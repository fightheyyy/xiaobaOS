import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FindingCase } from '../src/arena/arena-workflow';
import { EvaluationResult } from '../src/eval/evaluation';
import {
  Candidate,
  runEvolution,
} from '../src/roles/evolution-cat/evolution-workflow';

const findingCase: FindingCase = {
  finding: {
    summary: 'The task repeatedly ends with fake success.',
    evidence_refs: ['logs/source/traces.jsonl'],
  },
  case: {
    case_id: 'case-fake-success',
    task: 'Complete the task and provide real evidence.',
    oracle: {
      hard_verifiers: ['trace_exists'],
      semantic_criteria: ['The claimed result is grounded in evidence.'],
    },
    source: {
      trace_refs: ['logs/source/traces.jsonl'],
    },
  },
};

const candidate: Candidate = {
  candidate_id: 'candidate-1',
  owner: 'engineer-cat',
  candidate_type: 'skill',
  candidate_name: 'candidate-skill',
  artifact_ref: 'output/candidates/candidate-1.patch',
  artifact_fingerprint: 'a'.repeat(64),
  base_version: 'abc123',
};

function evaluation(status: 'pass' | 'fail' | 'blocked'): EvaluationResult {
  return {
    case_set_id: 'candidate-cases',
    runs_per_case: 1,
    outcomes: [{
      case_id: findingCase.case.case_id,
      run_id: 'run-1',
      status,
      trace_ref: 'logs/replay/traces.jsonl',
      reasons: [status],
      evidence_refs: ['logs/replay/traces.jsonl'],
      verifier_results: [],
    }],
    metrics: {
      total_runs: 1,
      pass_count: status === 'pass' ? 1 : 0,
      fail_count: status === 'fail' ? 1 : 0,
      blocked_count: status === 'blocked' ? 1 : 0,
      pass_rate: status === 'pass' ? 1 : 0,
      stability: 'stable',
      safety_violation_count: 0,
      total_latency_ms: 0,
      total_cost_usd: 0,
      total_tokens: 0,
    },
  };
}

describe('lightweight Evolution control DAG', () => {
  test('turns Trace into Case, reuses Test + Eval, and activates only for new Sessions', async () => {
    const calls: string[] = [];
    const result = await runEvolution({
      evolution_run_id: 'evolution-1',
      source: {
        type: 'trace',
        trace_refs: ['logs/source/traces.jsonl'],
      },
    }, {
      inspect: async () => {
        calls.push('inspector');
        return [findingCase];
      },
      change: async () => {
        calls.push('engineer-cat');
        return candidate;
      },
      test: async () => {
        calls.push('test');
        return { status: 'pass', evidence_refs: ['test.json'], reasons: [] };
      },
      evaluate: async () => {
        calls.push('eval');
        return evaluation('pass');
      },
      activateForNewSessions: async () => {
        calls.push('activate-next-session');
      },
    });

    assert.deepEqual(calls, [
      'inspector',
      'engineer-cat',
      'test',
      'eval',
      'activate-next-session',
    ]);
    assert.equal(result.attempts[0].activated, true);
  });

  test('a Case entry bypasses Inspector and failed Eval never activates', async () => {
    let inspectCalls = 0;
    let activationCalls = 0;
    const result = await runEvolution({
      evolution_run_id: 'evolution-2',
      source: {
        type: 'case',
        finding_case: findingCase,
      },
    }, {
      inspect: async () => {
        inspectCalls += 1;
        return [];
      },
      change: async () => ({
        ...candidate,
        owner: 'evolution-cat',
        artifact_ref: 'output/candidates/role-skill',
      }),
      test: async () => ({ status: 'pass', evidence_refs: [], reasons: [] }),
      evaluate: async () => evaluation('fail'),
      activateForNewSessions: async () => {
        activationCalls += 1;
      },
    });

    assert.equal(inspectCalls, 0);
    assert.equal(activationCalls, 0);
    assert.equal(result.attempts[0].activated, false);
    assert.deepEqual(result.attempts[0].reasons, ['fail']);
  });

  test('failed Test stops before Eval', async () => {
    let evalCalls = 0;
    const result = await runEvolution({
      evolution_run_id: 'evolution-3',
      source: { type: 'case', finding_case: findingCase },
    }, {
      inspect: async () => [],
      change: async () => candidate,
      test: async () => ({
        status: 'fail',
        evidence_refs: ['test.json'],
        reasons: ['implementation test failed'],
      }),
      evaluate: async () => {
        evalCalls += 1;
        return evaluation('pass');
      },
      activateForNewSessions: async () => undefined,
    });

    assert.equal(evalCalls, 0);
    assert.equal(result.attempts[0].activated, false);
    assert.deepEqual(result.attempts[0].reasons, ['implementation test failed']);
  });

  test('malformed or wrong-Case Evaluation coverage fails closed', async () => {
    const passEvaluation = evaluation('pass');
    const cases: Array<{
      name: string;
      value: EvaluationResult;
      reasons: string[];
    }> = [
      {
        name: 'missing outcomes array',
        value: {
          ...passEvaluation,
          outcomes: undefined,
        } as unknown as EvaluationResult,
        reasons: ['Candidate EvaluationResult requires an outcomes array'],
      },
      {
        name: 'empty outcomes',
        value: { ...passEvaluation, outcomes: [] },
        reasons: [
          `Candidate EvaluationResult has no outcomes for requested Case ${findingCase.case.case_id}`,
        ],
      },
      {
        name: 'only another Case',
        value: {
          ...passEvaluation,
          outcomes: passEvaluation.outcomes.map(outcome => ({
            ...outcome,
            case_id: 'case-undeclared',
          })),
        },
        reasons: [
          `Candidate EvaluationResult is missing requested Case ${findingCase.case.case_id}`,
          'Candidate EvaluationResult contains undeclared Cases: case-undeclared',
        ],
      },
      {
        name: 'requested plus undeclared Case',
        value: {
          ...passEvaluation,
          outcomes: [
            ...passEvaluation.outcomes,
            {
              ...passEvaluation.outcomes[0],
              case_id: 'case-undeclared',
              run_id: 'run-undeclared',
            },
          ],
        },
        reasons: ['Candidate EvaluationResult contains undeclared Cases: case-undeclared'],
      },
    ];

    for (const coverageCase of cases) {
      let activationCalls = 0;
      const result = await runEvolution({
        evolution_run_id: `evolution-${coverageCase.name}`,
        source: { type: 'case', finding_case: findingCase },
      }, {
        inspect: async () => [],
        change: async () => candidate,
        test: async () => ({ status: 'pass', evidence_refs: [], reasons: [] }),
        evaluate: async () => coverageCase.value,
        activateForNewSessions: async () => {
          activationCalls += 1;
        },
      });

      assert.equal(activationCalls, 0, coverageCase.name);
      assert.equal(result.attempts[0].activated, false, coverageCase.name);
      assert.deepEqual(result.attempts[0].reasons, coverageCase.reasons, coverageCase.name);
    }
  });
});
