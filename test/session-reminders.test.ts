import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionReminderStore, registerReminderRoute, tickSessionReminders, reminderCheckMessage, EventDispatcher, DailyEventScheduler } from '../src/events';
import type { ReminderOwner, ReminderInput } from '../src/events/session-reminders';
import { ScheduleReminderTool } from '../src/tools/schedule-reminder-tool';
import { MessageSessionManager } from '../src/core/message-session-manager';
import { ToolManager } from '../src/tools/tool-manager';
import { registerCliSubAgentCallbacks } from '../src/commands/chat';
import { FeishuBot } from '../src/feishu';
import { WeixinBot } from '../src/weixin';
import { Logger } from '../src/utils/logger';

const before = new Date('2099-10-08T00:00:00Z');
const due = new Date('2099-10-09T08:00:00Z');
const owner: ReminderOwner = { sessionKey: 'user:alice', surface: 'feishu', channelId: 'alice-chat' };
const input: ReminderInput = { dueAt: '2099-10-09T15:00:00+08:00', purpose: '带上护照', source: 'user', mode: 'remind' };

describe('Session reminders and checks', () => {
  let root: string, store: SessionReminderStore;
  let disposers: Array<() => void>;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reminder-')); store = new SessionReminderStore(root); disposers = []; Logger.setSilentMode(true); });
  afterEach(() => { for (const dispose of disposers) dispose(); fs.rmSync(root, { recursive: true, force: true }); Logger.setSilentMode(false); });
  function route(consume: (record: any) => Promise<void>, available = () => true, surface = owner.surface) {
    disposers.push(registerReminderRoute(root, surface, { available, consume }));
  }

  test('persists normalized time and restores the original owner after restart', async () => {
    const created = await store.create(owner, { ...input, sessionKey: 'forged' } as any, before);
    assert.equal(created.dueAt, '2099-10-09T07:00:00.000Z');
    assert.deepEqual(new SessionReminderStore(root).read(created.id), created);
    assert.equal(created.sessionKey, owner.sessionKey);
    assert.equal(fs.statSync(path.join(root, 'data/reminders', created.id + '.json')).mode & 0o777, 0o600);
  });

  test('rejects ambiguous, impossible, past times and agent-authored direct reminders', async () => {
    for (const dueAt of ['2099-10-09T15:00:00', '2099-02-30T15:00:00Z', '2099-10-09T24:00:00Z', before.toISOString()]) {
      await assert.rejects(store.create(owner, { ...input, dueAt }, before), /REMINDER_TIME/);
    }
    await assert.rejects(store.create(owner, { ...input, source: 'agent' }, before), /REMINDER_INPUT_INVALID/);
  });

  test('update and cancel enforce session and surface ownership, revision and safe IDs', async () => {
    const created = await store.create(owner, input, before);
    for (const other of [{ ...owner, sessionKey: 'user:bob' }, { ...owner, surface: 'weixin' as const }]) {
      assert.deepEqual(store.list(other), []);
      await assert.rejects(store.update(other, created.id, { purpose: 'bad' }, before), /REMINDER_NOT_FOUND/);
      await assert.rejects(store.cancel(other, created.id, before), /REMINDER_NOT_FOUND/);
    }
    await assert.rejects(store.cancel(owner, '../../outside', before), /REMINDER_ID_INVALID/);
    const updated = await store.update(owner, created.id, { purpose: '带上签证', sessionKey: 'forged', channelId: 'forged' } as any, before);
    assert.equal(updated.revision, 2); assert.equal(updated.channelId, owner.channelId); assert.equal(updated.sessionKey, owner.sessionKey);
    await store.cancel(owner, created.id, before);
    assert.equal((await tickSessionReminders(root, due)).handled.length, 0);
    assert.equal((await store.cancel(owner, created.id, before)).status, 'cancelled');
  });

  test('offline and busy sessions stay pending with no Event, then catch up once', async () => {
    const record = await store.create(owner, input, before);
    assert.deepEqual((await tickSessionReminders(root, due)).deferred, [record.id]);
    let busy = true, deliveries = 0;
    route(async current => { assert.equal(current.channelId, owner.channelId); deliveries++; }, () => !busy);
    assert.deepEqual((await tickSessionReminders(root, due)).deferred, [record.id]);
    assert.equal(new EventDispatcher(path.join(root, 'data/events')).list().length, 0);
    busy = false;
    assert.deepEqual((await tickSessionReminders(root, due)).handled, [record.id]);
    await tickSessionReminders(root, new Date('2099-10-10T08:00:00Z'));
    assert.equal(deliveries, 1); assert.equal(store.read(record.id)!.status, 'completed');
    const event = new EventDispatcher(path.join(root, 'data/events')).list()[0];
    assert.equal(event.event.type, 'session.wakeup.due'); assert.equal(event.status, 'handled');
    assert.equal(event.event.target.sessionKey, owner.sessionKey);
  });

  test('changing due time invalidates an earlier due scan', async () => {
    const record = await store.create(owner, input, before);
    await store.update(owner, record.id, { dueAt: '2099-10-10T15:00:00+08:00' }, before);
    assert.equal(await store.consume(record.id, async () => assert.fail('stale due record'), due), false);
    await store.cancel(owner, record.id, before);
    assert.equal(await store.consume(record.id, async () => assert.fail('cancelled record'), new Date('2099-10-11T08:00:00Z')), false);
  });

  test('concurrent scanners and edits cannot duplicate or cancel an active delivery', async () => {
    const record = await store.create(owner, input, before);
    let release!: () => void, started!: () => void, deliveries = 0;
    const began = new Promise<void>(resolve => started = resolve);
    const finish = new Promise<void>(resolve => release = resolve);
    route(async () => { deliveries++; started(); await finish; });
    const first = tickSessionReminders(root, due); await began;
    await tickSessionReminders(root, due);
    await assert.rejects(store.cancel(owner, record.id, before), /REMINDER_BUSY_OR_INTERRUPTED/);
    await assert.rejects(store.update(owner, record.id, { purpose: 'changed' }, before), /REMINDER_BUSY_OR_INTERRUPTED/);
    release(); await first; assert.equal(deliveries, 1);
  });

  test('failed delivery is inspectable, never retried automatically; explicit update uses a new Event revision', async () => {
    const record = await store.create(owner, input, before);
    let attempts = 0, fail = true;
    route(async () => { attempts++; if (fail) throw new Error('platform down'); });
    assert.equal((await tickSessionReminders(root, due)).failed[0].error, 'platform down');
    await tickSessionReminders(root, due); assert.equal(attempts, 1);
    assert.equal(store.read(record.id)!.status, 'failed');
    fail = false;
    await store.update(owner, record.id, { dueAt: '2099-10-10T15:00:00+08:00' }, due);
    await tickSessionReminders(root, new Date('2099-10-10T08:00:00Z'));
    assert.equal(attempts, 2);
    assert.deepEqual(new EventDispatcher(path.join(root, 'data/events')).list().map(record => record.status).sort(), ['failed','handled']);
  });

  test('interrupted running records are retained without blind replay', async () => {
    const record = await store.create(owner, input, before);
    fs.writeFileSync(path.join(root, 'data/reminders', record.id + '.json'), JSON.stringify({ ...record, status: 'running' }));
    route(async () => assert.fail('interrupted work replayed'));
    await tickSessionReminders(root, due); assert.equal(store.read(record.id)!.status, 'running');
  });

  test('the shared workspace scheduler also admits due session reminders', async () => {
    const record = await store.create(owner, input, before);
    let count = 0; route(async () => { count++; });
    const result = await new DailyEventScheduler(root).tick([], due);
    assert.ok(result.handled.includes('reminder:' + record.id)); assert.equal(count, 1);
  });

  test('tool derives identity from trusted context, supports lifecycle and denies children', async () => {
    const tool = new ScheduleReminderTool();
    const context = { workingDirectory: root, sessionId: owner.sessionKey, surface: owner.surface, channel: { chatId: owner.channelId } } as any;
    const created = await tool.execute({ action: 'create', due_at: input.dueAt, purpose: input.purpose, source: 'user', mode: 'remind', sessionKey: 'forged' }, context);
    assert.equal(created.status, 'success');
    const record = JSON.parse(created.toolContent as string).result;
    assert.equal(record.sessionKey, owner.sessionKey);
    assert.equal((await tool.execute({ action: 'list' }, context)).status, 'success');
    assert.equal((await tool.execute({ action: 'cancel', reminder_id: record.id }, { ...context, sessionId: 'bob' })).error_code, 'REMINDER_NOT_FOUND');
    assert.equal((await tool.execute({ action: 'create' }, { ...context, parentSessionId: 'parent' })).error_code, 'REMINDER_OWNER_REQUIRED');
    assert.equal((await tool.execute({ action: 'create' }, { ...context, channel: undefined })).error_code, 'REMINDER_CHANNEL_REQUIRED');
    assert.equal((await tool.execute({ action: 'update', reminder_id: record.id, purpose: '签证' }, context)).status, 'success');
    assert.equal((await tool.execute({ action: 'cancel', reminder_id: record.id }, context)).status, 'success');
  });

  test('manager restores the original session: direct reminders bypass the model and checks may stay quiet', async () => {
    let modelCalls = 0;
    const services = { toolManager: new ToolManager(root),
      aiService: { async chatStream(messages: any[]) { modelCalls++; assert.equal(messages.filter(message => typeof message.content === 'string' && message.content.startsWith('[transient_current_clock]')).length, 1); assert.ok(messages.some(message => typeof message.content === 'string' && message.content.startsWith('[scheduled_wakeup]'))); return { content: '' }; }, async chat(messages: any[]) { return this.chatStream(messages); } },
      skillManager: { loadSkills: async () => {}, getAllSkills: () => [], getUserInvocableSkills: () => [], getSkill: () => undefined, findAutoInvocableSkillByText: () => undefined } } as any;
    const manager = new MessageSessionManager(services, 'feishu');
    const deliveries: Array<[string,string]> = [];
    manager.setReminderChannelFactory(() => ({ chatId: owner.channelId, reply: async (id, text) => { deliveries.push([id,text]); }, sendFile: async () => {} }));
    manager.startReminderProcessing();
    try {
      await store.create(owner, input, before);
      const check = await store.create(owner, { ...input, source: 'agent', mode: 'check', purpose: '检查护照手续是否已经结束' }, before);
      assert.match(reminderCheckMessage(check), /不扩大操作授权/);
      await tickSessionReminders(root, due);
      assert.deepEqual(deliveries, [[owner.channelId, input.purpose]]); assert.equal(modelCalls, 1);
      assert.equal(manager.getOrCreate(owner.sessionKey).key, owner.sessionKey);
      assert.ok(!(manager.getOrCreate(owner.sessionKey) as any).messages.some((message: any) => typeof message.content === 'string' && message.content.startsWith('[transient_current_clock]')));
      assert.equal(store.read(check.id)!.status, 'completed');
    } finally { await manager.destroy(); }
  });

  test('Feishu and Weixin routes use the saved original channels and restored context tokens', async () => {
    const originalCwd = process.cwd();
    process.chdir(root);
    const texts: Array<[string,string]> = [];
    const services = { toolManager: new ToolManager(root), aiService: {} as any, skillManager: { loadSkills: async () => {}, getAllSkills: () => [] } as any };
    const feishu = new FeishuBot({ appId: 'fake', appSecret: 'fake' }, { client: {} as any, wsClient: { start: () => undefined } as any,
      sender: { reply: async (id: string, text: string) => { texts.push([id,text]); } } as any, agentServices: services });
    const stateDir = path.join(root, 'weixin-state');
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(stateDir, 'context_tokens.json'), JSON.stringify({ 'user:wx-alice': 'restored-token' }));
    const weixin = new WeixinBot({ token: 'fake', baseUrl: 'https://weixin.invalid', cdnBaseUrl: 'https://cdn.invalid', stateDir });
    const wxTexts: Array<[string,string,string]> = [];
    (weixin as any).sender = { sendText: async (id: string, text: string, token: string) => { wxTexts.push([id,text,token]); } };
    try {
      await (weixin as any).stateReady;
      (feishu as any).sessionManager.startReminderProcessing();
      (weixin as any).sessionManager.startReminderProcessing();
      const fsRecord = await store.create(owner, input, before);
      const wxRecord = await store.create({ sessionKey: 'user:wx-alice', surface: 'weixin', channelId: 'wx-alice' }, input, before);
      const result = await tickSessionReminders(root, due);
      assert.equal(result.failed.length, 0);
      assert.equal(store.read(fsRecord.id)!.status, 'completed');
      assert.equal(store.read(wxRecord.id)!.status, 'completed');
      assert.deepEqual(texts, [[owner.channelId,input.purpose]]);
      assert.deepEqual(wxTexts, [['wx-alice',input.purpose,'restored-token']]);
    } finally { await feishu.destroy(); await weixin.destroy(); process.chdir(originalCwd); }
  });

  test('CLI check failures are propagated to the reminder ledger', async () => {
    const cliOwner: ReminderOwner = { sessionKey: 'cli:alice', surface: 'cli', channelId: 'cli:alice' };
    const fakeSession = { key: cliOwner.sessionKey, getWorkingDirectory: () => root, isBusy: () => false } as any;
    const callbacks = registerCliSubAgentCallbacks(fakeSession, async () => { throw new Error('model unavailable'); });
    disposers.push(() => callbacks.dispose());
    const record = await store.create(cliOwner, { ...input, source: 'agent', mode: 'check' }, before);
    const result = await tickSessionReminders(root, due);
    assert.equal(result.failed[0].error, 'model unavailable'); assert.equal(store.read(record.id)!.status, 'failed');
    await callbacks.drain();
  });
});
