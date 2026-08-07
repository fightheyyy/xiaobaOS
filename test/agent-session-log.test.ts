import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentSession, ERROR_MESSAGE } from '../src/core/agent-session';
import { ContextCompressor } from '../src/core/context-compressor';
import { ToolManager } from '../src/tools/tool-manager';
import { Logger } from '../src/utils/logger';
import { ChatResponse, Message } from '../src/types';
import { ToolDefinition } from '../src/types/tool';
import { runScriptedRuntimeTestSuite } from '../src/testing';

class ScriptedAIService {
  constructor(private readonly response: ChatResponse) {}

  async chatStream(_messages: Message[], _tools: ToolDefinition[]): Promise<ChatResponse> {
    return this.response;
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

class RecordingAIService {
  requests: Message[][] = [];

  constructor(private readonly response: ChatResponse) {}

  async chatStream(messages: Message[], _tools: ToolDefinition[]): Promise<ChatResponse> {
    this.requests.push(messages.map(message => ({ ...message })));
    return this.response;
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

class FailingAIService {
  async chatStream(): Promise<ChatResponse> {
    const error = new Error('API错误 (429): provider rate limit at /Users/guowei/private/input.txt api_key=sk-test-abcdefghijklmnopqrstuvwxyz') as Error & {
      provider?: string;
      model?: string;
      endpoint?: string;
      status?: number;
      error_code?: string;
      retryable?: boolean;
    };
    error.provider = 'openai-compatible';
    error.model = 'gpt-test';
    error.endpoint = 'primary';
    error.status = 429;
    error.error_code = 'MODEL_RATE_LIMIT';
    error.retryable = true;
    throw error;
  }

  async chat(): Promise<ChatResponse> {
    return this.chatStream();
  }
}

class SendTextAIService {
  requests: Message[][] = [];

  constructor(private readonly text = '结构化交付证据') {}

  async chatStream(messages: Message[]): Promise<ChatResponse> {
    this.requests.push(messages.map(message => ({ ...message })));
    if (this.requests.length === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: 'send-text-call-1',
            type: 'function',
            function: {
              name: 'send_text',
              arguments: JSON.stringify({ text: this.text }),
            },
          },
        ],
      };
    }

    return { content: '已发送，不需要重复回复' };
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    return this.chatStream(messages);
  }
}

class EmptySkillManager {
  async loadSkills(): Promise<void> {}
  getAllSkills(): any[] { return []; }
  getUserInvocableSkills(): any[] { return []; }
  getSkill(): any { return undefined; }
  findAutoInvocableSkillByText(): any { return undefined; }
}

describe('AgentSession session log alignment', () => {
  let testRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-session-log-'));
    process.chdir(testRoot);
    Logger.setSilentMode(true);
  });

