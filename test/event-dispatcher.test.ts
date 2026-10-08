import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { EventDispatcher, FileEventStore, createAgentEvent, surfaceAgentEvent } from '../src/events';
import type { AgentEvent, EventRecord, EventStatus, EventStore } from '../src/events';

describe('Event admission and dispatch', () => {
  const roots: string[] = [];
  function root(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-events-'));
    roots.push(dir);
    return dir;
  }
  function event(sourceEventId = 'change-1') {
    return createAgentEvent({
      type: 'calendar.changed', source: { kind: 'connector', id: 'feishu:account-1' },
      target: { sessionKey: 'user:owner' }, payload: { calendarId: 'primary' }, sourceEventId,
    });
  }
  afterEach(() => roots.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

  test('dispatches app changes and timer events without requiring a chat message', async () => {
    const dispatcher = new EventDispatcher(root());
    const observed: string[] = [];
    dispatcher.register('calendar.changed', async value => { observed.push(value.target.sessionKey); });
    dispatcher.register('briefing.due', async value => { observed.push(value.source.kind); });
    await dispatcher.dispatch(event());
    await dispatcher.dispatch(createAgentEvent({
      type: 'briefing.due', source: { kind: 'timer', id: 'morning-brief' },
      target: { sessionKey: 'user:owner' }, payload: { timezone: 'Asia/Shanghai' },
      sourceEventId: '2026-10-07T01:00:00Z',
    }));
    assert.deepEqual(observed, ['user:owner', 'timer']);
    assert.equal(dispatcher.list('handled').length, 2);
  });

  test('deduplicates concurrent delivery and delivery after a dispatcher restart', async () => {
    const dir = root();
    const dispatcher = new EventDispatcher(dir);
    let calls = 0;
    const handler = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); };
    const receipts = await Promise.all([dispatcher.dispatch(event(), handler), dispatcher.dispatch(event(), handler)]);
    assert.equal(calls, 1);
    assert.deepEqual(receipts.map(value => value.duplicate), [false, true]);
    const restarted = new EventDispatcher(dir);
    assert.equal((await restarted.dispatch(event(), handler)).duplicate, true);
    assert.equal(calls, 1);
  });

  test('prevents two independent dispatchers from claiming the same active event', async () => {
    const dir = root();
    const first = new EventDispatcher(dir);
    const second = new EventDispatcher(dir);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const operation = first.dispatch(event(), async () => blocked);
    await assert.rejects(second.dispatch(event(), async () => assert.fail('duplicate effect')), /EVENT_IN_PROGRESS_OR_INTERRUPTED/);
    release();
    await operation;
    assert.equal((await second.dispatch(event(), async () => assert.fail('duplicate effect'))).duplicate, true);
  });

  test('rejects reusing an event identity with a different payload, active or after restart', async () => {
    const dir = root();
    const dispatcher = new EventDispatcher(dir);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const operation = dispatcher.dispatch(event(), async () => blocked);
    const changed = { ...event(), payload: { calendarId: 'other' } };
    await assert.rejects(dispatcher.dispatch(changed, async () => assert.fail()), /EVENT_ID_CONFLICT/);
    release();
    await operation;
    await assert.rejects(new EventDispatcher(dir).dispatch(changed, async () => assert.fail()), /EVENT_ID_CONFLICT/);
  });

  test('persists a failed handler but never automatically repeats a possibly completed side effect', async () => {
    const dir = root();
    const dispatcher = new EventDispatcher(dir);
    let effects = 0;
    await assert.rejects(dispatcher.dispatch(event(), async () => {
      effects++;
      throw new Error('response lost after send');
    }), /response lost/);
    assert.equal(dispatcher.list('failed').length, 1);
    await assert.rejects(new EventDispatcher(dir).dispatch(event(), async () => { effects++; }), /EVENT_REVIEW_REQUIRED/);
    assert.equal(effects, 1);
  });

  test('blocks interrupted running records and retained locks after restart', async () => {
    const dir = root();
    const value = event();
    const file = path.join(dir, `${createHash('sha256').update(value.id).digest('hex')}.json`);
    fs.writeFileSync(file, JSON.stringify({ event: value, status: 'running', updatedAt: value.occurredAt }));
    await assert.rejects(new EventDispatcher(dir).dispatch(value, async () => assert.fail()), /EVENT_REVIEW_REQUIRED/);
    fs.mkdirSync(`${file}.lock`);
    await assert.rejects(new EventDispatcher(dir).dispatch(value, async () => assert.fail()), /EVENT_IN_PROGRESS_OR_INTERRUPTED/);
  });

  test('keeps tracing and raw platform secrets out of durable surface envelopes', async () => {
    const dir = root();
    const value = surfaceAgentEvent({
      surface: 'weixin', adapterId: 'weixin', eventType: 'weixin.message', eventId: 'msg-1',
      sessionKey: 'user:a', channelId: 'chat', userId: 'a', userMessage: 'hello', payloadType: 'text',
      traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
      metadata: { context_token: 'platform-secret', aes_key: 'media-secret' },
    });
    await new EventDispatcher(dir).dispatch(value, async received => assert.equal(received.traceparent, value.traceparent));
    const content = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8');
    assert.ok(!content.includes('traceparent'));
    assert.ok(!content.includes('platform-secret'));
    assert.ok(!content.includes('media-secret'));
    assert.equal(JSON.parse(content).event.payload.text, 'hello');
  });

  test('scopes platform event identities by app instance and target session', () => {
    const original = event();
    const other = createAgentEvent({ ...original, source: { kind: 'connector', id: 'feishu:account-2' }, sourceEventId: 'change-1' });
    const otherUser = createAgentEvent({ ...original, target: { sessionKey: 'user:other' }, sourceEventId: 'change-1' });
    assert.notEqual(original.id, other.id);
    assert.notEqual(original.id, otherUser.id);
    assert.equal(event().id, original.id);
  });

  test('rejects missing routes before attempting execution', async () => {
    const dispatcher = new EventDispatcher(root());
    await assert.rejects(dispatcher.dispatch(event()), /EVENT_ROUTE_MISSING/);
    assert.deepEqual(dispatcher.list(), []);
  });

  test('routes runtime completion through injected storage and protects admitted content from mutation', async () => {
    const records = new Map<string, EventRecord>();
    const transitions: EventStatus[] = [];
    let claimed = false;
    const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
    const store: EventStore = {
      read: id => {
        assert.ok(claimed);
        const record = records.get(id);
        return record && copy(record);
      },
      write: record => {
        assert.ok(claimed);
        assert.equal(record.event.traceparent, undefined);
        transitions.push(record.status);
        records.set(record.event.id, copy(record));
      },
      list: status => [...records.values()].filter(record => !status || record.status === status).map(copy),
      async withEventLock(_id, operation) {
        assert.equal(claimed, false);
        claimed = true;
        try { return await operation(); } finally { claimed = false; }
      },
    };
    const value = createAgentEvent({
      type: 'task.completed', source: { kind: 'runtime', id: 'subagent:engineer' },
      target: { sessionKey: 'user:owner' }, payload: { result: 'original' }, sourceEventId: 'task-1',
    });
    const original = copy(value);
    const dispatcher = new EventDispatcher(store);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    dispatcher.register('task.completed', async received => {
      received.target.sessionKey = 'consumer-mutated';
      (received.payload as { result: string }).result = 'consumer-mutated';
      await blocked;
    });
    const operation = dispatcher.dispatch(value);
    value.target.sessionKey = 'producer-mutated';
    value.payload.result = 'producer-mutated';
    release();
    await operation;
    assert.deepEqual(transitions, ['pending', 'running', 'handled']);
    assert.deepEqual(dispatcher.list('handled')[0].event, original);
    assert.equal(claimed, false);
    assert.equal((await new EventDispatcher(store).dispatch(original, async () => assert.fail())).duplicate, true);
  });

  test('fails closed on malformed records, unknown states and records stored under the wrong identity', async () => {
    const dir = root();
    const value = event();
    const file = path.join(dir, `${createHash('sha256').update(value.id).digest('hex')}.json`);
    const fixtures = [
      '{broken',
      JSON.stringify({ event: value, status: 'unknown', updatedAt: value.occurredAt }),
      JSON.stringify({ event: { ...value, id: 'different' }, status: 'pending', updatedAt: value.occurredAt }),
    ];
    for (const content of fixtures) {
      fs.writeFileSync(file, content);
      const store = new FileEventStore(dir);
      assert.throws(() => store.list(), /EVENT_STORE_CORRUPT/);
      await assert.rejects(new EventDispatcher(store).dispatch(value, async () => assert.fail()), /EVENT_STORE_CORRUPT/);
      assert.ok(!fs.existsSync(`${file}.lock`));
    }
  });

  test('rejects invalid envelopes before storage or consumer invocation', async () => {
    const dir = root();
    const dispatcher = new EventDispatcher(dir);
    for (const value of [
      { ...event(), source: { kind: 'unsupported', id: 'a' } },
      { ...event(), occurredAt: 'not-a-timestamp' },
      { ...event(), target: { sessionKey: '' } },
      { ...event(), payload: undefined },
    ]) {
      await assert.rejects(dispatcher.dispatch(value as AgentEvent, async () => assert.fail()), /EVENT_INVALID/);
    }
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});
