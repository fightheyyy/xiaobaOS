export type OutcomeStatus = 'pass' | 'fail' | 'blocked';

export interface Oracle {
  hard_verifiers: readonly string[];
  semantic_criteria: readonly string[];
}

export interface CaseBudget {
  max_turns?: number;
  max_latency_ms?: number;
}

/**
 * A Case is executable input, not execution state.
 *
 * Scripted model responses intentionally do not belong here. They are Test
 * fixtures and cannot be used to claim Agent behavioral capability.
 */
export interface AgentCase<Setup = unknown> {
  case_id: string;
  task: string;
  setup?: Setup;
  budget?: CaseBudget;
  oracle: Oracle;
  source?: {
    trace_refs: readonly string[];
    finding?: string;
  };
}

export interface CaseSet<Setup = unknown> {
  case_set_id: string;
  cases: readonly AgentCase<Setup>[];
}

export interface ReplayMetrics {
  latency_ms?: number;
  cost_usd?: number;
  tokens?: number;
}

/**
 * Replay only executes a Case and points at the fresh Trace it produced.
 * Judgment belongs to Verifier and ReviewerCat.
 */
export interface ReplayResult {
  run_id: string;
  case_id: string;
  status: 'completed' | 'blocked';
  trace_ref?: string;
  reason?: string;
  metrics?: ReplayMetrics;
}

export interface VerifierResult {
  verifier_id: string;
  status: OutcomeStatus;
  reasons: readonly string[];
  evidence_refs: readonly string[];
  safety_violations?: readonly string[];
}

export interface ReviewerDecision {
  run_id: string;
  status: OutcomeStatus;
  reasons: readonly string[];
  evidence_refs: readonly string[];
}

export interface ReviewerRunEvidence {
  replay: Readonly<ReplayResult>;
  verification: readonly Readonly<VerifierResult>[];
}

/**
 * The caller must implement this as a fresh, independent ReviewerCat Session.
 * Evidence is readonly and the result is structured. ReviewerCat judges; the
 * caller persists the Outcome and performs any later action.
 */
export interface ReviewerRequest<Setup = unknown> {
  case: Readonly<AgentCase<Setup>>;
  runs: readonly Readonly<ReviewerRunEvidence>[];
}

export interface Outcome {
  case_id: string;
  run_id: string;
  status: OutcomeStatus;
  trace_ref?: string;
  reasons: string[];
  evidence_refs: string[];
  verifier_results: VerifierResult[];
  reviewer_decision?: ReviewerDecision;
  metrics?: ReplayMetrics;
}

export interface EvaluationMetrics {
  total_runs: number;
  pass_count: number;
  fail_count: number;
  blocked_count: number;
  pass_rate: number;
  stability: 'stable' | 'unstable';
  safety_violation_count: number;
  total_latency_ms?: number;
  total_cost_usd?: number;
  total_tokens?: number;
}

/**
 * EvaluationResult contains measurements, not a second overall verdict.
 */
export interface EvaluationResult {
  case_set_id: string;
  runs_per_case: number;
  outcomes: Outcome[];
  metrics: EvaluationMetrics;
}

export interface EvaluationDependencies<Setup = unknown> {
  replay: (input: {
    case: Readonly<AgentCase<Setup>>;
    attempt: number;
  }) => Promise<ReplayResult>;
  verify: (input: {
    case: Readonly<AgentCase<Setup>>;
    replay: Readonly<ReplayResult>;
  }) => Promise<readonly VerifierResult[]>;
  review: (request: ReviewerRequest<Setup>) => Promise<readonly ReviewerDecision[]>;
}

export interface EvaluationRequest<Setup = unknown> {
  case_set: Readonly<CaseSet<Setup>>;
  runs_per_case?: number;
}

export async function runEvaluation<Setup = unknown>(
  request: EvaluationRequest<Setup>,
  dependencies: EvaluationDependencies<Setup>,
): Promise<EvaluationResult> {
  const runsPerCase = request.runs_per_case ?? 3;
  validateRequest(request.case_set, runsPerCase);

  const outcomes: Outcome[] = [];
  for (const evaluationCase of request.case_set.cases) {
    outcomes.push(...await evaluateCase(evaluationCase, runsPerCase, dependencies));
  }

  return {
    case_set_id: request.case_set.case_set_id,
    runs_per_case: runsPerCase,
    outcomes,
    metrics: aggregateEvaluationMetrics(outcomes),
  };
}

