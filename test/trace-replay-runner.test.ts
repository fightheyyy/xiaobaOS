import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRoleAwareToolManager } from '../src/bootstrap/tool-manager';
import type { AgentServices } from '../src/core/agent-session';
import { runTraceReplay } from '../src/replay/trace-replay-runner';
import { SkillManager } from '../src/skills/skill-manager';
import type { ChatResponse, Message } from '../src/types';
import type { ToolDefinition } from '../src/types/tool';

const originalCwd = process.cwd();
const originalAppRoot = process.env.XIAOBA_APP_ROOT;

class ReplayFakeAIService {
  requests: Message[][] = [];

  async chatStream(messages: Message[], _tools: ToolDefinition[] = []): Promise<ChatResponse> {
    this.requests.push(messages.map(message => ({ ...message })));
    const lastUser = [...messages].reverse().find(message => message.role === 'user');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : 'unknown';
    if (this.requests.length % 2 === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: `trace-replay-send-${this.requests.length}`,
            type: 'function',
            function: {
              name: 'send_text',
              arguments: JSON.stringify({ text: `replayed: ${userText}` }),
            },
          },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    }
    return {
      content: '',
      usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 },
    };
  }

  async chat(messages: Message[], tools: ToolDefinition[] = []): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

function writePet(root: string, id: string): void {
  const petDir = path.join(root, 'desktop', 'dashboard', 'pets', id);
  fs.mkdirSync(petDir, { recursive: true });
  fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify({
    id,
    displayName: id,
    renderer: 'grok-cat-v1',
  }, null, 2));
}

function writeTrace(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const rows = [
    {
      schema_version: 3,
      entry_type: 'trace',
      trace_id: 'old.trace.1',
      trace_index: 1,
      session_id: 'pet:xiaoba:old-session',
      session_type: 'pet',
      user: { text: '第一轮：帮我收敛一下' },
      assistant: {
        text: '',
        tool_calls: [
          {
            id: 'old-send-1',
            name: 'send_text',
            arguments: { text: 'old reply 1' },
            result: '已发送',
            status: 'success',
            delivery_evidence: [{ delivery_type: 'text', status: 'delivered', timestamp: '2026-06-23T00:00:00.000Z' }],
          },
        ],
      },
      tokens: { prompt: 1, completion: 1 },
      events: [{ event_type: 'session_completed', visible_to_user: true, final_response_visible: false }],
    },
    {
      schema_version: 3,
      entry_type: 'trace',
      trace_id: 'old.trace.2',
      trace_index: 2,
      session_id: 'pet:xiaoba:old-session',
      session_type: 'pet',
      user: { text: '第二轮：变成 checklist' },
      assistant: {
        text: '',
        tool_calls: [
          {
            id: 'old-send-2',
            name: 'send_text',
            arguments: { text: 'old reply 2' },
            result: '已发送',
            status: 'success',
            delivery_evidence: [{ delivery_type: 'text', status: 'delivered', timestamp: '2026-06-23T00:00:01.000Z' }],
          },
        ],
      },
      tokens: { prompt: 1, completion: 1 },
      events: [{ event_type: 'session_completed', visible_to_user: true, final_response_visible: false }],
    },
  ];
  fs.writeFileSync(filePath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf-8');
}

describe('TraceReplayRunner', () => {
  let testRoot = '';

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-trace-replay-'));
    process.chdir(testRoot);
    process.env.XIAOBA_APP_ROOT = testRoot;
    writePet(testRoot, 'xiaoba');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    restoreEnv('XIAOBA_APP_ROOT', originalAppRoot);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('extracts historical user inputs and reruns them through the Pet runtime', async () => {
    const tracePath = path.join(testRoot, 'logs', 'sessions', 'pet', '2026-06-23', 'pet_xiaoba_old-session', 'traces.jsonl');
    writeTrace(tracePath);
    const fakeAI = new ReplayFakeAIService();
    const services: AgentServices = {
      aiService: fakeAI as any,
      toolManager: createRoleAwareToolManager(testRoot),
      skillManager: new SkillManager(),
    };

    const report = await runTraceReplay({
      tracePath,
      cwd: testRoot,
      outDir: path.join(testRoot, 'output', 'replay-test'),
      sessionKey: 'pet:xiaoba:role-base:custom-user-key',
      now: new Date('2026-06-23T00:00:00.000Z'),
      services,
    });

    assert.equal(report.replayed_turns, 2);
    assert.equal(report.pet_id, 'xiaoba');
    assert.ok(report.session_key.startsWith('pet:xiaoba:role-base:custom-user-key:'));
    assert.match(report.session_key, /:trace-replay-/);
    assert.equal(report.inputs.map(input => input.text).join('|'), '第一轮：帮我收敛一下|第二轮：变成 checklist');
    assert.equal(report.results.length, 2);
    assert.deepEqual(report.results.map(result => result.tools), [['send_text'], ['send_text']]);
    assert.equal(report.comparison.oldTrace.traceCount, 2);
    assert.equal(report.comparison.newTrace.traceCount, 2);
    assert.deepEqual(report.comparison.newTrace.userTexts, ['第一轮：帮我收敛一下', '第二轮：变成 checklist']);
    assert.equal(report.comparison.inputCountMatches, true);
    assert.equal(report.comparison.userInputsReplayed, true);
    assert.equal(report.comparison.newTrace.finalVisibleCount, 0);
    assert.equal(report.comparison.newTrace.deliveryEvidenceCount, 2);
    assert.ok(report.fresh_trace_path);
    assert.ok(fs.existsSync(report.fresh_trace_path!));
    assert.ok(report.visible_history_path);
    assert.ok(fs.existsSync(report.visible_history_path!));
    assert.ok(fs.existsSync(path.join(testRoot, 'output', 'replay-test', 'manifest.json')));
    assert.ok(fs.existsSync(path.join(testRoot, 'output', 'replay-test', 'comparison.json')));
    assert.ok(fs.existsSync(path.join(testRoot, 'output', 'replay-test', 'report.md')));
  });

  test('re-activates an internal evaluator Skill before every replayed Pet turn', async () => {
    const tracePath = path.join(testRoot, 'logs', 'sessions', 'pet', '2026-06-23', 'pet_xiaoba_old-session', 'traces.jsonl');
    writeTrace(tracePath);
    writeSkill(testRoot, 'replay-pinned-skill');
    const fakeAI = new ReplayFakeAIService();
    const services: AgentServices = {
      aiService: fakeAI as any,
      toolManager: createRoleAwareToolManager(testRoot),
      skillManager: new SkillManager(),
    };

    const report = await runTraceReplay({
      tracePath,
      cwd: testRoot,
      outDir: path.join(testRoot, 'output', 'replay-pinned-test'),
      now: new Date('2026-06-23T00:01:00.000Z'),
      services,
      requiredActiveSkillName: 'replay-pinned-skill',
    });

    assert.ok(fakeAI.requests.length >= 2);
    assert.ok(fakeAI.requests.every(messages => messages.some(message => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.startsWith('[skill:replay-pinned-skill]')
    ))));
    const rows = fs.readFileSync(report.fresh_trace_path!, 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => {
      const visibility = Array.isArray(row.tool_visibility) ? row.tool_visibility : [];
      return visibility[visibility.length - 1]?.activeSkillName === 'replay-pinned-skill';
    }));
  });
});

function writeSkill(root: string, name: string): void {
  const dir = path.join(root, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name} test skill`,
    '---',
    '',
    `Follow ${name}.`,
    '',
  ].join('\n'), 'utf-8');
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
