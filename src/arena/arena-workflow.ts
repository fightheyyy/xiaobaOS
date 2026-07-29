import {
  AgentCase,
  CaseSet,
  EvaluationResult,
  OutcomeStatus,
} from '../eval/evaluation';

export interface Scenario {
  scenario_id: string;
  user_context: string;
  goal: string;
  constraints: readonly string[];
  turn_budget: number;
}

export interface ArenaSubject {
  subject_id: string;
  role_id?: string;
  skill_id?: string;
}

export interface Finding {
  summary: string;
  evidence_refs: readonly string[];
}

export interface FindingCase<Setup = unknown> {
  finding: Finding;
  case: AgentCase<Setup>;
}

export interface ArenaInteractionResult {
  trace_refs: readonly string[];
}

export interface ArenaResult<Setup = unknown> {
  arena_run_id: string;
  subject: ArenaSubject;
  scenario: Scenario;
  trace_refs: string[];
  finding_cases: FindingCase<Setup>[];
  evaluation?: EvaluationResult;
  decision: OutcomeStatus;
  reasons: string[];
}

export interface ArenaRequest {
  arena_run_id: string;
  subject: ArenaSubject;
  scenario?: Scenario;
}

export interface ArenaDependencies<Setup = unknown> {
  proposeScenario: (subject: Readonly<ArenaSubject>) => Promise<Scenario>;
  interact: (input: {
    arena_run_id: string;
    subject: Readonly<ArenaSubject>;
    scenario: Readonly<Scenario>;
  }) => Promise<ArenaInteractionResult>;
  inspect: (input: {
    subject: Readonly<ArenaSubject>;
    scenario: Readonly<Scenario>;
    trace_refs: readonly string[];
  }) => Promise<readonly FindingCase<Setup>[]>;
  evaluate: (caseSet: Readonly<CaseSet<Setup>>) => Promise<EvaluationResult>;
}

/**
 * Arena is an Agentic Eval workflow, not another evaluator implementation.
 *
 * It expands the original Scenario Trace exactly once. Replay Traces produced
 * by Evaluation are evidence for this run and are never sent back to Inspector
 * from here.
 */
export async function runArena<Setup = unknown>(
  request: ArenaRequest,
  dependencies: ArenaDependencies<Setup>,
): Promise<ArenaResult<Setup>> {
  validateArenaRequest(request);
  const scenario = freezeScenario(
    request.scenario ?? await dependencies.proposeScenario(request.subject),
  );
  validateScenario(scenario);

  const interaction = await dependencies.interact({
    arena_run_id: request.arena_run_id,
    subject: Object.freeze({ ...request.subject }),
    scenario,
  });
  const traceRefs = unique(interaction.trace_refs);
  if (traceRefs.length === 0) {
    return {
      arena_run_id: request.arena_run_id,
      subject: { ...request.subject },
      scenario: copyScenario(scenario),
      trace_refs: [],
      finding_cases: [],
      decision: 'blocked',
      reasons: ['Scenario interaction produced no Trace'],
    };
  }

  const findingCases = [...await dependencies.inspect({
    subject: Object.freeze({ ...request.subject }),
    scenario,
    trace_refs: traceRefs,
  })];
  validateFindingCases(findingCases, traceRefs);

  if (findingCases.length === 0) {
    return {
      arena_run_id: request.arena_run_id,
      subject: { ...request.subject },
      scenario: copyScenario(scenario),
      trace_refs: traceRefs,
      finding_cases: [],
      decision: 'pass',
      reasons: ['No replayable counterexample was found in this Scenario'],
    };
  }

  const caseSet: CaseSet<Setup> = {
    case_set_id: `arena:${request.arena_run_id}`,
    cases: findingCases.map(item => item.case),
  };
  const evaluation = await dependencies.evaluate(caseSet);
  validateArenaEvaluation(caseSet, evaluation);
  const decision = decideArena(evaluation);

  return {
    arena_run_id: request.arena_run_id,
    subject: { ...request.subject },
    scenario: copyScenario(scenario),
    trace_refs: traceRefs,
    finding_cases: findingCases.map(copyFindingCase),
    evaluation,
    decision,
    reasons: arenaReasons(decision, evaluation),
  };
}