async function evaluateCase<Setup>(
  evaluationCase: Readonly<AgentCase<Setup>>,
  runsPerCase: number,
  dependencies: EvaluationDependencies<Setup>,
): Promise<Outcome[]> {
  const runs: Array<{
    replay: ReplayResult;
    verification: VerifierResult[];
    hardOutcome?: Outcome;
  }> = [];

  for (let attempt = 1; attempt <= runsPerCase; attempt += 1) {
    const replay = await dependencies.replay({ case: evaluationCase, attempt });
    validateReplay(evaluationCase, replay);

    if (replay.status === 'blocked' || !replay.trace_ref) {
      runs.push({
        replay,
        verification: [],
        hardOutcome: outcomeFromReplayBlock(evaluationCase, replay),
      });
      continue;
    }

    const verification = [...await dependencies.verify({
      case: evaluationCase,
      replay,
    })];
    validateVerification(evaluationCase, verification);
    const hardStatus = hardVerifierStatus(verification);
    runs.push({
      replay,
      verification,
      ...(hardStatus === 'pass'
        ? {}
        : { hardOutcome: outcomeFromVerifier(evaluationCase, replay, verification, hardStatus) }),
    });
  }

  const pendingRuns = runs.filter(run => !run.hardOutcome);
  let reviewerError: string | undefined;
  let decisionsByRun = new Map<string, ReviewerDecision>();
  if (pendingRuns.length > 0) {
    try {
      const reviewerDecisions = await dependencies.review({
        case: evaluationCase,
        // ReviewerCat may inspect every Trace for this Case, including hard
        // failures, while returning decisions only for hard-check-passing runs.
        runs: runs.map(run => ({
          replay: run.replay,
          verification: run.verification,
        })),
      });
      decisionsByRun = indexReviewerDecisions(
        reviewerDecisions,
        new Set(pendingRuns.map(run => run.replay.run_id)),
      );
    } catch (error) {
      reviewerError = error instanceof Error ? error.message : String(error);
    }
  }

  return runs.map(run => {
    if (run.hardOutcome) return run.hardOutcome;
    const decision = decisionsByRun.get(run.replay.run_id);
    if (!decision) {
      return {
        case_id: evaluationCase.case_id,
        run_id: run.replay.run_id,
        status: 'blocked',
        trace_ref: run.replay.trace_ref,
        reasons: [
          reviewerError
            ? `ReviewerCat Judge failed: ${reviewerError}`
            : 'ReviewerCat returned no decision for this run',
        ],
        evidence_refs: verifierEvidence(run.verification),
        verifier_results: run.verification,
        metrics: run.replay.metrics,
      };
    }
    return {
      case_id: evaluationCase.case_id,
      run_id: run.replay.run_id,
      status: decision.status,
      trace_ref: run.replay.trace_ref,
      reasons: [...decision.reasons],
      evidence_refs: unique([
        run.replay.trace_ref,
        ...verifierEvidence(run.verification),
        ...decision.evidence_refs,
      ]),
      verifier_results: run.verification,
      reviewer_decision: decision,
      metrics: run.replay.metrics,
    };
  });
}

function outcomeFromReplayBlock<Setup>(
  evaluationCase: Readonly<AgentCase<Setup>>,
  replay: ReplayResult,
): Outcome {
  return {
    case_id: evaluationCase.case_id,
    run_id: replay.run_id,
    status: 'blocked',
    trace_ref: replay.trace_ref,
    reasons: [replay.reason || 'Replay did not produce a fresh Trace'],
    evidence_refs: replay.trace_ref ? [replay.trace_ref] : [],
    verifier_results: [],
    metrics: replay.metrics,
  };
}

function outcomeFromVerifier<Setup>(
  evaluationCase: Readonly<AgentCase<Setup>>,
  replay: ReplayResult,
  verification: VerifierResult[],
  status: Exclude<OutcomeStatus, 'pass'>,
): Outcome {
  const relevant = verification.filter(result => result.status === status);
  return {
    case_id: evaluationCase.case_id,
    run_id: replay.run_id,
    status,
    trace_ref: replay.trace_ref,
    reasons: relevant.flatMap(result => result.reasons),
    evidence_refs: unique([
      ...(replay.trace_ref ? [replay.trace_ref] : []),
      ...verifierEvidence(verification),
    ]),
    verifier_results: verification,
    metrics: replay.metrics,
  };
}

function hardVerifierStatus(results: readonly VerifierResult[]): OutcomeStatus {
  if (results.some(result => result.status === 'fail')) return 'fail';
  if (results.some(result => result.status === 'blocked')) return 'blocked';
  return 'pass';
}

function indexReviewerDecisions(
  decisions: readonly ReviewerDecision[],
  expectedRunIds: ReadonlySet<string>,
): Map<string, ReviewerDecision> {
  const indexed = new Map<string, ReviewerDecision>();
  for (const decision of decisions) {
    if (!decision.run_id.trim()) {
      throw new Error('ReviewerCat decision requires run_id');
    }
    if (indexed.has(decision.run_id)) {
      throw new Error(`ReviewerCat returned duplicate decision for ${decision.run_id}`);
    }
    if (!expectedRunIds.has(decision.run_id)) {
      throw new Error(`ReviewerCat returned an unexpected decision for ${decision.run_id}`);
    }
    indexed.set(decision.run_id, decision);
  }
  return indexed;
}

