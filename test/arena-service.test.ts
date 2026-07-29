import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { FindingCase } from '../src/arena/arena-workflow';
import { runPreparedArena } from '../src/arena/arena-service';
import { EvaluationResult } from '../src/eval/evaluation';

describe('Arena shared service', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-arena-service-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('prepared clean runtime executes the lightweight workflow and persists one ArenaResult', async () => {
    const runId = 'prepared-shared-core';
    const runRoot = path.join(root, 'arena', 'runs', runId);
    const workspace = path.join(runRoot, 'workspace');
    const traceRef = path.join(workspace, 'logs', 'sessions', 'pet', 'trace.jsonl');
    fs.mkdirSync(path.dirname(traceRef), { recursive: true });
    fs.writeFileSync(traceRef, '{}\n', 'utf-8');
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(path.join(runRoot, 'clean-runtime.json'), JSON.stringify({
      version: 1,
      run_id: runId,
      subject_id: 'skill-demo',
      target_profile: {
        active_role_id: 'base',
        subject_skill_id: 'demo',
      },
      roots: {
        run_root: runRoot,
        workspace_root: workspace,
      },
    }), 'utf-8');

    const findingCase: FindingCase = {
      finding: {
        summary: 'The response lacked evidence.',
        evidence_refs: [traceRef],
      },
      case: {
        case_id: 'case-evidence',
        task: 'Complete the task with evidence.',
        oracle: {
          hard_verifiers: ['trace_exists'],
          semantic_criteria: ['Evidence is grounded.'],
        },
        source: {
          trace_refs: [traceRef],
        },
      },
    };
    let evaluateCalls = 0;
    const execution = await runPreparedArena({
      project_root: root,
      run_id: runId,
      scenario: 'Try the demo skill.',
      max_turns: 2,
      replay_attempts: 1,
    }, {
      proposeScenario: async () => {
        throw new Error('supplied Scenario should be used');
      },
      interact: async input => {
        assert.equal(input.subject.skill_id, 'demo');
        assert.equal(input.scenario.turn_budget, 2);
        return { trace_refs: [traceRef] };
      },
      inspect: async () => [findingCase],
      evaluate: async caseSet => {
        evaluateCalls += 1;
        assert.deepEqual(caseSet.cases[0].setup, {
          cwd: '.',
          required_active_skill_name: 'demo',
        });
        const result: EvaluationResult = {
          case_set_id: caseSet.case_set_id,
          runs_per_case: 1,
          outcomes: [{
            case_id: 'case-evidence',
            run_id: 'run-1',
            status: 'pass',
            trace_ref: traceRef,
            reasons: ['passed'],
            evidence_refs: [traceRef],
            verifier_results: [],
          }],
          metrics: {
            total_runs: 1,
            pass_count: 1,
            fail_count: 0,
            blocked_count: 0,
            pass_rate: 1,
            stability: 'stable',
            safety_violation_count: 0,
          },
        };
        return result;
      },
    });

    assert.equal(evaluateCalls, 1);
    assert.equal(execution.result.decision, 'pass');
    assert.equal(execution.result.evaluation?.case_set_id, `arena:${runId}`);
    assert.equal(execution.result_path, path.join(runRoot, 'arena-result.json'));
    assert.equal(fs.existsSync(execution.result_path), true);
    assert.equal(fs.existsSync(path.join(runRoot, 'arena-scorecard.json')), false);
  });
});
