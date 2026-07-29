import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  assertReplaySandboxAvailable,
  createReplayServices,
} from '../src/replay/replay-services';

const originalSandboxed = process.env.XIAOBA_ARENA_SANDBOXED;

afterEach(() => {
  if (originalSandboxed === undefined) delete process.env.XIAOBA_ARENA_SANDBOXED;
  else process.env.XIAOBA_ARENA_SANDBOXED = originalSandboxed;
});

describe('Case Replay side-effect boundary', () => {
  test('read_only exposes only deterministic read tools and blocks hard-called writes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-replay-read-only-'));
    const services = await createReplayServices({
      working_directory: root,
      parent_session_id: 'evaluation:case-1',
      sandbox_mode: 'read_only',
    });
    assert.deepEqual(
      services.toolManager.getToolDefinitions().map(item => item.name).sort(),
      ['glob', 'grep', 'read_file'],
    );
    const result = await services.toolManager.executeTool({
      id: 'write-1',
      type: 'function',
      function: {
        name: 'write_file',
        arguments: JSON.stringify({
          file_path: 'must-not-exist.txt',
          content: 'forbidden',
        }),
      },
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error_code, 'CASE_REPLAY_TOOL_FORBIDDEN');
    assert.equal(fs.existsSync(path.join(root, 'must-not-exist.txt')), false);
  });

  test('workspace_write fails closed unless the process is already sandboxed', async () => {
    delete process.env.XIAOBA_ARENA_SANDBOXED;
    assert.throws(
      () => assertReplaySandboxAvailable('workspace_write'),
      /requires an enforced clean-runtime sandbox/,
    );

    process.env.XIAOBA_ARENA_SANDBOXED = '1';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-replay-write-'));
    const services = await createReplayServices({
      working_directory: root,
      parent_session_id: 'evaluation:case-2',
      sandbox_mode: 'workspace_write',
    });
    assert.deepEqual(
      services.toolManager.getToolDefinitions().map(item => item.name).sort(),
      ['edit_file', 'execute_shell', 'glob', 'grep', 'read_file', 'write_file'],
    );
    assert.equal(
      services.toolManager.getToolDefinitions().some(item => (
        item.name === 'send_text'
        || item.name === 'send_file'
        || item.name.startsWith('browser_')
        || item.name.startsWith('gui_')
      )),
      false,
    );
  });
});
