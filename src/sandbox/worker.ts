import { spawn } from 'child_process';
import * as fs from 'fs';
import { SandboxManager, SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime';
import * as dotenv from 'dotenv';
import type { SandboxPolicy } from './policy';

interface Request { policy: SandboxPolicy; command: string; input?: string; probe?: boolean }

/** One SDK manager per OS process: concurrent sessions cannot replace its policy. */
async function run(request: Request): Promise<void> {
  try {
    if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Sandbox platform unsupported; macOS or Linux is required.');
    if (request.policy.version !== 1 || !request.policy.cwd || !request.command) throw new Error('Invalid sandbox request.');
    process.chdir(request.policy.cwd);
    const envFile = process.env.DOTENV_CONFIG_PATH;
    if (envFile && fs.existsSync(envFile)) {
      const parsed = dotenv.parse(fs.readFileSync(envFile));
      for (const [name, value] of Object.entries(parsed)) if (/^XIAOBA_LLM_/.test(name) && !process.env[name]) process.env[name] = value;
    }
    delete process.env.DOTENV_CONFIG_PATH;
    // The SDK's host-side Unix bridge needs a short socket path. Task TMPDIR
    // can be a deeply nested candidate directory and is applied only below.
    process.env.TMPDIR = '/tmp';
    process.env.TMP = '/tmp';
    process.env.TEMP = '/tmp';
    await SandboxManager.initialize(SandboxRuntimeConfigSchema.parse(request.policy.config), undefined, false);
    const bridgeRoots = [SandboxManager.getLinuxHttpSocketPath(), SandboxManager.getLinuxSocksSocketPath()]
      .filter((value): value is string => Boolean(value)).map(value => ({ path: value, literal: true as const }));
    if (bridgeRoots.length) SandboxManager.updateConfig({ ...request.policy.config, filesystem: {
      ...request.policy.config.filesystem, allowRead: [...(request.policy.config.filesystem.allowRead || []), ...bridgeRoots],
    } });
    const wrapped = await SandboxManager.wrapWithSandbox(request.command, '/bin/bash');
    const child = spawn('/bin/bash', ['-c', wrapped], {
      cwd: request.policy.cwd,
      env: { ...process.env, HOME: request.policy.home, TMPDIR: request.policy.tmp, TMP: request.policy.tmp, TEMP: request.policy.tmp, XIAOBA_SANDBOXED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.stdin.on('error', () => {});
    child.stdin.end(request.input || '');
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', status => resolve(status ?? 1));
    });
    await SandboxManager.reset();
    process.exitCode = code;
    if (process.connected) process.disconnect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.send?.({ error_code: 'SANDBOX_UNAVAILABLE', message });
    process.stderr.write(`Sandbox initialization failed: ${message}\n`);
    await SandboxManager.reset().catch(() => {});
    process.exitCode = 125;
    if (process.connected) process.disconnect();
  }
}

if (process.argv[2] === '--policy') {
  const policy = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) as SandboxPolicy;
  const separator = process.argv.indexOf('--', 4);
  if (separator < 0) throw new Error('Sandbox command missing.');
  const { shellQuote } = require('./policy') as typeof import('./policy');
  void run({ policy, command: process.argv.slice(separator + 1).map(shellQuote).join(' ') });
} else {
  process.once('message', request => void run(request as Request));
}
