import { sandboxExecutor } from '../sandbox/executor';
import { createSandboxPolicy, shellQuote } from '../sandbox/policy';
import type { SandboxPolicy } from '../sandbox/policy';
import * as fs from 'fs';
import * as path from 'path';
import { CandidateTestResult } from '../roles/evolution-cat/evolution-workflow';
import { validateSourceCandidate } from '../roles/evolution-cat/source-candidate';
import type { Candidate } from '../roles/evolution-cat/evolution-workflow';

export async function runSourceCandidateTest(input: {
  working_directory: string;
  candidate: Readonly<Candidate>;
  out_dir: string;
}): Promise<CandidateTestResult> {
  const root = path.resolve(input.working_directory);
  const outDir = path.resolve(input.out_dir);
  fs.mkdirSync(outDir, { recursive: true });
  const resultPath = path.join(outDir, 'test-result.json');
  let shortRuntimeRoot: string | undefined;
  try {
    const verified = validateSourceCandidate(root, input.candidate);
    if (verified.base_version !== input.candidate.base_version) {
      throw new Error('Production source changed before Source Candidate Test');
    }
    const sandbox = createSourceTestSandbox({
      source_root: root,
      candidate_root: verified.artifact_path,
      out_dir: outDir,
    });
    shortRuntimeRoot = sandbox.short_runtime_root;
    const environment = sourceTestEnvironment(
      sandbox.home_root,
      sandbox.tmp_root,
      sandbox.short_runtime_root,
      root,
    );
    const build = await runSandboxedNode({
      profile_path: sandbox.profile_path,
      cwd: verified.artifact_path,
      environment,
      args: [
        require.resolve('typescript/bin/tsc'),
        '--project',
        path.join(verified.artifact_path, 'tsconfig.json'),
      ],
      timeout_ms: 180_000,
    });
    fs.writeFileSync(path.join(outDir, 'build.log'), renderExecution(build), 'utf-8');
    if (build.status !== 0) {
      return writeResult({
        resultPath,
        candidate: input.candidate,
        status: 'fail',
        evidenceRefs: [resultPath, path.join(outDir, 'build.log')],
        reasons: [executionFailure('Source Candidate build', build)],
      });
    }

    const tests = await runSandboxedNode({
      profile_path: sandbox.profile_path,
      cwd: verified.artifact_path,
      environment,
      args: [
        path.join(verified.artifact_path, 'scripts', 'run-tests.mjs'),
        '--exclude-native-sandbox-tests',
      ],
      timeout_ms: 120_000,
    });
    fs.writeFileSync(path.join(outDir, 'tests.log'), renderExecution(tests), 'utf-8');
    if (tests.status !== 0) {
      return writeResult({
        resultPath,
        candidate: input.candidate,
        status: 'fail',
        evidenceRefs: [
          resultPath,
          path.join(outDir, 'build.log'),
          path.join(outDir, 'tests.log'),
        ],
        reasons: [executionFailure('Source Candidate tests', tests)],
      });
    }

    const nativeTestNames = [
      'source-candidate.test.ts',
      'sub-agent-security.test.ts',
    ];
    const missingNativeTests = nativeTestNames.filter(name => (
      fs.existsSync(path.join(root, 'test', name))
      && !fs.existsSync(path.join(verified.artifact_path, 'test', name))
    ));
    if (missingNativeTests.length > 0) {
      throw new Error(
        `Source Candidate removed native sandbox tests: ${missingNativeTests.join(', ')}`,
      );
    }
    const nativeTestPaths = nativeTestNames
      .map(name => path.join(verified.artifact_path, 'test', name))
      .filter(filePath => fs.existsSync(filePath));
    const nativeSandboxTests = nativeTestPaths.length === 0
      ? successfulExecution('No native sandbox test files in this source fixture')
      : await runSandboxedNode({
          profile_path: sandbox.profile_path,
          args: [
            require.resolve('tsx/cli'),
            '--test',
            '--test-concurrency=1',
            ...nativeTestPaths,
          ],
          cwd: verified.artifact_path,
          environment: {
            ...environment,
            TMPDIR: sandbox.short_runtime_root,
          },
          timeout_ms: 60_000,
        });
    const nativeSandboxLog = path.join(outDir, 'native-sandbox-tests.log');
    fs.writeFileSync(nativeSandboxLog, renderExecution(nativeSandboxTests), 'utf-8');
    if (nativeSandboxTests.status !== 0) {
      return writeResult({
        resultPath,
        candidate: input.candidate,
        status: 'fail',
        evidenceRefs: [
          resultPath,
          path.join(outDir, 'build.log'),
          path.join(outDir, 'tests.log'),
          nativeSandboxLog,
        ],
        reasons: [executionFailure(
          'Source Candidate native sandbox tests',
          nativeSandboxTests,
        )],
      });
    }
    const after = validateSourceCandidate(root, input.candidate);
    if (after.base_version !== input.candidate.base_version) {
      throw new Error('Production source changed during Source Candidate Test');
    }
    return writeResult({
      resultPath,
      candidate: input.candidate,
      status: 'pass',
      evidenceRefs: [
        resultPath,
        path.join(outDir, 'build.log'),
        path.join(outDir, 'tests.log'),
        nativeSandboxLog,
      ],
      reasons: [],
    });
  } catch (error) {
    return writeResult({
      resultPath,
      candidate: input.candidate,
      status: 'blocked',
      evidenceRefs: [resultPath],
      reasons: [error instanceof Error ? error.message : String(error)],
    });
  } finally {
    if (shortRuntimeRoot) {
      fs.rmSync(shortRuntimeRoot, { recursive: true, force: true });
    }
  }
}

