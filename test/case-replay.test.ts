import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { createCaseReplayAdapter } from '../src/replay/case-replay';

describe('Case Replay adapter', () => {
  test('executes Case input and returns only a fresh Trace reference', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-case-replay-'));
    let capturedTrace = '';
    const replay = createCaseReplayAdapter({
      working_directory: root,
      run: async options => {
        capturedTrace = fs.readFileSync(options.tracePath, 'utf-8');
        return {
          replay_version: '0.1',
          run_id: 'fresh-run',
          generated_at: new Date().toISOString(),
          input_trace_path: options.tracePath,
          out_dir: options.outDir!,
          pet_id: 'xiaoba',
          session_key: 'pet:xiaoba:role-base:fresh',
          replayed_turns: 2,
          fresh_trace_path: path.join(root, 'logs', 'fresh', 'traces.jsonl'),
          artifacts: {
            manifest_path: 'manifest.json',
            extracted_inputs_path: 'extracted-inputs.json',
            replay_results_path: 'replay-results.json',
            comparison_path: 'comparison.json',
            report_path: 'report.md',
          },
          inputs: [],
          results: [
            {
              index: 1,
              sourceLine: 1,
              ok: false,
              durationMs: 12,
              text: '',
              textEventCount: 0,
              files: [],
              tools: [],
              eventCount: 0,
            },
          ],
          comparison: {
            oldTrace: emptyFacts(),
            newTrace: emptyFacts(),
            inputCountMatches: false,
            userInputsReplayed: false,
            slashCommandsMissingFromTrace: false,
            notes: ['legacy comparison failed'],
          },
        };
      },
    });

    const result = await replay({
      case: {
        case_id: 'delivery-case',
        task: 'Create the report.',
        setup: {
          follow_up_messages: ['Now send it to me.'],
        },
        oracle: {
          hard_verifiers: ['trace_exists'],
          semantic_criteria: ['The report is delivered.'],
        },
      },
      attempt: 1,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.trace_ref, path.join(root, 'logs', 'fresh', 'traces.jsonl'));
    assert.match(capturedTrace, /Create the report/);
    assert.match(capturedTrace, /Now send it to me/);
    assert.equal('decision' in result, false);
  });

  test('blocks when execution produces no fresh Trace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-case-replay-blocked-'));
    const replay = createCaseReplayAdapter({
      working_directory: root,
      run: async options => ({
        replay_version: '0.1',
        run_id: 'no-trace',
        generated_at: new Date().toISOString(),
        input_trace_path: options.tracePath,
        out_dir: options.outDir!,
        pet_id: 'xiaoba',
        session_key: 'pet:xiaoba:role-base:no-trace',
        replayed_turns: 1,
        artifacts: {
          manifest_path: 'manifest.json',
          extracted_inputs_path: 'extracted-inputs.json',
          replay_results_path: 'replay-results.json',
          comparison_path: 'comparison.json',
          report_path: 'report.md',
        },
        inputs: [],
        results: [],
        comparison: {
          oldTrace: emptyFacts(),
          newTrace: emptyFacts(),
          inputCountMatches: false,
          userInputsReplayed: false,
          slashCommandsMissingFromTrace: false,
          notes: [],
        },
      }),
    });

    const result = await replay({
      case: {
        case_id: 'blocked',
        task: 'Do the task.',
        oracle: {
          hard_verifiers: [],
          semantic_criteria: ['Done.'],
        },
      },
      attempt: 1,
    });
    assert.equal(result.status, 'blocked');
    assert.match(result.reason ?? '', /no fresh Trace/);
  });

  test('defaults production Replay to an isolated read-only child', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-case-replay-isolated-'));
    fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
    let captured: Record<string, unknown> = {};
    const replay = createCaseReplayAdapter({
      working_directory: path.join(root, 'workspace'),
      code_root: root,
      runIsolated: input => {
        captured = input;
        return {
          replay_version: '0.1',
          run_id: 'isolated',
          generated_at: new Date().toISOString(),
          input_trace_path: input.tracePath,
          out_dir: input.outDir,
          pet_id: 'xiaoba',
          session_key: input.sessionKey,
          replayed_turns: 1,
          fresh_trace_path: path.join(root, 'fresh-trace.jsonl'),
          artifacts: {
            manifest_path: 'manifest.json',
            extracted_inputs_path: 'extracted-inputs.json',
            replay_results_path: 'replay-results.json',
            comparison_path: 'comparison.json',
            report_path: 'report.md',
          },
          inputs: [],
          results: [],
          comparison: {
            oldTrace: emptyFacts(),
            newTrace: emptyFacts(),
            inputCountMatches: true,
            userInputsReplayed: true,
            slashCommandsMissingFromTrace: false,
            notes: [],
          },
        };
      },
    });
    const result = await replay({
      case: {
        case_id: 'isolated-read',
        task: 'Inspect package.json.',
        setup: {
          session_key: 'pet:xiaoba:role-engineer-cat',
          required_active_skill_name: 'audit',
        },
        oracle: {
          hard_verifiers: ['trace_exists'],
          semantic_criteria: ['Grounded answer'],
        },
      },
      attempt: 1,
    });

    assert.equal(result.status, 'completed');
    assert.equal(captured.sandboxMode, 'read_only');
    assert.equal(captured.targetRole, 'engineer-cat');
    assert.equal(captured.requiredActiveSkillName, 'audit');
    assert.equal(captured.codeRoot, root);
  });

  test('blocks workspace_write before execution outside a clean-runtime sandbox', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-case-replay-write-block-'));
    delete process.env.XIAOBA_ARENA_SANDBOXED;
    let called = false;
    const replay = createCaseReplayAdapter({
      working_directory: root,
      run: async () => {
        called = true;
        throw new Error('must not run');
      },
    });
    const result = await replay({
      case: {
        case_id: 'write-blocked',
        task: 'Modify a file.',
        setup: { sandbox: 'workspace_write' },
        oracle: {
          hard_verifiers: [],
          semantic_criteria: ['The file is modified'],
        },
      },
      attempt: 1,
    });
    assert.equal(result.status, 'blocked');
    assert.match(result.reason ?? '', /requires an enforced clean-runtime sandbox/);
    assert.equal(called, false);
  });
});

function emptyFacts() {
  return {
    traceCount: 0,
    userTexts: [],
    toolCounts: {},
    deliveryEvidenceCount: 0,
    visibleCompletedCount: 0,
    finalVisibleCount: 0,
    failedTools: [],
  };
}
