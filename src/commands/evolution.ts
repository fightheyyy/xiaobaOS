import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Command, Option } from 'commander';
import {
  buildEvolutionDigest,
  normalizeEvolutionDate,
} from '../roles/evolution-cat/evolution-observer';
import {
  EvolutionSleepExecution,
  EvolutionSleepRunOptions,
  runEvolutionSleep,
} from '../roles/evolution-cat/evolution-runtime';
import { EvolutionSleepSchedule } from '../roles/evolution-cat/evolution-scheduler';

const STALE_LOCK_MS = 12 * 60 * 60 * 1000;
const DEFAULT_WORKER_TIMEOUT_MS = 45 * 60 * 1000;
const WORKER_KILL_GRACE_MS = 5 * 1000;

export interface EvolutionCommandDependencies {
  runWorkflow?: (options: EvolutionSleepRunOptions) => Promise<EvolutionSleepExecution>;
  runWorker?: (request: EvolutionSleepWorkerRequest) => Promise<void>;
}

interface EvolutionSleepOptions {
  date?: string;
  minOccurrences?: string;
  runs?: string;
  harvestOnly?: boolean;
  verbose?: boolean;
  worker?: boolean;
}

export interface EvolutionSleepWorkerRequest {
  workingDirectory: string;
  targetDate: string;
  minOccurrences: number;
  runsPerCase: number;
  verbose: boolean;
  timeoutMs?: number;
}

export interface SupervisedProcessOptions {
  command: string;
  args: string[];
  workingDirectory: string;
  timeoutMs: number;
  killGraceMs?: number;
  lockPath?: string;
}

export function registerEvolutionCommand(
  program: Command,
  dependencies: EvolutionCommandDependencies = {},
): void {
  const evolution = program
    .command('evolution')
    .description('Lightweight Trace -> Candidate -> shared Test + Eval evolution');

  evolution
    .command('sleep')
    .description('Run one lightweight Evolution cycle without entering Base')
    .option('--date <date>', 'local calendar date to harvest (YYYY-MM-DD); default yesterday')
    .option('--min-occurrences <n>', 'minimum repeated observations required for a pattern', '2')
    .option('--runs <n>', 'shared Eval Replay runs per generated Case', '3')
    .option('--harvest-only', 'only build the deterministic digest; do not call the model')
    .option('--verbose', 'show runtime logs')
    .addOption(new Option('--worker').hideHelp())
    .action(async (options: EvolutionSleepOptions) => {
      const targetDate = normalizeEvolutionDate(options.date);
      const minOccurrences = parseMinOccurrences(options.minOccurrences);
      const runsPerCase = parsePositiveInteger(options.runs || '3', 'runs');
      if (options.harvestOnly) {
        const result = buildEvolutionDigest({
          workingDirectory: process.cwd(),
          targetDate,
          minOccurrences,
        });
        printJson({
          ok: true,
          mode: 'harvest_only',
          run_id: result.digest.run_id,
          digest_path: displayPath(result.digestPath),
          proposal_dir: displayPath(result.proposalDirectory),
          totals: result.digest.totals,
        });
        return;
      }

      if (!options.worker && !dependencies.runWorkflow) {
        const runWorker = dependencies.runWorker || runEvolutionSleepWorker;
        await runWorker({
          workingDirectory: process.cwd(),
          targetDate,
          minOccurrences,
          runsPerCase,
          verbose: options.verbose === true,
        });
        return;
      }

      await withEvolutionSleepLock(process.cwd(), async () => {
        const runWorkflow = dependencies.runWorkflow || runEvolutionSleep;
        const execution = await runWorkflow({
          workingDirectory: process.cwd(),
          targetDate,
          minOccurrences,
          runsPerCase,
          verbose: options.verbose === true,
        });
        const attempts = execution.result.attempts;
        const activated = attempts.filter(attempt => attempt.activated).length;
        const ok = activated === attempts.length;
        printJson({
          ok,
          mode: 'evolution',
          run_id: execution.result.evolution_run_id,
          status: attempts.length === 0 ? 'no_op' : ok ? 'completed' : 'blocked',
          attempts: attempts.length,
          activated,
          result_path: displayPath(execution.result_path),
          digest_path: displayPath(execution.digest_path),
        });
        if (options.worker && !ok) {
          process.exitCode = 1;
        }
      });
    });

  const schedule = evolution
    .command('schedule')
    .description('Install, inspect or remove the per-project nightly crontab entry');

  schedule
    .command('install')
    .option('--hour <n>', 'local hour (0-23)', '3')
    .option('--minute <n>', 'local minute (0-59)', '17')
    .action((options: { hour: string; minute: string }) => {
      const scheduler = createSchedule(options);
      printJson({ ok: true, action: 'install', ...scheduler.install() });
    });

  schedule
    .command('status')
    .action(() => {
      const scheduler = createSchedule({ hour: '3', minute: '17' });
      printJson({ ok: true, action: 'status', ...scheduler.status() });
    });

  schedule
    .command('remove')
    .action(() => {
      const scheduler = createSchedule({ hour: '3', minute: '17' });
      printJson({ ok: true, action: 'remove', ...scheduler.remove() });
    });
}