function createSourceTestSandbox(input: {
  source_root: string;
  candidate_root: string;
  out_dir: string;
}): {
  profile_path: string;
  home_root: string;
  tmp_root: string;
  short_runtime_root: string;
} {
  const sandboxRoot = path.join(input.out_dir, 'sandbox');
  const homeRoot = path.join(sandboxRoot, 'home');
  const tmpRoot = path.join(sandboxRoot, 'tmp');
  fs.mkdirSync(homeRoot, { recursive: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  const shortRuntimeRoot = fs.mkdtempSync('/tmp/xst-');
  const profilePath = path.join(sandboxRoot, 'anthropic-policy.json');
  const policy = createSandboxPolicy({
    cwd: input.candidate_root, scratchRoot: sandboxRoot,
    readRoots: [input.candidate_root, input.out_dir, shortRuntimeRoot, path.join(input.source_root, 'node_modules')],
    writeRoots: [input.candidate_root, input.out_dir, shortRuntimeRoot],
    denyRead: [input.source_root],
    allowLocalBinding: true,
    allowedDomains: ['localhost', '127.0.0.1', '[::1]'],
  });
  policy.config.filesystem.denyWrite.push({ path: profilePath, literal: true });
  fs.writeFileSync(profilePath, JSON.stringify(policy, null, 2), 'utf8');
  return {
    profile_path: profilePath,
    home_root: homeRoot,
    tmp_root: tmpRoot,
    short_runtime_root: shortRuntimeRoot,
  };
}

interface SandboxedExecution {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

async function runSandboxedNode(input: {
  profile_path: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  args: string[];
  timeout_ms: number;
}): Promise<SandboxedExecution> {
  const policy = JSON.parse(fs.readFileSync(input.profile_path, 'utf8')) as SandboxPolicy;
  const execution = await sandboxExecutor.execute({
    policy, command: [process.execPath, ...input.args].map(shellQuote).join(' '),
    environment: input.environment, timeoutMs: input.timeout_ms, maxOutputBytes: 64 * 1024 * 1024,
  });
  if (execution.errorCode === 'SANDBOX_UNAVAILABLE') throw execution.error || new Error('Sandbox unavailable.');
  return execution;
}

function sourceTestEnvironment(
  homeRoot: string,
  tmpRoot: string,
  shortRuntimeRoot: string,
  sourceRoot: string,
): NodeJS.ProcessEnv {
  return {
    HOME: homeRoot,
    TMPDIR: tmpRoot,
    PATH: [
      path.join(sourceRoot, 'node_modules', '.bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      ...(process.env.PATH || '').split(path.delimiter),
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(path.delimiter),
    NO_COLOR: '1',
    XIAOBA_SOURCE_CANDIDATE_TEST: '1',
    XIAOBA_SOURCE_TEST_TMP_ROOT: shortRuntimeRoot,
  };
}

function renderExecution(execution: SandboxedExecution): string {
  return [
    `status=${String(execution.status)}`,
    `signal=${String(execution.signal)}`,
    execution.error ? `error=${execution.error.message}` : '',
    '',
    String(execution.stdout || ''),
    String(execution.stderr || ''),
  ].filter(Boolean).join('\n');
}

function executionFailure(label: string, execution: SandboxedExecution): string {
  return [
    `${label} failed with status ${String(execution.status)}`,
    execution.signal ? `signal ${execution.signal}` : '',
    execution.error?.message ?? '',
  ].filter(Boolean).join(': ');
}

function successfulExecution(message: string): SandboxedExecution {
  return {
    status: 0,
    signal: null,
    stdout: `${message}\n`,
    stderr: '',
  };
}

function writeResult(input: {
  resultPath: string;
  candidate: Readonly<Candidate>;
  status: CandidateTestResult['status'];
  evidenceRefs: string[];
  reasons: string[];
}): CandidateTestResult {
  const result: CandidateTestResult = {
    status: input.status,
    evidence_refs: input.evidenceRefs,
    reasons: input.reasons,
  };
  fs.writeFileSync(input.resultPath, `${JSON.stringify({
    test_type: 'source_candidate',
    candidate_id: input.candidate.candidate_id,
    status: result.status,
    artifact_ref: input.candidate.artifact_ref,
    artifact_fingerprint: input.candidate.artifact_fingerprint,
    evidence_refs: result.evidence_refs,
    reasons: result.reasons,
  }, null, 2)}\n`, 'utf-8');
  return result;
}
