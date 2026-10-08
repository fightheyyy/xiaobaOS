import * as fs from 'fs';
import * as path from 'path';
import { createSandboxPolicy, PACKAGE_DOMAINS, shellQuote } from './policy';
import { sandboxExecutor, sandboxWorkerCommand } from './executor';
import type { SandboxPolicy } from './policy';
import type { ToolExecutionContext, ToolExecutionOutput } from '../types/tool';
import { MemoryFinalizer } from '../utils/memory-finalizer';
import { PathResolver } from '../utils/path-resolver';
import { isWritePathWithinRoot } from '../utils/safety';

export const SANDBOX_FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'glob', 'grep']);

export function toolSandboxPolicy(context: ToolExecutionContext): SandboxPolicy {
  if (context.sandboxPolicy) return context.sandboxPolicy;
  const project = PathResolver.getProjectRoot();
  const cwd = path.resolve(context.workingDirectory);
  const scratch = fs.mkdtempSync(path.join(require('os').tmpdir(), 'xiaoba-tool-'));
  const session = context.parentSessionId || context.sessionId;
  return createSandboxPolicy({
    cwd, scratchRoot: scratch,
    readRoots: [...(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean), path.resolve(__dirname, '..'), path.resolve(__dirname, '../../node_modules'), path.join(project, 'dist'), path.join(project, 'src'), path.join(project, 'node_modules'), path.join(project, 'memory', 'MEMORY.md'),
      ...(session ? [MemoryFinalizer.getSessionDir(session, project)] : [])],
    denyRead: [path.join(project, 'data'), path.join(project, 'logs'), path.join(project, 'memory')],
    denyWrite: [path.join(project, 'data'), path.join(project, 'logs'), path.join(project, 'memory')],
    allowedDomains: PACKAGE_DOMAINS,
  });
}

export async function executeFileToolInSandbox(name: string, args: unknown, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
  const policy = toolSandboxPolicy(context);
  try {
    if (name === 'write_file' || name === 'edit_file') {
      const file = (args as any)?.file_path;
      const target = typeof file === 'string' ? path.resolve(context.workingDirectory, file) : '';
      const roots = policy.config.filesystem.allowWrite.flatMap(entry => typeof entry === 'string' ? [entry] : [entry.path]);
      if (!target || !roots.some(root => isWritePathWithinRoot(path.relative(root, target) || '.', root, root).allowed)) {
        return { toolContent: '写入路径超出沙箱工作目录。', status: 'blocked', error_code: 'PATH_DENIED', blocked_reason: 'Write path is outside the sandbox workspace.', retryable: false };
      }
    }
    const result = await sandboxExecutor.execute({
      policy, command: sandboxWorkerCommand('file-worker').map(shellQuote).join(' '),
      input: JSON.stringify({ name, args, workingDirectory: context.workingDirectory }),
      abortSignal: context.abortSignal,
    });
    if (result.status !== 0 || result.errorCode) {
      return { toolContent: result.error?.message || result.stderr || 'Sandbox file execution failed.',
        status: result.errorCode === 'SANDBOX_UNAVAILABLE' ? 'blocked' : result.errorCode === 'SANDBOX_CANCELLED' ? 'cancelled' : result.errorCode === 'SANDBOX_TIMEOUT' ? 'timeout' : 'failure',
        error_code: result.errorCode || 'SANDBOX_FILE_FAILED', retryable: false };
    }
    return JSON.parse(result.stdout) as ToolExecutionOutput;
  } finally {
    if (!context.sandboxPolicy) fs.rmSync(path.dirname(policy.home), { recursive: true, force: true });
  }
}