export async function runEvolutionSleepWorker(request: EvolutionSleepWorkerRequest): Promise<void> {
  const entryFile = path.resolve(process.argv[1]);
  const isTypeScriptEntry = entryFile.endsWith('.ts');
  const command = isTypeScriptEntry
    ? path.join(request.workingDirectory, 'node_modules', '.bin', 'tsx')
    : process.execPath;
  const args = [
    entryFile,
    'evolution',
    'sleep',
    '--worker',
    '--date',
    request.targetDate,
    '--min-occurrences',
    String(request.minOccurrences),
    '--runs',
    String(request.runsPerCase),
    ...(request.verbose ? ['--verbose'] : []),
  ];
  await runSupervisedProcess({
    command,
    args,
    workingDirectory: request.workingDirectory,
    timeoutMs: request.timeoutMs ?? evolutionWorkerTimeoutMs(),
    lockPath: evolutionSleepLockPath(request.workingDirectory),
  });
}

export async function runSupervisedProcess(options: SupervisedProcessOptions): Promise<void> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('EVOLUTION_SLEEP_TIMEOUT_MS 必须是正整数。');
  }
  const killGraceMs = options.killGraceMs ?? WORKER_KILL_GRACE_MS;
  if (!Number.isFinite(killGraceMs) || killGraceMs <= 0) {
    throw new Error('Evolution worker kill grace 必须是正整数。');
  }
  const child = spawn(options.command, options.args, {
    cwd: options.workingDirectory,
    env: process.env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (timedOut && options.lockPath && child.pid) {
        removeOwnedLock(options.lockPath, child.pid);
      }
      if (error) reject(error);
      else resolve();
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateSupervisedProcess(child.pid, 'SIGTERM', () => child.kill('SIGTERM'));
      forceKillTimer = setTimeout(
        () => {
          terminateSupervisedProcess(child.pid, 'SIGKILL', () => child.kill('SIGKILL'));
          finish(new Error(`EVOLUTION_SLEEP_TIMEOUT：worker 超过 ${options.timeoutMs}ms，已终止。`));
        },
        killGraceMs,
      );
    }, options.timeoutMs);
    timeoutTimer.unref();

    child.once('error', error => {
      if (timedOut) {
        if (!isSupervisedProcessGroupAlive(child.pid)) {
          finish(new Error(`EVOLUTION_SLEEP_TIMEOUT：worker 超过 ${options.timeoutMs}ms，已终止。`));
        }
        return;
      }
      finish(error);
    });
    child.once('close', (code, signal) => {
      if (timedOut) {
        if (!isSupervisedProcessGroupAlive(child.pid)) {
          finish(new Error(`EVOLUTION_SLEEP_TIMEOUT：worker 超过 ${options.timeoutMs}ms，已终止。`));
        }
        return;
      }
      if (code !== 0) {
        finish(new Error(`EVOLUTION_SLEEP_WORKER_FAILED：exit=${code ?? 'null'} signal=${signal || 'none'}`));
        return;
      }
      finish();
    });
  });
}

function isSupervisedProcessGroupAlive(pid: number | undefined): boolean {
  if (!pid || process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function createSchedule(options: { hour: string; minute: string }): EvolutionSleepSchedule {
  return new EvolutionSleepSchedule({
    workingDirectory: process.cwd(),
    hour: parseInteger(options.hour, 'hour'),
    minute: parseInteger(options.minute, 'minute'),
  });
}

function parseMinOccurrences(value: string | undefined): number {
  const parsed = parseInteger(value || '2', 'min-occurrences');
  if (parsed < 2 || parsed > 20) {
    throw new Error('min-occurrences 必须是 2 到 20 的整数。');
  }
  return parsed;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = parseInteger(value, name);
  if (parsed <= 0) throw new Error(`${name} 必须是正整数。`);
  return parsed;
}

function parseInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} 必须是整数。`);
  return Number(value);
}

async function withEvolutionSleepLock<T>(workingDirectory: string, action: () => Promise<T>): Promise<T> {
  const lockPath = evolutionSleepLockPath(workingDirectory);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let descriptor: number | undefined;
  try {
    descriptor = acquireLock(lockPath);
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    return await action();
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
  }
}

function evolutionWorkerTimeoutMs(): number {
  const raw = process.env.XIAOBA_EVOLUTION_SLEEP_TIMEOUT_MS;
  if (!raw) return DEFAULT_WORKER_TIMEOUT_MS;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    throw new Error('XIAOBA_EVOLUTION_SLEEP_TIMEOUT_MS 必须是正整数。');
  }
  return Number(raw);
}

function evolutionSleepLockPath(workingDirectory: string): string {
  return path.join(workingDirectory, 'output', 'evolution', 'sleep', '.run.lock');
}

function removeOwnedLock(lockPath: string, workerPid: number): void {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { pid?: number };
    if (lock.pid === workerPid) fs.unlinkSync(lockPath);
  } catch {
    // Never remove a lock unless it is readable and belongs to this worker.
  }
}

function terminateSupervisedProcess(
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback: () => boolean,
): void {
  if (pid && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the direct child if the process group is already gone.
    }
  }
  try {
    fallback();
  } catch {
    // The child may already have exited between timeout and signal delivery.
  }
}

function acquireLock(lockPath: string): number {
  try {
    return fs.openSync(lockPath, 'wx');
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (age <= STALE_LOCK_MS) {
      throw new Error(`EVOLUTION_SLEEP_ALREADY_RUNNING：${displayPath(lockPath)}`);
    }
    fs.unlinkSync(lockPath);
    return fs.openSync(lockPath, 'wx');
  }
}

function displayPath(filePath: string): string {
  const relative = path.relative(process.cwd(), filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.replace(/\\/g, '/')
    : filePath.replace(/\\/g, '/');
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
