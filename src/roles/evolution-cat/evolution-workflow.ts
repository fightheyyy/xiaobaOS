import { FindingCase } from '../../arena/arena-workflow';
import {
  AgentCase,
  EvaluationResult,
  OutcomeStatus,
} from '../../eval/evaluation';

export type ChangeOwner = 'engineer-cat' | 'evolution-cat';
export type CandidateType = 'skill' | 'role' | 'code';

export interface Candidate {
  candidate_id: string;
  owner: ChangeOwner;
  candidate_type: CandidateType;
  candidate_name: string;
  artifact_ref: string;
  artifact_fingerprint: string;
  base_version: string;
}

export interface CandidateTestResult {
  status: OutcomeStatus;
  evidence_refs: readonly string[];
  reasons: readonly string[];
}

export type EvolutionSource<Setup = unknown> =
  | {
      type: 'trace';
      trace_refs: readonly string[];
    }
  | {
      type: 'case';
      finding_case: FindingCase<Setup>;
    };

export interface EvolutionRequest<Setup = unknown> {
  evolution_run_id: string;
  source: EvolutionSource<Setup>;
}

export interface EvolutionAttempt<Setup = unknown> {
  finding_case: FindingCase<Setup>;
  candidate?: Candidate;
  test_result?: CandidateTestResult;
  evaluation?: EvaluationResult;
  activated: boolean;
  reasons: string[];
}

export interface EvolutionResult<Setup = unknown> {
  evolution_run_id: string;
  attempts: EvolutionAttempt<Setup>[];
}

export interface EvolutionDependencies<Setup = unknown> {
  inspect: (traceRefs: readonly string[]) => Promise<readonly FindingCase<Setup>[]>;
  change: (input: {
    finding_case: Readonly<FindingCase<Setup>>;
  }) => Promise<Candidate>;
  test: (input: {
    candidate: Readonly<Candidate>;
  }) => Promise<CandidateTestResult>;
  evaluate: (input: {
    candidate: Readonly<Candidate>;
    cases: readonly Readonly<AgentCase<Setup>>[];
  }) => Promise<EvaluationResult>;
  activateForNewSessions: (candidate: Readonly<Candidate>) => Promise<void>;
}

/**
 * Evolution is only a control DAG. Every operation is supplied by its owning
 * module; this workflow owns no Replay, Judge, Test, Scorecard or promotion
 * implementation.
 */
export async function runEvolution<Setup = unknown>(
  request: EvolutionRequest<Setup>,
  dependencies: EvolutionDependencies<Setup>,
): Promise<EvolutionResult<Setup>> {
  if (!request.evolution_run_id.trim()) throw new Error('Evolution requires evolution_run_id');

  const findingCases = request.source.type === 'trace'
    ? [...await dependencies.inspect(unique(request.source.trace_refs))]
    : [request.source.finding_case];
  validateFindingCases(findingCases);

  const attempts: EvolutionAttempt<Setup>[] = [];
  for (const findingCase of findingCases) {
    attempts.push(await evolveFindingCase(findingCase, dependencies));
  }

  return {
    evolution_run_id: request.evolution_run_id,
    attempts,
  };
}

async function evolveFindingCase<Setup>(
  findingCase: FindingCase<Setup>,
  dependencies: EvolutionDependencies<Setup>,
): Promise<EvolutionAttempt<Setup>> {
  let candidate: Candidate;
  try {
    candidate = await dependencies.change({ finding_case: findingCase });
    validateCandidate(candidate);
  } catch (error) {
    return {
      finding_case: copyFindingCase(findingCase),
      activated: false,
      reasons: [`Candidate creation failed: ${errorMessage(error)}`],
    };
  }

  let testResult: CandidateTestResult;
  try {
    testResult = await dependencies.test({ candidate });
  } catch (error) {
    return {
      finding_case: copyFindingCase(findingCase),
      candidate: { ...candidate },
      activated: false,
      reasons: [`Test failed to run: ${errorMessage(error)}`],
    };
  }
  if (testResult.status !== 'pass') {
    return {
      finding_case: copyFindingCase(findingCase),
      candidate: { ...candidate },
      test_result: copyTestResult(testResult),
      activated: false,
      reasons: [...testResult.reasons],
    };
  }

  let evaluation: EvaluationResult;
  try {
    evaluation = await dependencies.evaluate({
      candidate,
      cases: [findingCase.case],
    });
  } catch (error) {
    return {
      finding_case: copyFindingCase(findingCase),
      candidate: { ...candidate },
      test_result: copyTestResult(testResult),
      activated: false,
      reasons: [`Evaluation failed to run: ${errorMessage(error)}`],
    };
  }
  const coverageReasons = evaluationCoverageReasons(
    evaluation,
    findingCase.case.case_id,
  );
  if (coverageReasons.length > 0) {
    return {
      finding_case: copyFindingCase(findingCase),
      candidate: { ...candidate },
      test_result: copyTestResult(testResult),
      ...(Array.isArray(evaluation?.outcomes) ? { evaluation } : {}),
      activated: false,
      reasons: coverageReasons,
    };
  }
  const acceptance = candidateAcceptance(evaluation);
  if (acceptance !== 'pass') {
    return {
      finding_case: copyFindingCase(findingCase),
      candidate: { ...candidate },
      test_result: copyTestResult(testResult),
      evaluation,
      activated: false,
      reasons: outcomeReasons(evaluation, acceptance),
    };
  }

  try {
    await dependencies.activateForNewSessions(candidate);
  } catch (error) {
    return {
      finding_case: copyFindingCase(findingCase),
      candidate: { ...candidate },
      test_result: copyTestResult(testResult),
      evaluation,
      activated: false,
      reasons: [`Activation failed: ${errorMessage(error)}`],
    };
  }

  return {
    finding_case: copyFindingCase(findingCase),
    candidate: { ...candidate },
    test_result: copyTestResult(testResult),
    evaluation,
    activated: true,
    reasons: ['Candidate passed Test + Eval and was activated'],
  };
}

