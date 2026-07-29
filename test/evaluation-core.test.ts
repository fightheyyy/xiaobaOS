import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AgentCase,
  ReviewerRequest,
  runEvaluation,
} from '../src/eval/evaluation';

const evaluationCase: AgentCase = {
  case_id: 'case-weather',
  task: 'Answer the user with grounded weather evidence.',
  oracle: {
    hard_verifiers: ['trace_exists', 'tool_boundary'],
    semantic_criteria: ['The answer addresses the requested place and date.'],
  },
};

describe('lightweight Evaluation core', () => {
  test('rejects an empty CaseSet instead of reporting a vacuous result', async () => {
    await assert.rejects(() => runEvaluation({
      case_set: {
        case_set_id: 'empty',
        cases: [],
      },
    }, {
      replay: async () => {
        throw new Error('unused');
      },
      verify: async () => [],
      review: async () => [],
    }), /at least one Case/);
  });

  test('replays a Case, applies hard vetoes, then asks ReviewerCat once with all Traces', async () => {
    let reviewerRequest: ReviewerRequest | undefined;
    const result = await runEvaluation({
      case_set: {
        case_set_id: 'weather',
        cases: [evaluationCase],
      },
      runs_per_case: 3,
    }, {
      replay: async ({ case: current, attempt }) => ({
        run_id: `run-${attempt}`,
        case_id: current.case_id,
        status: 'completed',
        trace_ref: `logs/run-${attempt}/traces.jsonl`,
        metrics: {
          latency_ms: attempt * 10,
          cost_usd: 0.01,
          tokens: 100,
        },
      }),
      verify: async ({ replay }) => [
        {
          verifier_id: 'trace_exists',
          status: 'pass',
          reasons: [],
          evidence_refs: [replay.trace_ref!],
        },
        {
          verifier_id: 'tool_boundary',
          status: replay.run_id === 'run-2' ? 'fail' : 'pass',
          reasons: replay.run_id === 'run-2' ? ['forbidden tool call'] : [],
          evidence_refs: [replay.trace_ref!],
          safety_violations: replay.run_id === 'run-2' ? ['forbidden_tool'] : [],
        },
      ],
      review: async request => {
        reviewerRequest = request;
        return request.runs
          .filter(run => run.verification.every(item => item.status === 'pass'))
          .map(run => ({
            run_id: run.replay.run_id,
            status: 'pass' as const,
            reasons: ['semantic criteria satisfied'],
            evidence_refs: [run.replay.trace_ref!],
          }));
      },
    });

    assert.equal(reviewerRequest?.runs.length, 3);
    assert.deepEqual(result.outcomes.map(outcome => outcome.status), ['pass', 'fail', 'pass']);
    assert.equal(result.outcomes[1].reviewer_decision, undefined);
    assert.deepEqual(result.metrics, {
      total_runs: 3,
      pass_count: 2,
      fail_count: 1,
      blocked_count: 0,
      pass_rate: 2 / 3,
      stability: 'unstable',
      safety_violation_count: 1,
      total_latency_ms: 60,
      total_cost_usd: 0.03,
      total_tokens: 300,
    });
    assert.equal('decision' in result, false);
  });

  test('measures stability within each Case and omits totals for incomplete measurements', async () => {
    const passingCase = {
      ...evaluationCase,
      case_id: 'case-pass',
    };
    const failingCase = {
      ...evaluationCase,
      case_id: 'case-fail',
    };
    const result = await runEvaluation({
      case_set: {
        case_set_id: 'case-local-stability',
        cases: [passingCase, failingCase],
      },
      runs_per_case: 2,
    }, {
      replay: async ({ case: current, attempt }) => ({
        run_id: `${current.case_id}-run-${attempt}`,
        case_id: current.case_id,
        status: 'completed',
        trace_ref: `logs/${current.case_id}-run-${attempt}/traces.jsonl`,
        ...(current.case_id === passingCase.case_id
          ? {
            metrics: {
              latency_ms: 10,
              cost_usd: 0.01,
              tokens: 100,
            },
          }
          : {}),
      }),
      verify: async ({ case: current, replay }) => current.oracle.hard_verifiers.map(verifierId => ({
        verifier_id: verifierId,
        status: 'pass',
        reasons: [],
        evidence_refs: [replay.trace_ref!],
      })),
      review: async request => request.runs.map(run => ({
        run_id: run.replay.run_id,
        status: request.case.case_id === passingCase.case_id ? 'pass' : 'fail',
        reasons: [],
        evidence_refs: [run.replay.trace_ref!],
      })),
    });

    assert.deepEqual(result.outcomes.map(outcome => outcome.status), [
      'pass',
      'pass',
      'fail',
      'fail',
    ]);
    assert.equal(result.metrics.stability, 'stable');
    assert.equal('total_latency_ms' in result.metrics, false);
    assert.equal('total_cost_usd' in result.metrics, false);
    assert.equal('total_tokens' in result.metrics, false);
  });

  test('keeps Replay blocked and never treats execution as a passing judgment', async () => {
    let reviewCalls = 0;
    const result = await runEvaluation({
      case_set: {
        case_set_id: 'blocked',
        cases: [evaluationCase],
      },
      runs_per_case: 1,
    }, {
      replay: async () => ({
        run_id: 'blocked-run',
        case_id: evaluationCase.case_id,
        status: 'blocked',
        reason: 'provider unavailable',
      }),
      verify: async () => {
        throw new Error('Verifier must not run without a fresh Trace');
      },
      review: async () => {
        reviewCalls += 1;
        return [];
      },
    });

    assert.equal(reviewCalls, 0);
    assert.equal(result.outcomes[0].status, 'blocked');
    assert.deepEqual(result.outcomes[0].reasons, ['provider unavailable']);
  });

  test('blocks a hard-check-passing run when ReviewerCat omits its decision', async () => {
    const result = await runEvaluation({
      case_set: {
        case_set_id: 'missing-review',
        cases: [evaluationCase],
      },
      runs_per_case: 1,
    }, {
      replay: async () => ({
        run_id: 'run-1',
        case_id: evaluationCase.case_id,
        status: 'completed',
        trace_ref: 'logs/run-1/traces.jsonl',
      }),
      verify: async () => [
        {
          verifier_id: 'trace_exists',
          status: 'pass',
          reasons: [],
          evidence_refs: ['logs/run-1/traces.jsonl'],
        },
        {
          verifier_id: 'tool_boundary',
          status: 'pass',
          reasons: [],
          evidence_refs: ['logs/run-1/traces.jsonl'],
        },
      ],
      review: async () => [],
    });

    assert.equal(result.outcomes[0].status, 'blocked');
    assert.match(result.outcomes[0].reasons[0], /no decision/);
  });

  test('blocks the semantic stage when ReviewerCat returns a decision for another run', async () => {
    const result = await runEvaluation({
      case_set: {
        case_set_id: 'unexpected-review',
        cases: [evaluationCase],
      },
      runs_per_case: 1,
    }, {
      replay: async () => ({
        run_id: 'run-1',
        case_id: evaluationCase.case_id,
        status: 'completed',
        trace_ref: 'logs/run-1/traces.jsonl',
      }),
      verify: async ({ replay }) => evaluationCase.oracle.hard_verifiers.map(verifierId => ({
        verifier_id: verifierId,
        status: 'pass' as const,
        reasons: [],
        evidence_refs: [replay.trace_ref!],
      })),
      review: async () => [{
        run_id: 'run-from-another-case',
        status: 'pass',
        reasons: [],
        evidence_refs: [],
      }],
    });

    assert.equal(result.outcomes[0].status, 'blocked');
    assert.match(result.outcomes[0].reasons[0], /unexpected decision/);
  });

  test('rejects a hard verifier that was not declared by the Case Oracle', async () => {
    await assert.rejects(() => runEvaluation({
      case_set: {
        case_set_id: 'hidden-oracle',
        cases: [evaluationCase],
      },
      runs_per_case: 1,
    }, {
      replay: async () => ({
        run_id: 'run-1',
        case_id: evaluationCase.case_id,
        status: 'completed',
        trace_ref: 'logs/run-1/traces.jsonl',
      }),
      verify: async ({ replay }) => [
        ...evaluationCase.oracle.hard_verifiers.map(verifierId => ({
          verifier_id: verifierId,
          status: 'pass' as const,
          reasons: [],
          evidence_refs: [replay.trace_ref!],
        })),
        {
          verifier_id: 'hidden_policy',
          status: 'fail' as const,
          reasons: ['undeclared'],
          evidence_refs: [replay.trace_ref!],
        },
      ],
      review: async () => [],
    }), /undeclared verifier result/);
  });
});
