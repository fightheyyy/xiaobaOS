import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConversationJournal } from '../src/utils/conversation-journal';
import { MemoryMaintenance, MaintenanceInput, validateProposal, memoryCalendar } from '../src/utils/memory-maintenance';
import { MemoryFinalizer } from '../src/utils/memory-finalizer';
import { MemoryMaintenanceSchedule } from '../src/utils/memory-scheduler';
import { createSubAgentToolExecutor } from '../src/core/sub-agent-session';
import { buildFileMemoryContext } from '../src/utils/file-memory-context';
import { EventDispatcher } from '../src/events';
import { createMemoryPlanner, registerMemoryCommand } from '../src/commands/memory';
import { createRoleAwareToolManager } from '../src/bootstrap/tool-manager';
import { Command } from 'commander';
import { createHash } from 'crypto';

describe('Proactive file memory maintenance', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-maintenance-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = new Date('2026-10-08T20:00:00Z');
  const add = async (root: string, key = 'owner', text = '我更喜欢简洁回复') => new ConversationJournal({ workingDirectory: root, env: { XIAOBA_CONVERSATION_RECORDING: '1' } }).record({ surface: 'cli', sessionKey: key, role: 'user', content: [{ type: 'text', text }], delivery: { status: 'received' } });
  const proposal = (input: MaintenanceInput, text = '喜欢简洁回复') => ({ actions: [{ action: 'remember', text, kind: 'preference', confidence: 'high', evidence: [input.messages[0].message_id], reason: '用户明确表达稳定偏好' }] });

  test('processes incrementally, records evidence, and never crosses session scopes', async () => {
    await add(root); await add(root, 'other', '喜欢详细回答');
    const inputs: { key: string; input: MaintenanceInput }[] = [];
    const service = new MemoryMaintenance(root, async (input, target) => { inputs.push({ key: target.sessionKey, input }); return proposal(input, target.sessionKey === 'owner' ? '喜欢简洁回复' : '喜欢详细回答'); });
    assert.equal((await service.run({ now })).processed, 2);
    assert.ok(inputs.every(({ input }) => input.messages.length === 1));
    const owner = MemoryFinalizer.loadSessionMemory('owner', root)!;
    assert.equal(owner.records.length, 1);
    assert.equal(owner.records[0].source.kind, 'conversation');
    assert.ok(owner.records[0].source.messageIds?.length);
    assert.ok(!String(buildFileMemoryContext('owner', root)?.content).includes('喜欢详细回答'));
    await add(root, 'owner', '还喜欢 TypeScript');
    const next: number[] = [];
    await new MemoryMaintenance(root, async input => { next.push(input.messages.length); return { actions: [] }; }).run({ now });
    assert.deepEqual(next.sort(), [0, 1]);
  });

  test('failure retains cursor, records failed Event and prevents scheduled minute retry storms', async () => {
    await add(root);
    let calls = 0;
    const service = new MemoryMaintenance(root, async () => { calls++; throw new Error('offline'); });
    await assert.rejects(service.run({ now, scheduled: true }), /offline/);
    assert.deepEqual(new EventDispatcher(path.join(root, 'data/events')).list('failed').map(record => record.event.type).sort(), ['memory.maintenance.due', 'memory.maintenance.window']);
    assert.equal((await service.run({ now, scheduled: true })).skipped, true);
    assert.equal(calls, 1);
    let messages = 0;
    await new MemoryMaintenance(root, async input => { messages = input.messages.length; return proposal(input); }).run({ now });
    assert.equal(messages, 1);
  });

  test('rejects fabricated evidence and all invalid actions before writing', async () => {
    await add(root);
    await assert.rejects(new MemoryMaintenance(root, async input => ({ actions: [...proposal(input).actions, { action: 'forget', recordId: 'other-person', evidence: ['invented'], reason: 'bad' }] })).run({ now }), /MEMORY_PROPOSAL_INVALID/);
    assert.equal(MemoryFinalizer.loadSessionMemory('owner', root), null);
  });

  test('concurrent user correction wins over stale nightly plan', async () => {
    await add(root);
    await assert.rejects(new MemoryMaintenance(root, async input => {
      MemoryFinalizer.remember('owner', '喜欢丰富细节', { rootDir: root });
      return proposal(input);
    }).run({ now }), /MEMORY_CHANGED/);
    assert.match(MemoryFinalizer.loadSessionMemory('owner', root)!.records[0].text, /喜欢丰富细节/);
  });

  test('archive preserves full record without injecting archive contents or reviving it on finalization', async () => {
    await add(root);
    const saved = MemoryFinalizer.remember('owner', '以后使用旧工作方式', { rootDir: root });
    await new MemoryMaintenance(root, async () => ({ actions: [{ action: 'archive', recordId: saved.record.id, reason: '已有事实明确不再适用', evidence: [] }] })).run({ now });
    assert.equal(MemoryFinalizer.loadSessionMemory('owner', root)!.records.length, 0);
    const archive = path.join(path.dirname(saved.memoryPath), 'ARCHIVE.md');
    assert.match(fs.readFileSync(archive, 'utf8'), /以后使用旧工作方式/);
    assert.match(String(buildFileMemoryContext('owner', root)?.content), /ARCHIVE.md/);
    assert.ok(!String(buildFileMemoryContext('owner', root)?.content).includes('以后使用旧工作方式'));
    MemoryFinalizer.finalizeSession('owner', [{ role: 'user', content: '以后使用旧工作方式' }], { rootDir: root });
    assert.equal(MemoryFinalizer.loadSessionMemory('owner', root)!.records.length, 0);
    const hash = createHash('sha256').update(fs.readFileSync(saved.memoryPath, 'utf8')).digest('hex');
    assert.throws(() => MemoryFinalizer.applyMaintenance('owner', [{ ...proposal({ messages: [{ message_id: 'source' }] } as MaintenanceInput, '以后使用旧工作方式').actions[0], kind: saved.record.kind } as any], hash, root), /MEMORY_EXCLUDED_RECORD/);
  });

  test('append during maintenance stays for next window and incomplete tail never advances cursor', async () => {
    await add(root);
    await new MemoryMaintenance(root, async input => { await add(root, 'owner', '后续稳定事实'); return proposal(input); }).run({ now });
    let text = '';
    await new MemoryMaintenance(root, async input => { text = JSON.stringify(input.messages); return { actions: [] }; }).run({ now });
    assert.match(text, /后续稳定事实/);
    const journal = new ConversationJournal({ workingDirectory: root });
    fs.appendFileSync(journal.filePathFor('cli', 'owner'), '{"incomplete":');
    await new MemoryMaintenance(root, async input => { assert.equal(input.messages.length, 0); return { actions: [] }; }).run({ now });
  });

  test('replacement/truncation and interrupted project lock fail closed', async () => {
    await add(root);
    const service = new MemoryMaintenance(root, async () => ({ actions: [] }));
    await service.run({ now });
    const file = new ConversationJournal({ workingDirectory: root }).filePathFor('cli', 'owner');
    fs.writeFileSync(file, '');
    await assert.rejects(service.run({ now }), /MEMORY_JOURNAL_CHANGED/);
    fs.mkdirSync(path.join(root, 'data/memory/maintenance/.run.lock'));
    await assert.rejects(service.run({ now }), /MEMORY_MAINTENANCE_BUSY_OR_INTERRUPTED/);
  });

  test('nightly no-tool mode hides and blocks even forged write/remember calls', async () => {
    const executor = createSubAgentToolExecutor(root, 'nightly', 'evolution-cat', { allowedTools: [] });
    assert.deepEqual(executor.getToolDefinitions(), []);
    for (const name of ['write_file','remember','bash']) {
      const result = await executor.executeTool({ id: name, type: 'function', function: { name, arguments: '{}' } });
      assert.match(result.content, /不可调用/);
    }
  });

  test('timezone gating and daily receipt avoid duplicate scheduled models', async () => {
    await add(root);
    let calls = 0;
    const service = new MemoryMaintenance(root, async input => { calls++; return input.messages.length ? proposal(input) : { actions: [] }; });
    assert.deepEqual(memoryCalendar(now), { day: '2026-10-09', minutes: 240 });
    assert.equal((await service.run({ scheduled: true, now: new Date('2026-10-08T18:00:00Z') })).skipped, true);
    await service.run({ scheduled: true, now });
    await service.run({ scheduled: true, now });
    assert.equal(calls, 1);
    await service.run({ scheduled: true, now: new Date('2026-10-09T20:00:00Z') });
    assert.equal(calls, 2);
  });

  test('real EvolutionCat loop proposes JSON with zero tools and parent scoped memory', async () => {
    MemoryFinalizer.remember('owner', '喜欢简洁回答', { rootDir: root });
    MemoryFinalizer.remember('other', '喜欢秘密计划', { rootDir: root });
    let requests = 0;
    const ai = { chatStream: async (messages: any[], tools: any[]) => {
      requests++;
      assert.deepEqual(tools, []);
      const content = JSON.stringify(messages);
      assert.match(content, /喜欢简洁回答/);
      assert.ok(!content.includes('喜欢秘密计划'));
      return { content: '{"actions":[]}' };
    } };
    const result = await createMemoryPlanner(root, () => ai as any)({ messages: [], memories: MemoryFinalizer.loadSessionMemory('owner', root), now: now.toISOString() }, { sessionKey: 'owner', surface: 'cli' });
    assert.deepEqual(result, { actions: [] });
    assert.equal(requests, 1);
  });

  test('immediate role tool preserves uncertain provenance and archives through trusted parent', async () => {
    const manager = createRoleAwareToolManager(root, { sessionId: 'worker', parentSessionId: 'owner' }, 'evolution-cat');
    const saved = await manager.executeTool({ id: 'remember', type: 'function', function: { name: 'remember', arguments: JSON.stringify({ content: '推测用户在设计讨论中偏好图示', confidence: 'medium', evidence: '2026-10-08 用户连续请求机制图；仅适用于设计讨论' }) } });
    assert.equal(saved.status, 'success');
    const record = MemoryFinalizer.loadSessionMemory('owner', root)!.records[0];
    assert.equal(record.confidence, 'medium');
    assert.match(record.source.reason!, /2026-10-08/);
    const archived = await manager.executeTool({ id: 'archive', type: 'function', function: { name: 'remember', arguments: JSON.stringify({ action: 'archive', record_id: record.id, evidence: '用户后来说明图示仅是这次任务的需求，长期推断不成立' }) } });
    assert.equal(archived.status, 'success');
    assert.equal(archived.artifact_manifest?.[0].action, 'updated');
    assert.equal(MemoryFinalizer.loadSessionMemory('owner', root)!.records.length, 0);
    assert.equal(MemoryFinalizer.loadSessionMemory('worker', root), null);
  });

  test('CLI maintain reaches journal planner and writes scoped memory', async () => {
    await add(root);
    const program = new Command();
    registerMemoryCommand(program, { root, planner: async input => proposal(input) });
    await program.parseAsync(['node', 'xiaoba', 'memory', 'maintain']);
    assert.equal(MemoryFinalizer.loadSessionMemory('owner', root)!.records.length, 1);
  });

  test('replacement and forgetting apply in one batch with first-seen time retained', async () => {
    const old = MemoryFinalizer.remember('owner', '喜欢旧回复方式', { rootDir: root, now: new Date('2025-01-01Z') });
    const remove = MemoryFinalizer.remember('owner', '记住旧地址', { rootDir: root });
    await add(root, 'owner', '改为简洁回答，并忘掉旧地址');
    await new MemoryMaintenance(root, async input => ({ actions: [
      { ...proposal(input).actions[0], action: 'replace', recordId: old.record.id },
      { action: 'forget', recordId: remove.record.id, evidence: [input.messages[0].message_id], reason: '用户要求忘掉旧地址' },
    ] })).run({ now });
    const memory = MemoryFinalizer.loadSessionMemory('owner', root)!;
    assert.equal(memory.records.length, 1);
    assert.equal(memory.records[0].firstSeenAt, old.record.firstSeenAt);
    assert.match(memory.records[0].text, /喜欢简洁回复/);
  });

  test('scheduler install is idempotent, quotes paths, preserves other cron jobs and removes only own job', () => {
    let content = '15 2 * * * existing-job\n';
    const schedule = new MemoryMaintenanceSchedule({ workingDirectory: path.join(root, "some ' path"), entryFile: '/tmp/main.js', crontab: { read: () => content, write: value => { content = value; } } });
    assert.equal(schedule.install().changed, true);
    assert.equal(schedule.install().changed, false);
    assert.match(content, /existing-job/);
    assert.match(content, /schedule tick/);
    assert.equal(schedule.status().jobs[0].timezone, 'Asia/Shanghai');
    assert.equal(schedule.remove().changed, true);
    assert.equal(content.trim(), '15 2 * * * existing-job');
    assert.equal(schedule.remove().changed, false);
  });
});
