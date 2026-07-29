import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  activateEvolutionCandidate,
  createEvolutionCandidateBuilder,
  runEvolutionSleep,
} from '../src/roles/evolution-cat/evolution-runtime';
import {
  createCapabilityCandidate,
  fingerprintProductionTarget,
} from '../src/roles/evolution-cat/candidate-package';
import { runCandidatePackageTest } from '../src/testing/candidate-package-test';

describe('Evolution production adapters', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-evolution-runtime-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('nightly entry uses the lightweight control DAG and writes one EvolutionResult', async () => {
    const calls: string[] = [];
    const tracePath = path.join(root, 'logs', 'sessions', 'pet', 'traces.jsonl');
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    fs.writeFileSync(tracePath, '{}\n', 'utf-8');
    const candidate = capabilityCandidateFixture(root, 'nightly-skill');
    const execution = await runEvolutionSleep({
      workingDirectory: root,
      targetDate: '2026-07-28',
      minOccurrences: 2,
      runsPerCase: 1,
    }, {
      buildDigest: options => ({
        digest: {
          schema_version: 1,
          run_id: 'sleep-2026-07-28',
          source: 'xiaoba_session_log_v3',
          generated_at: '2026-07-29T00:00:00.000Z',
          window: {
            target_date: '2026-07-28',
            timezone: 'Asia/Shanghai',
            start_inclusive: '2026-07-27T16:00:00.000Z',
            end_exclusive: '2026-07-28T16:00:00.000Z',
          },
          source_root: 'logs/sessions',
          proposal_dir: 'output/evolution/sleep/2026-07-28/proposals',
          totals: {
            trace_files: 1,
            parsed_rows: 2,
            malformed_rows: 0,
            duplicate_rows: 0,
            non_terminal_rows: 0,
            self_run_rows: 0,
            synthetic_or_replay_rows: 0,
            observations: 2,
            sessions: 2,
            recurring_patterns: 1,
          },
          patterns: [{
            pattern_id: 'pattern-1',
            occurrence_count: 2,
            intent_signature: 'nightly',
            tool_sequence: [],
            terminal_status_counts: { failure: 2 },
            error_codes: [],
            artifact_refs: [],
            sample_trace_refs: [`${tracePath}#trace-1`],
            sample_user_intents: ['nightly'],
          }],
          observations: [],
        },
        digestPath: path.join(root, 'output', 'evolution', 'sleep', '2026-07-28', 'digest.json'),
        proposalDirectory: path.join(root, 'output', 'evolution', 'sleep', '2026-07-28', 'proposals'),
        artifactAction: 'created',
      }),
      inspect: async refs => {
        calls.push('inspect');
        assert.deepEqual(refs, [tracePath]);
        return [findingCase(tracePath)];
      },
      change: async () => {
        calls.push('change');
        return candidate;
      },
      test: async () => {
        calls.push('test');
        return { status: 'pass', evidence_refs: [], reasons: [] };
      },
      evaluate: async ({ cases }) => {
        calls.push('eval');
        return {
          case_set_id: 'candidate',
          runs_per_case: 1,
          outcomes: [{
            case_id: cases[0].case_id,
            run_id: 'run-1',
            status: 'pass',
            trace_ref: tracePath,
            reasons: ['pass'],
            evidence_refs: [tracePath],
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
      },
      activateForNewSessions: async () => {
        calls.push('activate');
      },
    });

    assert.deepEqual(calls, ['inspect', 'change', 'test', 'eval', 'activate']);
    assert.equal(execution.result.attempts[0].activated, true);
    assert.equal(fs.existsSync(execution.result_path), true);
  });

  test('Candidate builder accepts exactly one directly loadable package', async () => {
    const runRoot = path.join(root, 'output', 'evolution', 'runs', 'builder');
    const candidatesRoot = path.join(runRoot, 'candidates');
    const builder = createEvolutionCandidateBuilder({
      working_directory: root,
      run_root: runRoot,
      candidates_root: candidatesRoot,
      runSession: async ({ working_directory }) => {
        writeSkill(path.join(working_directory, 'candidates', 'builder-skill'), 'builder-skill');
        return JSON.stringify({
          version: 1,
          status: 'candidate',
          candidate_type: 'skill',
          candidate_name: 'builder-skill',
          artifact_ref: 'candidates/builder-skill',
        });
      },
    });
    const candidate = await builder({
      finding_case: findingCase('logs/source/traces.jsonl'),
    });

    assert.equal(candidate.candidate_type, 'skill');
    assert.equal(candidate.candidate_name, 'builder-skill');
    assert.match(candidate.artifact_fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(candidate.base_version, 'absent');
  });

  test('Candidate builder delegates source-code Findings to an isolated EngineerCat workspace', async () => {
    writeSource(root, 'src/value.ts', 'export const value = "old";\n');
    writeSource(root, 'dist/index.js', 'exports.value = "old";\n');
    writeSource(root, 'package.json', '{"name":"fixture","version":"1.0.0"}\n');
    const runRoot = path.join(root, 'output', 'evolution', 'runs', 'engineer-builder');
    const candidatesRoot = path.join(runRoot, 'candidates');
    const builder = createEvolutionCandidateBuilder({
      working_directory: root,
      run_root: runRoot,
      candidates_root: candidatesRoot,
      runSession: async () => JSON.stringify({
        version: 1,
        status: 'delegate_code',
        reason: 'runtime source change required',
      }),
      runEngineerSession: async ({ working_directory }) => {
        writeSource(working_directory, 'src/value.ts', 'export const value = "new";\n');
        return JSON.stringify({
          version: 1,
          status: 'candidate',
          candidate_name: 'xiaoba-source',
        });
      },
    });

    const candidate = await builder({
      finding_case: findingCase('logs/source/traces.jsonl'),
    });
    assert.equal(candidate.owner, 'engineer-cat');
    assert.equal(candidate.candidate_type, 'code');
    assert.equal(candidate.candidate_name, 'xiaoba-source');
    assert.match(
      fs.readFileSync(path.join(root, candidate.artifact_ref, 'src', 'value.ts'), 'utf-8'),
      /new/,
    );
  });

  test('shared Candidate Test passes and activation atomically replaces only the target', async () => {
    writeSkill(path.join(root, 'skills', 'replace-skill'), 'replace-skill', 'old body');
    const candidate = capabilityCandidateFixture(root, 'replace-skill', 'new body');
    const testResult = runCandidatePackageTest({
      working_directory: root,
      candidate,
      out_dir: path.join(root, 'output', 'test', 'candidate'),
    });
    assert.equal(testResult.status, 'pass');

    await activateEvolutionCandidate({
      working_directory: root,
      candidate,
      out_dir: path.join(root, 'output', 'evolution', 'activation'),
    });

    assert.match(
      fs.readFileSync(path.join(root, 'skills', 'replace-skill', 'SKILL.md'), 'utf-8'),
      /new body/,
    );
    assert.equal(
      fingerprintProductionTarget(root, 'skill', 'replace-skill'),
      candidate.artifact_fingerprint,
    );
    assert.deepEqual(
      fs.readdirSync(path.join(root, 'skills')).filter(name => name.startsWith('.replace-skill.')),
      [],
    );
  });

  test('activation fails closed when the production base changes after Candidate creation', async () => {
    writeSkill(path.join(root, 'skills', 'stale-skill'), 'stale-skill', 'old body');
    const candidate = capabilityCandidateFixture(root, 'stale-skill', 'new body');
    writeSkill(path.join(root, 'skills', 'stale-skill'), 'stale-skill', 'someone else changed it');

    await assert.rejects(() => activateEvolutionCandidate({
      working_directory: root,
      candidate,
      out_dir: path.join(root, 'output', 'evolution', 'activation'),
    }), /changed after Candidate creation/);
    assert.match(
      fs.readFileSync(path.join(root, 'skills', 'stale-skill', 'SKILL.md'), 'utf-8'),
      /someone else changed it/,
    );
  });
});

function capabilityCandidateFixture(
  root: string,
  name: string,
  body = 'candidate body',
) {
  const candidatesRoot = path.join(root, 'output', 'evolution', 'fixtures', 'candidates');
  const artifactPath = path.join(candidatesRoot, name);
  writeSkill(artifactPath, name, body);
  return createCapabilityCandidate({
    working_directory: root,
    candidates_root: candidatesRoot,
    case_id: 'case-1',
    candidate_type: 'skill',
    candidate_name: name,
    artifact_path: artifactPath,
  });
}

function findingCase(traceRef: string) {
  return {
    finding: {
      summary: 'The response lacks grounded evidence.',
      evidence_refs: [traceRef],
    },
    case: {
      case_id: 'case-1',
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
}

function writeSkill(directory: string, name: string, body = 'candidate body'): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name} description`,
    '---',
    '',
    body,
    '',
  ].join('\n'), 'utf-8');
}

function writeSource(root: string, relative: string, content: string): void {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}
