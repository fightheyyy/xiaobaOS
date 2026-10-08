import { sandboxExecutor } from '../sandbox/executor';
import type { SandboxPolicy } from '../sandbox/policy';
import { shellQuote } from '../sandbox/policy';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { PathResolver } from '../utils/path-resolver';
import { ArenaManager } from './arena-manager';
import { buildArenaShellCommand, arenaRuntimeEnvironment } from './arena-shell';
import type { ArenaResult } from './arena-workflow';
import {
  ArenaCleanRuntimeIndex,
  ArenaReviewMode,
  ArenaSandboxPolicy,
} from './types';

const DEFAULT_ARENA_EXECUTION_TIMEOUT_MS = 600_000;

export interface ExecuteArenaRunInput {
  projectRoot?: string;
  runId?: string;
  reviewMode: ArenaReviewMode;
  subjectId: string;
  targetRoleId?: string;
  surface?: string;
  passThroughEnv?: string[];
  workspaceSeedPath?: string;
  sandbox?: Partial<ArenaSandboxPolicy>;
  scenario?: string;
  maxTurns?: number;
  replayAttempts?: number;
  dryRun?: boolean;
}

export interface ExecuteArenaRunResult {
  status: 'dry_run' | 'completed';
  run_id: string;
  clean_runtime_path: string;
  runner_path: string;
  result_path?: string;
  sandbox_enforced: boolean;
  sandbox_configured: boolean;
  command_kind: 'sandbox_shell_command' | 'shell_command';
  stdout_path?: string;
  stderr_path?: string;
  result?: ArenaResult;
}

/**
 * Prepare one clean subject runtime and invoke the lightweight Arena worker.
 *
 * This is an isolation adapter only. Arena orchestration, Replay and judgment
 * remain in arena-service and shared Evaluation.
 */
export async function executeArenaRun(
  input: ExecuteArenaRunInput,
): Promise<ExecuteArenaRunResult> {
  const projectRoot = path.resolve(input.projectRoot || PathResolver.getProjectRoot());
  const manager = new ArenaManager({ projectRoot });
  const timeoutMs = input.sandbox?.timeout_ms ?? DEFAULT_ARENA_EXECUTION_TIMEOUT_MS;
  const runtime = manager.prepareCleanRuntime({
    runId: input.runId,
    reviewMode: input.reviewMode,
    subjectId: input.subjectId,
    targetRoleId: input.targetRoleId,
    surface: input.surface,
    passThroughEnv: input.passThroughEnv || [],
    workspaceSeedPath: input.workspaceSeedPath,
    sandbox: {
      ...input.sandbox,
      timeout_ms: timeoutMs,
    },
  });

  if (!input.dryRun) {
    assertArenaProviderConfigured(runtime, projectRoot);
  }

  const workerCommand = buildWorkerCommand({
    projectRoot,
    runId: runtime.run_id,
    scenario: input.scenario,
    maxTurns: input.maxTurns,
    replayAttempts: input.replayAttempts,
    requireEntrypoint: !input.dryRun,
  });
  const sandboxPolicyPath = runtime.launch.sandbox_policy_path;
  const sandboxEnforced = Boolean(sandboxPolicyPath && runtime.launch.sandbox_shell_command);
  if (!sandboxEnforced) {
    throw new Error(
      'Arena runner requires clean-runtime launch.sandbox_shell_command; '
      + 'Anthropic SDK policy is required.',
    );
  }

  const shellCommand = buildArenaShellCommand({
    cwd: runtime.roots.workspace_root,
    command: workerCommand,
    env: runtime.launch.env,
    passThroughEnv: runtime.launch.pass_through_env,
    ...(sandboxPolicyPath && { sandboxPolicyPath }),
  });
  const commandKind: ExecuteArenaRunResult['command_kind'] = sandboxEnforced
    ? 'sandbox_shell_command'
    : 'shell_command';
  const runnerPath = path.join(runtime.roots.run_root, 'arena-runner.json');
  const runnerMetadata = {
    version: 1,
    run_id: runtime.run_id,
    command_kind: commandKind,
    sandbox_enforced: false,
    sandbox_configured: sandboxEnforced,
    timeout_ms: timeoutMs,
    worker_command: workerCommand,
    ...(sandboxEnforced
      ? { sandbox_shell_command: shellCommand }
      : { shell_command: shellCommand }),
    clean_runtime_path: path.join(runtime.roots.run_root, 'clean-runtime.json'),
    created_at: new Date().toISOString(),
  };
  writeJson(runnerPath, runnerMetadata);

  if (input.dryRun) {
    return {
      status: 'dry_run',
      run_id: runtime.run_id,
      clean_runtime_path: path.join(runtime.roots.run_root, 'clean-runtime.json'),
      runner_path: runnerPath,
      sandbox_enforced: false,
      sandbox_configured: sandboxEnforced,
      command_kind: commandKind,
    };
  }

  const stdoutPath = path.join(runtime.roots.run_root, 'arena-runner.stdout.log');
  const stderrPath = path.join(runtime.roots.run_root, 'arena-runner.stderr.log');
  const environment = arenaRuntimeEnvironment(runtime);
  const execution = await sandboxExecutor.execute({
    policy: JSON.parse(fs.readFileSync(sandboxPolicyPath!, 'utf8')) as SandboxPolicy,
    command: workerCommand.map(shellQuote).join(' '),
    environment: { ...environment, XIAOBA_ARENA_SANDBOXED: '1' }, timeoutMs,
  });
  fs.writeFileSync(stdoutPath, execution.stdout || '', 'utf-8');
  fs.writeFileSync(stderrPath, execution.stderr || '', 'utf-8');
  if (execution.error) {
    throw new Error(`Arena runner failed: ${execution.error.message}`);
  }
  if (execution.status !== 0) {
    throw new Error(
      `Arena runner exited with status ${execution.status}; `
      + `stderr: ${(execution.stderr || '').slice(0, 1000)}`,
    );
  }
  writeJson(runnerPath, { ...runnerMetadata, sandbox_enforced: true });

  const resultPath = path.join(runtime.roots.run_root, 'arena-result.json');
  if (!fs.existsSync(resultPath)) {
    throw new Error('Arena worker completed without arena-result.json');
  }
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as ArenaResult;
  return {
    status: 'completed',
    run_id: runtime.run_id,
    clean_runtime_path: path.join(runtime.roots.run_root, 'clean-runtime.json'),
    runner_path: runnerPath,
    result_path: resultPath,
    sandbox_enforced: sandboxEnforced,
    sandbox_configured: sandboxEnforced,
    command_kind: commandKind,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    result,
  };
}

