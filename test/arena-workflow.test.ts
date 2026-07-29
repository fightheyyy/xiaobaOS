import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FindingCase, runArena } from '../src/arena/arena-workflow';
import { EvaluationResult } from '../src/eval/evaluation';

const traceRef = 'logs/arena-session/traces.jsonl';

function findingCase(caseId = 'case-1'): FindingCase {
  return {
    finding: {
      summary: 'The Subject claimed success without evidence.',
      evidence_refs: [traceRef],
    },
    case: {
      case_id: caseId,
      task: 'Repeat the task and provide verifiable evidence.',
      oracle: {
        hard_verifiers: ['trace_exists'],
        semantic_criteria: ['The response includes grounded evidence.'],
      },
      source: {
        trace_refs: [traceRef],
      },
    },
  };
}

function evaluation(
  caseSetId: string,
  statuses: Array<'pass' | 'fail' | 'blocked'>,
): EvaluationResult {
  const outcomes = statuses.map((status, index) => ({
    case_id: 'case-1',
    run_id: `run-${index + 1}`,
    status,
    trace_ref: `logs/replay-${index + 1}/traces.jsonl`,
    reasons: status === 'pass' ? ['passed'] : [`${status} reason`],
    evidence_refs: [],
    verifier_results: [],
  }));
  return {
    case_set_id: caseSetId,
    runs_per_case: statuses.length,
    outcomes,
    metrics: {
      total_runs: statuses.length,
      pass_count: statuses.filter(status => status === 'pass').length,
      fail_count: statuses.filter(status => status === 'fail').length,
      blocked_count: statuses.filter(status => status === 'blocked').length,
      pass_rate: statuses.filter(status => status === 'pass').length / statuses.length,
      stability: new Set(statuses).size <= 1 ? 'stable' : 'unstable',
      safety_violation_count: 0,
      total_latency_ms: 0,
      total_cost_usd: 0,
      total_tokens: 0,
    },
  };
}

describe('lightweight Arena workflow', () => {
  test('asks UserCat for a Scenario when absent and passes when Inspector finds no Case', async () => {
    let evaluateCalls = 0;
    let inspectCalls = 0;
    const result = await runArena({
      arena_run_id: 'arena-1',
      subject: { subject_id: 'subject-1' },
    }, {
      proposeScenario: async () => ({
        scenario_id: 'scenario-1',
        user_context: 'A user has a vague file task.',
        goal: 'Produce the requested file.',
        constraints: ['Do not invent delivery evidence.'],
        turn_budget: 4,
      }),
      interact: async ({ scenario }) => {
        assert.equal(Object.isFrozen(scenario), true);
        assert.equal(Object.isFrozen(scenario.constraints), true);
        return { trace_refs: [traceRef] };
      },
      inspect: async () => {
        inspectCalls += 1;
        return [];
      },
      evaluate: async () => {
        evaluateCalls += 1;
        throw new Error('Evaluation must not run without a generated Case');
      },
    });

    assert.equal(inspectCalls, 1);
    assert.equal(evaluateCalls, 0);
    assert.equal(result.decision, 'pass');
    assert.equal(result.evaluation, undefined);
  });

  test('runs all generated Cases through shared Evaluation and one failure is a counterexample', async () => {
    let inspected = 0;
    const result = await runArena({
      arena_run_id: 'arena-2',
      subject: { subject_id: 'subject-1' },
      scenario: {
        scenario_id: 'scenario-2',
        user_context: 'A user asks for evidence.',
        goal: 'Complete the task with evidence.',
        constraints: [],
        turn_budget: 3,
      },
    }, {
      proposeScenario: async () => {
        throw new Error('A supplied Scenario must be used');
      },
      interact: async () => ({ trace_refs: [traceRef] }),
      inspect: async () => {
        inspected += 1;
        return [findingCase()];
      },
      evaluate: async caseSet => evaluation(caseSet.case_set_id, ['pass', 'fail', 'pass']),
    });

    assert.equal(inspected, 1);
    assert.equal(result.decision, 'fail');
    assert.deepEqual(result.reasons, ['fail reason']);
    assert.equal(result.finding_cases.length, 1);
  });

  test('uses blocked only when no failed Outcome exists', async () => {
    const result = await runArena({
      arena_run_id: 'arena-3',
      subject: { subject_id: 'subject-1' },
      scenario: {
        scenario_id: 'scenario-3',
        user_context: '',
        goal: 'Try the task.',
        constraints: [],
        turn_budget: 1,
      },
    }, {
      proposeScenario: async () => {
        throw new Error('unused');
      },
      interact: async () => ({ trace_refs: [traceRef] }),
      inspect: async () => [findingCase()],
      evaluate: async caseSet => evaluation(caseSet.case_set_id, ['pass', 'blocked']),
    });

    assert.equal(result.decision, 'blocked');
  });

  test('rejects a Finding that cites evidence outside the Scenario Trace', async () => {
    await assert.rejects(() => runArena({
      arena_run_id: 'arena-invented-evidence',
      subject: { subject_id: 'subject-1' },
      scenario: {
        scenario_id: 'scenario-4',
        user_context: '',
        goal: 'Try the task.',
        constraints: [],
        turn_budget: 1,
      },
    }, {
      proposeScenario: async () => {
        throw new Error('unused');
      },
      interact: async () => ({ trace_refs: [traceRef] }),
      inspect: async () => [{
        ...findingCase(),
        finding: {
          summary: 'Invented evidence',
          evidence_refs: ['logs/invented.jsonl'],
        },
      }],
      evaluate: async caseSet => evaluation(caseSet.case_set_id, ['pass']),
    }), /outside the Scenario Trace/);
  });
});
