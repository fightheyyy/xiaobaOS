import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MessageSessionManager } from '../src/core/message-session-manager';
import { createRoleAwareToolManager } from '../src/bootstrap/tool-manager';
import { buildFeishuVisibleInboundContent, FeishuBot } from '../src/feishu';
import { RoleResolver } from '../src/utils/role-resolver';
import { Message, ChatResponse } from '../src/types';
import { ToolDefinition } from '../src/types/tool';
import { Skill } from '../src/types/skill';
import { resetConversationJournalForTests } from '../src/utils/conversation-journal';

const originalRole = process.env.XIAOBA_ROLE;
const originalCurrentRole = process.env.CURRENT_ROLE;
const originalCurrentRoleDisplayName = process.env.CURRENT_ROLE_DISPLAY_NAME;
const conversationRoots: string[] = [];

class ScriptedFeishuAIService {
  requests: Array<{ messages: Message[]; tools: ToolDefinition[] }> = [];
  private index = 0;

  constructor(private readonly responses: ChatResponse[]) {}

  async chatStream(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    this.requests.push({
      messages: messages.map(message => ({ ...message })),
      tools,
    });
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) {
      throw new Error('No scripted response left');
    }
    return response;
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

class FailingFeishuAIService {
  requests: Array<{ messages: Message[]; tools: ToolDefinition[] }> = [];

  constructor(private readonly error: Error) {}

