import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { sandboxEnvironment, shellQuote } from './policy';
import type { SandboxPolicy } from './policy';

export interface SandboxExecutionRequest {
  policy: SandboxPolicy;
  command: string;
  input?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  abortSignal?: AbortSignal;
  /** Reuse a verified outer SDK boundary, never establish an unsandboxed one. */
  inheritExistingSandbox?: boolean;
}
export interface SandboxExecutionResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  errorCode?: 'SANDBOX_UNAVAILABLE' | 'SANDBOX_TIMEOUT' | 'SANDBOX_CANCELLED' | 'SANDBOX_OUTPUT_LIMIT';
  error?: Error;
}

export function sandboxWorkerCommand(file = 'worker'): string[] {
  const built = path.join(__dirname, `${file}.js`);
  if (fs.existsSync(built)) return [process.execPath, built];
  return [process.execPath, '--require', require.resolve('tsx/cjs'), path.join(__dirname, `${file}.ts`)];
}

/** SDK is the sole backend; inherited execution stays in a runtime-launched SDK worker. */
export class SandboxExecutor {
  async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    if (request.abortSignal?.aborted) return { status: null, signal: null, stdout: '', stderr: '', errorCode: 'SANDBOX_CANCELLED', error: new Error('Sandbox execution cancelled.') };
    const timeoutMs = request.timeoutMs ?? 30_000;
    const maxBytes = request.maxOutputBytes ?? 10 * 1024 * 1024;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('Invalid sandbox execution limits.');
    return new Promise(resolve => {
      const inherited = request.inheritExistingSandbox && process.env.XIAOBA_SANDBOXED === '1';
      const [command, ...args] = inherited ? ['/bin/bash', '-c', request.command] : sandboxWorkerCommand();
      const proxyEnv: NodeJS.ProcessEnv = {};
      if (inherited) for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy']) proxyEnv[key] = process.env[key];
      const child = spawn(command, args, {
        cwd: request.policy.cwd, env: { ...sandboxEnvironment(), ...proxyEnv, ...request.environment, HOME: request.policy.home, TMPDIR: request.policy.tmp },
        detached: true, stdio: inherited ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let bytes = 0, errorCode: SandboxExecutionResult['errorCode'], error: Error | undefined;
      const kill = () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      };
      const stop = (code: NonNullable<SandboxExecutionResult['errorCode']>, message: string) => {
        if (!errorCode) { errorCode = code; error = new Error(message); }
        kill();
      };
      const collect = (target: Buffer[], chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { stop('SANDBOX_OUTPUT_LIMIT', 'Sandbox output limit exceeded.'); return; }
        target.push(chunk);
      };
      child.stdout?.on('data', chunk => collect(stdout, Buffer.from(chunk)));
      child.stderr?.on('data', chunk => collect(stderr, Buffer.from(chunk)));
      child.on('message', (message: any) => {
        if (message?.error_code === 'SANDBOX_UNAVAILABLE') { errorCode = 'SANDBOX_UNAVAILABLE'; error = new Error(message.message); }
      });
      child.once('error', cause => { error = cause; errorCode = 'SANDBOX_UNAVAILABLE'; });
      const abort = () => stop('SANDBOX_CANCELLED', 'Sandbox execution cancelled.');
      request.abortSignal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => stop('SANDBOX_TIMEOUT', `Sandbox timed out after ${timeoutMs}ms.`), timeoutMs);
      child.once('close', (status, signal) => {
        clearTimeout(timeout);
        request.abortSignal?.removeEventListener('abort', abort);
        kill(); // Do not leave detached task descendants after a normal exit either.
        resolve({ status, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), errorCode, error });
      });
      if (inherited) { child.stdin?.on('error', () => {}); child.stdin?.end(request.input || ''); }
      else child.send({ policy: request.policy, command: request.command, input: request.input }, cause => {
        if (cause) stop('SANDBOX_UNAVAILABLE', cause.message);
      });
      if (request.abortSignal?.aborted) abort();
    });
  }
  async probe(policy: SandboxPolicy): Promise<{ available: boolean; reason?: string }> {
    const result = await this.execute({ policy, command: 'printf sandbox-probe-ok', timeoutMs: 15_000 });
    return result.status === 0 && result.stdout === 'sandbox-probe-ok'
      ? { available: true } : { available: false, reason: result.error?.message || result.stderr || 'Sandbox execution failed.' };
  }
}

export function buildSandboxCommand(policyPath: string, command: string[]): string {
  return [...sandboxWorkerCommand(), '--policy', policyPath, '--', ...command].map(shellQuote).join(' ');
}

export const sandboxExecutor = new SandboxExecutor();