function aggregateEvaluationMetrics(outcomes: readonly Outcome[]): EvaluationMetrics {
  const passCount = countStatus(outcomes, 'pass');
  const failCount = countStatus(outcomes, 'fail');
  const blockedCount = countStatus(outcomes, 'blocked');
  const totalLatencyMs = sumMetric(outcomes, 'latency_ms');
  const totalCostUsd = sumMetric(outcomes, 'cost_usd');
  const totalTokens = sumMetric(outcomes, 'tokens');
  return {
    total_runs: outcomes.length,
    pass_count: passCount,
    fail_count: failCount,
    blocked_count: blockedCount,
    pass_rate: outcomes.length === 0 ? 0 : passCount / outcomes.length,
    stability: hasStableCaseRuns(outcomes) ? 'stable' : 'unstable',
    safety_violation_count: outcomes.reduce((sum, outcome) => (
      sum + outcome.verifier_results.reduce(
        (inner, result) => inner + (result.safety_violations?.length ?? 0),
        0,
      )
    ), 0),
    ...(totalLatencyMs === undefined ? {} : { total_latency_ms: totalLatencyMs }),
    ...(totalCostUsd === undefined ? {} : { total_cost_usd: totalCostUsd }),
    ...(totalTokens === undefined ? {} : { total_tokens: totalTokens }),
  };
}

function countStatus(outcomes: readonly Outcome[], status: OutcomeStatus): number {
  return outcomes.filter(outcome => outcome.status === status).length;
}

function hasStableCaseRuns(outcomes: readonly Outcome[]): boolean {
  const statusByCase = new Map<string, OutcomeStatus>();
  for (const outcome of outcomes) {
    const priorStatus = statusByCase.get(outcome.case_id);
    if (priorStatus !== undefined && priorStatus !== outcome.status) return false;
    statusByCase.set(outcome.case_id, outcome.status);
  }
  return true;
}

function sumMetric(
  outcomes: readonly Outcome[],
  key: keyof ReplayMetrics,
): number | undefined {
  let total = 0;
  for (const outcome of outcomes) {
    const value = outcome.metrics?.[key];
    if (value === undefined) return undefined;
    total += value;
  }
  return total;
}

function verifierEvidence(results: readonly VerifierResult[]): string[] {
  return results.flatMap(result => result.evidence_refs);
}

function validateRequest<Setup>(caseSet: Readonly<CaseSet<Setup>>, runsPerCase: number): void {
  if (!caseSet.case_set_id.trim()) throw new Error('Evaluation requires case_set_id');
  if (caseSet.cases.length === 0) throw new Error('Evaluation requires at least one Case');
  if (!Number.isInteger(runsPerCase) || runsPerCase <= 0) {
    throw new Error('runs_per_case must be a positive integer');
  }
  const ids = new Set<string>();
  for (const evaluationCase of caseSet.cases) {
    if (!evaluationCase.case_id.trim()) throw new Error('Case requires case_id');
    if (!evaluationCase.task.trim()) throw new Error(`Case ${evaluationCase.case_id} requires task`);
    if (ids.has(evaluationCase.case_id)) {
      throw new Error(`Duplicate Case id: ${evaluationCase.case_id}`);
    }
    ids.add(evaluationCase.case_id);
  }
}

function validateReplay<Setup>(
  evaluationCase: Readonly<AgentCase<Setup>>,
  replay: ReplayResult,
): void {
  if (!replay.run_id.trim()) throw new Error(`Replay for ${evaluationCase.case_id} requires run_id`);
  if (replay.case_id !== evaluationCase.case_id) {
    throw new Error(`Replay ${replay.run_id} belongs to ${replay.case_id}, expected ${evaluationCase.case_id}`);
  }
}

function validateVerification<Setup>(
  evaluationCase: Readonly<AgentCase<Setup>>,
  results: readonly VerifierResult[],
): void {
  const allowed = new Set(evaluationCase.oracle.hard_verifiers);
  const required = new Set(allowed);
  const seen = new Set<string>();
  for (const result of results) {
    if (!allowed.has(result.verifier_id)) {
      throw new Error(
        `Case ${evaluationCase.case_id} returned undeclared verifier result: ${result.verifier_id}`,
      );
    }
    if (seen.has(result.verifier_id)) {
      throw new Error(
        `Case ${evaluationCase.case_id} returned duplicate verifier result: ${result.verifier_id}`,
      );
    }
    seen.add(result.verifier_id);
    required.delete(result.verifier_id);
  }
  if (required.size > 0) {
    throw new Error(
      `Case ${evaluationCase.case_id} missing hard verifier results: ${[...required].join(', ')}`,
    );
  }
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