export function candidateAcceptance(
  evaluation: Readonly<EvaluationResult>,
): OutcomeStatus {
  if (!Array.isArray(evaluation.outcomes) || evaluation.outcomes.length === 0) return 'blocked';
  if (evaluation.outcomes.some(outcome => outcome.status === 'fail')) return 'fail';
  if (evaluation.outcomes.some(outcome => outcome.status === 'blocked')) return 'blocked';
  if (evaluation.outcomes.some(outcome => outcome.status !== 'pass')) return 'blocked';
  return 'pass';
}

function evaluationCoverageReasons(
  evaluation: Readonly<EvaluationResult>,
  requestedCaseId: string,
): string[] {
  const outcomes: unknown = evaluation?.outcomes;
  if (!Array.isArray(outcomes)) {
    return ['Candidate EvaluationResult requires an outcomes array'];
  }
  if (outcomes.length === 0) {
    return [`Candidate EvaluationResult has no outcomes for requested Case ${requestedCaseId}`];
  }

  const caseIds: string[] = [];
  for (const outcome of outcomes) {
    if (
      typeof outcome !== 'object'
      || outcome === null
      || !('case_id' in outcome)
      || typeof outcome.case_id !== 'string'
      || !outcome.case_id.trim()
    ) {
      return ['Candidate EvaluationResult contains an Outcome without a valid case_id'];
    }
    caseIds.push(outcome.case_id);
  }

  const reasons: string[] = [];
  if (!caseIds.includes(requestedCaseId)) {
    reasons.push(`Candidate EvaluationResult is missing requested Case ${requestedCaseId}`);
  }
  const undeclaredCaseIds = unique(caseIds.filter(caseId => caseId !== requestedCaseId));
  if (undeclaredCaseIds.length > 0) {
    reasons.push(
      `Candidate EvaluationResult contains undeclared Cases: ${undeclaredCaseIds.join(', ')}`,
    );
  }
  return reasons;
}

function validateFindingCases<Setup>(findingCases: readonly FindingCase<Setup>[]): void {
  for (const item of findingCases) {
    if (!item.finding.summary.trim()) throw new Error('Evolution Finding requires summary');
    if (!item.case.case_id.trim()) throw new Error('Evolution requires an executable Case');
  }
}

function validateCandidate(candidate: Readonly<Candidate>): void {
  if (!candidate.candidate_id.trim()) throw new Error('Candidate requires candidate_id');
  if (!candidate.candidate_name.trim()) throw new Error('Candidate requires candidate_name');
  if (!candidate.artifact_ref.trim()) throw new Error('Candidate requires artifact_ref');
  if (!candidate.artifact_fingerprint.trim()) {
    throw new Error('Candidate requires artifact_fingerprint');
  }
  if (!candidate.base_version.trim()) throw new Error('Candidate requires base_version');
}

function outcomeReasons(
  evaluation: Readonly<EvaluationResult>,
  status: Exclude<OutcomeStatus, 'pass'>,
): string[] {
  const reasons = evaluation.outcomes
    .filter(outcome => outcome.status === status)
    .flatMap(outcome => outcome.reasons);
  return reasons.length > 0 ? unique(reasons) : [`Candidate Evaluation ${status}`];
}

function copyTestResult(result: Readonly<CandidateTestResult>): CandidateTestResult {
  return {
    status: result.status,
    evidence_refs: [...result.evidence_refs],
    reasons: [...result.reasons],
  };
}

function copyFindingCase<Setup>(item: FindingCase<Setup>): FindingCase<Setup> {
  return {
    finding: {
      summary: item.finding.summary,
      evidence_refs: [...item.finding.evidence_refs],
    },
    case: {
      ...item.case,
      oracle: {
        hard_verifiers: [...item.case.oracle.hard_verifiers],
        semantic_criteria: [...item.case.oracle.semantic_criteria],
      },
      ...(item.case.source
        ? {
            source: {
              ...item.case.source,
              trace_refs: [...item.case.source.trace_refs],
            },
          }
        : {}),
    },
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