  async chatStream(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    this.requests.push({
      messages: messages.map(message => ({ ...message })),
      tools,
    });
    throw this.error;
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

class EmptySkillManager {
  async loadSkills(): Promise<void> {}
  getAllSkills(): any[] { return []; }
  getUserInvocableSkills(): any[] { return []; }
  getSkill(): any { return undefined; }
  findAutoInvocableSkillByText(): any { return undefined; }
}

class SingleSkillManager extends EmptySkillManager {
  constructor(private readonly skill: Skill) {
    super();
  }

  getAllSkills(): Skill[] { return [this.skill]; }
  getUserInvocableSkills(): Skill[] { return [this.skill]; }
  getSkill(name: string): Skill | undefined {
    return name === this.skill.metadata.name ? this.skill : undefined;
  }
}

class CapturingFeishuSender {
  replies: Array<{ chatId: string; text: string }> = [];

  async reply(chatId: string, text: string): Promise<void> {
    this.replies.push({ chatId, text });
  }

  async sendFile(): Promise<void> {}
  async downloadFile(): Promise<string | null> { return null; }
  async fetchMergeForwardTexts(): Promise<string> { return ''; }
}

function engineerReadToolCall(): ChatResponse {
  return {
    content: null,
    toolCalls: [
      {
        id: 'call-engineer-read',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: JSON.stringify({
            file_path: 'package.json',
            limit: 20,
          }),
        },
      },
    ],
  };
}

function sendTextToolCall(text: string): ChatResponse {
  return {
    content: null,
    toolCalls: [
      {
        id: 'call-send-text',
        type: 'function',
        function: {
          name: 'send_text',
          arguments: JSON.stringify({ text }),
        },
      },
    ],
  };
}

function feishuTextEvent(
  messageId: string,
  text: string,
  senderOpenId = 'ou_engineer_tester',
  chatId = 'oc_engineer_chat',
) {
  return {
    sender: {
      sender_id: {
        open_id: senderOpenId,
      },
    },
    message: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
  };
}

describe('Feishu Engineer runtime', () => {
  afterEach(() => {
    resetConversationJournalForTests({ env: { NODE_ENV: 'test' } });
    for (const root of conversationRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    if (originalRole) {
      process.env.XIAOBA_ROLE = originalRole;
    } else {
      delete process.env.XIAOBA_ROLE;
    }
    if (originalCurrentRole) {
      process.env.CURRENT_ROLE = originalCurrentRole;
    } else {
      delete process.env.CURRENT_ROLE;
    }
    if (originalCurrentRoleDisplayName) {
      process.env.CURRENT_ROLE_DISPLAY_NAME = originalCurrentRoleDisplayName;
    } else {
      delete process.env.CURRENT_ROLE_DISPLAY_NAME;
    }
    RoleResolver.clearActiveRole();
    const sessionFile = path.join(process.cwd(), 'data', 'sessions', 'feishu', 'user_ou_engineer_tester.jsonl');
    fs.rmSync(sessionFile, { force: true });
  });

  test('Feishu Engineer sessions use allowlisted coding tools directly', async () => {
    RoleResolver.activateRole('engineer-cat');
    const feishuSource = fs.readFileSync(path.join(process.cwd(), 'src', 'feishu', 'index.ts'), 'utf-8');
    assert.match(feishuSource, /createRoleAwareToolManager\(process\.cwd\(\), \{\}, roleName\)/);

    const toolManager = createRoleAwareToolManager();
    const visibleToolNames = toolManager.getToolDefinitions().map(tool => tool.name);
    for (const toolName of ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'execute_shell']) {
      assert.ok(visibleToolNames.includes(toolName), `${toolName} should be visible`);
    }
    assert.ok(visibleToolNames.includes('skill'));
    assert.ok(visibleToolNames.includes('ask_parent'));
    for (const baseControlTool of ['spawn_subagent', 'check_subagent', 'stop_subagent', 'resume_subagent']) {
      assert.strictEqual(visibleToolNames.includes(baseControlTool), false);
    }
    assert.strictEqual(toolManager.getTool('engineer_task_run'), undefined);
    assert.strictEqual(toolManager.getTool('codex_job_start'), undefined);

    const ai = new ScriptedFeishuAIService([
      engineerReadToolCall(),
      sendTextToolCall('已直接用 XiaoBa 原生工具读取仓库并完成检查。'),
      { content: '已发送。' },
    ]);
    const manager = new MessageSessionManager({
      aiService: ai as any,
      toolManager,
      skillManager: new EmptySkillManager() as any,
    }, 'feishu', 10_000);
    const replies: Array<{ chatId: string; text: string }> = [];

    try {
      const session = manager.getOrCreate('user:ou_engineer_tester', 'oc_engineer_chat');
      await session.handleMessage('早上好，帮我维护 XiaoBa-CLI 的 engineer 角色。', {
        channel: {
          chatId: 'oc_engineer_chat',
          reply: async (chatId: string, text: string) => {
            replies.push({ chatId, text });
          },
          sendFile: async () => undefined,
        },
      });

      assert.strictEqual(ai.requests[0].tools.some(tool => tool.name === 'read_file'), true);
      assert.strictEqual(ai.requests[0].tools.some(tool => tool.name === 'engineer_task_run'), false);
      assert.strictEqual(ai.requests[0].tools.some(tool => tool.name === 'codex_job_start'), false);
      assert.deepStrictEqual(replies, [
        {
          chatId: 'oc_engineer_chat',
          text: '已直接用 XiaoBa 原生工具读取仓库并完成检查。',
        },
      ]);
    } finally {
      await manager.destroy();
    }
  });

  test('Feishu visible file inbound preserves both its label and file part', () => {
    assert.deepStrictEqual(
      buildFeishuVisibleInboundContent('[文件] release-notes.md', 'release-notes.md'),
      [
        { type: 'text', text: '[文件] release-notes.md' },
        { type: 'file', name: 'release-notes.md' },
      ],
    );
  });

  test('Feishu slash skill commands preserve channel delivery context for send_text', async () => {
    const journalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-feishu-conversation-'));
    conversationRoots.push(journalRoot);
    const journal = resetConversationJournalForTests({
      workingDirectory: journalRoot,
      env: {
        NODE_ENV: 'test',
        XIAOBA_CONVERSATION_RECORDING_ENABLED: 'true',
      },
    });
    const skill: Skill = {
      metadata: {
        name: 'ship',
        description: 'Ship a short update',
        argumentHint: '<topic>',
        userInvocable: true,
      },
      content: 'Use the supplied topic to send one concise Feishu update.',
      filePath: path.join(process.cwd(), 'skills', 'ship', 'SKILL.md'),
    };
    const ai = new ScriptedFeishuAIService([
      sendTextToolCall('Feishu skill update delivered through send_text.'),
      { content: 'This final text should stay internal.' },
    ]);
    const sender = new CapturingFeishuSender();
    const bot = new FeishuBot({
      appId: 'cli_a_fake_app_id_for_slash_skill',
      appSecret: 'fake_app_secret_for_slash_skill',
      sessionTTL: 10_000,
    }, {
      client: {} as any,
      wsClient: { start: () => undefined } as any,
      sender: sender as any,
      agentServices: {
        aiService: ai as any,
        toolManager: createRoleAwareToolManager(),
        skillManager: new SingleSkillManager(skill) as any,
      },
    });

    try {
      await (bot as any).onMessage(feishuTextEvent(
        'om_feishu_slash_skill_1',
        '/ship release notes',
      ));

      assert.strictEqual(ai.requests.length, 2);
      assert.ok(ai.requests[0].tools.some(tool => tool.name === 'send_text'));
      assert.deepStrictEqual(sender.replies, [
        {
          chatId: 'oc_engineer_chat',
          text: 'Feishu skill update delivered through send_text.',
        },
      ]);
      const rows = fs.readFileSync(journal.filePathFor('feishu', 'user:ou_engineer_tester'), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      assert.deepStrictEqual(rows.map(row => row.role), ['user', 'assistant']);
      assert.deepStrictEqual(rows[0].content, [{ type: 'text', text: '/ship release notes' }]);
      assert.deepStrictEqual(rows[1].content, [{ type: 'text', text: 'Feishu skill update delivered through send_text.' }]);
      assert.strictEqual(rows[0].trace_id, rows[1].trace_id);
      assert.ok(!JSON.stringify(rows).includes('This final text should stay internal.'));
    } finally {
      await bot.destroy();
    }
  });

  test('Feishu slash skill commands direct-send visible provider error text', async () => {
    const skill: Skill = {
      metadata: {
        name: 'vision-check',
        description: 'Check an image-capable provider path',
        argumentHint: '<topic>',
        userInvocable: true,
      },
      content: 'Check whether the provider can handle the supplied request.',
      filePath: path.join(process.cwd(), 'skills', 'vision-check', 'SKILL.md'),
    };
    const ai = new FailingFeishuAIService(new Error('image input is not supported by this model'));
    const sender = new CapturingFeishuSender();
    const bot = new FeishuBot({
      appId: 'cli_a_fake_app_id_for_slash_skill_error',
      appSecret: 'fake_app_secret_for_slash_skill_error',
      sessionTTL: 10_000,
    }, {
      client: {} as any,
      wsClient: { start: () => undefined } as any,
      sender: sender as any,
      agentServices: {
        aiService: ai as any,
        toolManager: createRoleAwareToolManager(),
        skillManager: new SingleSkillManager(skill) as any,
      },
    });

    try {
      await (bot as any).onMessage(feishuTextEvent(
        'om_feishu_slash_skill_error_1',
        '/vision-check uploaded image',
      ));

      assert.strictEqual(ai.requests.length, 1);
      assert.deepStrictEqual(sender.replies, [
        {
          chatId: 'oc_engineer_chat',
          text: '当前模型不支持图片识别。请使用支持多模态的模型（如 Claude 3.5 Sonnet 或 GPT-4V），或者用文字描述图片内容。',
        },
      ]);
    } finally {
      await bot.destroy();
    }
  });
});
