import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentSession } from '../src/core/agent-session';
import { ChatResponse, Message, Skill } from '../src/types';
import { ToolDefinition, ToolExecutor, ToolCall, ToolResult } from '../src/types/tool';

class RecordingAIService {
  requests: Array<{ messages: Message[]; tools: ToolDefinition[] }> = [];

  async chatStream(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    this.requests.push({
      messages: messages.map(message => ({ ...message })),
      tools,
    });
    return {
      content: 'handled with skill context',
      usage: {
        promptTokens: 10,
        completionTokens: 4,
        totalTokens: 14,
      },
    };
  }

  async chat(messages: Message[], tools: ToolDefinition[] = []): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

class EmptyToolExecutor implements ToolExecutor {
  getToolDefinitions(): ToolDefinition[] {
    return [];
  }

  async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    throw new Error(`Unexpected tool call: ${toolCall.function.name}`);
  }
}

class FakeSkillManager {
  loadCount = 0;
  available = true;

  constructor(private readonly skill: Skill) {}

  async loadSkills(): Promise<void> {
    this.loadCount += 1;
  }

  getSkill(name: string): Skill | undefined {
    return this.available && name === this.skill.metadata.name ? this.skill : undefined;
  }

  getUserInvocableSkills(): Skill[] {
    return this.available ? [this.skill] : [];
  }

  findAutoInvocableSkillByText(text: string): Skill | undefined {
    return this.available && text.includes(this.skill.metadata.name) ? this.skill : undefined;
  }
}

describe('AgentSession skill integration', () => {
  const originalCwd = process.cwd();
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-agent-session-skill-'));
    process.chdir(testRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('auto-activates a mentioned skill and sends its system prompt into the runner request', async () => {
    const skill: Skill = {
      metadata: {
        name: 'audit-skill',
        description: 'Audit a runtime behavior',
        maxTurns: 3,
      },
      content: 'Audit mode for: $ARGUMENTS\nUser said: $0',
      filePath: path.join(testRoot, 'skills', 'audit-skill', 'SKILL.md'),
    };
    const aiService = new RecordingAIService();
    const skillManager = new FakeSkillManager(skill);
    const session = new AgentSession('chat:test-session', {
      aiService: aiService as any,
      toolManager: new EmptyToolExecutor() as any,
      skillManager: skillManager as any,
    });

    const result = await session.handleMessage('please use audit-skill on this runtime case');

    assert.strictEqual(result.text, 'handled with skill context');
    assert.strictEqual(result.visibleToUser, true);
    assert.strictEqual(skillManager.loadCount, 1);
    assert.strictEqual(aiService.requests.length, 1);

    const requestMessages = aiService.requests[0].messages;
    assert.ok(requestMessages.some(message =>
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.startsWith('[skill:audit-skill]\nAudit mode for:'),
    ));
    assert.ok(requestMessages.some(message =>
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('你可以使用以下skills'),
    ));
    assert.ok(requestMessages.some(message =>
      message.role === 'user'
      && message.content === 'please use audit-skill on this runtime case',
    ));
  });

  test('revokes an activated skill when reload makes it unavailable or missing', async () => {
    const skill: Skill = {
      metadata: {
        name: 'revoked-skill',
        description: 'Skill that becomes unavailable',
        maxTurns: 9,
        toolsets: ['revoked-tools'],
      },
      content: 'This prompt must not survive revocation.',
      filePath: path.join(testRoot, 'skills', 'revoked-skill', 'SKILL.md'),
    };
    const aiService = new RecordingAIService();
    const skillManager = new FakeSkillManager(skill);
    const session = new AgentSession('chat:revoked-skill', {
      aiService: aiService as any,
      toolManager: new EmptyToolExecutor() as any,
      skillManager: skillManager as any,
    });

    assert.strictEqual(await session.activateSkill('revoked-skill'), true);
    skillManager.available = false;

    await session.handleMessage('continue after the lifecycle change');

    assert.strictEqual(skillManager.loadCount, 1);
    assert.strictEqual(aiService.requests.length, 1);
    assert.strictEqual(aiService.requests[0].messages.some(message => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.startsWith('[skill:revoked-skill]')
    )), false);
    assert.strictEqual((session as any).activeSkillName, undefined);
    assert.strictEqual((session as any).activeSkillMaxTurns, undefined);
    assert.strictEqual((session as any).activeSkillToolsets, undefined);
  });
});
