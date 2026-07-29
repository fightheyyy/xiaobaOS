import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArenaManager } from '../src/arena/arena-manager';
import { executeArenaRun } from '../src/arena/arena-runner';

describe('Arena clean-runtime executor', () => {
  let root: string;
  let manager: ArenaManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-arena-runner-'));
    manager = new ArenaManager({ projectRoot: root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('dry-run invokes only the lightweight worker through the enforced sandbox', async () => {
    const manifest = manager.importLocalSkill({
      skillPath: writeSkill(path.join(root, 'fixtures', 'skills', 'dry-skill')),
    });
    const result = await executeArenaRun({
      projectRoot: root,
      runId: 'dry-run',
      reviewMode: 'base_skill',
      subjectId: manifest.subject_id,
      dryRun: true,
      sandbox: { engine: 'macos_seatbelt' },
    });

    assert.equal(result.status, 'dry_run');
    assert.equal(result.command_kind, 'sandbox_shell_command');
    assert.equal(result.sandbox_enforced, true);
    const runner = JSON.parse(fs.readFileSync(result.runner_path, 'utf-8'));
    assert.match(runner.sandbox_shell_command, /sandbox-exec/);
    assert.match(runner.sandbox_shell_command, /XIAOBA_ARENA_SANDBOXED='1'/);
    assert.match(runner.sandbox_shell_command, /arena' 'run' 'worker/);
    assert.deepEqual(runner.worker_command.slice(-2), ['--run-id', 'dry-run']);
    for (const removed of [
      '--message',
      '--scenario-count',
      '--max-replay-cases',
      '--timeout-ms',
    ]) {
      assert.equal(runner.worker_command.includes(removed), false);
    }
    const profile = fs.readFileSync(
      path.join(root, 'arena', 'runs', 'dry-run', 'sandbox', 'macos-seatbelt.sb'),
      'utf-8',
    );
    assert.ok(profile.includes(path.join(root, 'arena', 'runs', 'dry-run')));
    assert.match(profile, /\(allow file-write-data \(subpath "\/dev"\)\)/);
  });

  test('dry-run prepares the requested clean workspace seed', async () => {
    const manifest = manager.importLocalSkill({
      skillPath: writeSkill(path.join(root, 'fixtures', 'skills', 'seed-skill')),
    });
    writeJson(
      path.join(root, 'fixtures', 'workspace-seed', 'employee_data.json'),
      { name: 'Sarah Chen' },
    );

    const result = await executeArenaRun({
      projectRoot: root,
      runId: 'seeded',
      reviewMode: 'base_skill',
      subjectId: manifest.subject_id,
      workspaceSeedPath: 'fixtures/workspace-seed',
      dryRun: true,
      sandbox: { engine: 'macos_seatbelt' },
    });
    const runtime = JSON.parse(fs.readFileSync(result.clean_runtime_path, 'utf-8'));
    assert.deepEqual(runtime.copied.workspace_seed, {
      source: 'fixtures/workspace-seed',
      file_count: 1,
    });
    assert.equal(
      fs.existsSync(path.join(root, 'arena', 'runs', 'seeded', 'workspace', 'employee_data.json')),
      true,
    );
  });

  test('real execution fails before spawning when no provider is configured', async () => {
    const manifest = manager.importLocalSkill({
      skillPath: writeSkill(path.join(root, 'fixtures', 'skills', 'missing-env')),
    });

    await assert.rejects(() => executeArenaRun({
      projectRoot: root,
      runId: 'missing-env',
      reviewMode: 'base_skill',
      subjectId: manifest.subject_id,
      sandbox: { engine: 'macos_seatbelt' },
    }), /需要先配置 XiaoBa provider/);
    assert.equal(
      fs.existsSync(path.join(root, 'arena', 'runs', 'missing-env', 'arena-runner.json')),
      false,
    );
  });
});

function writeSkill(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), [
    '---',
    `name: ${path.basename(directory)}`,
    'description: Arena executor fixture',
    '---',
    '',
    '# Fixture',
    '',
  ].join('\n'), 'utf-8');
  return directory;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}