function buildWorkerCommand(input: {
  projectRoot: string;
  runId: string;
  scenario?: string;
  maxTurns?: number;
  replayAttempts?: number;
  requireEntrypoint: boolean;
}): string[] {
  const entrypoint = path.join(input.projectRoot, 'dist', 'index.js');
  if (input.requireEntrypoint && !fs.existsSync(entrypoint)) {
    throw new Error(
      `Arena worker requires built CLI entrypoint: ${entrypoint}. Run npm run build first.`,
    );
  }
  const command = [
    process.execPath,
    entrypoint,
    'arena',
    'run',
    'worker',
    '--run-id',
    input.runId,
  ];
  if (input.scenario) command.push('--scenario', input.scenario);
  if (input.maxTurns) command.push('--max-turns', String(input.maxTurns));
  if (input.replayAttempts) {
    command.push('--replay-attempts', String(input.replayAttempts));
  }
  return command;
}

function assertArenaProviderConfigured(
  runtime: ArenaCleanRuntimeIndex,
  projectRoot: string,
): void {
  const env = collectArenaRuntimeProviderEnv(runtime);
  if (hasUsableProviderEnv(env)) return;

  const dotenvPath = runtime.launch.env.DOTENV_CONFIG_PATH;
  const dotenvHint = dotenvPath
    ? `已检测到 .env: ${dotenvPath}，但没有可用 provider 配置。`
    : `未检测到项目 .env: ${path.join(projectRoot, '.env')}。`;
  throw new Error([
    'Arena run execute 需要先配置 XiaoBa provider，避免真实测评变成“API 密钥未配置”的假 blocked。',
    dotenvHint,
    '请先在项目根 .env 配置 XIAOBA_LLM_API_KEY（以及需要的 XIAOBA_LLM_API_BASE / XIAOBA_LLM_MODEL / XIAOBA_LLM_PROVIDER），',
    '或使用 --pass-env 显式传入 XIAOBA_LLM_* 相关变量；本地 Ollama 需配置 XIAOBA_LLM_PROVIDER=ollama、XIAOBA_LLM_API_BASE 和 XIAOBA_LLM_MODEL。',
  ].join(' '));
}

function collectArenaRuntimeProviderEnv(
  runtime: ArenaCleanRuntimeIndex,
): Record<string, string> {
  const env: Record<string, string> = { ...runtime.launch.env };
  const dotenvPath = runtime.launch.env.DOTENV_CONFIG_PATH;
  if (dotenvPath && fs.existsSync(dotenvPath)) {
    Object.assign(env, dotenv.parse(fs.readFileSync(dotenvPath, 'utf-8')));
  }
  for (const envName of runtime.launch.pass_through_env) {
    const value = process.env[envName];
    if (typeof value === 'string') env[envName] = value;
  }
  return env;
}

function hasUsableProviderEnv(env: Record<string, string>): boolean {
  if (hasUsableProviderSlot(env, 'XIAOBA_LLM_')) return true;
  if (hasUsableProviderSlot(env, 'XIAOBA_LLM_BACKUP_')) return true;
  for (let index = 1; index <= 5; index += 1) {
    if (hasUsableProviderSlot(env, `XIAOBA_LLM_BACKUP_${index}_`)) return true;
  }
  return false;
}

function hasUsableProviderSlot(
  env: Record<string, string>,
  prefix: string,
): boolean {
  const provider = (env[`${prefix}PROVIDER`] || '').trim().toLowerCase();
  const apiBase = (env[`${prefix}API_BASE`] || '').trim();
  const apiKey = (env[`${prefix}API_KEY`] || '').trim();
  const model = (env[`${prefix}MODEL`] || '').trim();
  if (!provider && !apiBase && !apiKey && !model) return false;
  if (
    provider === 'ollama'
    || apiBase.toLowerCase().includes('ollama')
    || apiBase.includes(':11434')
    || model.toLowerCase().includes('ollama')
  ) {
    return Boolean(apiBase && model);
  }
  return Boolean(apiKey);
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}
