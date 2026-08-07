import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetConversationJournalForTests } from '../src/utils/conversation-journal';
import {
  journalVisibleChannel,
  recordVisibleAssistant,
  recordVisibleInbound,
} from '../src/utils/conversation-surface';

describe('conversation surface visibility boundary', () => {
  const roots: string[] = [];

  afterEach(() => {
    resetConversationJournalForTests({ env: { NODE_ENV: 'test' } });
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function enabledJournal() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-conversation-surface-'));
    roots.push(root);
    const journal = resetConversationJournalForTests({
      workingDirectory: root,
      env: {
        NODE_ENV: 'test',
        XIAOBA_CONVERSATION_RECORDING_ENABLED: 'true',
      },
    });
    return { root, journal };
  }

  test('records inbound and only resolved channel text/file deliveries in one ordered conversation', async () => {
    const { journal } = enabledJournal();
    const turn = await recordVisibleInbound({
      surface: 'feishu',
      sessionKey: 'user:surface-test',
      sourceEventId: 'om_inbound_1',
      content: [{ type: 'text', text: '请发送结果' }],
    });
    const channel = journalVisibleChannel({ ...turn, roleName: 'engineer-cat' }, {
      chatId: 'oc_test',
      reply: async () => [
        {
          receipt_type: 'message',
          status: 'delivered',
          timestamp: new Date().toISOString(),
          platform_message_id: 'om_segment_1',
        },
        {
          receipt_type: 'message',
          status: 'delivered',
          timestamp: new Date().toISOString(),
          platform_message_id: 'om_segment_2',
        },
      ],
      sendFile: async () => ({
        receipt_type: 'file',
        status: 'delivered',
        timestamp: new Date().toISOString(),
        platform_message_id: 'om_file_1',
      }),
    });

    await channel.reply(channel.chatId, '第一段');
    await channel.sendFile(channel.chatId, '/private/report.pdf', 'report.pdf');

    const rows = readRows(journal.filePathFor('feishu', 'user:surface-test'));
    assert.deepStrictEqual(rows.map(row => row.sequence), [1, 2, 3]);
    assert.deepStrictEqual(rows.map(row => row.role), ['user', 'assistant', 'assistant']);
    assert.deepStrictEqual(rows[0].delivery, {
      status: 'received',
      platform_message_ids: ['om_inbound_1'],
    });
    assert.deepStrictEqual(rows[1].content, [{ type: 'text', text: '第一段' }]);
    assert.deepStrictEqual(rows[1].delivery.platform_message_ids, ['om_segment_1', 'om_segment_2']);
    assert.deepStrictEqual(rows[2].content, [{ type: 'file', name: 'report.pdf' }]);
    assert.deepStrictEqual(rows[2].delivery.platform_message_ids, ['om_file_1']);
    assert.ok(rows.every(row => row.trace_id === turn.traceId));
    assert.match(turn.traceId, /^[0-9a-f]{32}$/);
    assert.doesNotMatch(JSON.stringify(rows[2]), /\/private\/report\.pdf/);

    const retryChannel = journalVisibleChannel({ ...turn, roleName: 'engineer-cat' }, {
      chatId: channel.chatId,
      reply: async () => [
        {
          receipt_type: 'message',
          status: 'delivered',
          timestamp: new Date().toISOString(),
          platform_message_id: 'om_segment_1',
        },
        {
          receipt_type: 'message',
          status: 'delivered',
          timestamp: new Date().toISOString(),
          platform_message_id: 'om_segment_2',
        },
      ],
      sendFile: async () => undefined,
    });
    await retryChannel.reply(retryChannel.chatId, '第一段');
    assert.equal(readRows(journal.filePathFor('feishu', 'user:surface-test')).length, 3);
  });

  test('does not record a failed delivery and supports one explicit direct reply', async () => {
    const { journal } = enabledJournal();
    const turn = await recordVisibleInbound({
      surface: 'weixin',
      sessionKey: 'user:wx-surface-test',
      sourceEventId: 'wx_inbound_1',
      content: [{ type: 'text', text: 'hello' }],
    });
    const channel = journalVisibleChannel(turn, {
      chatId: 'wx-chat',
      reply: async () => {
        throw new Error('delivery failed');
      },
      sendFile: async () => undefined,
    });

    await assert.rejects(channel.reply(channel.chatId, 'not delivered'), /delivery failed/);
    await recordVisibleAssistant({
      ...turn,
      content: [{ type: 'text', text: 'provider error visible to user' }],
      deliveryKey: 'weixin:direct-error',
    });

    const rows = readRows(journal.filePathFor('weixin', 'user:wx-surface-test'));
    assert.equal(rows.length, 2);
    assert.deepStrictEqual(rows[1].content, [{ type: 'text', text: 'provider error visible to user' }]);
  });
});

function readRows(filePath: string): any[] {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}