  afterEach(() => {
    Logger.setSilentMode(false);
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('turn log can keep raw user input when the provider prompt is wrapped', async () => {
    const session = new AgentSession('pet:agent-1', {
      aiService: new ScriptedAIService({ content: 'done' }) as any,
      toolManager: new ToolManager(),
      skillManager: new EmptySkillManager() as any,
    }, 'pet');

    await session.handleMessage('[pet-agent]\ninternal prompt\n\nraw task', {
      logInput: 'raw task',
    });

    const entries = readSessionEntries(testRoot, 'pet');
    const turn = entries.find(isTraceEntry);
    assert.ok(turn);
    assert.strictEqual(turn.user.text, 'raw task');
    assert.strictEqual(turn.assistant.text, 'done');
  });

  test('surface-reserved trace id is reused by durable session evidence', async () => {
    const session = new AgentSession('pet:conversation-trace', {
      aiService: new ScriptedAIService({ content: 'done' }) as any,
      toolManager: new ToolManager(),
      skillManager: new EmptySkillManager() as any,
    }, 'pet');

    await session.handleMessage('trace me', {
      surface: 'pet',
      traceId: 'trace_conversation_contract_1',
    });

    const trace = readSessionEntries(testRoot, 'pet').find(isTraceEntry);
    assert.ok(trace);
    assert.strictEqual(trace.trace_id, 'trace_conversation_contract_1');
    assert.strictEqual(trace.episode_id, 'trace_conversation_contract_1');
  });

  test('pre-message compaction records a trace event and compact-after snapshot', async () => {
    const aiService = new ScriptedAIService({ content: 'done' });
    const session = new AgentSession('pet:compact-pre-message', {
      aiService: aiService as any,
      toolManager: new ToolManager(),
      skillManager: new EmptySkillManager() as any,
    }, 'pet');

    (session as any).messages = [
      { role: 'user', content: '第一轮：记住不要改无关文件。' },
      { role: 'assistant', content: '已记住。' },
      { role: 'user', content: '第二轮：命令坏了。' },
      { role: 'assistant', content: '我先看证据。' },
      { role: 'user', content: '第三轮：路径在 workspace 里。' },
      { role: 'assistant', content: '收到。' },
      { role: 'user', content: '第四轮：继续。' },
      { role: 'assistant', content: '继续处理。' },
    ];
    (session as any).compressor = new ContextCompressor(aiService as any, {
      maxContextTokens: 80,
      compactionThreshold: 0.2,
    });

    await session.handleMessage('现在继续', { surface: 'pet' });

    const tracePath = readSessionLogFile(testRoot, 'pet');
    const entries = fs.readFileSync(tracePath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const compactEvent = embeddedRuntimeEvents(entries).find(entry => entry.event_type === 'context_compaction');
    assert.ok(compactEvent);
    assert.equal(compactEvent.source, 'agent_session_pre_message');
    assert.equal(compactEvent.status, 'success');
    assert.equal(compactEvent.snapshot_kind, 'compact_after');
    assert.equal(compactEvent.snapshot_status, 'written');
    assert.match(compactEvent.snapshot_ref, /^context-snapshots\/pet_compact-pre-message\.jsonl#/);
    assert.equal(compactEvent.snapshot_id, compactEvent.snapshot_ref.split('#')[1]);

    const snapshotPath = path.join(path.dirname(tracePath), 'context-snapshots', 'pet_compact-pre-message.jsonl');
    assert.ok(fs.existsSync(snapshotPath));
    const [snapshot] = fs.readFileSync(snapshotPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    assert.equal(snapshot.entry_type, 'context_snapshot');
    assert.equal(snapshot.kind, 'compact_after');
    assert.equal(snapshot.event_id, compactEvent.event_id);
    assert.equal(snapshot.snapshot_id, compactEvent.snapshot_id);
    assert.ok(snapshot.messages.some((message: Message) =>
      message.role === 'system' && String(message.content).startsWith('[compact_boundary]')
    ));
  });

  test('weixin message sessions use weixin surface prompt instead of feishu prompt', async () => {
    const aiService = new RecordingAIService({ content: '收到' });
    const replies: Array<{ chatId: string; text: string }> = [];
    const session = new AgentSession('user:wx-user', {
      aiService: aiService as any,
      toolManager: new ToolManager(),
      skillManager: new EmptySkillManager() as any,
    }, 'weixin');

    const result = await session.handleMessage('你好', {
      surface: 'weixin',
      channel: {
        chatId: 'wx-chat',
        reply: async (chatId, text) => {
          replies.push({ chatId, text });
        },
        sendFile: async () => undefined,
      },
    });

    assert.strictEqual(result.text, '');
    assert.strictEqual(result.visibleToUser, false);
    assert.deepStrictEqual(replies, []);
    const systemTexts = aiService.requests[0]
      .filter(message => message.role === 'system')
      .map(message => String(message.content));
    assert.ok(systemTexts.some(text => text.includes('[surface:weixin]')));
    assert.ok(systemTexts.some(text => text.includes('消息交付规则（强制）')));
    assert.ok(systemTexts.some(text => text.includes('只有 send_text 和 send_file 会产生用户可见输出')));
    assert.ok(systemTexts.some(text => text.includes('最终直接文本回复默认不会发送给用户')));
    assert.ok(!systemTexts.some(text => text.includes('当前是飞书')));

    const savedPath = path.join(testRoot, 'data', 'sessions', 'weixin', 'user_wx-user.jsonl');
    assert.ok(fs.existsSync(savedPath), 'weixin turn should be saved for restart restore');
    const savedMessages = fs.readFileSync(savedPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Message);
    assert.ok(savedMessages.some(message => message.role === 'user' && message.content === '你好'));
    assert.ok(savedMessages.some(message => message.role === 'assistant' && message.content === '收到'));

    const entries = readSessionEntries(testRoot, 'weixin');
    const turn = entries.find(isTraceEntry);
    assert.ok(turn);
    assertSessionLogEntryShape(turn);
    assert.equal(turn.state_boundary.durable_session.ref, 'data/sessions/weixin/user_wx-user.jsonl');
    assert.equal(turn.state_boundary.durable_session.scope, 'surface_restore');
    assert.match(turn.state_boundary.working_trace.ref, /^logs\/sessions\/weixin\/\d{4}-\d{2}-\d{2}\/user_wx-user\/traces\.jsonl$/);
    assert.equal(turn.state_boundary.working_trace.schema, 'session-log-v3');
    assert.match(turn.state_boundary.provider_transcript.ref, /^provider-transcripts\/sha256:[a-f0-9]{64}$/);
    assert.equal(turn.state_boundary.provider_transcript.mode, 'reference');
    assert.equal(turn.state_boundary.provider_transcript.raw_messages_stored, false);
    assert.equal(turn.state_boundary.provider_transcript.tool_result_payload_stored, false);
    assert.equal(turn.state_boundary.provider_transcript.raw_request_stored, false);
    assert.equal(turn.state_boundary.provider_transcript.raw_response_stored, false);
    assert.equal(turn.state_boundary.provider_transcript.raw_payload_stored, false);
    assert.equal(turn.state_boundary.visible_history, undefined);

    const restored = new AgentSession('user:wx-user', {
      aiService: new RecordingAIService({ content: '继续' }) as any,
      toolManager: new ToolManager(),
      skillManager: new EmptySkillManager() as any,
    }, 'weixin');
    assert.equal(restored.restoreFromStore(), true);
    await restored.init('weixin');
    const restoredMessages = (restored as any).messages as Message[];
    assert.ok(restoredMessages.some(message => message.role === 'user' && message.content === '你好'));
    assert.ok(restoredMessages.some(message => message.role === 'assistant' && message.content === '收到'));
  });

  test('channel final text fallback is opt-in at AgentSession boundary', async () => {
    const aiService = new RecordingAIService({ content: '收到' });
    const replies: Array<{ chatId: string; text: string }> = [];
    const session = new AgentSession('user:wx-fallback', {
      aiService: aiService as any,
      toolManager: new ToolManager(),
      skillManager: new EmptySkillManager() as any,
    }, 'weixin');

    const result = await session.handleMessage('你好', {
      surface: 'weixin',
      deliveryFallbackFinalReply: true,
      channel: {
        chatId: 'wx-chat',
        reply: async (chatId, text) => {
          replies.push({ chatId, text });
        },
        sendFile: async () => undefined,
      },
    });

    assert.strictEqual(result.text, '收到');
    assert.strictEqual(result.visibleToUser, true);
    assert.deepStrictEqual(replies, [{ chatId: 'wx-chat', text: '收到' }]);

    const entries = readSessionEntries(testRoot, 'weixin');
    const turn = entries.find(isTraceEntry);
    assert.ok(turn);
    assert.equal(turn.assistant.tool_calls[0].name, 'send_text');
    assert.deepStrictEqual(turn.assistant.tool_calls[0].arguments, {
      text: '收到',
      _delivery_fallback: true,
    });
  });

  test('failed provider calls still produce a turn entry for replay', async () => {
    const session = new AgentSession('pet:xiaoba', {
      aiService: new FailingAIService() as any,
      toolManager: new ToolManager(),
      skillManager: new EmptySkillManager() as any,
    }, 'pet');

    const result = await session.handleMessage('你好');

    assert.strictEqual(result.text, ERROR_MESSAGE);
    const entries = readSessionEntries(testRoot, 'pet');
    const runtimeLog = readRuntimeLogFile(testRoot, 'pet');
    assert.ok(fs.readFileSync(runtimeLog, 'utf-8').includes('处理失败'));
    const providerEvent = embeddedRuntimeEvents(entries).find(entry => entry.entry_type === 'runtime_event' && entry.event_type === 'provider_error');
    assert.ok(providerEvent);
    assertSessionLogEntryShape(providerEvent);
    assert.equal(providerEvent.surface, 'pet');
    assert.equal(providerEvent.provider_error.provider, 'openai-compatible');
    assert.equal(providerEvent.provider_error.model, 'gpt-test');
    assert.equal(providerEvent.provider_error.endpoint, 'primary');
    assert.equal(providerEvent.provider_error.status, 429);
    assert.equal(providerEvent.provider_error.error_code, 'MODEL_RATE_LIMIT');
    assert.equal(providerEvent.provider_error.retryable, true);
    assert.equal(providerEvent.status, 'failure');
    assert.equal(providerEvent.error_code, 'MODEL_RATE_LIMIT');
    assert.equal(providerEvent.retryable, true);
    assert.equal(providerEvent.retry_count, 0);
    assert.equal(providerEvent.retry_budget, 1);
    assert.equal(providerEvent.retry_budget_exhausted, false);
    assert.equal(providerEvent.provider_failure_budget.scope, 'session');
    assert.match(providerEvent.provider_failure_budget.fingerprint, /^sha256:[a-f0-9]{16}$/);
    assert.equal(providerEvent.provider_failure_budget.prior_failure_count, 0);
    assert.equal(typeof providerEvent.tokens.prompt, 'number');
    assert.equal(typeof providerEvent.tokens.completion, 'number');
    const serializedProviderEvent = JSON.stringify(providerEvent);
    assert.ok(serializedProviderEvent.includes('/Users/guowei/private/input.txt'));
    assert.ok(serializedProviderEvent.includes('sk-test-abcdefghijklmnopqrstuvwxyz'));
    const turn = entries.find(isTraceEntry);
    assert.ok(turn);
    assert.strictEqual(turn.user.text, '你好');
    assert.strictEqual(turn.assistant.text, ERROR_MESSAGE);
    assert.match(turn.state_boundary.provider_transcript.ref, /^provider-transcripts\/sha256:[a-f0-9]{64}$/);
    assert.equal(turn.state_boundary.provider_transcript.status, 'degraded');
    assert.equal(turn.state_boundary.provider_transcript.degraded, true);
    assert.equal(turn.state_boundary.provider_transcript.degradation_reason, 'MODEL_RATE_LIMIT');
    assert.equal(turn.state_boundary.provider_transcript.error_code, 'MODEL_RATE_LIMIT');
    assert.deepEqual(turn.state_boundary.provider_transcript.fallback_chain, [
      'openai-compatible:primary',
      'runtime_error_fallback',
    ]);
    assert.match(turn.state_boundary.provider_transcript.blocked_reason, /raw provider payload omitted/);
    assert.equal(turn.state_boundary.provider_transcript.raw_messages_stored, false);
    assert.equal(turn.state_boundary.provider_transcript.tool_result_payload_stored, false);
    assert.equal(turn.state_boundary.provider_transcript.raw_request_stored, false);
    assert.equal(turn.state_boundary.provider_transcript.raw_response_stored, false);
    assert.equal(turn.state_boundary.provider_transcript.raw_payload_stored, false);

    const degradationScorecard = await runScriptedRuntimeTestSuite({
      suitePath: writeLiveProviderDegradationSuite(testRoot, readSessionLogFile(testRoot, 'pet')),
      outDir: path.join(testRoot, 'eval-provider-degradation-output'),
      now: new Date('2026-06-05T00:00:00.000Z'),
    });

    assert.equal(degradationScorecard.summary.decision, 'pass');
    assert.equal(degradationScorecard.cases[0].decision, 'pass');
  });

  test('repeated provider failures converge to blocked provider budget evidence', async () => {
    const session = new AgentSession('pet:xiaoba', {
      aiService: new FailingAIService() as any,
      toolManager: new ToolManager(),
      skillManager: new EmptySkillManager() as any,
    }, 'pet');

    const first = await session.handleMessage('第一次请求');
    const second = await session.handleMessage('第二次请求');

    assert.strictEqual(first.text, ERROR_MESSAGE);
    assert.match(second.text, /模型服务连续限流/);

    const entries = readSessionEntries(testRoot, 'pet');
    const providerEvents = embeddedRuntimeEvents(entries).filter(entry => entry.entry_type === 'runtime_event' && entry.event_type === 'provider_error');
    assert.equal(providerEvents.length, 2);

    const firstEvent = providerEvents[0];
    const blockedEvent = providerEvents[1];
    assertSessionLogEntryShape(firstEvent);
    assertSessionLogEntryShape(blockedEvent);
    assert.equal(firstEvent.status, 'failure');
    assert.equal(firstEvent.retry_count, 0);
    assert.equal(firstEvent.retry_budget, 1);
    assert.equal(firstEvent.retry_budget_exhausted, false);
    assert.equal(blockedEvent.status, 'blocked');
    assert.equal(blockedEvent.error_code, 'MODEL_RATE_LIMIT');
    assert.equal(blockedEvent.retryable, true);
    assert.equal(blockedEvent.retry_count, 1);
    assert.equal(blockedEvent.retry_budget, 1);
    assert.equal(blockedEvent.retry_budget_exhausted, true);
    assert.equal(blockedEvent.provider_failure_budget.scope, 'session');
    assert.equal(blockedEvent.provider_failure_budget.prior_failure_count, 1);
    assert.match(blockedEvent.provider_failure_budget.fingerprint, /^sha256:[a-f0-9]{16}$/);
    assert.match(blockedEvent.blocked_reason, /Provider retry budget exhausted after 1 prior failure/);
    assert.equal(blockedEvent.provider_error.error_code, 'MODEL_RATE_LIMIT');

    const turns = entries.filter(isTraceEntry);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].state_boundary.provider_transcript.status, 'degraded');
    assert.equal(turns[1].state_boundary.provider_transcript.status, 'blocked');
    assert.deepEqual(turns[1].state_boundary.provider_transcript.fallback_chain, [
      'openai-compatible:primary',
      'runtime_blocked_fallback',
    ]);
    assert.match(turns[1].state_boundary.provider_transcript.blocked_reason, /Provider retry budget exhausted after 1 prior failure/);
  });

  test('channel delivery tools write structured delivery evidence to session JSONL', async () => {
    const replies: Array<{ chatId: string; text: string }> = [];
    const session = new AgentSession('pet:xiaoba', {
      aiService: new SendTextAIService() as any,
      toolManager: new ToolManager(),
      skillManager: new EmptySkillManager() as any,
    }, 'pet');

    const result = await session.handleMessage('发一句话', {
      surface: 'pet',
      channel: {
        chatId: 'pet-chat-secret-id',
        reply: async (chatId, text) => {
          replies.push({ chatId, text });
          return {
            receipt_id: 'pet-receipt-secret-id',
            receipt_type: 'message',
            surface: 'pet',
            status: 'delivered',
            timestamp: '2026-06-04T00:00:00.000Z',
            platform_message_id: 'pet-platform-message-secret-id',
            delivery_id: 'pet-delivery-secret-id',
          };
        },
        sendFile: async () => undefined,
      },
    });

    assert.equal(result.text, '');
    assert.equal(result.visibleToUser, true);
    assert.deepStrictEqual(replies, [{ chatId: 'pet-chat-secret-id', text: '结构化交付证据' }]);
    const entries = readSessionEntries(testRoot, 'pet');
    const turn = entries.find(isTraceEntry);
    assert.ok(turn);
    assertSessionLogEntryShape(turn);

    const toolCall = turn.assistant.tool_calls[0];
    assert.equal(toolCall.name, 'send_text');
    assert.equal(toolCall.status, 'success');
    assert.equal(toolCall.retryable, false);
    assert.equal(typeof toolCall.duration_ms, 'number');
    assert.deepEqual(toolCall.delivery_evidence, [
      {
        surface: 'pet',
        channel_id: toolCall.delivery_evidence[0].channel_id,
        status: 'delivered',
        timestamp: toolCall.delivery_evidence[0].timestamp,
        delivery_type: 'text',
        text_preview: '结构化交付证据',
      },
    ]);
    assert.match(toolCall.delivery_evidence[0].channel_id, /^sha256:[a-f0-9]{16}$/);
    assert.deepEqual(toolCall.external_delivery_receipts, [
      {
        receipt_id: 'pet-receipt-secret-id',
        receipt_type: 'message',
        surface: 'pet',
        status: 'delivered',
        timestamp: '2026-06-04T00:00:00.000Z',
        platform_message_id: 'pet-platform-message-secret-id',
        delivery_id: 'pet-delivery-secret-id',
      },
    ]);
    assert.equal(turn.state_boundary.visible_history.ref, 'data/chat/sessions/pet_xiaoba.jsonl');
    assert.equal(turn.state_boundary.visible_history.scope, 'surface_visible_history');
    const completed = embeddedRuntimeEvents(entries).find(event => event.event_type === 'session_completed');
    assert.equal(completed.visible_to_user, true);
    assert.equal(completed.final_response_visible, false);
  });

  test('live AgentSession session JSONL satisfies the state boundary contract', async () => {
    const deliveries: string[] = [];
    const deliveryText = 'durable session, working trace, provider transcript reference, visible history';
    const session = new AgentSession('pet:xiaoba', {
      aiService: new SendTextAIService(deliveryText) as any,
      toolManager: new ToolManager(),
      skillManager: new EmptySkillManager() as any,
    }, 'pet');

    await session.handleMessage('检查状态边界', {
      surface: 'pet',
      channel: {
        chatId: 'pet:xiaoba',
        reply: async (_chatId, text) => {
          deliveries.push(text);
        },
        sendFile: async () => undefined,
      },
    });
    assert.deepEqual(deliveries, [deliveryText]);

    const logPath = readSessionLogFile(testRoot, 'pet');
    const suitePath = path.join(testRoot, 'live-state-boundary-suite.json');
    fs.writeFileSync(suitePath, JSON.stringify({
      suite_id: 'live-state-boundary-smoke',
      name: 'Live State Boundary Smoke',
      version: '0.1-test',
      decision_policy: {
        fail_on_any_hard_failure: true,
        block_on_missing_evidence: true,
        min_pass_rate: 1,
      },
      cases: [
        {
          case_id: 'live.state-boundary.001',
          name: 'Live AgentSession state boundary',
          lane: 'contract_sentinel',
          target_module: 'state_evidence',
          risk_level: 'release_blocking',
          task: 'Verify a live AgentSession turn emits separated state boundary evidence.',
          inputs: {
            jsonl: logPath,
            jsonl_schema: 'session-log-v2',
          },
          hard_verifiers: [
            { id: 'jsonl_parse' },
            {
              id: 'state_boundary_contract',
              config: {
                require_visible_history: true,
              },
            },
            {
              id: 'provider_transcript_normalization',
              config: {
                require_digest_ref: true,
              },
            },
            { id: 'budget_check' },
          ],
          budgets: {
            max_turns: 2,
            max_tool_calls: 1,
            max_tokens: 1000,
          },
          failure_route: 'state_evidence',
        },
      ],
    }, null, 2) + '\n', 'utf-8');

    const scorecard = await runScriptedRuntimeTestSuite({
      suitePath,
      outDir: path.join(testRoot, 'eval-output'),
      now: new Date('2026-06-04T00:00:00.000Z'),
    });

    assert.equal(scorecard.summary.decision, 'pass');
    assert.equal(scorecard.cases[0].decision, 'pass');
  });
});

function readSessionLogFile(root: string, sessionType: string): string {
  const sessionRoot = path.join(root, 'logs', 'sessions', sessionType);
  const files = collectFiles(sessionRoot).filter(file => path.basename(file) === 'traces.jsonl');
  assert.strictEqual(files.length, 1);
  return files[0];
}

function readRuntimeLogFile(root: string, sessionType: string): string {
  const sessionRoot = path.join(root, 'logs', 'sessions', sessionType);
  const files = collectFiles(sessionRoot).filter(file => file.endsWith('runtime.log'));
  assert.strictEqual(files.length, 1);
  return files[0];
}

function readSessionEntries(root: string, sessionType: string): any[] {
  return fs.readFileSync(readSessionLogFile(root, sessionType), 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function isTraceEntry(entry: any): boolean {
  return entry?.entry_type === 'trace' || entry?.entry_type === 'turn';
}

function embeddedRuntimeEvents(entries: any[]): any[] {
  return entries.flatMap(entry => Array.isArray(entry.events) ? entry.events : [entry]);
}

function writeLiveProviderDegradationSuite(root: string, logPath: string): string {
  const suitePath = path.join(root, 'live-provider-degradation-suite.json');
  fs.writeFileSync(suitePath, JSON.stringify({
    suite_id: 'live-provider-degradation-smoke',
    name: 'Live Provider Transcript Degradation Smoke',
    version: '0.1-test',
    decision_policy: {
      fail_on_any_hard_failure: true,
      block_on_missing_evidence: true,
      min_pass_rate: 1,
    },
    cases: [
      {
        case_id: 'live.provider-transcript-degradation.001',
        name: 'Live AgentSession provider transcript degradation',
        lane: 'contract_sentinel',
        target_module: 'state_evidence',
        risk_level: 'release_blocking',
        task: 'Verify a live AgentSession provider failure emits structured degraded provider transcript boundary evidence.',
        inputs: {
          jsonl: logPath,
          jsonl_schema: 'session-log-v2',
        },
        hard_verifiers: [
          { id: 'jsonl_parse' },
          {
            id: 'provider_transcript_normalization',
            config: {
              require_digest_ref: true,
            },
          },
          {
            id: 'provider_transcript_degradation',
            config: {
              min_degraded_refs: 1,
              require_digest_ref: true,
              require_explicit_raw_payload_storage_flags: true,
              require_fallback_chain: true,
              require_blocked_reason: true,
              expected_reasons: ['MODEL_RATE_LIMIT'],
              expected_statuses: ['degraded'],
            },
          },
          { id: 'budget_check' },
        ],
        budgets: {
          max_turns: 1,
          max_tool_calls: 0,
          max_tokens: 1000,
        },
        failure_route: 'state_evidence',
      },
    ],
  }, null, 2) + '\n', 'utf-8');
  return suitePath;
}

function collectFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectFiles(fullPath));
    } else {
      result.push(fullPath);
    }
  }
  return result;
}

