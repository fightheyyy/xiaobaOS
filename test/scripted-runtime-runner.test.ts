import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  loadScriptedRuntimeTestSuite,
  runScriptedRuntimeTestSuite,
  writeScriptedRuntimeTestResult,
} from '../src/testing';

describe('scripted runtime test runner', () => {
  test('runs the contract sentinel test set and writes result artifacts', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-'));
    const scorecard = writeScriptedRuntimeTestResult(await runScriptedRuntimeTestSuite({
      suitePath: path.resolve('test/contract-smoke/suites/contract-sentinel.json'),
      outDir,
      now: new Date('2026-05-31T00:00:00.000Z'),
    }));

    assert.equal(scorecard.summary.decision, 'pass');
    assert.equal(scorecard.summary.cases_total, 9);
    assert.equal(scorecard.summary.hard_failures, 0);
    assert.equal(scorecard.summary.required_artifact_failures, 0);
    assert.equal(scorecard.summary.pass_rate, 1);
    assert.ok(scorecard.cases.every(item => item.decision === 'pass'));
    assert.ok(fs.existsSync(path.join(outDir, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(outDir, 'test-result.json')));
    assert.ok(fs.existsSync(path.join(outDir, 'report.md')));

    const report = fs.readFileSync(path.join(outDir, 'report.md'), 'utf-8');
    const persistedScorecard = fs.readFileSync(path.join(outDir, 'test-result.json'), 'utf-8');
    assert.ok(report.includes('Scripted Runtime Test Report: Contract Sentinel'));
    assert.ok(persistedScorecard.includes('"suite_path":'));
    assert.ok(scorecard.cases.some(item =>
      item.case_id === 'contract.role-artifact-evidence.001'
      && item.verifier_results.some(result => result.id === 'artifact_evidence' && result.status === 'pass')
    ));
    assert.ok(scorecard.cases.some(item =>
      item.case_id === 'contract.tool-owned-artifact-evidence.001'
      && item.verifier_results.some(result => result.id === 'artifact_evidence' && result.status === 'pass')
    ));
    assert.ok(scorecard.cases.some(item =>
      item.case_id === 'contract.role-tool-owned-artifact-evidence.001'
      && item.verifier_results.some(result => result.id === 'artifact_evidence' && result.status === 'pass')
    ));
    assert.ok(scorecard.cases.some(item =>
      item.case_id === 'contract.state-boundary.001'
      && item.verifier_results.some(result => result.id === 'state_boundary_contract' && result.status === 'pass')
      && item.verifier_results.some(result => result.id === 'provider_transcript_normalization' && result.status === 'pass')
    ));
    assert.ok(scorecard.cases.some(item =>
      item.case_id === 'contract.provider-transcript-degradation.001'
      && item.verifier_results.some(result => result.id === 'provider_transcript_normalization' && result.status === 'pass')
      && item.verifier_results.some(result => result.id === 'provider_transcript_degradation' && result.status === 'pass')
    ));
    assert.ok(scorecard.cases.some(item =>
      item.case_id === 'contract.provider-network-readiness-blocked.001'
      && item.verifier_results.some(result => result.id === 'provider_network_readiness_contract' && result.status === 'pass')
    ));
    assert.ok(scorecard.cases.some(item =>
      item.case_id === 'contract.provider-network-readiness-pass.001'
      && item.verifier_results.some(result => result.id === 'provider_network_readiness_contract' && result.status === 'pass')
    ));
    assert.ok(scorecard.cases.some(item =>
      item.case_id === 'contract.runtime-evidence.001'
      && item.verifier_results.some(result => result.id === 'tool_result_contract' && result.status === 'pass')
    ));
  });

  test('provider-network readiness verifier fails missing session evidence', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-provider-readiness-fail-'));
    const artifactsDir = path.join(tempDir, 'artifacts');
    const suitePath = path.join(tempDir, 'suite.json');
    fs.cpSync(path.resolve('test/contract-smoke/fixtures/contract-sentinel/provider-network-readiness-pass'), artifactsDir, { recursive: true });
    fs.rmSync(path.join(artifactsDir, 'logs'), { recursive: true, force: true });
    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'provider-network-readiness-fail',
      name: 'Provider Network Readiness Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'provider-readiness.fail.001',
          name: 'provider readiness fail',
          lane: 'contract_sentinel',
          target_module: 'state_evidence',
          risk_level: 'release_blocking',
          inputs: { artifacts_dir: './artifacts' },
          hard_verifiers: [
            {
              id: 'provider_network_readiness_contract',
              config: {
                scorecard_path: 'scorecard.json',
                allowed_decisions: ['pass', 'fail', 'blocked'],
                require_degradation_verified: true,
                require_session_log_evidence: true,
              },
            },
          ],
          failure_route: 'state_evidence',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-06-05T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    const verifier = scorecard.cases[0].verifier_results.find(item => item.id === 'provider_network_readiness_contract');
    assert.equal(verifier?.status, 'fail');
    assert.match(verifier?.message ?? '', /session log evidence file not found/);
  });

  test('artifact evidence strict config requires manifest provenance metadata', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-artifact-strict-config-'));
    const fixturePath = path.join(tempDir, 'trace.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');

    fs.writeFileSync(fixturePath, `${JSON.stringify({
      schema_version: 2,
      entry_type: 'turn',
      turn: 1,
      user: { text: 'write the final report' },
      assistant: {
        text: 'Report written.',
        tool_calls: [
          {
            tool_call_id: 'artifact-write',
            name: 'write_file',
            arguments: { path: 'report.md' },
            result: 'created report.md',
            status: 'success',
            artifact_manifest: [
              {
                path: 'report.md',
                type: 'md',
                action: 'created',
                metadata: { source: 'tool_owned' },
              },
            ],
          },
        ],
      },
      tokens: { prompt: 10, completion: 10 },
    })}\n`, 'utf-8');

    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'artifact-strict-config',
      name: 'Artifact Strict Config',
      version: '0.1',
      cases: [
        {
          case_id: 'artifact.strict-config.001',
          name: 'artifact strict config',
          lane: 'contract_sentinel',
          target_module: 'state_evidence',
          risk_level: 'release_blocking',
          inputs: {
            jsonl: './trace.jsonl',
          },
          required_artifacts: [
            {
              path: 'report.md',
              type: 'md',
              action: 'created',
              evidence: 'manifest',
            },
          ],
          hard_verifiers: [
            { id: 'jsonl_parse' },
            {
              id: 'artifact_evidence',
              config: {
                require_manifest_evidence: true,
                required_metadata_keys: ['source'],
                min_required_artifacts: 1,
              },
            },
          ],
          failure_route: 'state_evidence',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-06-05T00:00:00.000Z'),
    });

    const artifactResult = scorecard.cases[0].verifier_results.find(item => item.id === 'artifact_evidence');
    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].decision, 'fail');
    assert.ok(artifactResult);
    assert.equal(artifactResult.status, 'fail');
    assert.match(artifactResult.message, /metadata\.source/);
  });

  test('runtime observability does not treat zero failure counters as tool failures', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-runtime-observability-'));
    const fixturePath = path.join(tempDir, 'zero-failures.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');

    fs.writeFileSync(fixturePath, `${JSON.stringify({
      schema_version: 2,
      entry_type: 'turn',
      turn: 1,
      user: { text: 'show aggregate status' },
      assistant: {
        text: 'All workers are observable.',
        tool_calls: [
          {
            tool_call_id: 'aggregate-status',
            name: 'worker_pool_status',
            arguments: { supervisor_id: 'zero-failures' },
            result: [
              'worker_pool: status=running',
              'running=1',
              'queued=0',
              'completed=2',
              'failed=0',
              'blocked=0',
              'cancelled=0',
            ].join('\n'),
            status: 'success',
          },
        ],
      },
      tokens: { prompt: 10, completion: 10 },
    })}\n`, 'utf-8');

    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'runtime-observability-zero-counters',
      name: 'Runtime Observability Zero Counters',
      version: '0.1',
      cases: [
        {
          case_id: 'runtime.zero-counters.001',
          name: 'zero counters are not failures',
          lane: 'contract_sentinel',
          target_module: 'runtime',
          risk_level: 'high',
          inputs: { jsonl: './zero-failures.jsonl' },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            { id: 'tool_transcript_completeness' },
            { id: 'runtime_observability' },
          ],
          failure_route: 'runtime',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-06-03T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'pass');
    assert.equal(scorecard.summary.hard_failures, 0);
    assert.equal(scorecard.cases[0].metrics.failed_tool_calls, 0);
    assert.ok(scorecard.cases[0].verifier_results.some(item => {
      return item.id === 'runtime_observability' && item.status === 'pass';
    }));
  });

  test('runtime observability does not treat success domain status text as tool failure', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-domain-status-'));
    const fixturePath = path.join(tempDir, 'domain-status.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');

    fs.writeFileSync(fixturePath, `${JSON.stringify({
      schema_version: 2,
      entry_type: 'turn',
      turn: 1,
      user: { text: 'show task status' },
      assistant: {
        text: 'Task status read successfully.',
        tool_calls: [
          {
            tool_call_id: 'task-status',
            name: 'case_validation_status',
            arguments: { task_id: 'task-1' },
            result: [
              'case_validation: running=false status=failed',
              'validation_status=failed',
              'error=validation_failed',
            ].join('\n'),
            status: 'success',
          },
        ],
      },
      tokens: { prompt: 10, completion: 10 },
    })}\n`, 'utf-8');

    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'runtime-observability-domain-status',
      name: 'Runtime Observability Domain Status',
      version: '0.1',
      cases: [
        {
          case_id: 'runtime.domain-status.001',
          name: 'domain failed status is not tool execution failure',
          lane: 'contract_sentinel',
          target_module: 'runtime',
          risk_level: 'high',
          inputs: { jsonl: './domain-status.jsonl' },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            { id: 'tool_transcript_completeness' },
            { id: 'tool_result_contract' },
            { id: 'runtime_observability' },
          ],
          failure_route: 'runtime',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-06-04T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'pass');
    assert.equal(scorecard.summary.hard_failures, 0);
    assert.equal(scorecard.cases[0].metrics.failed_tool_calls, 0);
    assert.ok(scorecard.cases[0].verifier_results.some(item => (
      item.id === 'runtime_observability'
      && item.status === 'pass'
    )));
  });

  test('tool result contract fails when result text lacks terminal status', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-tool-result-contract-'));
    const fixturePath = path.join(tempDir, 'missing-status.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');

    fs.writeFileSync(fixturePath, `${JSON.stringify({
      schema_version: 2,
      entry_type: 'turn',
      turn: 1,
      turn_id: 'tool-result.missing-status.001.turn.1',
      timestamp: '2026-06-04T00:00:00.000Z',
      session_id: 'eval:tool-result-contract',
      session_type: 'eval',
      user: { text: 'read README' },
      assistant: {
        text: 'Read complete.',
        tool_calls: [
          {
            id: 'call-read-missing-status',
            tool_call_id: 'call-read-missing-status',
            name: 'read_file',
            arguments: { file_path: 'README.md' },
            result: 'read ok',
          },
        ],
      },
      tokens: { prompt: 20, completion: 8 },
    })}\n`, 'utf-8');
    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'tool-result-contract-fail',
      name: 'Tool Result Contract Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'tool-result.missing-status.001',
          name: 'tool result missing status',
          lane: 'contract_sentinel',
          target_module: 'runtime',
          risk_level: 'release_blocking',
          inputs: { jsonl: fixturePath },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            { id: 'tool_transcript_completeness' },
            { id: 'tool_result_contract' },
          ],
          failure_route: 'runtime',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-06-04T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'runtime');
    assert.ok(scorecard.cases[0].verifier_results.some(item => (
      item.id === 'tool_result_contract'
      && item.status === 'fail'
      && item.message.includes('missing status')
    )));
  });

  test('CLI writes a passing Scripted Runtime Test result', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-cli-'));
    const output = execFileSync('npx', [
      'tsx',
      'scripts/run-test-suite.ts',
      '--suite',
      'test/contract-smoke/suites/contract-sentinel.json',
      '--out',
      outDir,
    ], {
      encoding: 'utf-8',
    });

    assert.ok(output.includes('Scripted Runtime Test complete: pass'));
    const result = JSON.parse(fs.readFileSync(path.join(outDir, 'test-result.json'), 'utf-8'));
    assert.equal(result.summary.decision, 'pass');
  });

  test('CLI can target a single test case', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-cli-case-'));
    const output = execFileSync('npx', [
      'tsx',
      'scripts/run-test-suite.ts',
      '--suite',
      'test/contract-smoke/suites/contract-sentinel.json',
      '--case',
      'contract.jsonl-compatibility.001',
      '--out',
      outDir,
    ], {
      encoding: 'utf-8',
    });

    assert.ok(output.includes('cases=1/1 passed'));
    const result = JSON.parse(fs.readFileSync(path.join(outDir, 'test-result.json'), 'utf-8'));
    assert.equal(result.summary.decision, 'pass');
    assert.equal(result.summary.cases_total, 1);
    assert.equal(result.cases[0].case_id, 'contract.jsonl-compatibility.001');
  });

  test('Research Board quality verifier fails incomplete board state', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-researcher-board-quality-fail-'));
    const artifactDir = path.join(tempDir, 'artifacts');
    const boardDir = path.join(artifactDir, 'data', 'researcher-cat', 'boards', 'bad-board');
    const markdownDir = path.join(artifactDir, 'output', 'researcher-cat', 'boards', 'bad-board');
    fs.mkdirSync(boardDir, { recursive: true });
    fs.mkdirSync(markdownDir, { recursive: true });
    fs.writeFileSync(path.join(boardDir, 'board.json'), `${JSON.stringify({
      schema_version: 1,
      project: 'Bad Board',
      project_slug: 'bad-board',
      project_goal: 'claim unsupported research result',
      current_storyline: 'unsupported result is ready',
      claim_board: [
        {
          id: 'claim-1',
          claim: 'unsupported result is proven',
          status: 'supported',
          evidence: [],
        },
      ],
      evidence_board: [],
      experiment_queue: [],
      artifact_board: [
        {
          id: 'artifact-1',
          path: '/absolute/private/result.pdf',
          status: 'completed',
          evidence: [],
        },
      ],
      risk_board: [],
      handoffs: [],
      next_actions: [],
      run_registry: [],
    }, null, 2)}\n`, 'utf-8');
    fs.writeFileSync(path.join(markdownDir, 'research-board.md'), '# Bad Board\n', 'utf-8');

    const suitePath = path.join(tempDir, 'suite.json');
    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'research-board-quality-fail',
      name: 'Research Board Quality Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'research-board.quality.fail.001',
          name: 'incomplete board fails',
          lane: 'requirement_acceptance',
          target_module: 'state_evidence',
          risk_level: 'release_blocking',
          inputs: {
            artifacts_dir: './artifacts',
          },
          hard_verifiers: [
            {
              id: 'research_board_quality',
              config: {
                project_slug: 'bad-board',
                min_claims: 1,
                min_evidence: 1,
                min_experiments: 1,
                min_handoffs: 1,
                min_next_actions: 1,
                min_runs: 1,
                required_claim_statuses: ['unsupported'],
                required_handoff_roles: ['reviewer-cat'],
                require_unsupported_claim: true,
              },
            },
          ],
          failure_route: 'state_evidence',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-06-03T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].decision, 'fail');
    const verifier = scorecard.cases[0].verifier_results.find(result => result.id === 'research_board_quality');
    assert.equal(verifier?.status, 'fail');
    assert.match(verifier?.message ?? '', /supported claims lack evidence|missing claim statuses|not workspace-relative/);
  });

  test('Research Board reviewer semantic verifier fails final acceptance and unverified delivery artifacts', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-researcher-board-semantic-fail-'));
    const artifactDir = path.join(tempDir, 'artifacts');
    const boardDir = path.join(artifactDir, 'data', 'researcher-cat', 'boards', 'bad-semantic-board');
    const markdownDir = path.join(artifactDir, 'output', 'researcher-cat', 'boards', 'bad-semantic-board');
    fs.mkdirSync(boardDir, { recursive: true });
    fs.mkdirSync(markdownDir, { recursive: true });
    fs.writeFileSync(path.join(boardDir, 'board.json'), `${JSON.stringify({
      schema_version: 1,
      project: 'Bad Semantic Board',
      project_slug: 'bad-semantic-board',
      project_goal: 'send the final submission package',
      current_storyline: 'everything is done and the package is ready to send',
      claim_board: [
        {
          id: 'claim-1',
          claim: 'submission package is accepted',
          status: 'supported',
          evidence: ['delivery/submission.pdf'],
        },
      ],
      evidence_board: [
        {
          id: 'evidence-1',
          text: 'submission.pdf exists',
          status: 'supported',
          evidence: ['delivery/submission.pdf'],
        },
      ],
      experiment_queue: [
        {
          id: 'experiment-1',
          text: 'no experiment needed',
          status: 'completed',
          evidence: ['results/final.json'],
        },
      ],
      artifact_board: [
        {
          id: 'artifact-1',
          path: 'delivery/submission.pdf',
          type: 'pdf',
          status: 'completed',
          note: 'ready to send',
          evidence: ['delivery/submission.pdf'],
        },
      ],
      risk_board: [
        {
          id: 'risk-1',
          text: 'no residual risk',
          status: 'closed',
          evidence: ['delivery/submission.pdf'],
        },
      ],
      handoffs: [
        {
          id: 'handoff-1',
          target_role: 'engineer-cat',
          reason: 'send file',
          status: 'completed',
          evidence: ['delivery/submission.pdf'],
        },
      ],
      next_actions: ['Send the package'],
      run_registry: [
        {
          run_id: 'final-package',
          method: 'manual',
          split: 'n/a',
          seed: 'n/a',
          status: 'completed',
          log_path: 'logs/final.log',
          output_path: 'delivery/submission.pdf',
          manuscript_target: 'submission',
          evidence: ['delivery/submission.pdf'],
        },
      ],
    }, null, 2)}\n`, 'utf-8');
    fs.writeFileSync(path.join(markdownDir, 'research-board.md'), '# Bad Semantic Board\nEverything is done and ready to send.\n', 'utf-8');

    const suitePath = path.join(tempDir, 'suite.json');
    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'research-board-semantic-fail',
      name: 'Research Board Semantic Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'research-board.semantic.fail.001',
          name: 'semantic board fails',
          lane: 'requirement_acceptance',
          target_module: 'state_evidence',
          risk_level: 'release_blocking',
          inputs: {
            artifacts_dir: './artifacts',
          },
          hard_verifiers: [
            {
              id: 'research_board_reviewer_semantic',
              config: {
                project_slug: 'bad-semantic-board',
                min_score: 0.9,
                require_delivery_artifact_blockers: true,
                delivery_artifact_paths: ['delivery/submission.pdf'],
              },
            },
          ],
          failure_route: 'state_evidence',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-06-03T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].decision, 'fail');
    const verifier = scorecard.cases[0].verifier_results.find(result => result.id === 'research_board_reviewer_semantic');
    assert.equal(verifier?.status, 'fail');
    assert.match(verifier?.message ?? '', /reviewer semantic score|forbidden final acceptance|delivery status/);
  });

  test('skill activation contract fails when system prompt evidence is missing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-skill-fail-'));
    const fixturePath = path.join(tempDir, 'skill.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');

    fs.writeFileSync(fixturePath, `${JSON.stringify({
      schema_version: 2,
      entry_type: 'turn',
      turn: 1,
      assistant: {
        text: 'audit-skill was mentioned but no system prompt evidence was captured',
        tool_calls: [
          {
            id: 'skill-call-1',
            tool_call_id: 'skill-call-1',
            name: 'skill',
            arguments: { name: 'audit-skill' },
            result: JSON.stringify({
              __type__: 'skill_activation',
              skillName: 'audit-skill',
              prompt: 'Audit mode: inspect runtime evidence.',
            }),
            status: 'success',
          },
        ],
      },
      tokens: { prompt: 10, completion: 10 },
    })}\n`, 'utf-8');

    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'skill-fail',
      name: 'Skill Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'skill.fail.001',
          name: 'skill fail',
          lane: 'requirement_acceptance',
          target_module: 'skill',
          risk_level: 'release_blocking',
          inputs: { jsonl: './skill.jsonl' },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            {
              id: 'skill_activation_contract',
              config: {
                required_skills: ['audit-skill'],
                required_system_prompt_texts: ['Audit mode'],
                min_activation_tool_calls: 1,
              },
            },
          ],
          failure_route: 'skill',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-05-31T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'skill');
    assert.ok(scorecard.cases[0].verifier_results.some(item => item.id === 'skill_activation_contract' && item.status === 'fail'));
  });

  test('cross-skill handoff fails when handoff edge and final artifact are missing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-skill-handoff-fail-'));
    const fixturePath = path.join(tempDir, 'skill-handoff.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');

    fs.writeFileSync(fixturePath, [
      JSON.stringify({
        schema_version: 2,
        entry_type: 'turn',
        turn: 1,
        skill_activations: [
          {
            skill_name: 'log-triage-skill',
            prompt: 'Triage mode',
            system_prompt_count: 1,
            source: 'system_prompt',
          },
        ],
        skill_handoffs: [
          {
            from_skill: 'log-triage-skill',
            to_skill: 'patch-plan-skill',
            case_id: 'skill-handoff.fail.001',
            artifacts: ['triage-note.md'],
          },
        ],
        assistant: { text: 'Only the first handoff exists.', tool_calls: [] },
        tokens: { prompt: 10, completion: 10 },
      }),
      JSON.stringify({
        schema_version: 2,
        entry_type: 'turn',
        turn: 2,
        skill_activations: [
          {
            skill_name: 'patch-plan-skill',
            prompt: 'Planning mode',
            system_prompt_count: 1,
            source: 'system_prompt',
          },
        ],
        assistant: { text: 'Plan exists but no review handoff or final artifact exists.', tool_calls: [] },
        tokens: { prompt: 10, completion: 10 },
      }),
    ].join('\n') + '\n', 'utf-8');

    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'skill-handoff-fail',
      name: 'Skill Handoff Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'skill-handoff.fail.001',
          name: 'skill handoff fail',
          lane: 'requirement_acceptance',
          target_module: 'skill',
          risk_level: 'release_blocking',
          inputs: { jsonl: './skill-handoff.jsonl' },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            {
              id: 'cross_skill_handoff',
              config: {
                required_case_id: 'skill-handoff.fail.001',
                required_skill_sequence: [
                  'log-triage-skill',
                  'patch-plan-skill',
                  'review-evidence-skill',
                ],
                required_handoffs: [
                  {
                    from_skill: 'log-triage-skill',
                    to_skill: 'patch-plan-skill',
                    case_id: 'skill-handoff.fail.001',
                  },
                  {
                    from_skill: 'patch-plan-skill',
                    to_skill: 'review-evidence-skill',
                    case_id: 'skill-handoff.fail.001',
                  },
                ],
                expected_final_artifact: 'skill-handoff-scorecard.json',
              },
            },
          ],
          failure_route: 'skill',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-05-31T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'skill');
    assert.ok(scorecard.cases[0].verifier_results.some(item => item.id === 'cross_skill_handoff' && item.status === 'fail'));
  });

  test('provider error fallback verifier fails when fallback evidence is missing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-provider-fail-'));
    const fixturePath = path.join(tempDir, 'provider.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');

    fs.writeFileSync(fixturePath, [
      JSON.stringify({
        schema_version: 2,
        entry_type: 'runtime_event',
        event_type: 'provider_error',
        session_id: 'eval:provider.fail.001',
        provider_error: { error_code: 'MODEL_RATE_LIMIT' },
      }),
      JSON.stringify({
        schema_version: 2,
        entry_type: 'turn',
        turn: 1,
        assistant: { text: 'Continuing as if nothing happened.', tool_calls: [] },
        tokens: { prompt: 10, completion: 10 },
      }),
    ].join('\n') + '\n', 'utf-8');

    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'provider-fallback-fail',
      name: 'Provider Fallback Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'provider.fail.001',
          name: 'provider fail',
          lane: 'contract_sentinel',
          target_module: 'provider',
          risk_level: 'release_blocking',
          inputs: { jsonl: './provider.jsonl' },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            {
              id: 'provider_error_fallback',
              config: {
                provider_error_terms: ['provider_error', 'MODEL_RATE_LIMIT'],
                fallback_terms: ['fallback', 'blocked'],
              },
            },
          ],
          failure_route: 'provider',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-05-31T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'provider');
    assert.ok(scorecard.cases[0].verifier_results.some(item => item.id === 'provider_error_fallback' && item.status === 'fail'));
  });

  test('provider error fallback verifier fails when required retry budget evidence is missing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-provider-budget-fail-'));
    const fixturePath = path.join(tempDir, 'provider.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');

    fs.writeFileSync(fixturePath, [
      JSON.stringify({
        schema_version: 2,
        entry_type: 'runtime_event',
        event_type: 'provider_error',
        session_id: 'eval:provider.budget.fail.001',
        provider_error: {
          provider: 'openai-compatible',
          error_code: 'MODEL_RATE_LIMIT',
          retryable: true,
          message: 'provider rate limit',
        },
      }),
      JSON.stringify({
        schema_version: 2,
        entry_type: 'turn',
        turn: 1,
        assistant: {
          text: 'Provider error observed: MODEL_RATE_LIMIT. fallback evidence preserved; blocked for live model quality.',
          tool_calls: [],
        },
        tokens: { prompt: 10, completion: 10 },
      }),
    ].join('\n') + '\n', 'utf-8');

    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'provider-budget-fail',
      name: 'Provider Budget Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'provider.budget.fail.001',
          name: 'provider budget fail',
          lane: 'contract_sentinel',
          target_module: 'provider',
          risk_level: 'release_blocking',
          inputs: { jsonl: './provider.jsonl' },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            {
              id: 'provider_error_fallback',
              config: {
                provider_error_terms: ['provider_error', 'MODEL_RATE_LIMIT'],
                fallback_terms: ['fallback', 'blocked'],
                required_texts: ['Provider error observed', 'fallback evidence preserved'],
                require_retry_budget: true,
                require_blocked_budget: true,
              },
            },
          ],
          failure_route: 'provider',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-05-31T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    const verifier = scorecard.cases[0].verifier_results.find(item => item.id === 'provider_error_fallback');
    assert.equal(verifier?.status, 'fail');
    assert.match(verifier?.message || '', /missing provider retry budget evidence/);
    assert.match(verifier?.message || '', /missing provider blocked budget evidence/);
  });

  test('provider failover sequence verifier fails when provider order drifts', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-provider-failover-order-fail-'));
    const fixturePath = path.join(tempDir, 'provider-failover.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');

    fs.writeFileSync(fixturePath, [
      JSON.stringify({
        schema_version: 2,
        entry_type: 'runtime_event',
        event_type: 'provider_error',
        timestamp: '2026-05-31T00:00:00.000Z',
        session_id: 'eval:provider.failover.order.fail.001',
        session_type: 'eval',
        status: 'failure',
        error_code: 'PROVIDER_TIMEOUT',
        retryable: true,
        retry_count: 0,
        retry_budget: 1,
        retry_budget_exhausted: false,
        provider_failure_budget: {
          scope: 'session',
          fingerprint: 'sha256:1111111111111111',
          prior_failure_count: 0,
        },
        provider_error: {
          provider: 'anthropic',
          endpoint: 'fallback',
          error_code: 'PROVIDER_TIMEOUT',
          retryable: true,
          message: 'fallback timed out',
        },
      }),
      JSON.stringify({
        schema_version: 2,
        entry_type: 'runtime_event',
        event_type: 'provider_error',
        timestamp: '2026-05-31T00:00:01.000Z',
        session_id: 'eval:provider.failover.order.fail.001',
        session_type: 'eval',
        status: 'blocked',
        error_code: 'MODEL_RATE_LIMIT',
        retryable: true,
        retry_count: 1,
        retry_budget: 1,
        retry_budget_exhausted: true,
        blocked_reason: 'Failover ended in the wrong order.',
        provider_failure_budget: {
          scope: 'session',
          fingerprint: 'sha256:2222222222222222',
          prior_failure_count: 0,
        },
        provider_error: {
          provider: 'openai-compatible',
          endpoint: 'primary',
          error_code: 'MODEL_RATE_LIMIT',
          retryable: true,
          message: 'primary rate limited',
        },
      }),
    ].join('\n') + '\n', 'utf-8');

    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'provider-failover-order-fail',
      name: 'Provider Failover Order Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'provider.failover.order.fail.001',
          name: 'provider failover order fail',
          lane: 'contract_sentinel',
          target_module: 'provider',
          risk_level: 'release_blocking',
          inputs: { jsonl: './provider-failover.jsonl' },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            {
              id: 'provider_failover_sequence',
              config: {
                expected_providers: ['openai-compatible', 'anthropic'],
                expected_endpoints: ['primary', 'fallback'],
                require_retry_budget: true,
                require_terminal_blocked: true,
              },
            },
          ],
          failure_route: 'provider',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-05-31T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    const verifier = scorecard.cases[0].verifier_results.find(item => item.id === 'provider_failover_sequence');
    assert.equal(verifier?.status, 'fail');
    assert.match(verifier?.message || '', /provider sequence mismatch/);
  });

  test('workspace boundary verifier fails when an escaped path succeeds', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-workspace-fail-'));
    const fixturePath = path.join(tempDir, 'workspace.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');

    fs.writeFileSync(fixturePath, `${JSON.stringify({
      schema_version: 2,
      entry_type: 'turn',
      turn: 1,
      assistant: {
        text: 'Wrote outside workspace.',
        tool_calls: [
          {
            id: 'unsafe-write',
            tool_call_id: 'unsafe-write',
            name: 'write_file',
            arguments: { file_path: '../outside/secret.txt' },
            result: 'wrote ../outside/secret.txt',
            status: 'success',
            artifact_manifest: [{ path: '../outside/secret.txt', type: 'txt', action: 'created' }],
          },
        ],
      },
      tokens: { prompt: 10, completion: 10 },
    })}\n`, 'utf-8');

    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'workspace-boundary-fail',
      name: 'Workspace Boundary Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'workspace.fail.001',
          name: 'workspace fail',
          lane: 'contract_sentinel',
          target_module: 'tool',
          risk_level: 'release_blocking',
          inputs: { jsonl: './workspace.jsonl' },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            { id: 'workspace_boundary' },
          ],
          failure_route: 'tool',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-05-31T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'tool');
    assert.ok(scorecard.cases[0].verifier_results.some(item => item.id === 'workspace_boundary' && item.status === 'fail'));
  });

  test('surface runtime verifier fails when visible delivery evidence is missing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-surface-runtime-fail-'));
    const fixturePath = path.join(tempDir, 'surface-runtime.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');

    fs.writeFileSync(fixturePath, `${JSON.stringify({
      schema_version: 2,
      entry_type: 'turn',
      turn: 1,
      surface: 'pet',
      surface_runtime: {
        surface: 'pet',
        runtime_id: 'pet_channel_router',
        method: 'POST',
        path: '/api/pet/message',
        status_code: 200,
        session_key: 'pet:alpha-puff',
        channel_id: 'pet:alpha-puff',
        user_message: 'surface runtime smoke',
        visible_delivery_count: 0,
        event_types: ['user_message', 'state'],
        request_artifact_path: 'missing-request.json',
        response_artifact_path: 'missing-response.json',
      },
      user: { text: 'surface runtime smoke' },
      assistant: { text: '', tool_calls: [] },
      tokens: { prompt: 0, completion: 0 },
    })}\n`, 'utf-8');

    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'surface-runtime-fail',
      name: 'Surface Runtime Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'surface.runtime.fail.001',
          name: 'surface runtime fail',
          lane: 'requirement_acceptance',
          target_module: 'surface',
          risk_level: 'release_blocking',
          inputs: { jsonl: './surface-runtime.jsonl' },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            {
              id: 'surface_runtime_e2e',
              config: {
                expected_surface: 'pet',
                expected_runtime_id: 'pet_channel_router',
                expected_status_code: 200,
                required_event_types: ['user_message', 'text', 'done'],
                min_visible_deliveries: 1,
                require_request_artifact: true,
                require_response_artifact: true,
              },
            },
          ],
          failure_route: 'surface',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-05-31T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'surface');
    assert.ok(scorecard.cases[0].verifier_results.some(item => item.id === 'surface_runtime_e2e' && item.status === 'fail'));
  });

  test('delivery evidence contract fails when surface runtime has no structured delivery evidence', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-surface-runtime-delivery-fail-'));
    const fixturePath = path.join(tempDir, 'surface-runtime-delivery.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');

    fs.writeFileSync(fixturePath, `${JSON.stringify({
      schema_version: 2,
      entry_type: 'turn',
      turn: 1,
      surface: 'pet',
      surface_runtime: {
        surface: 'pet',
        runtime_id: 'pet_channel_router',
        method: 'POST',
        path: '/api/pet/messages',
        status_code: 200,
        session_key: 'pet:agent-runtime',
        channel_id: 'agent-runtime',
        user_message: 'surface runtime smoke',
        visible_delivery_count: 1,
        file_delivery_count: 0,
        event_types: ['user_message', 'state', 'text', 'done'],
        request_artifact_path: 'surface-runtime-request.json',
        response_artifact_path: 'surface-runtime-response.json',
      },
      user: { text: 'surface runtime smoke' },
      assistant: { text: '', tool_calls: [] },
      tokens: { prompt: 0, completion: 0 },
    })}\n`, 'utf-8');

    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'surface-runtime-delivery-evidence-fail',
      name: 'Surface Runtime Delivery Evidence Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'surface.runtime.delivery.fail.001',
          name: 'surface runtime delivery evidence missing',
          lane: 'requirement_acceptance',
          target_module: 'state_evidence',
          risk_level: 'release_blocking',
          inputs: { jsonl: './surface-runtime-delivery.jsonl' },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            {
              id: 'delivery_evidence_contract',
              config: {
                min_delivery_evidence: 1,
                require_delivery_tools: false,
              },
            },
          ],
          failure_route: 'state_evidence',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-06-04T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'state_evidence');
    assert.ok(scorecard.cases[0].verifier_results.some(item => (
      item.id === 'delivery_evidence_contract'
      && item.status === 'fail'
      && item.message.includes('delivery evidence 0 < 1')
    )));
  });

  test('delivery evidence contract fails when required external receipts are missing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-external-receipt-fail-'));
    const fixturePath = path.join(tempDir, 'surface-runtime-receipt.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');

    fs.writeFileSync(fixturePath, `${JSON.stringify({
      schema_version: 2,
      entry_type: 'turn',
      turn: 1,
      surface: 'feishu',
      surface_runtime: {
        surface: 'feishu',
        runtime_id: 'feishu_bot_event',
        status_code: 200,
        session_key: 'group:receipt-fail',
        channel_id: 'oc_receipt_fail',
        user_message: 'send with delivery evidence but no external receipt',
        visible_delivery_count: 1,
        file_delivery_count: 0,
        event_types: ['feishu.event.received', 'feishu.reply'],
        delivery_evidence: [
          {
            delivery_id: 'feishu.reply.1',
            surface: 'feishu',
            channel_id: 'oc_receipt_fail',
            delivery_type: 'text',
            status: 'delivered',
            timestamp: '2026-06-04T00:00:00.000Z',
            text_preview: 'sent',
          },
        ],
      },
      user: { text: 'send with delivery evidence but no external receipt' },
      assistant: { text: '', tool_calls: [] },
      tokens: { prompt: 0, completion: 0 },
    })}\n`, 'utf-8');

    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'external-receipt-contract-fail',
      name: 'External Receipt Contract Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'delivery.external-receipt.fail.001',
          name: 'external receipt evidence missing',
          lane: 'contract_sentinel',
          target_module: 'state_evidence',
          risk_level: 'release_blocking',
          inputs: { jsonl: './surface-runtime-receipt.jsonl' },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            {
              id: 'delivery_evidence_contract',
              config: {
                min_delivery_evidence: 1,
                min_external_receipts: 1,
                required_external_receipt_types: ['message'],
                require_external_platform_ids: true,
                require_delivery_tools: false,
              },
            },
          ],
          failure_route: 'state_evidence',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-06-04T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'state_evidence');
    assert.ok(scorecard.cases[0].verifier_results.some(item => (
      item.id === 'delivery_evidence_contract'
      && item.status === 'fail'
      && /external receipts 0 < 1|missing external receipt types/.test(item.message)
    )));
  });

  test('surface runtime verifier fails when required file delivery evidence is missing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-surface-runtime-file-fail-'));
    const fixturePath = path.join(tempDir, 'surface-runtime-file.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');
    const artifactsDir = path.join(tempDir, 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });

    fs.writeFileSync(fixturePath, `${JSON.stringify({
      schema_version: 2,
      entry_type: 'turn',
      turn: 1,
      surface: 'pet',
      surface_runtime: {
        surface: 'pet',
        runtime_id: 'pet_channel_router',
        method: 'POST',
        path: '/api/pet/messages',
        status_code: 200,
        session_key: 'pet:engineer-cat',
        channel_id: 'engineer-cat',
        user_message: 'surface runtime file smoke',
        visible_delivery_count: 1,
        file_delivery_count: 0,
        file_names: [],
        file_artifact_paths: [],
        event_types: ['user_message', 'state', 'text', 'done'],
        request_artifact_path: 'request.json',
        response_artifact_path: 'response.json',
      },
      user: { text: 'surface runtime file smoke' },
      assistant: { text: '', tool_calls: [] },
      tokens: { prompt: 0, completion: 0 },
    })}\n`, 'utf-8');
    fs.writeFileSync(path.join(artifactsDir, 'request.json'), '{}\n', 'utf-8');
    fs.writeFileSync(path.join(artifactsDir, 'response.json'), '{}\n', 'utf-8');

    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'surface-runtime-file-fail',
      name: 'Surface Runtime File Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'surface.runtime.file.fail.001',
          name: 'surface runtime file fail',
          lane: 'requirement_acceptance',
          target_module: 'surface',
          risk_level: 'release_blocking',
          inputs: {
            jsonl: './surface-runtime-file.jsonl',
            artifacts_dir: './artifacts',
          },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            {
              id: 'surface_runtime_e2e',
              config: {
                expected_surface: 'pet',
                expected_runtime_id: 'pet_channel_router',
                expected_status_code: 200,
                min_visible_deliveries: 1,
                min_file_deliveries: 1,
                required_files: ['pet-runtime-file-report.md'],
                require_file_artifacts: true,
              },
            },
          ],
          failure_route: 'surface',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-05-31T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'surface');
    assert.ok(scorecard.cases[0].verifier_results.some(item => item.id === 'surface_runtime_e2e' && item.status === 'fail'));
  });

  test('channel delivery verifier fails when required file delivery is missing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-delivery-fail-'));
    const suitePath = path.join(tempDir, 'suite.json');
    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'delivery-fail',
      name: 'Delivery Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'delivery.fail.001',
          name: 'delivery fail',
          lane: 'contract_sentinel',
          target_module: 'surface',
          risk_level: 'high',
          inputs: {
            jsonl: path.resolve('eval/benchmarks/RoleArena/fixtures/role-arena/engineer-cat.jsonl'),
          },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            {
              id: 'channel_delivery',
              config: {
                min_deliveries: 1,
                min_file_deliveries: 1,
                required_files: ['delivery-report.md'],
              },
            },
          ],
          failure_route: 'surface',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-05-31T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'state_evidence');
    assert.ok(scorecard.cases[0].verifier_results.some(item => item.id === 'channel_delivery' && item.status === 'fail'));
  });

  test('delivery evidence contract fails when send_file has no structured delivery evidence', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-delivery-evidence-fail-'));
    const fixturePath = path.join(tempDir, 'delivery-missing-evidence.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');
    fs.writeFileSync(fixturePath, `${JSON.stringify({
      schema_version: 2,
      entry_type: 'turn',
      turn: 1,
      turn_id: 'delivery.missing-evidence.001.turn.1',
      timestamp: '2026-06-04T00:00:00.000Z',
      session_id: 'eval:delivery.missing-evidence.001',
      session_type: 'eval',
      surface: 'feishu',
      user: { text: 'send report' },
      assistant: {
        text: '',
        tool_calls: [
          {
            id: 'missing-delivery-send-file',
            tool_call_id: 'missing-delivery-send-file',
            name: 'send_file',
            arguments: {
              file_path: 'delivery-report.md',
              file_name: 'delivery-report.md',
            },
            result: '文件 "delivery-report.md" 已发送',
            status: 'success',
            artifact_manifest: [
              {
                path: 'delivery-report.md',
                type: 'md',
                action: 'sent',
              },
            ],
          },
        ],
      },
      tokens: { prompt: 20, completion: 8 },
    })}\n`, 'utf-8');
    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'delivery-evidence-contract-fail',
      name: 'Delivery Evidence Contract Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'delivery.missing-evidence.001',
          name: 'delivery evidence missing',
          lane: 'contract_sentinel',
          target_module: 'state_evidence',
          risk_level: 'release_blocking',
          inputs: {
            jsonl: fixturePath,
          },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            {
              id: 'delivery_evidence_contract',
              config: {
                "min_delivery_evidence": 1
              }
            },
          ],
          failure_route: 'state_evidence',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-06-04T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'state_evidence');
    assert.ok(scorecard.cases[0].verifier_results.some(item => (
      item.id === 'delivery_evidence_contract'
      && item.status === 'fail'
      && item.message.includes('lacks delivery_evidence')
    )));
  });

  test('soft judge fails after hard verifiers pass when semantic evidence is weak', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-judge-fail-'));
    const fixturePath = path.join(tempDir, 'weak.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');
    fs.writeFileSync(fixturePath, `${JSON.stringify({
      schema_version: 2,
      entry_type: 'turn',
      turn: 1,
      user: { text: 'review this run' },
      assistant: { text: 'Looks fine.', tool_calls: [] },
      tokens: { prompt: 10, completion: 5 },
    })}\n`, 'utf-8');
    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'judge-fail',
      name: 'Judge Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'judge.fail.001',
          name: 'judge fail',
          lane: 'requirement_acceptance',
          target_module: 'state_evidence',
          risk_level: 'high',
          inputs: { jsonl: fixturePath },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            { id: 'budget_check' },
          ],
          soft_judges: [
            {
              id: 'semantic_text_quality',
              min_score: 1,
              config: {
                required_texts: ['Decision:', 'Evidence:', 'Residual risk:'],
              },
            },
          ],
          budgets: {
            max_turns: 1,
            max_tool_calls: 0,
            max_tokens: 100,
          },
          failure_route: 'state_evidence',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-05-31T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.summary.hard_failures, 0);
    assert.equal(scorecard.summary.judge_failures, 1);
    assert.equal(scorecard.cases[0].decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'state_evidence');
    assert.ok(scorecard.cases[0].judge_results.some(item => item.id === 'semantic_text_quality' && item.status === 'fail'));
  });

  test('state continuity verifier fails when restore evidence is missing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-state-continuity-'));
    const fixturePath = path.join(tempDir, 'state.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');
    fs.writeFileSync(fixturePath, `${JSON.stringify({
      schema_version: 2,
      entry_type: 'turn',
      turn: 1,
      user: { text: 'continue' },
      assistant: { text: 'Continuing without restore evidence.' },
      tokens: { prompt: 10, completion: 10 },
    })}\n`, 'utf-8');
    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'state-continuity-fail',
      name: 'State Continuity Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'state.fail.001',
          name: 'state continuity fail',
          lane: 'contract_sentinel',
          target_module: 'state_evidence',
          risk_level: 'high',
          inputs: {
            jsonl: fixturePath,
          },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            {
              id: 'state_continuity',
              config: {
                required_events: ['session_restore'],
                required_texts: ['analysis.md'],
                min_turns: 2,
              },
            },
          ],
          failure_route: 'state_evidence',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-05-31T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'state_evidence');
    assert.ok(scorecard.cases[0].verifier_results.some(item => item.id === 'state_continuity' && item.status === 'fail'));
  });

  test('state boundary verifier fails when provider transcript stores raw messages', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-state-boundary-'));
    const fixturePath = path.join(tempDir, 'state-boundary.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');
    fs.writeFileSync(fixturePath, `${JSON.stringify({
      schema_version: 2,
      entry_type: 'turn',
      turn: 1,
      turn_id: 'state.boundary.fail.001.turn.1',
      timestamp: '2026-06-04T00:00:00.000Z',
      session_id: 'eval_state_boundary_fail',
      session_type: 'eval',
      user: { text: 'restore session' },
      assistant: { text: 'Restored with unsafe provider transcript payload.', tool_calls: [] },
      state_boundary: {
        durable_session: {
          kind: 'durable_session',
          ref: 'data/sessions/chat/eval_state_boundary_fail.jsonl',
        },
        working_trace: {
          kind: 'working_trace',
          ref: 'logs/sessions/chat/eval_state_boundary_fail.jsonl',
        },
        provider_transcript: {
          kind: 'provider_transcript_ref',
          ref: 'provider-transcripts/sha256:9999',
          mode: 'reference',
          raw_messages_stored: true,
          messages: [
            { role: 'user', content: 'raw provider message should not be durable state' },
          ],
        },
      },
      tokens: { prompt: 10, completion: 10 },
    })}\n`, 'utf-8');
    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'state-boundary-fail',
      name: 'State Boundary Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'state.boundary.fail.001',
          name: 'state boundary fail',
          lane: 'contract_sentinel',
          target_module: 'state_evidence',
          risk_level: 'release_blocking',
          inputs: {
            jsonl: fixturePath,
          },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            { id: 'state_boundary_contract' },
          ],
          failure_route: 'state_evidence',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-06-04T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'state_evidence');
    assert.ok(scorecard.cases[0].verifier_results.some(item => (
      item.id === 'state_boundary_contract'
      && item.status === 'fail'
      && item.message.includes('provider transcript')
    )));
  });

  test('provider transcript normalization verifier fails on non-digest refs', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-provider-normalization-'));
    const fixturePath = path.join(tempDir, 'state-boundary.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');
    fs.writeFileSync(fixturePath, `${JSON.stringify({
      schema_version: 2,
      entry_type: 'turn',
      turn: 1,
      turn_id: 'provider.normalization.fail.001.turn.1',
      timestamp: '2026-06-04T00:00:00.000Z',
      session_id: 'eval_provider_normalization_fail',
      session_type: 'eval',
      user: { text: 'restore session' },
      assistant: { text: 'Restored with a non-normalized provider transcript ref.', tool_calls: [] },
      state_boundary: {
        durable_session: {
          kind: 'durable_session',
          ref: 'data/sessions/chat/eval_provider_normalization_fail.jsonl',
        },
        working_trace: {
          kind: 'working_trace',
          ref: 'logs/sessions/chat/eval_provider_normalization_fail.jsonl',
        },
        provider_transcript: {
          kind: 'provider_transcript_ref',
          ref: 'provider-transcripts/latest.json',
          mode: 'reference',
          raw_messages_stored: false,
          tool_result_payload_stored: false,
        },
      },
      tokens: { prompt: 10, completion: 10 },
    })}\n`, 'utf-8');
    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'provider-normalization-fail',
      name: 'Provider Normalization Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'provider.normalization.fail.001',
          name: 'provider normalization fail',
          lane: 'contract_sentinel',
          target_module: 'state_evidence',
          risk_level: 'release_blocking',
          inputs: {
            jsonl: fixturePath,
          },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            { id: 'provider_transcript_normalization' },
          ],
          failure_route: 'state_evidence',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-06-04T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'state_evidence');
    assert.ok(scorecard.cases[0].verifier_results.some(item => (
      item.id === 'provider_transcript_normalization'
      && item.status === 'fail'
      && item.message.includes('normalized digest')
    )));
  });

  test('provider transcript degradation verifier fails when structured degradation evidence is incomplete', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-provider-degradation-'));
    const fixturePath = path.join(tempDir, 'provider-degradation.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');
    fs.writeFileSync(fixturePath, `${JSON.stringify({
      schema_version: 2,
      entry_type: 'turn',
      turn: 1,
      turn_id: 'provider.degradation.fail.001.turn.1',
      timestamp: '2026-06-05T00:00:00.000Z',
      session_id: 'eval_provider_degradation_fail',
      session_type: 'eval',
      user: { text: 'show degraded transcript evidence' },
      assistant: { text: 'Provider transcript degraded, but the evidence is incomplete.', tool_calls: [] },
      state_boundary: {
        provider_transcript: {
          kind: 'provider_transcript_ref',
          ref: 'provider-transcripts/sha256:aaaabbbbccccdddd',
          mode: 'summary',
          status: 'degraded',
          degraded: true,
          degradation_reason: 'MODEL_RATE_LIMIT',
          raw_messages_stored: false,
          tool_result_payload_stored: false,
          raw_request_stored: false,
          raw_response_stored: false,
          raw_payload_stored: false,
        },
      },
      tokens: { prompt: 10, completion: 10 },
    })}\n`, 'utf-8');
    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'provider-degradation-fail',
      name: 'Provider Degradation Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'provider.degradation.fail.001',
          name: 'provider degradation fail',
          lane: 'contract_sentinel',
          target_module: 'state_evidence',
          risk_level: 'release_blocking',
          inputs: {
            jsonl: fixturePath,
          },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            {
              id: 'provider_transcript_degradation',
              config: {
                min_degraded_refs: 1,
                expected_reasons: ['MODEL_RATE_LIMIT'],
                require_fallback_chain: true,
                require_blocked_reason: true,
                require_explicit_raw_payload_storage_flags: true,
              },
            },
          ],
          failure_route: 'state_evidence',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-06-05T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'state_evidence');
    assert.ok(scorecard.cases[0].verifier_results.some(item => (
      item.id === 'provider_transcript_degradation'
      && item.status === 'fail'
      && item.message.includes('missing blocked reasons')
      && item.message.includes('missing fallback chains')
    )));
  });

  test('role boundary verifier fails on role mismatch', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-role-boundary-'));
    const suitePath = path.join(tempDir, 'suite.json');
    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'role-boundary-fail',
      name: 'Role Boundary Fail',
      version: '0.1',
      cases: [
        {
          case_id: 'role.boundary.fail.001',
          name: 'role boundary fail',
          lane: 'role_arena',
          target_module: 'role',
          risk_level: 'high',
          inputs: {
            jsonl: path.resolve('eval/benchmarks/RoleArena/fixtures/role-arena/reviewer-cat.jsonl'),
          },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            {
              id: 'role_boundary',
              config: {
                expected_role: 'engineer-cat',
                required_texts: ['Implementation:'],
                forbidden_texts: ['Decision: pass'],
              },
            },
          ],
          failure_route: 'role',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-05-31T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'state_evidence');
    assert.ok(scorecard.cases[0].verifier_results.some(item => item.id === 'role_boundary' && item.status === 'fail'));
  });

  test('all-roles gate fails when ResearcherCat handoff evidence is missing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-all-roles-fail-'));
    const fixturePath = path.join(tempDir, 'researcher-missing-handoff.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');
    fs.writeFileSync(fixturePath, `${JSON.stringify({
      schema_version: 2,
      entry_type: 'turn',
      turn: 1,
      turn_id: 'role.researcher-cat.fail.turn.1',
      timestamp: '2026-05-31T00:00:00.000Z',
      session_id: 'eval:role.researcher-cat.fail',
      session_type: 'eval',
      role_id: 'researcher-cat',
      user: { text: 'Maintain research state.' },
      assistant: {
        role_id: 'researcher-cat',
        text: 'Role: ResearcherCat\nResearch goal: finish the evidence pack.\nEvidence board: claim A has current support.\nExperiment queue: rerun E8.\nArtifact versions: manuscript-v12.docx.\nRisks: E8 may contradict claim A.',
        tool_calls: [
          {
            id: 'researcher-board-update',
            tool_call_id: 'researcher-board-update',
            name: 'research_board_update',
            arguments: { project: 'revision-response' },
            result: 'research board updated',
            status: 'success',
          },
        ],
      },
      tokens: { prompt: 500, completion: 120 },
    })}\n`, 'utf-8');
    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'all-roles-missing-handoff',
      name: 'All Roles Missing Handoff',
      version: '0.1',
      cases: [
        {
          case_id: 'all-roles.researcher-cat.fail.001',
          name: 'researcher missing handoff',
          lane: 'role_arena',
          target_module: 'role',
          risk_level: 'release_blocking',
          inputs: { jsonl: fixturePath },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            {
              id: 'role_boundary',
              config: {
                expected_role: 'researcher-cat',
                required_texts: ['Research goal:', 'Evidence board:', 'Experiment queue:', 'Artifact versions:', 'Risks:', 'Handoff:'],
                allowed_tools: ['research_board_update'],
              },
            },
          ],
          failure_route: 'role',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-05-31T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'role');
    assert.ok(scorecard.cases[0].verifier_results.some(item => item.id === 'role_boundary' && item.status === 'fail'));
  });

  test('cross-role handoff verifier fails when a handoff edge is missing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eval-role-handoff-fail-'));
    const fixturePath = path.join(tempDir, 'handoff-missing-review.jsonl');
    const suitePath = path.join(tempDir, 'suite.json');
    fs.writeFileSync(fixturePath, [
      JSON.stringify({
        schema_version: 2,
        entry_type: 'turn',
        turn: 1,
        turn_id: 'handoff.fail.turn.1',
        session_id: 'eval:handoff.fail.001',
        session_type: 'eval',
        role_id: 'inspector-cat',
        role_handoffs: [{
          from_role: 'inspector-cat',
          to_role: 'engineer-cat',
          case_id: 'handoff.delivery-evidence.001',
          artifacts: ['inspector-issue.json'],
        }],
        assistant: {
          role_id: 'inspector-cat',
          text: 'Role: InspectorCat\nIssue: artifact delivery lacks durable evidence.\nRoute: state_evidence\nOwner: EngineerCat',
          tool_calls: [{
            id: 'route',
            tool_call_id: 'route',
            name: 'case_route',
            arguments: { case_id: 'handoff.delivery-evidence.001' },
            result: 'case routed',
            status: 'success',
          }],
        },
        tokens: { prompt: 100, completion: 50 },
      }),
      JSON.stringify({
        schema_version: 2,
        entry_type: 'turn',
        turn: 2,
        turn_id: 'handoff.fail.turn.2',
        session_id: 'eval:handoff.fail.001',
        session_type: 'eval',
        role_id: 'engineer-cat',
        assistant: {
          role_id: 'engineer-cat',
          text: 'Role: EngineerCat\nImplementation: patch.diff is ready.\nVerification: validation.log passed.',
          tool_calls: [{
            id: 'patch',
            tool_call_id: 'patch',
            name: 'apply_patch',
            arguments: { case_id: 'handoff.delivery-evidence.001' },
            result: 'patch.diff created',
            status: 'success',
          }],
        },
        tokens: { prompt: 120, completion: 60 },
      }),
    ].join('\n') + '\n', 'utf-8');
    fs.writeFileSync(suitePath, `${JSON.stringify({
      suite_id: 'role-handoff-missing-edge',
      name: 'Role Handoff Missing Edge',
      version: '0.1',
      cases: [
        {
          case_id: 'role-handoff.fail.001',
          name: 'missing reviewer handoff',
          lane: 'role_arena',
          target_module: 'role',
          risk_level: 'release_blocking',
          inputs: { jsonl: fixturePath },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            {
              id: 'cross_role_handoff',
              config: {
                required_case_id: 'handoff.delivery-evidence.001',
                required_role_sequence: ['inspector-cat', 'engineer-cat', 'reviewer-cat'],
                required_handoffs: [
                  { from_role: 'inspector-cat', to_role: 'engineer-cat', case_id: 'handoff.delivery-evidence.001' },
                  { from_role: 'engineer-cat', to_role: 'reviewer-cat', case_id: 'handoff.delivery-evidence.001' },
                ],
                required_artifacts: ['patch.diff', 'validation.log', 'review-scorecard.json'],
                expected_final_decision: 'closed',
              },
            },
          ],
          failure_route: 'role',
        },
      ],
    }, null, 2)}\n`, 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(tempDir, 'out'),
      now: new Date('2026-05-31T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'fail');
    assert.equal(scorecard.cases[0].failure_route, 'role');
    assert.ok(scorecard.cases[0].verifier_results.some(item => item.id === 'cross_role_handoff' && item.status === 'fail'));
  });

  test('loads suite metadata for downstream tooling', () => {
    const suite = loadScriptedRuntimeTestSuite(path.resolve('test/contract-smoke/suites/contract-sentinel.json'));
    assert.equal(suite.suite_id, 'contract-sentinel');
    assert.ok(suite.cases.some(item => item.case_id === 'contract.runtime-evidence.001'));
    assert.ok(suite.cases.some(item => item.case_id === 'contract.state-boundary.001'));
  });
});
