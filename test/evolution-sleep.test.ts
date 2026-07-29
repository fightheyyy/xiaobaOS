import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import {
  registerEvolutionCommand,
  runSupervisedProcess,
} from '../src/commands/evolution';
import {
  buildEvolutionDigest,
  normalizeEvolutionDate,
  previousLocalDate,
} from '../src/roles/evolution-cat/evolution-observer';
import {
  CrontabAdapter,
  EvolutionSleepSchedule,
} from '../src/roles/evolution-cat/evolution-scheduler';

describe('EvolutionCat nightly sleep', () => {
  let testRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-evolution-sleep-'));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('harvests terminal trace rows by timestamp across enclosing date directories', () => {
    const traceFile = path.join(testRoot, 'logs', 'sessions', 'pet', '2026-05-31', 'pet_xiaoba', 'traces.jsonl');
    writeJsonl(traceFile, [
      { ...terminalTrace('trace-1', localIso('2026-06-01', 8), '帮我整理日报', 'write_file', 'success'), session_id: 'pet:xiaoba:session-a' },
      { ...terminalTrace('trace-2', localIso('2026-06-01', 20), '帮我整理日报', 'write_file', 'failure'), session_id: 'pet:xiaoba:session-b' },
      {
        ...terminalTrace('trace-self', localIso('2026-06-01', 22), '[evolution_sleep] nightly', 'evolution_observe', 'success'),
      },
      {
        ...terminalTrace('trace-open', localIso('2026-06-01', 10), '仍在运行', 'read_file', 'success'),
        events: [{ event_type: 'session_started', status: 'started' }],
      },
      {
        ...terminalTrace('trace-synthetic', localIso('2026-06-01', 11), 'synthetic smoke', 'read_file', 'success'),
        events: [{ event_type: 'session_completed', status: 'success', environment: 'test' }],
      },
      {
        ...terminalTrace('trace-reviewer-replay', localIso('2026-06-01', 12), 'synthetic formal replay', 'read_file', 'success'),
        session_id: 'pet:xiaoba:role-engineer-cat:evolution-replay-20260601-1234',
      },
      {
        ...terminalTrace('trace-generic-replay', localIso('2026-06-01', 13), 'generic trace replay', 'read_file', 'success'),
        session_id: 'pet:xiaoba:custom-user-key:trace-replay-20260601-1234',
      },
    ], ['{broken-json']);

    const result = buildEvolutionDigest({
      workingDirectory: testRoot,
      targetDate: '2026-06-01',
      minOccurrences: 2,
      now: new Date('2026-07-01T00:00:00.000Z'),
    });

    assert.equal(result.digest.totals.observations, 2);
    assert.equal(result.digest.totals.sessions, 2);
    assert.equal(result.digest.totals.recurring_patterns, 1);
    assert.equal(result.digest.totals.self_run_rows, 1);
    assert.equal(result.digest.totals.synthetic_or_replay_rows, 3);
    assert.equal(result.digest.totals.non_terminal_rows, 1);
    assert.equal(result.digest.totals.malformed_rows, 1);
    assert.deepEqual(result.digest.patterns[0].terminal_status_counts, { success: 1, failure: 1 });
    assert.match(result.digest.observations[0].trace_ref, /logs\/sessions\/pet\/2026-05-31\/pet_xiaoba\/traces\.jsonl#trace-/);
    assert.equal(fs.existsSync(result.digestPath), true);
    assert.equal(fs.existsSync(result.proposalDirectory), true);

    const rerun = buildEvolutionDigest({
      workingDirectory: testRoot,
      targetDate: '2026-06-01',
      minOccurrences: 2,
      now: new Date('2026-07-01T00:00:00.000Z'),
    });
    assert.equal(rerun.artifactAction, 'updated');
    assert.deepEqual(
      rerun.digest.observations.map(item => item.observation_id),
      result.digest.observations.map(item => item.observation_id),
    );
  });

  test('does not call repeated turns in one session a recurring pattern', () => {
    const traceFile = path.join(testRoot, 'logs', 'sessions', 'pet', 'same-session', 'traces.jsonl');
    writeJsonl(traceFile, [
      terminalTrace('same-session-1', localIso('2026-06-01', 8), '帮我整理日报', 'read_file', 'success'),
      terminalTrace('same-session-2', localIso('2026-06-01', 9), '帮我整理日报', 'read_file', 'success'),
    ]);

    const result = buildEvolutionDigest({
      workingDirectory: testRoot,
      targetDate: '2026-06-01',
      minOccurrences: 2,
      now: new Date('2026-07-01T00:00:00.000Z'),
    });

    assert.equal(result.digest.totals.observations, 2);
    assert.equal(result.digest.totals.sessions, 1);
    assert.equal(result.digest.totals.recurring_patterns, 0);
    assert.deepEqual(result.digest.patterns, []);
  });

  test('sleep command invokes the lightweight workflow directly and harvest-only stays deterministic', async () => {
    process.chdir(testRoot);
    let received: Record<string, unknown> | undefined;
    const program = new Command();
    program.exitOverride();
    registerEvolutionCommand(program, {
      runWorkflow: async options => {
        received = options as unknown as Record<string, unknown>;
        return completedEvolution(testRoot, String(options.targetDate));
      },
    });
    await program.parseAsync(['node', 'xiaoba', 'evolution', 'sleep', '--date', '2026-06-01']);
    assert.equal(fs.realpathSync(String(received?.workingDirectory)), fs.realpathSync(testRoot));
    assert.equal(received?.targetDate, '2026-06-01');
    assert.equal(received?.minOccurrences, 2);
    assert.equal(received?.runsPerCase, 3);
    assert.equal(received?.verbose, false);

    assert.equal(normalizeEvolutionDate('2024-02-29'), '2024-02-29');
    assert.throws(() => normalizeEvolutionDate('2024-02-30'), /无效日期/);
    assert.match(previousLocalDate(new Date(2026, 0, 1, 12)), /^2025-12-31$/);
  });

  test('production sleep entry delegates to an isolated worker process', async () => {
    process.chdir(testRoot);
    let request: Record<string, unknown> | undefined;
    const program = new Command();
    program.exitOverride();
    registerEvolutionCommand(program, {
      runWorker: async value => {
        request = value as unknown as Record<string, unknown>;
      },
    });
    await program.parseAsync([
      'node', 'xiaoba', 'evolution', 'sleep', '--date', '2026-06-01', '--min-occurrences', '4', '--verbose',
    ]);
    assert.equal(fs.realpathSync(String(request?.workingDirectory)), fs.realpathSync(testRoot));
    assert.equal(request?.targetDate, '2026-06-01');
    assert.equal(request?.minOccurrences, 4);
    assert.equal(request?.verbose, true);
  });

  test('does not expose the removed manual promote command', () => {
    process.chdir(testRoot);
    const program = new Command();
    program.exitOverride();
    registerEvolutionCommand(program);
    const evolution = program.commands.find(command => command.name() === 'evolution');
    const promote = evolution?.commands.find(command => command.name() === 'promote');
    assert.equal(promote, undefined);
  });

  test('worker supervisor terminates a hung process and removes only its owned lock', async () => {
    const lockPath = path.join(testRoot, 'output', 'evolution', 'sleep', '.run.lock');
    const script = [
      "const fs = require('fs')",
      "const path = require('path')",
      `const lockPath = ${JSON.stringify(lockPath)}`,
      "fs.mkdirSync(path.dirname(lockPath), { recursive: true })",
      "fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }))",
      "setInterval(() => {}, 1000)",
    ].join(';');

    await assert.rejects(
      runSupervisedProcess({
        command: process.execPath,
        args: ['-e', script],
        workingDirectory: testRoot,
        timeoutMs: 100,
        lockPath,
      }),
      /EVOLUTION_SLEEP_TIMEOUT/,
    );
    assert.equal(fs.existsSync(lockPath), false);
  });

  test('worker supervisor does not remove a foreign lock after timeout', async () => {
    const lockPath = path.join(testRoot, 'output', 'evolution', 'sleep', '.run.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999 }));
    const script = 'setInterval(() => {}, 1000)';

    await assert.rejects(
      runSupervisedProcess({
        command: process.execPath,
        args: ['-e', script],
        workingDirectory: testRoot,
        timeoutMs: 100,
        lockPath,
      }),
      /EVOLUTION_SLEEP_TIMEOUT/,
    );
    assert.equal(fs.existsSync(lockPath), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf-8')), { pid: 999999 });
  });

  test('worker timeout keeps the group SIGKILL grace after the leader exits', async () => {
    if (process.platform === 'win32') return;

    const pidPath = path.join(testRoot, 'descendant.pid');
    const signalPath = path.join(testRoot, 'descendant.signal');
    const descendantScript = [
      "const fs = require('fs')",
      `const pidPath = ${JSON.stringify(pidPath)}`,
      `const signalPath = ${JSON.stringify(signalPath)}`,
      "fs.writeFileSync(pidPath, String(process.pid))",
      "process.on('SIGTERM', () => fs.appendFileSync(signalPath, 'T'))",
      'setInterval(() => {}, 1000)',
    ].join(';');
    const leaderScript = [
      "const { spawn } = require('child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' })`,
      'setInterval(() => {}, 1000)',
    ].join(';');

    let descendantPid: number | undefined;
    try {
      await assert.rejects(
        runSupervisedProcess({
          command: process.execPath,
          args: ['-e', leaderScript],
          workingDirectory: testRoot,
          timeoutMs: 500,
          killGraceMs: 300,
        }),
        /EVOLUTION_SLEEP_TIMEOUT/,
      );
      descendantPid = Number(fs.readFileSync(pidPath, 'utf-8'));
      assert.match(fs.readFileSync(signalPath, 'utf-8'), /T/);
      assert.equal(await waitForProcessExit(descendantPid), true, 'SIGKILL must terminate the surviving descendant');
    } finally {
      if (descendantPid && isProcessAlive(descendantPid)) {
        process.kill(descendantPid, 'SIGKILL');
      }
    }
  });

  test('blocked lightweight workflow persists its Result and marks the process unsuccessful', async () => {
    process.chdir(testRoot);
    const previousExitCode = process.exitCode;
    const resultPath = path.join(testRoot, 'output', 'evolution', 'runs', 'evolution-2026-06-01', 'evolution-result.json');
    const program = new Command();
    program.exitOverride();
    registerEvolutionCommand(program, {
      runWorkflow: async () => {
        const result = {
          evolution_run_id: 'evolution-2026-06-01',
          attempts: [{
            finding_case: {
              finding: {
                summary: 'invalid role contract',
                evidence_refs: ['logs/source/traces.jsonl'],
              },
              case: {
                case_id: 'case-role-contract',
                task: 'Reproduce the role contract failure.',
                oracle: {
                  hard_verifiers: ['trace_exists'],
                  semantic_criteria: ['The role contract remains valid.'],
                },
                source: {
                  trace_refs: ['logs/source/traces.jsonl'],
                },
              },
            },
            activated: false,
            reasons: ['invalid role contract'],
          }],
        };
        fs.mkdirSync(path.dirname(resultPath), { recursive: true });
        fs.writeFileSync(resultPath, JSON.stringify(result), 'utf-8');
        return {
          result,
          result_path: resultPath,
          digest_path: path.join(testRoot, 'output', 'evolution', 'sleep', '2026-06-01', 'digest.json'),
        };
      },
    });

    try {
      process.exitCode = undefined;
      await program.parseAsync([
        'node', 'xiaoba', 'evolution', 'sleep', '--worker', '--date', '2026-06-01',
      ]);
      assert.equal(process.exitCode, 1);
      assert.equal(fs.existsSync(resultPath), true);
      assert.equal(JSON.parse(fs.readFileSync(resultPath, 'utf-8')).attempts[0].activated, false);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  test('nightly schedule install is project-scoped, idempotent and removable', () => {
    const crontab = new MemoryCrontab('5 1 * * * /usr/bin/other\n');
    const schedule = new EvolutionSleepSchedule({
      workingDirectory: testRoot,
      hour: 3,
      minute: 17,
      entryFile: path.join(testRoot, 'dist', 'index.js'),
      nodeExecutable: '/usr/bin/node',
      crontab,
    });

    const first = schedule.install();
    assert.equal(first.installed, true);
    assert.equal(first.changed, true);
    assert.match(crontab.content, /5 1 \* \* \* \/usr\/bin\/other/);
    assert.match(crontab.content, /17 3 \* \* \*/);
    assert.match(crontab.content, /evolution sleep/);
    assert.equal(schedule.install().changed, false);
    assert.equal(schedule.status().installed, true);
    const defaultStatusReader = new EvolutionSleepSchedule({
      workingDirectory: testRoot,
      entryFile: path.join(testRoot, 'dist', 'index.js'),
      nodeExecutable: '/usr/bin/node',
      crontab,
    });
    assert.equal(defaultStatusReader.status().schedule, '17 3 * * *');
    assert.equal(defaultStatusReader.status().command, first.command);
    const removed = schedule.remove();
    assert.equal(removed.changed, true);
    assert.equal(removed.installed, false);
    assert.match(crontab.content, /\/usr\/bin\/other/);
    assert.doesNotMatch(crontab.content, /xiaoba-evolution-sleep/);
  });
});

class MemoryCrontab implements CrontabAdapter {
  constructor(public content = '') {}
  read(): string { return this.content; }
  write(content: string): void { this.content = content; }
}

function completedEvolution(root: string, targetDate: string) {
  return {
    result: {
      evolution_run_id: `evolution-${targetDate}`,
      attempts: [],
    },
    result_path: path.join(root, 'output/evolution/runs', `evolution-${targetDate}`, 'evolution-result.json'),
    digest_path: path.join(root, 'output/evolution/sleep', targetDate, 'digest.json'),
  };
}

function terminalTrace(
  traceId: string,
  timestamp: string,
  userText: string,
  toolName: string,
  terminalStatus: string,
): Record<string, unknown> {
  return {
    schema_version: 3,
    entry_type: 'trace',
    trace_id: traceId,
    trace_index: 1,
    episode_id: traceId,
    episode_index: 1,
    turn_id: `${traceId}.turn.1`,
    turn: 1,
    timestamp,
    session_id: 'pet:xiaoba',
    session_type: 'pet',
    user: { text: userText },
    assistant: {
      text: '完成',
      tool_calls: [{
        id: `${traceId}.tool.1`,
        name: toolName,
        arguments: {},
        result: terminalStatus === 'success' ? 'ok' : 'failed',
        status: terminalStatus === 'success' ? 'success' : 'failure',
        ...(terminalStatus === 'failure' ? { error_code: 'DEMO_FAILURE' } : {}),
      }],
    },
    tokens: { prompt: 1, completion: 1 },
    events: [{
      schema_version: 3,
      entry_type: 'runtime_event',
      event_id: `${traceId}.event`,
      event_type: 'session_completed',
      timestamp,
      session_id: 'pet:xiaoba',
      session_type: 'pet',
      status: terminalStatus,
    }],
  };
}

async function waitForProcessExit(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function writeJsonl(filePath: string, entries: unknown[], rawLines: string[] = []): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    [...entries.map(entry => JSON.stringify(entry)), ...rawLines].join('\n') + '\n',
    'utf-8',
  );
}

function localIso(date: string, hour: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, hour, 0, 0, 0).toISOString();
}