function assertSessionLogEntryShape(entry: unknown): void {
  assert.ok(isPlainRecord(entry), 'session log entry must be an object');
  assert.equal(typeof entry.schema_version, 'number');
  assert.ok(['trace', 'turn', 'runtime_event', 'runtime'].includes(String(entry.entry_type)));
  assert.equal(typeof entry.timestamp, 'string');
  assert.equal(typeof entry.session_id, 'string');
  assert.equal(typeof entry.session_type, 'string');

  if (entry.entry_type === 'trace' || entry.entry_type === 'turn') {
    assert.ok(isPlainRecord(entry.user), 'trace user must be an object');
    assert.equal(typeof entry.user.text, 'string');
    assert.ok(isPlainRecord(entry.assistant), 'trace assistant must be an object');
    assert.equal(typeof entry.assistant.text, 'string');
    assert.ok(Array.isArray(entry.assistant.tool_calls));
    assert.ok(isPlainRecord(entry.tokens), 'trace tokens must be an object');
    assert.equal(typeof entry.tokens.prompt, 'number');
    assert.equal(typeof entry.tokens.completion, 'number');
    if (entry.entry_type === 'trace') {
      assert.equal(typeof entry.trace_id, 'string');
      assert.equal(typeof entry.trace_index, 'number');
    }
    return;
  }

  if (entry.entry_type === 'runtime_event') {
    assert.equal(typeof entry.event_id, 'string');
    assert.equal(typeof entry.event_type, 'string');
    return;
  }

  assert.equal(typeof entry.event_id, 'string');
  assert.equal(typeof entry.level, 'string');
  assert.equal(typeof entry.message, 'string');
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
