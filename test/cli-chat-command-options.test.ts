import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  cleanupCliOneShotSubAgents,
  registerCliSubAgentCallbacks,
  sendSingleMessage,
  settleCliOneShotSubAgents,
  shouldRenderCliRuntimeLogs,
  shouldRestoreCliSession,
} from '../src/commands/chat';
import { SubAgentManager } from '../src/core/sub-agent-manager';
import { ChatResponse, Message } from '../src/types';
import { ToolDefinition } from '../src/types/tool';
import { resetConversationJournalForTests } from '../src/utils/conversation-journal';

class ImmediateCliSubAgentAIService {
  async chatStream(_messages: Message[], _tools: ToolDefinition[]): Promise<ChatResponse> {
    return { content: 'cli background task completed' };
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

class WaitingCliSubAgentAIService {
  private requestIndex = 0;

  async chatStream(_messages: Message[], _tools: ToolDefinition[]): Promise<ChatResponse> {
    if (this.requestIndex++ === 0) {
      return {
        content: null,
        toolCalls: [{
          id: 'cli-one-shot-ask-parent',
          type: 'function',
          function: {
            name: 'ask_parent',
            arguments: JSON.stringify({ question: 'Need an interactive answer before continuing' }),
          },
        }],
      };
    }
    return { content: 'continued unexpectedly' };
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

class HangingCliSubAgentAIService {
  async chatStream(): Promise<ChatResponse> {
    return new Promise(() => undefined);
  }

  async chat(): Promise<ChatResponse> {
    return this.chatStream();
  }
}

class EmptyCliSkillManager {
  getSkill(): undefined {
    return undefined;
  }
}

describe('CLI chat command options', () => {
  test('restores CLI session only when resume is explicit', () => {
    assert.equal(shouldRestoreCliSession({}), false);
    assert.equal(shouldRestoreCliSession({ resume: false }), false);
    assert.equal(shouldRestoreCliSession({ resume: true }), true);
    assert.equal(shouldRestoreCliSession({ message: 'hello', resume: true }), false);
  });

  test('renders runtime logs only when verbose is explicit', () => {
    assert.equal(shouldRenderCliRuntimeLogs({}), false);
    assert.equal(shouldRenderCliRuntimeLogs({ verbose: false }), false);
    assert.equal(shouldRenderCliRuntimeLogs({ verbose: true }), true);
  });

  test('one-shot CLI journals one inbound and one aggregated streamed reply', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cli-conversation-'));
    const sessionKey = 'cli:conversation-contract';
    const journal = resetConversationJournalForTests({
      workingDirectory: root,
      env: {
        NODE_ENV: 'test',
        XIAOBA_CONVERSATION_RECORDING_ENABLED: 'true',
      },
    });

    try {
      const session = {
        key: sessionKey,
        handleMessage: async (_message: string, options: any) => {
          options.callbacks.onText?.('streamed reply');
          return {
            text: 'streamed reply',
            visibleToUser: true,
            finalResponseVisible: true,
          };
        },
      };

      await sendSingleMessage(session as any, 'hello', {
        recordInbound: true,
        roleName: 'engineer-cat',
      });

      const rows = fs.readFileSync(journal.filePathFor('cli', sessionKey), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      assert.deepStrictEqual(rows.map(row => row.role), ['user', 'assistant']);
      assert.deepStrictEqual(rows.map(row => row.sequence), [1, 2]);
      assert.deepStrictEqual(rows[1].content, [{ type: 'text', text: 'streamed reply' }]);
      assert.equal(rows[1].role_name, 'engineer-cat');
      assert.equal(rows[0].trace_id, rows[1].trace_id);
    } finally {
      resetConversationJournalForTests({ env: { NODE_ENV: 'test' } });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('interactive CLI callback receives and drives sub-agent feedback', async () => {
    const sessionKey = `cli-feedback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const rendered: string[] = [];
    let busy = true;
    const feedback = registerCliSubAgentCallbacks(
      { key: sessionKey, isBusy: () => busy } as any,
      async (_session, text) => {
        rendered.push(text);
      },
    );

    const spawned = SubAgentManager.getInstance().spawn(
      sessionKey,
      undefined,
      'CLI feedback test',
      'finish immediately',
      process.cwd(),
      new ImmediateCliSubAgentAIService() as any,
      new EmptyCliSkillManager() as any,
      { parentSessionId: sessionKey },
    );
    assert.ok(!('error' in spawned));

    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepStrictEqual(rendered, []);
    busy = false;
    await waitFor(() => rendered.length > 0);
    assert.match(rendered[0], /CLI feedback test/);
    assert.match(rendered[0], /cli background task completed/);
    feedback.dispose();
  });

  test('CLI callback dispose is conditional and cannot unregister a newer session owner', async () => {
    const sessionKey = `cli-feedback-owner-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const firstRendered: string[] = [];
    const secondRendered: string[] = [];
    const first = registerCliSubAgentCallbacks(
      { key: sessionKey, isBusy: () => false } as any,
      async (_session, text) => { firstRendered.push(text); },
    );
    const second = registerCliSubAgentCallbacks(
      { key: sessionKey, isBusy: () => false } as any,
      async (_session, text) => { secondRendered.push(text); },
    );

    first.dispose();
    const spawned = SubAgentManager.getInstance().spawn(
      sessionKey,
      undefined,
      'new callback owner task',
      'finish immediately',
      process.cwd(),
      new ImmediateCliSubAgentAIService() as any,
      new EmptyCliSkillManager() as any,
      { parentSessionId: sessionKey },
    );
    assert.ok(!('error' in spawned));
    await waitFor(() => secondRendered.length > 0);
    assert.deepStrictEqual(firstRendered, []);

    second.dispose();
    const afterDispose = SubAgentManager.getInstance().spawn(
      sessionKey,
      undefined,
      'must not spawn after callback disposal',
      'finish immediately',
      process.cwd(),
      new ImmediateCliSubAgentAIService() as any,
      new EmptyCliSkillManager() as any,
      { parentSessionId: sessionKey },
    );
    assert.ok('error' in afterDispose);
    if ('error' in afterDispose) assert.match(afterDispose.error, /平台回调未注册/);
  });

  test('one-shot coordinator waits for sub-agent completion and drains its feedback', async () => {
    const sessionKey = `cli-one-shot-success-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const rendered: string[] = [];
    const session = { key: sessionKey, isBusy: () => false } as any;
    const feedback = registerCliSubAgentCallbacks(session, async (_session, text) => {
      rendered.push(text);
    });
    const baseline = new Set(SubAgentManager.getInstance().listByParent(sessionKey).map(item => item.id));
    const spawned = SubAgentManager.getInstance().spawn(
      sessionKey,
      undefined,
      'one-shot completion task',
      'finish immediately',
      process.cwd(),
      new ImmediateCliSubAgentAIService() as any,
      new EmptyCliSkillManager() as any,
      { parentSessionId: sessionKey },
    );
    assert.ok(!('error' in spawned));

    const outcome = await settleCliOneShotSubAgents(session, feedback, baseline, {
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    });
    assert.strictEqual(outcome, 'completed');
    assert.strictEqual(rendered.length, 1);
    assert.match(rendered[0], /one-shot completion task/);
    assert.match(rendered[0], /cli background task completed/);
    feedback.dispose();
  });

  test('one-shot coordinator stops waiting tasks and emits an interactive-mode recovery message', async () => {
    const sessionKey = `cli-one-shot-waiting-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const rendered: string[] = [];
    const session = { key: sessionKey, isBusy: () => false } as any;
    const feedback = registerCliSubAgentCallbacks(session, async (_session, text) => {
      rendered.push(text);
    });
    const baseline = new Set(SubAgentManager.getInstance().listByParent(sessionKey).map(item => item.id));
    const spawned = SubAgentManager.getInstance().spawn(
      sessionKey,
      undefined,
      'one-shot waiting task',
      'ask before continuing',
      process.cwd(),
      new WaitingCliSubAgentAIService() as any,
      new EmptyCliSkillManager() as any,
      { parentSessionId: sessionKey },
    );
    assert.ok(!('error' in spawned));
    if ('error' in spawned) return;

    const outcome = await settleCliOneShotSubAgents(session, feedback, baseline, {
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    });
    assert.strictEqual(outcome, 'waiting_stopped');
    assert.strictEqual(SubAgentManager.getInstance().getInfoForParent(sessionKey, spawned.id)?.status, 'stopped');
    assert.ok(rendered.some(text => text.includes('单条消息模式无法继续交互式恢复')));
    assert.ok(rendered.some(text => text.includes('xiaoba chat -i')));
    feedback.dispose();
  });

  test('one-shot coordinator times out and stops a still-running task', async () => {
    const sessionKey = `cli-one-shot-timeout-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const rendered: string[] = [];
    const session = { key: sessionKey, isBusy: () => false } as any;
    const feedback = registerCliSubAgentCallbacks(session, async (_session, text) => {
      rendered.push(text);
    });
    const baseline = new Set(SubAgentManager.getInstance().listByParent(sessionKey).map(item => item.id));
    const spawned = SubAgentManager.getInstance().spawn(
      sessionKey,
      undefined,
      'one-shot timeout task',
      'keep running',
      process.cwd(),
      new HangingCliSubAgentAIService() as any,
      new EmptyCliSkillManager() as any,
      { parentSessionId: sessionKey },
    );
    assert.ok(!('error' in spawned));
    if ('error' in spawned) return;

    const outcome = await settleCliOneShotSubAgents(session, feedback, baseline, {
      timeoutMs: 30,
      pollIntervalMs: 5,
    });
    assert.strictEqual(outcome, 'timed_out');
    assert.strictEqual(SubAgentManager.getInstance().getInfoForParent(sessionKey, spawned.id)?.status, 'stopped');
    assert.ok(rendered.some(text => text.includes('后台任务已超时并停止')));
    feedback.dispose();
  });

  test('one-shot cleanup stops only newly spawned active tasks and disposes its callback', async () => {
    const sessionKey = `cli-one-shot-cleanup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const session = { key: sessionKey, isBusy: () => false } as any;
    const feedback = registerCliSubAgentCallbacks(session, async () => undefined);
    const baseline = new Set(SubAgentManager.getInstance().listByParent(sessionKey).map(item => item.id));
    const spawned = SubAgentManager.getInstance().spawn(
      sessionKey,
      undefined,
      'one-shot exceptional cleanup task',
      'keep running',
      process.cwd(),
      new HangingCliSubAgentAIService() as any,
      new EmptyCliSkillManager() as any,
      { parentSessionId: sessionKey },
    );
    assert.ok(!('error' in spawned));
    if ('error' in spawned) return;

    assert.strictEqual(cleanupCliOneShotSubAgents(sessionKey, feedback, baseline), 1);
    assert.strictEqual(SubAgentManager.getInstance().getInfoForParent(sessionKey, spawned.id)?.status, 'stopped');
    const afterCleanup = SubAgentManager.getInstance().spawn(
      sessionKey,
      undefined,
      'must not spawn after one-shot cleanup',
      'finish immediately',
      process.cwd(),
      new ImmediateCliSubAgentAIService() as any,
      new EmptyCliSkillManager() as any,
      { parentSessionId: sessionKey },
    );
    assert.ok('error' in afterCleanup);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for CLI sub-agent feedback');
}
