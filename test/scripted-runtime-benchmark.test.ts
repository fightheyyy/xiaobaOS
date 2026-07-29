import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertScriptedRuntimeTestSet,
  loadScriptedRuntimeTestSet,
  runScriptedRuntimeTestBenchmark,
  writeScriptedRuntimeTestBenchmarkResult,
} from '../src/testing';

describe('Scripted Runtime Test set', () => {
  test('loads the BaseRuntime test groups', () => {
    const benchmark = loadScriptedRuntimeTestSet(
      path.resolve('test/scripted-runtime/base-runtime/benchmark.json'),
    );

    assert.equal(benchmark.benchmark_id, 'base-runtime');
    assert.equal(benchmark.name, 'BaseRuntime Scripted Runtime Test');
    assert.equal(benchmark.case_jsonl, 'runtime-benchmark.jsonl');
    assert.equal(benchmark.cases.length, 11);
    assert.ok(benchmark.cases.every(item => item.eval_case_ids && item.eval_case_ids.length > 0));
    assert.ok(benchmark.cases.some(item => item.case_id === 'base-runtime.im-coding-patch'));
    assert.ok(benchmark.cases.some(item => item.case_id === 'base-runtime.im-subagent-goal'));
    assert.ok(benchmark.cases.some(item => item.case_id === 'base-runtime.trace-derived.artifact-locator'));
    assert.ok(!benchmark.cases.some(item => item.case_id.startsWith('eval-smoke.')));
  });

  test('runs a lightweight synthetic benchmark and writes aggregate artifacts', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-benchmark-bridge-'));
    const casesDir = path.join(tempDir, 'cases');
    const suitesDir = path.join(tempDir, 'suites');
    const outDir = path.join(tempDir, 'out');
    fs.mkdirSync(casesDir, { recursive: true });
    fs.mkdirSync(suitesDir, { recursive: true });

    fs.writeFileSync(path.join(suitesDir, 'synthetic.json'), `${JSON.stringify({
      suite_id: 'synthetic-bridge-suite',
      name: 'Synthetic Bridge Suite',
      version: '0.1',
      cases: [
        {
          case_id: 'synthetic.pass.001',
          name: 'synthetic pass',
          lane: 'contract_sentinel',
          target_module: 'runtime',
          risk_level: 'low',
          replay: {
            mode: 'surface_runtime',
            surface: 'pet',
            capture_internal_trace: true,
            user_message: 'Create a tiny live benchmark report.',
            surface_turns: [
              {
                user_message: 'Create a tiny live benchmark report.',
                surface_event: {
                  event_id: 'pet-synthetic-bridge-001',
                  event_type: 'pet.message',
                  user_ref: 'pet:alpha-puff:synthetic-bridge',
                  raw: {
                    sessionKey: 'pet:alpha-puff:role-base:synthetic-bridge',
                  },
                },
              },
            ],
            model_responses: [
              {
                tool_calls: [
                  {
                    id: 'call-1',
                    name: 'send_text',
                    arguments: {
                      text: 'Tiny report ready.',
                    },
                  },
                ],
                usage: {
                  prompt_tokens: 100,
                  completion_tokens: 20,
                },
              },
              {
                content: '',
                usage: {
                  prompt_tokens: 120,
                  completion_tokens: 0,
                },
              },
            ],
          },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            { id: 'tool_transcript_completeness' },
            { id: 'tool_result_contract' },
            { id: 'surface_runtime_e2e', config: {
              expected_surface: 'pet',
              expected_runtime_id: 'pet_channel_router',
              expected_status_code: 200,
              expected_session_key: 'pet:alpha-puff:role-base:synthetic-bridge',
              expected_channel_id: 'pet:alpha-puff:role-base:synthetic-bridge',
              required_event_types: ['user_message', 'tool_start', 'tool_end', 'text', 'done'],
              user_message_contains: ['tiny live benchmark report'],
              min_visible_deliveries: 1,
            } },
            { id: 'channel_delivery', config: {
              min_deliveries: 1,
              min_text_deliveries: 1,
              required_texts: ['Tiny report ready'],
            } },
            {
              id: 'tool_sequence',
              config: {
                names: ['send_text'],
              },
            },
            {
              id: 'assistant_text_contains',
              config: {
                text: 'Tiny report ready',
                include_delivery_tools: true,
              },
            },
          ],
          failure_route: 'runtime',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    fs.writeFileSync(path.join(casesDir, 'synthetic.case.json'), `${JSON.stringify({
      case_id: 'synthetic.bridge',
      name: 'Synthetic bridge',
      lane: 'contract_sentinel',
      target_module: 'runtime',
      risk_level: 'low',
      eval_suite: 'suites/synthetic.json',
      eval_case_ids: ['synthetic.pass.001'],
      expected_decision: 'pass',
      failure_route: 'runtime',
      benchmark_case_kind: 'live_pet_runtime_case',
      raw_user_text_included: false,
      task_prompt: 'The user asks for a tiny report, and the replay must deliver it through the Pet surface runtime.',
      verifier_ids: [
        'jsonl_parse',
        'tool_transcript_completeness',
        'tool_result_contract',
        'surface_runtime_e2e',
        'channel_delivery',
        'tool_sequence',
        'assistant_text_contains',
      ],
      replay_modes: ['surface_runtime_pet'],
    }, null, 2)}\n`, 'utf-8');

    const benchmarkPath = path.join(tempDir, 'benchmark.json');
    fs.writeFileSync(benchmarkPath, `${JSON.stringify({
      benchmark_id: 'synthetic-bridge',
      name: 'Synthetic Bridge Benchmark',
      version: '0.1',
      case_files: ['cases/synthetic.case.json'],
      decision_policy: {
        fail_on_any_case_failure: true,
        min_pass_rate: 1,
      },
    }, null, 2)}\n`, 'utf-8');

    const scorecard = writeScriptedRuntimeTestBenchmarkResult(
      await runScriptedRuntimeTestBenchmark({
      benchmarkPath,
      outDir,
      now: new Date('2026-05-31T00:00:00.000Z'),
      }),
    );

    assert.equal(scorecard.summary.decision, 'pass');
    assert.equal(scorecard.summary.benchmark_cases_total, 1);
    assert.equal(scorecard.summary.eval_cases_total, 1);
    assert.equal(scorecard.summary.hard_failures, 0);
    assert.deepEqual(scorecard.cases.map(item => item.case_id), ['synthetic.bridge']);
    assert.ok(fs.existsSync(path.join(outDir, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(outDir, 'test-result.json')));
    assert.ok(fs.existsSync(path.join(outDir, 'report.md')));
    assert.ok(fs.existsSync(path.join(outDir, 'suites', 'synthetic.bridge', 'test-result.json')));
  });

  test('rejects scripted Pet cases with invalid session keys during preflight', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-benchmark-invalid-pet-'));
    const casesDir = path.join(tempDir, 'cases');
    const suitesDir = path.join(tempDir, 'suites');
    fs.mkdirSync(casesDir, { recursive: true });
    fs.mkdirSync(suitesDir, { recursive: true });

    fs.writeFileSync(path.join(suitesDir, 'invalid-pet.json'), `${JSON.stringify({
      suite_id: 'invalid-pet-suite',
      name: 'Invalid Pet Suite',
      version: '0.1',
      cases: [
        {
          case_id: 'invalid-pet.001',
          name: 'invalid pet session key',
          lane: 'contract_sentinel',
          target_module: 'runtime',
          risk_level: 'low',
          replay: {
            mode: 'surface_runtime',
            surface: 'pet',
            user_message: 'hello',
            surface_event: {
              event_id: 'pet-invalid-session-key-001',
              event_type: 'pet.message',
              raw: {
                sessionKey: 'pet:alpha-puff:not-role-session',
              },
            },
            model_responses: [
              { content: 'hello' },
            ],
          },
          hard_verifiers: [
            { id: 'surface_runtime_e2e' },
          ],
          failure_route: 'runtime',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    fs.writeFileSync(path.join(casesDir, 'invalid-pet.case.json'), `${JSON.stringify({
      case_id: 'invalid-pet.bridge',
      name: 'Invalid Pet bridge',
      lane: 'contract_sentinel',
      target_module: 'runtime',
      risk_level: 'low',
      eval_suite: 'suites/invalid-pet.json',
      eval_case_ids: ['invalid-pet.001'],
      expected_decision: 'pass',
      failure_route: 'runtime',
      benchmark_case_kind: 'live_pet_runtime_case',
      raw_user_text_included: false,
      task_prompt: 'Validate Pet surface payloads before the Scripted Runtime Test.',
      verifier_ids: ['surface_runtime_e2e'],
      replay_modes: ['surface_runtime_pet'],
    }, null, 2)}\n`, 'utf-8');

    const benchmarkPath = path.join(tempDir, 'benchmark.json');
    const benchmark = {
      benchmark_id: 'invalid-pet-bridge',
      name: 'Invalid Pet Bridge Benchmark',
      version: '0.1',
      case_files: ['cases/invalid-pet.case.json'],
    };
    fs.writeFileSync(benchmarkPath, `${JSON.stringify(benchmark, null, 2)}\n`, 'utf-8');

    assert.throws(
      () => assertScriptedRuntimeTestSet(
        loadScriptedRuntimeTestSet(benchmarkPath),
        benchmarkPath,
      ),
      /invalid pet surface payload: invalid-pet\.001 turn 1 .*invalid pet session key/,
    );
  });
});