export function decideArena(evaluation: Readonly<EvaluationResult>): OutcomeStatus {
  if (evaluation.outcomes.some(outcome => outcome.status === 'fail')) return 'fail';
  if (evaluation.outcomes.some(outcome => outcome.status === 'blocked')) return 'blocked';
  return 'pass';
}

function validateArenaRequest(request: ArenaRequest): void {
  if (!request.arena_run_id.trim()) throw new Error('Arena requires arena_run_id');
  if (!request.subject.subject_id.trim()) throw new Error('Arena requires subject_id');
}

function validateScenario(scenario: Readonly<Scenario>): void {
  if (!scenario.scenario_id.trim()) throw new Error('Scenario requires scenario_id');
  if (!scenario.goal.trim()) throw new Error(`Scenario ${scenario.scenario_id} requires goal`);
  if (!Number.isInteger(scenario.turn_budget) || scenario.turn_budget <= 0) {
    throw new Error(`Scenario ${scenario.scenario_id} requires a positive turn_budget`);
  }
}

function validateFindingCases<Setup>(
  items: readonly FindingCase<Setup>[],
  traceRefs: readonly string[],
): void {
  const caseIds = new Set<string>();
  for (const item of items) {
    if (!item.finding.summary.trim()) throw new Error('Inspector Finding requires summary');
    if (item.finding.evidence_refs.length === 0) {
      throw new Error(`Finding for ${item.case.case_id || 'unknown Case'} requires evidence_refs`);
    }
    const unknownFindingRefs = item.finding.evidence_refs.filter(ref => !traceRefs.includes(ref));
    if (unknownFindingRefs.length > 0) {
      throw new Error(
        `Finding for ${item.case.case_id || 'unknown Case'} referenced evidence outside the Scenario Trace`,
      );
    }
    if (!item.case.case_id.trim() || !item.case.task.trim()) {
      throw new Error('Inspector must return an executable Case with case_id and task');
    }
    if (caseIds.has(item.case.case_id)) {
      throw new Error(`Inspector returned duplicate Case id: ${item.case.case_id}`);
    }
    caseIds.add(item.case.case_id);
    const sourceRefs = item.case.source?.trace_refs ?? [];
    if (!sourceRefs.some(ref => traceRefs.includes(ref))) {
      throw new Error(`Case ${item.case.case_id} is not linked to the Scenario Trace`);
    }
    if (sourceRefs.some(ref => !traceRefs.includes(ref))) {
      throw new Error(`Case ${item.case.case_id} referenced a source outside the Scenario Trace`);
    }
  }
}

function validateArenaEvaluation<Setup>(
  caseSet: Readonly<CaseSet<Setup>>,
  evaluation: Readonly<EvaluationResult>,
): void {
  if (evaluation.case_set_id !== caseSet.case_set_id) {
    throw new Error(
      `Arena EvaluationResult belongs to ${evaluation.case_set_id}, expected ${caseSet.case_set_id}`,
    );
  }
  const evaluatedCases = new Set(evaluation.outcomes.map(outcome => outcome.case_id));
  for (const evaluationCase of caseSet.cases) {
    if (!evaluatedCases.has(evaluationCase.case_id)) {
      throw new Error(`Arena EvaluationResult is missing Case ${evaluationCase.case_id}`);
    }
  }
}

function arenaReasons(
  decision: OutcomeStatus,
  evaluation: Readonly<EvaluationResult>,
): string[] {
  const selected = evaluation.outcomes.filter(outcome => outcome.status === decision);
  if (selected.length > 0) {
    return unique(selected.flatMap(outcome => outcome.reasons));
  }
  return ['All generated Cases passed'];
}

function freezeScenario(scenario: Scenario): Readonly<Scenario> {
  return Object.freeze({
    ...scenario,
    constraints: Object.freeze([...scenario.constraints]),
  });
}

function copyScenario(scenario: Readonly<Scenario>): Scenario {
  return {
    ...scenario,
    constraints: [...scenario.constraints],
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
