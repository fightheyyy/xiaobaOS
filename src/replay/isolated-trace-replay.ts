import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { TraceReplayReport } from './trace-replay-runner';
import type { ReplaySandboxMode } from './replay-services';

export function runIsolatedTraceReplay(input: {
  codeRoot: string;
  workingDirectory: string;
  tracePath: string;
  outDir: string;
  parentSessionId: string;
  targetRole?: string;
  requiredActiveSkillName?: string;
  sessionKey: string;
  source: string;
  maxTurns: number;
  timeoutMs: number;
  sandboxMode: ReplaySandboxMode;
}): TraceReplayReport {
  const codeRoot = fs.realpathSync(path.resolve(input.codeRoot));
  const workingDirectory = fs.realpathSync(path.resolve(input.workingDirectory));
  const scriptPath = path.join(codeRoot, 'scripts', 'run-trace-replay.ts');
  let tsxPath: string;
  try {
    tsxPath = require.resolve('tsx/cli', { paths: [codeRoot] });
  } catch {
    throw new Error(`Isolated replay requires project-local tsx for: ${codeRoot}`);
  }
  if (!fs.existsSync(scriptPath)) throw new Error(`Isolated replay script is unavailable: ${scriptPath}`);
  fs.mkdirSync(input.outDir, { recursive: true });
  const args = [
    scriptPath,
    '--trace', input.tracePath,
    '--out', input.outDir,
    '--cwd', workingDirectory,
    '--session-key', input.sessionKey,
    '--source', input.source,
    '--max-turns', String(input.maxTurns),
    '--timeout-ms', String(input.timeoutMs),
    '--sandbox-mode', input.sandboxMode,
    '--parent-session-id', input.parentSessionId,
    ...(input.targetRole ? ['--role', input.targetRole] : []),
    ...(input.requiredActiveSkillName
      ? ['--required-active-skill', input.requiredActiveSkillName]
      : []),
  ];
  try {
    execFileSync(process.execPath, [tsxPath, ...args], {
      cwd: codeRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: input.timeoutMs * input.maxTurns + 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error: any) {
    const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf-8').trim() : '';
    throw new Error(`Isolated trace replay failed: ${stderr || String(error?.message || error)}`);
  }
  const manifestPath = path.join(input.outDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('Isolated trace replay did not produce manifest.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as TraceReplayReport;
}
