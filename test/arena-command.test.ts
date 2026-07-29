import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import { registerArenaCommand } from '../src/commands/arena';

const originalCwd = process.cwd();

describe('registerArenaCommand', () => {
  let testRoot = '';
  let logs: string[] = [];
  let originalLog: typeof console.log;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-arena-command-'));
    process.chdir(testRoot);
    writeSkill(path.join(testRoot, 'skills', 'demo-skill'), 'demo-skill');
    originalLog = console.log;
    logs = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('registers arena import skill command', async () => {
    const program = createProgram();
    registerArenaCommand(program);

    await program.parseAsync(['node', 'xiaoba', 'arena', 'import', 'skill', 'skills/demo-skill']);

    const output = JSON.parse(logs.join('\n'));
    assert.strictEqual(output.subject.type, 'skill');
    assert.strictEqual(output.subject.name, 'demo-skill');
    assert.ok(fs.existsSync(path.join(
      testRoot,
      'arena',
      'subjects',
      output.subject_id,
      'arena-manifest.json',
    )));
  });

  test('registers a credential-free Barena live contract command', async () => {
    const program = createProgram();
    registerArenaCommand(program);

    await program.parseAsync(['node', 'xiaoba', 'arena', 'live-contract', '--json']);

    const output = JSON.parse(logs.join('\n'));
    assert.strictEqual(output.schema, 'barena.xiaoba_live_runtime_contract.v1');
    assert.strictEqual(output.bounds.target_calls_per_turn, 4);
    assert.strictEqual(output.enforcement.sdk_max_retries, 0);
  });

  test('registers the lightweight Scenario-based Arena entry', () => {
    const program = createProgram();
    registerArenaCommand(program);
    const arena = program.commands.find(command => command.name() === 'arena');
    const evaluate = arena?.commands.find(command => command.name() === 'evaluate');
    assert.ok(evaluate);
    assert.match(evaluate.description(), /Scenario -> Trace -> Finding\+Case -> shared Eval/);
    assert.ok(evaluate.options.some(option => option.long === '--scenario'));
    assert.ok(evaluate.options.some(option => option.long === '--role'));
    assert.ok(evaluate.options.some(option => option.long === '--skill'));

    const skill = arena?.commands.find(command => command.name() === 'skill');
    const run = arena?.commands.find(command => command.name() === 'run');
    const worker = run?.commands.find(command => command.name() === 'worker');
    for (const command of [skill, worker]) {
      assert.ok(command);
      assert.equal(command.options.some(option => option.long === '--message'), false);
      assert.equal(command.options.some(option => option.long === '--scenario-count'), false);
      assert.equal(command.options.some(option => option.long === '--max-replay-cases'), false);
    }
  });

  test('registers arena runtime prepare command', async () => {
    const importProgram = createProgram();
    registerArenaCommand(importProgram);
    await importProgram.parseAsync(['node', 'xiaoba', 'arena', 'import', 'skill', 'skills/demo-skill']);
    const manifest = JSON.parse(logs.join('\n'));
    logs = [];

    const runtimeProgram = createProgram();
    registerArenaCommand(runtimeProgram);
    await runtimeProgram.parseAsync([
      'node',
      'xiaoba',
      'arena',
      'runtime',
      'prepare',
      '--mode',
      'base_skill',
      '--subject',
      manifest.subject_id,
      '--run-id',
      'cli-clean',
      '--pass-env',
      'OPENAI_API_KEY',
    ]);

    const runtime = JSON.parse(logs.join('\n'));
    assert.strictEqual(runtime.run_id, 'cli-clean');
    assert.strictEqual(runtime.review_mode, 'base_skill');
    assert.strictEqual(runtime.target_profile.active_role_id, 'base');
    assert.ok(runtime.launch.pass_through_env.includes('OPENAI_API_KEY'));
    assert.ok(fs.existsSync(path.join(testRoot, 'arena', 'runs', 'cli-clean', 'clean-runtime.json')));
  });

  test('registers arena run execute dry-run command with sandbox shell runner', async () => {
    const importProgram = createProgram();
    registerArenaCommand(importProgram);
    await importProgram.parseAsync(['node', 'xiaoba', 'arena', 'import', 'skill', 'skills/demo-skill']);
    const manifest = JSON.parse(logs.join('\n'));
    logs = [];

    const executeProgram = createProgram();
    registerArenaCommand(executeProgram);
    await executeProgram.parseAsync([
      'node',
      'xiaoba',
      'arena',
      'run',
      'execute',
      '--mode',
      'base_skill',
      '--subject',
      manifest.subject_id,
      '--run-id',
      'cli-execute-dry',
      '--sandbox-engine',
      'macos_seatbelt',
      '--dry-run',
    ]);

    const output = JSON.parse(logs.join('\n'));
    assert.strictEqual(output.status, 'dry_run');
    assert.strictEqual(output.command_kind, 'sandbox_shell_command');
    assert.ok(fs.existsSync(path.join(testRoot, 'arena', 'runs', 'cli-execute-dry', 'arena-runner.json')));
  });

  test('registers arena run execute with workspace seed option', async () => {
    writeJson(path.join(testRoot, 'fixtures', 'workspace-seed', 'employee_data.json'), { name: 'Sarah Chen' });
    const importProgram = createProgram();
    registerArenaCommand(importProgram);
    await importProgram.parseAsync(['node', 'xiaoba', 'arena', 'import', 'skill', 'skills/demo-skill']);
    const manifest = JSON.parse(logs.join('\n'));
    logs = [];

    const executeProgram = createProgram();
    registerArenaCommand(executeProgram);
    await executeProgram.parseAsync([
      'node',
      'xiaoba',
      'arena',
      'run',
      'execute',
      '--mode',
      'base_skill',
      '--subject',
      manifest.subject_id,
      '--run-id',
      'cli-execute-seeded-dry',
      '--workspace-seed',
      'fixtures/workspace-seed',
      '--sandbox-engine',
      'macos_seatbelt',
      '--dry-run',
    ]);

    const output = JSON.parse(logs.join('\n'));
    const runtime = JSON.parse(fs.readFileSync(output.clean_runtime_path, 'utf-8'));
    assert.strictEqual(runtime.copied.workspace_seed.source, 'fixtures/workspace-seed');
    assert.ok(fs.existsSync(path.join(testRoot, 'arena', 'runs', 'cli-execute-seeded-dry', 'workspace', 'employee_data.json')));
  });

  test('registers arena skill shortcut for installed XiaoBa skills', async () => {
    const program = createProgram();
    registerArenaCommand(program);

    await program.parseAsync([
      'node',
      'xiaoba',
      'arena',
      'skill',
      'demo-skill',
      '--run-id',
      'cli-skill-dry',
      '--sandbox-engine',
      'macos_seatbelt',
      '--dry-run',
    ]);

    const output = JSON.parse(logs.join('\n'));
    assert.strictEqual(output.status, 'dry_run');
    assert.strictEqual(output.command, 'arena skill');
    assert.strictEqual(output.skill.name, 'demo-skill');
    assert.strictEqual(output.review_mode, 'base_skill');
    assert.strictEqual(output.run_id, 'cli-skill-dry');
    assert.strictEqual(output.command_kind, 'sandbox_shell_command');
    assert.ok(fs.existsSync(path.join(testRoot, 'arena', 'subjects', output.skill.subject_id, 'arena-manifest.json')));
    assert.ok(fs.existsSync(path.join(testRoot, 'arena', 'runs', 'cli-skill-dry', 'arena-runner.json')));
  });

  test('registers arena skill shortcut for previously imported Arena subjects', async () => {
    writeSkill(path.join(testRoot, 'external', 'hang-to-la-rating'), 'hang-to-la-rating');
    const importProgram = createProgram();
    registerArenaCommand(importProgram);
    await importProgram.parseAsync(['node', 'xiaoba', 'arena', 'import', 'skill', 'external/hang-to-la-rating']);
    logs = [];

    const program = createProgram();
    registerArenaCommand(program);
    await program.parseAsync([
      'node',
      'xiaoba',
      'arena',
      'skill',
      'hang-to-la-rating',
      '--run-id',
      'cli-imported-skill-dry',
      '--sandbox-engine',
      'macos_seatbelt',
      '--dry-run',
    ]);

    const output = JSON.parse(logs.join('\n'));
    assert.strictEqual(output.status, 'dry_run');
    assert.strictEqual(output.command, 'arena skill');
    assert.strictEqual(output.skill.name, 'hang-to-la-rating');
    assert.strictEqual(output.run_id, 'cli-imported-skill-dry');
    assert.strictEqual(output.command_kind, 'sandbox_shell_command');
    assert.ok(fs.existsSync(path.join(testRoot, 'arena', 'runs', 'cli-imported-skill-dry', 'arena-runner.json')));
  });
});

function createProgram(): Command {
  return new Command()
    .exitOverride()
    .configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined,
    });
}

function writeSkill(dirPath: string, name: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name} description`,
    '---',
    '',
    'Use evidence.',
    '',
  ].join('\n'), 'utf-8');
}

function writeJson(filePath: string, value: unknown): void {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf-8');
}
