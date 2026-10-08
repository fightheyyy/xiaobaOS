import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { Command } from 'commander';
import { DailyEventScheduler, WorkspaceSchedule, DailySchedule, dailyCalendar, FileEventStore, EventDispatcher } from '../src/events';
import { EvolutionSleepSchedule } from '../src/roles/evolution-cat/evolution-scheduler';
import { MemoryMaintenanceSchedule } from '../src/utils/memory-scheduler';
import { registerScheduleCommand } from '../src/commands/schedule';
import { registerMemoryCommand } from '../src/commands/memory';
import { ConversationJournal } from '../src/utils/conversation-journal';
import { MemoryFinalizer } from '../src/utils/memory-finalizer';

describe('Shared daily Scheduler and Event consumers', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-scheduler-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = new Date('2026-10-08T20:00:00Z');
  const plans: DailySchedule[] = ['evolution','memory'].map(id => ({ id: id as any, hour: 3, minute: 17, timezone: 'Asia/Shanghai' }));
  function cron(initial = '') { return { content: initial, read() { return this.content; }, write(value: string) { this.content = value; } }; }
  const marker = (root: string) => createHash('sha256').update(root).digest('hex').slice(0, 12);

  test('legacy facades share one cron, preserve sibling configuration, and remove cron only after last job', () => {
    const adapter = cron('5 1 * * * unrelated\n');
    const options = { workingDirectory: root, crontab: adapter, entryFile: '/tmp/main.js' };
    const evolution = new EvolutionSleepSchedule(options), memory = new MemoryMaintenanceSchedule({ ...options, hour: 4 });
    assert.equal(evolution.install().changed, true);
    memory.install();
    assert.equal((adapter.content.match(/schedule tick/g) || []).length, 1);
    assert.deepEqual(new WorkspaceSchedule(options).schedules().map(job => [job.id, job.hour]), [['evolution', 3], ['memory', 4]]);
    assert.equal(memory.install().changed, false);
    evolution.remove();
    assert.equal(memory.status().installed, true);
    assert.match(adapter.content, /schedule tick/);
    memory.remove();
    assert.equal(adapter.content.trim(), '5 1 * * * unrelated');
  });

  test('migration imports old schedules, removes both old blocks, and preserves another workspace', () => {
    const id = marker(root);
    const adapter = cron(`1 2 * * * unrelated\n# BEGIN xiaoba-evolution-sleep:${id}\n42 4 * * * node old evolution sleep\n# END xiaoba-evolution-sleep:${id}\n# BEGIN xiaoba-memory:${id}\n* * * * * node old memory maintain --scheduled --hour 6 --minute 5 --timezone 'Europe/London'\n# END xiaoba-memory:${id}\n# BEGIN xiaoba-memory:another\n* * * * * another-workspace\n# END xiaoba-memory:another\n`);
    const shared = new WorkspaceSchedule({ workingDirectory: root, crontab: adapter, entryFile: '/tmp/main.js' });
    assert.equal(shared.status().migrationRequired, true);
    shared.install([]); // migrate existing jobs without changing their times
    assert.equal(shared.status().migrationRequired, false);
    assert.deepEqual(shared.schedules().map(job => [job.id, job.hour, job.minute]), [['evolution', 4, 42], ['memory', 6, 5]]);
    assert.equal(shared.schedules()[1].timezone, 'Europe/London');
    assert.match(adapter.content, /another-workspace/);
    assert.equal((adapter.content.match(/schedule tick/g) || []).length, 1);
    assert.ok(!adapter.content.includes('node old'));
  });

  test('installation rolls back configuration when cron rejects the write', () => {
    const adapter = cron();
    const shared = new WorkspaceSchedule({ workingDirectory: root, crontab: adapter });
    shared.install(['memory']);
    const before = fs.readFileSync(path.join(root, 'data/scheduler/jobs.json'), 'utf8');
    adapter.write = () => { throw new Error('denied'); };
    const changedCommand = new WorkspaceSchedule({ workingDirectory: root, crontab: adapter, entryFile: '/tmp/new.js', hour: 8 });
    assert.throws(() => changedCommand.install(['evolution']), /denied/);
    assert.equal(fs.readFileSync(path.join(root, 'data/scheduler/jobs.json'), 'utf8'), before);
  });

  test('malformed owned cron refuses migration without dropping unrelated entries', () => {
    const adapter = cron(`# BEGIN xiaoba-memory:${marker(root)}\n* * * * * node old\nunrelated\n`);
    assert.throws(() => new WorkspaceSchedule({ workingDirectory: root, crontab: adapter }).install(['memory']), /SCHEDULE_CRON_BLOCK_INVALID/);
    assert.match(adapter.content, /unrelated/);
    assert.ok(!fs.existsSync(path.join(root, 'data/scheduler/jobs.json')));
  });

  test('daily admission survives restart and schedule time edits without duplicate execution', async () => {
    let count = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const scheduler = new DailyEventScheduler(root);
      scheduler.register('memory', async () => { count++; });
      await scheduler.tick([plans[1]], now);
    }
    const scheduler = new DailyEventScheduler(root);
    scheduler.register('memory', async () => { count++; });
    await scheduler.tick([{ ...plans[1], hour: 1 }], now);
    assert.equal(count, 1);
    assert.equal(new EventDispatcher(path.join(root, 'data/events')).list('handled')[0].event.source.kind, 'timer');
    await scheduler.tick([plans[1]], new Date('2026-10-09T20:00:00Z'));
    assert.equal(count, 2);
  });

  test('a failed Evolution Event does not prevent memory and is not retried by a minute tick', async () => {
    let evolution = 0, memory = 0;
    const scheduler = new DailyEventScheduler(root);
    scheduler.register('evolution', async () => { evolution++; throw new Error('worker failed'); });
    scheduler.register('memory', async () => { memory++; });
    const first = await scheduler.tick(plans, now);
    assert.deepEqual(first.handled, ['memory']);
    assert.equal(first.failed[0].id, 'evolution');
    assert.equal(new EventDispatcher(path.join(root, 'data/events')).list('failed').length, 1);
    await scheduler.tick(plans, now);
    assert.deepEqual([evolution, memory], [1, 1]);
    await assert.rejects(scheduler.dispatch('evolution', { manual: true }, now), /worker failed/);
    assert.equal(evolution, 2);
  });

  test('interrupted running Event and a concurrent second tick never start duplicate work', async () => {
    let release!: () => void, started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    const one = new DailyEventScheduler(root), two = new DailyEventScheduler(root);
    let count = 0;
    one.register('memory', async () => { count++; started(); await finish; });
    two.register('memory', async () => { count++; });
    const first = one.tick([plans[1]], now);
    await began;
    assert.deepEqual((await two.tick([plans[1]], now)).skipped, ['memory']);
    release(); await first;
    const store = new FileEventStore(path.join(root, 'data/events'));
    const record = store.list()[0];
    store.write({ ...record, status: 'running' });
    assert.deepEqual((await two.tick([plans[1]], now)).skipped, ['memory']);
    assert.equal(count, 1);
  });

  test('timezone and DST use local calendar dates and execute once across a repeated hour', async () => {
    assert.deepEqual(dailyCalendar(now), { day: '2026-10-09', minutes: 240 });
    const scheduler = new DailyEventScheduler(root);
    let count = 0;
    scheduler.register('memory', async () => { count++; });
    const ny: DailySchedule = { id: 'memory', timezone: 'America/New_York', hour: 1, minute: 17 };
    await scheduler.tick([ny], new Date('2026-11-01T05:20:00Z'));
    await scheduler.tick([ny], new Date('2026-11-01T06:20:00Z'));
    assert.equal(count, 1);
    await scheduler.tick([{ ...ny, hour: 2 }], new Date('2027-03-14T07:20:00Z')); // spring gap catches up at 03:20
    assert.equal(count, 2);
    await scheduler.tick([plans[1]], new Date('2026-10-08T18:00:00Z'));
    assert.equal(count, 2);
  });

  test('actual unified CLI routes both due jobs and retains per-session memory progress', async () => {
    const adapter = cron(), shared = new WorkspaceSchedule({ workingDirectory: root, crontab: adapter });
    shared.install(['memory','evolution']);
    await new ConversationJournal({ workingDirectory: root, env: { XIAOBA_CONVERSATION_RECORDING: '1' } }).record({ surface: 'cli', sessionKey: 'owner', role: 'user', content: [{ type: 'text', text: '以后喜欢简洁回复' }], delivery: { status: 'received' } });
    let workers = 0, planners = 0;
    const program = new Command();
    registerScheduleCommand(program, { root, schedule: shared, now: () => now, evolution: { runWorker: async () => { workers++; } }, memoryPlanner: async input => { planners++; return { actions: [{ action: 'remember', text: '喜欢简洁回复', kind: 'preference', confidence: 'high', evidence: [input.messages[0].message_id], reason: '用户陈述' }] }; } });
    await program.parseAsync(['node','xiaoba','schedule','tick']);
    await program.parseAsync(['node','xiaoba','schedule','tick']);
    assert.deepEqual([workers, planners], [1, 1]);
    assert.equal(MemoryFinalizer.loadSessionMemory('owner', root)!.records.length, 1);
    const events = new EventDispatcher(path.join(root, 'data/events')).list();
    assert.deepEqual(events.map(record => record.event.type).sort(), ['evolution.sleep.due','memory.maintenance.due','memory.maintenance.window']);
    assert.ok(events.every(record => record.status === 'handled'));
  });

  test('old memory --scheduled CLI consumes work instead of recursively skipping its own Event', async () => {
    await new ConversationJournal({ workingDirectory: root, env: { XIAOBA_CONVERSATION_RECORDING: '1' } }).record({ surface: 'cli', sessionKey: 'owner', role: 'user', content: [{ type: 'text', text: '喜欢简洁回复' }], delivery: { status: 'received' } });
    let count = 0;
    const program = new Command();
    registerMemoryCommand(program, { root, planner: async () => { count++; return { actions: [] }; } });
    // Midnight is always due. The legacy CLI now shares the same persisted admission slot.
    await program.parseAsync(['node','xiaoba','memory','maintain','--scheduled','--hour','0','--minute','0']);
    await program.parseAsync(['node','xiaoba','memory','maintain','--scheduled','--hour','0','--minute','0']);
    assert.equal(count, 1);
  });
});
