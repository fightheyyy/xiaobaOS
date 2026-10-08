import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ConnectorRegistry } from '../src/connectors/connector';
import { FeishuConnector, LarkCliExecFile } from '../src/connectors/feishu';
import { FeishuCalendarAgendaTool } from '../src/roles/secretary-cat/tools/feishu-calendar-tools';
import { DefaultLarkCliRunner } from '../src/roles/secretary-cat/utils/lark-cli-runner';

describe('App Connector boundary', () => {
  test('discovers app capabilities without disclosing credentials and rejects duplicate identities', () => {
    const registry = new ConnectorRegistry();
    const connector = registry.register(new FeishuConnector('lark-cli', { FEISHU_APP_SECRET: 'secret' }));
    assert.equal(connector.app, 'feishu');
    assert.ok(registry.list()[0].capabilities.includes('calendar'));
    assert.ok(!JSON.stringify(registry.list()).includes('secret'));
    assert.throws(() => registry.register(new FeishuConnector()), /CONNECTOR_ID_CONFLICT/);
    assert.equal(new ConnectorRegistry().register(new FeishuConnector()).id, 'feishu');
  });

  test('existing Role tool calls the extracted Connector with execution cancellation and timeout', async () => {
    const calls: Array<{ args: string[]; signal?: AbortSignal; timeout: number }> = [];
    const executor: LarkCliExecFile = async (_command, args, options) => {
      calls.push({ args, signal: options.signal, timeout: options.timeout });
      return { stdout: JSON.stringify({ events: [] }), stderr: '' };
    };
    const connector = new FeishuConnector('lark-cli', {}, executor);
    const controller = new AbortController();
    const output = await new FeishuCalendarAgendaTool(connector).execute({
      start: '2026-10-07T09:00:00+08:00', end: '2026-10-07T10:00:00+08:00',
    }, { workingDirectory: process.cwd(), conversationHistory: [], abortSignal: controller.signal });
    assert.equal(JSON.parse(output).ok, true);
    assert.deepEqual(calls[0].args.slice(0, 4), ['calendar', '+agenda', '--as', 'user']);
    assert.equal(calls[0].signal, controller.signal);
    assert.equal(calls[0].timeout, 15000);
  });

  test('direct invocation retains profile enforcement and the old runner import is compatible', async () => {
    assert.equal(DefaultLarkCliRunner, FeishuConnector);
    const connector = new FeishuConnector();
    await assert.rejects(connector.invoke(['--profile', 'other', 'auth', 'status']), /cannot override/);
  });
});
