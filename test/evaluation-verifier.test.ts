import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentCase, ReplayResult } from '../src/eval/evaluation';
import { verifyReplayTrace } from '../src/eval/verifier-registry';

describe('Evaluation hard verifier registry', () => {
  const evaluationCase: AgentCase = {
    case_id: 'case-1',
    task: 'Run a tool',
    oracle: {
      hard_verifiers: ['trace_exists', 'no_failed_tools'],
      semantic_criteria: ['The task is complete'],
    },
  };

  test('passes a non-empty Trace whose tool calls have successful terminal status', () => {
    const replay = writeTrace({
      assistant: {
        tool_calls: [{ name: 'read_file', status: 'success' }],
      },
    });
    const results = verifyReplayTrace({ case: evaluationCase, replay });
    assert.deepEqual(results.map(item => item.status), ['pass', 'pass']);
  });

  test('fails a structured tool failure and blocks an unknown verifier', () => {
    const replay = writeTrace({
      assistant: {
        tool_calls: [{ name: 'read_file', status: 'blocked', error_code: 'NOT_FOUND' }],
      },
    });
    const results = verifyReplayTrace({
      case: {
        ...evaluationCase,
        oracle: {
          ...evaluationCase.oracle,
          hard_verifiers: ['no_failed_tools', 'custom_verifier'],
        },
      },
      replay,
    });
    assert.equal(results[0].status, 'fail');
    assert.equal(results[1].status, 'blocked');
  });

  test('read_only_tools rejects writes and external side effects', () => {
    const replay = writeTrace({
      assistant: {
        tool_calls: [
          { name: 'read_file', status: 'success' },
          { name: 'send_text', status: 'success' },
        ],
      },
    });
    const results = verifyReplayTrace({
      case: {
        ...evaluationCase,
        oracle: {
          ...evaluationCase.oracle,
          hard_verifiers: ['read_only_tools'],
        },
      },
      replay,
    });
    assert.equal(results[0].status, 'fail');
    assert.deepEqual(results[0].safety_violations, ['send_text']);
  });
});

function writeTrace(row: unknown): ReplayResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-trace-'));
  const tracePath = path.join(root, 'traces.jsonl');
  fs.writeFileSync(tracePath, `${JSON.stringify(row)}\n`);
  return {
    run_id: 'run-1',
    case_id: 'case-1',
    status: 'completed',
    trace_ref: tracePath,
  };
}
