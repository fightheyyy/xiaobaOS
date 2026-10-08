import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSubAgentToolExecutor } from '../src/core/sub-agent-session';
import { createSandboxPolicy } from '../src/sandbox/policy';
import { sandboxExecutor } from '../src/sandbox/executor';
import { ToolCall } from '../src/types/tool';

describe('SubAgent execution boundaries', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-subagent-security-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('hidden tools cannot be reached through legacy aliases', async () => {
    const executor = createSubAgentToolExecutor(root, 'hidden-aliases', undefined, {
      hiddenTools: ['write_file', 'edit_file', 'execute_shell'],
    });
    const target = path.join(root, 'target.txt');
    fs.writeFileSync(target, 'before', 'utf-8');

    const calls: Array<[string, Record<string, unknown>]> = [
      ['Write', { file_path: 'written.txt', content: 'should not exist' }],
      ['Edit', { file_path: 'target.txt', old_string: 'before', new_string: 'after' }],
      ['Bash', { command: 'touch bash-bypass.txt' }],
      ['Shell', { command: 'touch shell-bypass.txt' }],
      ['execute_bash', { command: 'touch execute-bash-bypass.txt' }],
    ];

    for (const [name, args] of calls) {
      const result = await executor.executeTool(toolCall(name, args));
      assert.equal(result.status, 'blocked', `${name} must be blocked after alias canonicalization`);
      assert.equal(result.error_code, 'TOOL_FORBIDDEN_IN_SUBAGENT');
    }

    assert.equal(fs.readFileSync(target, 'utf-8'), 'before');
    for (const file of ['written.txt', 'bash-bypass.txt', 'shell-bypass.txt', 'execute-bash-bypass.txt']) {
      assert.equal(fs.existsSync(path.join(root, file)), false, `${file} must not be created`);
    }
  });

  test('alias names in hiddenTools also block canonical tool names', async () => {
    const executor = createSubAgentToolExecutor(root, 'canonical-hidden', undefined, {
      hiddenTools: ['Write', 'Edit', 'Bash'],
    });

    for (const name of ['write_file', 'edit_file', 'execute_shell']) {
      const result = await executor.executeTool(toolCall(name, {}));
      assert.equal(result.status, 'blocked');
      assert.equal(result.error_code, 'TOOL_FORBIDDEN_IN_SUBAGENT');
    }
  });

  test('allowedWriteRoot permits local candidates and blocks traversal, absolute paths and symlink escape', async () => {
    const runRoot = path.join(root, 'run');
    const candidateRoot = path.join(runRoot, 'candidates');
    const outsideRoot = path.join(root, 'outside');
    fs.mkdirSync(candidateRoot, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });
    fs.symlinkSync(outsideRoot, path.join(candidateRoot, 'escape-link'), 'dir');

    const executor = createSubAgentToolExecutor(runRoot, 'write-boundary', undefined, {
      allowedWriteRoot: candidateRoot,
    });

    const allowed = await executor.executeTool(toolCall('write_file', {
      file_path: 'candidates/ok.txt',
      content: 'candidate',
    }));
    assert.equal(allowed.status, 'success', JSON.stringify(allowed));
    assert.equal(fs.readFileSync(path.join(candidateRoot, 'ok.txt'), 'utf-8'), 'candidate');

    const deniedPaths = [
      'candidates/../traversal.txt',
      path.join(candidateRoot, 'absolute.txt'),
      'candidates/escape-link/symlink.txt',
    ];
    for (const [index, filePath] of deniedPaths.entries()) {
      const result = await executor.executeTool(toolCall(index === 0 ? 'Write' : 'write_file', {
        file_path: filePath,
        content: 'must not escape',
      }));
      assert.equal(result.status, 'blocked', `${filePath} must be blocked`);
      assert.equal(result.error_code, 'PATH_DENIED');
    }

    assert.equal(fs.existsSync(path.join(runRoot, 'traversal.txt')), false);
    assert.equal(fs.existsSync(path.join(candidateRoot, 'absolute.txt')), false);
    assert.equal(fs.existsSync(path.join(outsideRoot, 'symlink.txt')), false);
  });

  test('ordinary subagents now keep writes within their SDK workspace', async () => {
    const runRoot = path.join(root, 'ordinary-run');
    fs.mkdirSync(runRoot, { recursive: true });
    const executor = createSubAgentToolExecutor(runRoot, 'ordinary-write');

    const result = await executor.executeTool(toolCall('write_file', {
      file_path: '../ordinary.txt',
      content: 'ordinary role behavior',
    }));

    assert.notEqual(result.status, 'success');
    assert.equal(fs.existsSync(path.join(root, 'ordinary.txt')), false);
  });

  test('allowedWriteRoot confines shell writes to the isolated root', async () => {
    const runRoot = path.join(root, 'shell-run');
    const outsideRoot = path.join(root, 'outside-shell');
    fs.mkdirSync(runRoot, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });
    const executor = createSubAgentToolExecutor(runRoot, 'shell-boundary', undefined, {
      allowedWriteRoot: runRoot,
    });

    const allowed = await executor.executeTool(toolCall('execute_shell', {
      command: 'touch shell-allowed.txt',
    }));
    const probe = await sandboxExecutor.probe(createSandboxPolicy({ cwd: runRoot, scratchRoot: path.join(runRoot, 'probe') }));
    if (!probe.available) {
      assert.equal(allowed.status, 'blocked');
      assert.equal(allowed.error_code, 'SANDBOX_UNAVAILABLE');
      return;
    }
    assert.equal(allowed.status, 'success', JSON.stringify(allowed));
    assert.equal(fs.existsSync(path.join(runRoot, 'shell-allowed.txt')), true);

    const escaped = await executor.executeTool(toolCall('execute_shell', {
      command: `touch ${shellQuote(path.join(outsideRoot, 'must-not-exist.txt'))}`,
    }));
    assert.equal(escaped.status, 'failure');
    assert.equal(fs.existsSync(path.join(outsideRoot, 'must-not-exist.txt')), false);
  });
});

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call-${name}-${Math.random().toString(16).slice(2)}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
