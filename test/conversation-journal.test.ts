import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CONVERSATION_BATCH_SCHEMA,
  CONVERSATION_MESSAGE_SCHEMA,
  ConversationJournal,
  ConversationMessageConflictError,
  createConversationMessageId,
  createConversationTraceId,
  createTraceId,
  stableId,
} from '../src/utils/conversation-journal';

describe('ConversationJournal', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function temporaryRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-conversation-journal-'));
    temporaryRoots.push(root);
    return root;
  }

  test('writes the exact message schema in per-surface append order across restarts', async () => {
    const root = temporaryRoot();
    const env = {
      NODE_ENV: 'test',
      XIAOBA_CONVERSATION_RECORDING_ENABLED: 'true',
      OTEL_SERVICE_NAME: 'xiaoba-test-agent',
    } as NodeJS.ProcessEnv;
    const now = () => new Date('2026-08-06T01:02:03.000Z');
    const firstJournal = new ConversationJournal({ workingDirectory: root, env, now });
    const first = await firstJournal.record({
      surface: 'feishu',
      sessionKey: 'user:open-id-sensitive',
      role: 'user',
      content: [{ type: 'text', text: '你好' }],
      delivery: { status: 'received', platform_message_ids: ['om_inbound'] },
      traceId: '11111111111111111111111111111111',
      messageId: 'msg_inbound',
      roleName: 'User',
    });

    const secondJournal = new ConversationJournal({ workingDirectory: root, env, now });
    const second = await secondJournal.record({
      surface: 'feishu',
      sessionKey: 'user:open-id-sensitive',
      role: 'assistant',
      content: [{ type: 'file', name: 'report.pdf', ref: 'artifact:report' }],
      delivery: { status: 'delivered', platform_message_ids: ['om_outbound'] },
      traceId: '11111111111111111111111111111111',
      messageId: 'msg_outbound',
      agentName: '小八',
    });

    assert.equal(first.created, true);
    assert.equal(first.message.sequence, 1);
    assert.equal(second.message.sequence, 2);
    assert.deepStrictEqual(first.message, {
      schema: CONVERSATION_MESSAGE_SCHEMA,
      message_id: 'msg_inbound',
      conversation_id: first.message.conversation_id,
      occurred_at: '2026-08-06T01:02:03.000Z',
      runtime: 'xiaobaos',
      agent_id: 'xiaoba-test-agent',
      surface: 'feishu',
      role: 'user',
      role_name: 'User',
      content: [{ type: 'text', text: '你好' }],
      delivery: { status: 'received', platform_message_ids: ['om_inbound'] },
      trace_id: '11111111111111111111111111111111',
      sequence: 1,
    });

    const filePath = firstJournal.filePathFor('feishu', 'user:open-id-sensitive');
    assert.equal(path.dirname(filePath), path.join(root, 'data', 'conversations', 'feishu'));
    assert.doesNotMatch(path.basename(filePath), /open-id-sensitive/);
    const rows = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepStrictEqual(rows, [first.message, second.message]);
  });

  test('is idempotent for the same stable id and rejects a conflicting fact', async () => {
    const root = temporaryRoot();
    let clock = 0;
    const journal = new ConversationJournal({
      workingDirectory: root,
      env: {
        NODE_ENV: 'test',
        XIAOBA_CONVERSATION_RECORDING_ENABLED: 'true',
      },
      now: () => new Date(1_700_000_000_000 + clock++ * 1_000),
    });
    const input = {
      surface: 'cli' as const,
      sessionKey: 'cli:default',
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: '完成' }],
      delivery: { status: 'delivered' as const },
      traceId: '22222222222222222222222222222222',
      messageId: 'msg_idempotent',
    };

    const first = await journal.record(input);
    const duplicate = await journal.record(input);

    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.deepStrictEqual(duplicate.message, first.message);
    const rows = fs.readFileSync(journal.filePathFor('cli', input.sessionKey), 'utf8').trim().split('\n');
    assert.equal(rows.length, 1);

    await assert.rejects(
      journal.record({
        ...input,
        content: [{ type: 'text', text: '不同内容' }],
      }),
      ConversationMessageConflictError,
    );
  });

  test('serializes concurrent appends per conversation without duplicate sequences', async () => {
    const root = temporaryRoot();
    const journal = new ConversationJournal({
      workingDirectory: root,
      env: {
        NODE_ENV: 'test',
        XIAOBA_CONVERSATION_RECORDING_ENABLED: 'true',
      },
    });
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) => journal.record({
      surface: 'pet',
      sessionKey: 'pet:concurrent',
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `message-${index}` }],
      delivery: { status: index % 2 === 0 ? 'received' : 'delivered' },
      messageId: `msg_concurrent_${index}`,
    })));

    assert.deepStrictEqual(
      results.map(result => result.message.sequence),
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    const rows = fs.readFileSync(journal.filePathFor('pet', 'pet:concurrent'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.deepStrictEqual(rows.map(row => row.sequence), Array.from({ length: 24 }, (_, index) => index + 1));
  });

  test('defaults recording off in tests and on outside tests with an explicit override', async () => {
    const implicitTest = new ConversationJournal({ workingDirectory: temporaryRoot() });
    assert.equal(implicitTest.isEnabled(), false);

    const disabledRoot = temporaryRoot();
    const disabled = new ConversationJournal({
      workingDirectory: disabledRoot,
      env: { NODE_ENV: 'test' },
    });
    const skipped = await disabled.record({
      surface: 'pet',
      sessionKey: 'pet:alpha',
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      delivery: { status: 'received' },
      messageId: 'msg_disabled',
    });
    assert.equal(disabled.isEnabled(), false);
    assert.equal(skipped.created, false);
    assert.equal(fs.existsSync(disabled.filePathFor('pet', 'pet:alpha')), false);

    const production = new ConversationJournal({
      workingDirectory: temporaryRoot(),
      env: { NODE_ENV: 'production' },
    });
    const explicitTest = new ConversationJournal({
      workingDirectory: temporaryRoot(),
      env: {
        NODE_ENV: 'test',
        XIAOBA_CONVERSATION_RECORDING_ENABLED: '1',
      },
    });
    assert.equal(production.isEnabled(), true);
    assert.equal(explicitTest.isEnabled(), true);
  });

  test('preserves a malformed trailing line and continues from the last valid sequence', async () => {
    const root = temporaryRoot();
    const journal = new ConversationJournal({
      workingDirectory: root,
      env: {
        NODE_ENV: 'test',
        XIAOBA_CONVERSATION_RECORDING_ENABLED: 'true',
      },
    });
    const base = {
      surface: 'cli' as const,
      sessionKey: 'cli:malformed-tail',
      role: 'assistant' as const,
      delivery: { status: 'delivered' as const },
    };
    await journal.record({
      ...base,
      content: [{ type: 'text', text: 'first' }],
      messageId: 'msg_first',
    });
    const filePath = journal.filePathFor(base.surface, base.sessionKey);
    fs.appendFileSync(filePath, '{"schema":"xiaoba.conversation_message.v1"', 'utf8');

    const second = await journal.record({
      ...base,
      content: [{ type: 'text', text: 'second' }],
      messageId: 'msg_second',
    });

    assert.equal(second.message.sequence, 2);
    const raw = fs.readFileSync(filePath, 'utf8');
    assert.match(raw, /\{"schema":"xiaoba\.conversation_message\.v1"\n/);
    const validRows = raw.split('\n').flatMap(line => {
      try {
        const row = JSON.parse(line);
        return typeof row.sequence === 'number' ? [row] : [];
      } catch {
        return [];
      }
    });
    assert.deepStrictEqual(validRows.map(row => row.sequence), [1, 2]);
  });

  test('posts one exact Catena batch after append and fails open on export errors', async () => {
    const root = temporaryRoot();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const journal = new ConversationJournal({
      workingDirectory: root,
      env: {
        NODE_ENV: 'test',
        XIAOBA_CONVERSATION_RECORDING_ENABLED: 'true',
        XIAOBA_CONVERSATION_AGENT_ID: 'agent-override',
        CATENA_BASE_URL: 'https://catena.example/root/',
        CATENA_API_KEY: 'catena-secret',
      },
      fetchImpl,
      now: () => new Date('2026-08-06T05:00:00.000Z'),
    });
    const result = await journal.record({
      surface: 'weixin',
      sessionKey: 'user:wx-id',
      role: 'assistant',
      content: [{ type: 'text', text: '已发送' }],
      delivery: { status: 'delivered', platform_message_ids: ['wx-message'] },
      traceId: '33333333333333333333333333333333',
      messageId: 'msg_export',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://catena.example/root/v1/ingest/conversations');
    assert.deepStrictEqual(requests[0].init?.headers, {
      'Authorization': 'Bearer catena-secret',
      'Content-Type': 'application/json',
    });
    assert.ok(requests[0].init?.signal instanceof AbortSignal);
    assert.deepStrictEqual(JSON.parse(String(requests[0].init?.body)), {
      schema: CONVERSATION_BATCH_SCHEMA,
      messages: [result.message],
    });

    const failingRoot = temporaryRoot();
    const failing = new ConversationJournal({
      workingDirectory: failingRoot,
      env: {
        NODE_ENV: 'test',
        XIAOBA_CONVERSATION_RECORDING_ENABLED: 'true',
        CATENA_BASE_URL: 'https://offline.example',
        CATENA_API_KEY: 'secret',
      },
      fetchImpl: (async () => {
        throw new Error('collector unavailable');
      }) as typeof fetch,
    });
    const failOpenResult = await failing.record({
      surface: 'cli',
      sessionKey: 'cli:offline',
      role: 'assistant',
      content: [{ type: 'text', text: 'still local' }],
      delivery: { status: 'delivered' },
      messageId: 'msg_still_local',
    });
    assert.equal(failOpenResult.created, true);
    assert.equal(fs.existsSync(failing.filePathFor('cli', 'cli:offline')), true);

    let pendingSignal: AbortSignal | null | undefined;
    const bounded = new ConversationJournal({
      workingDirectory: temporaryRoot(),
      env: {
        NODE_ENV: 'test',
        XIAOBA_CONVERSATION_RECORDING_ENABLED: 'true',
        CATENA_BASE_URL: 'https://pending.example',
        CATENA_API_KEY: 'secret',
      },
      fetchImpl: (async (_url, init) => {
        pendingSignal = init?.signal;
        return new Promise<Response>(() => undefined);
      }) as typeof fetch,
      exportTimeoutMs: 5,
    });
    const boundedResult = await bounded.record({
      surface: 'cli',
      sessionKey: 'cli:pending',
      role: 'assistant',
      content: [{ type: 'text', text: 'local before export' }],
      delivery: { status: 'delivered' },
      messageId: 'msg_bounded',
    });
    assert.equal(boundedResult.created, true);
    assert.ok(pendingSignal instanceof AbortSignal);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(pendingSignal.aborted, true);
  });

  test('provides stable message ids and opaque trace ids', () => {
    assert.equal(stableId('feishu', 'om-1'), stableId('feishu', 'om-1'));
    assert.notEqual(stableId('feishu', 'om-1'), stableId('weixin', 'om-1'));
    assert.match(stableId('feishu', 'om-1'), /^msg_[0-9a-f]{32}$/);
    assert.equal(createConversationMessageId('feishu', 'om-1'), stableId('feishu', 'om-1'));
    assert.match(createTraceId(), /^[0-9a-f]{32}$/);
    assert.equal(
      createConversationTraceId('feishu', 'user:1', 'om-1'),
      createConversationTraceId('feishu', 'user:1', 'om-1'),
    );
    assert.notEqual(
      createConversationTraceId('feishu', 'user:1'),
      createConversationTraceId('feishu', 'user:1'),
    );
    assert.match(createConversationTraceId('feishu', 'user:1', 'om-1'), /^[0-9a-f]{32}$/);
  });

  test('normalizes fields to the Catena validation boundary and rejects empty text', async () => {
    const journal = new ConversationJournal({
      workingDirectory: temporaryRoot(),
      env: {
        NODE_ENV: 'test',
        XIAOBA_CONVERSATION_RECORDING_ENABLED: 'true',
        OTEL_SERVICE_NAME: 'xiaoba-cli\ninvalid',
      },
    });

    const result = await journal.record({
      surface: 'cli',
      sessionKey: 'cli:validation',
      role: 'assistant',
      roleName: 'engineer-cat\nrole',
      content: [{ type: 'text', text: '  visible text  ' }],
      delivery: { status: 'delivered' },
      messageId: 'msg_validation',
    });
    assert.equal(result.message.agent_id, 'xiaoba-cli_invalid');
    assert.equal(result.message.role_name, 'engineer-cat role');
    assert.deepStrictEqual(result.message.content, [{ type: 'text', text: 'visible text' }]);

    await assert.rejects(
      journal.record({
        surface: 'cli',
        sessionKey: 'cli:validation',
        role: 'assistant',
        content: [{ type: 'text', text: '   ' }],
        delivery: { status: 'delivered' },
        messageId: 'msg_empty',
      }),
      /text must be non-empty/,
    );
  });
});
