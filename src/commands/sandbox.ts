import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSandboxPolicy } from '../sandbox/policy';
import { sandboxExecutor } from '../sandbox/executor';

export function registerSandboxCommand(program: Command): void {
  program.command('sandbox').description('检查统一 Sandbox Runtime 执行环境')
    .command('check').description('实际启动 SDK 沙箱并检查可用性')
    .action(async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-sandbox-check-'));
      try {
        const result = await sandboxExecutor.probe(createSandboxPolicy({ cwd: root, scratchRoot: path.join(root, 'scratch') }));
        console.log(JSON.stringify({ backend: 'anthropic_sdk', platform: process.platform, ...result }, null, 2));
        if (!result.available) process.exitCode = 1;
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
}
