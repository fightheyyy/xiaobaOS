import axios from 'axios';
import { WeixinConfig, WeixinMessage } from './types';
import { MessageHandler } from './message-handler';
import { MessageSender } from './message-sender';
import { createRoleAwareToolManager } from '../bootstrap/tool-manager';
import { MessageSessionManager } from '../core/message-session-manager';
import { AIService } from '../utils/ai-service';
import { SkillManager } from '../skills/skill-manager';
import { AgentServices, BUSY_MESSAGE, HandleMessageResult } from '../core/agent-session';
import { SubAgentManager } from '../core/sub-agent-manager';
import { Logger } from '../utils/logger';
import { ChannelCallbacks } from '../types/tool';
import { promises as fs } from 'fs';
import path from 'path';
import { RoleResolver } from '../utils/role-resolver';
import { ConversationContent } from '../utils/conversation-journal';
import {
  ConversationTurnContext,
  journalVisibleChannel,
  recordVisibleInbound,
  reserveConversationTraceId,
} from '../utils/conversation-surface';

const CHANNEL_VERSION = 'xiaoba-weixin/1.0';
const DEFAULT_LONGPOLL_MS = 30000;

export class WeixinBot {
  private handler: MessageHandler;
  private sender: MessageSender;
  private sessionManager: MessageSessionManager;
  private agentServices: AgentServices;
  private contextTokens = new Map<string, string>();
  private isRunning = false;
  private getUpdatesBuf = '';
  private stateDir: string;

  constructor(private config: WeixinConfig) {
    this.handler = new MessageHandler(config.cdnBaseUrl);
    this.sender = new MessageSender(config.token, config.baseUrl, config.cdnBaseUrl);
    this.stateDir = config.stateDir || path.join(process.cwd(), 'data', 'weixin');

    const roleName = RoleResolver.getActiveRoleName();
    const aiService = new AIService();
    const toolManager = createRoleAwareToolManager(process.cwd(), {}, roleName);
    const skillManager = new SkillManager(roleName);

    this.agentServices = {
      aiService,
      toolManager,
      skillManager,
      ...(roleName ? { roleName } : {}),
    };

    this.sessionManager = new MessageSessionManager(this.agentServices, 'weixin');
    this.setupChannelCallbacks();
    this.loadState();
  }

  private setupChannelCallbacks(): void {
    this.sessionManager.setWakeupSendFn(async (chatId, text, sessionKey) => {
      const turn = this.createTurnContext(sessionKey);
      const channel = journalVisibleChannel(turn, this.buildChannel(chatId, sessionKey));
      await channel.reply(chatId, text);
    });
  }

  private async loadState(): Promise<void> {
    try {
      await fs.mkdir(this.stateDir, { recursive: true });
      const bufPath = path.join(this.stateDir, 'get_updates.buf');
      const tokensPath = path.join(this.stateDir, 'context_tokens.json');

      try {
        this.getUpdatesBuf = await fs.readFile(bufPath, 'utf-8');
      } catch {}

      try {
        const data = await fs.readFile(tokensPath, 'utf-8');
        const tokens = JSON.parse(data);
        this.contextTokens = new Map(Object.entries(tokens));
      } catch {}
    } catch (err) {
      Logger.error(`[微信] 加载状态失败: ${err}`);
    }
  }

  private async saveState(): Promise<void> {
    try {
      const bufPath = path.join(this.stateDir, 'get_updates.buf');
      const tokensPath = path.join(this.stateDir, 'context_tokens.json');

      await fs.writeFile(bufPath, this.getUpdatesBuf);
      await fs.writeFile(tokensPath, JSON.stringify(Object.fromEntries(this.contextTokens)));
    } catch (err) {
      Logger.error(`[微信] 保存状态失败: ${err}`);
    }
  }

  private buildChannel(chatId: string, sessionKey: string): ChannelCallbacks {
    return {
      chatId,
      reply: async (cid: string, text: string) => {
        const userId = sessionKey.replace('user:', '');
        const contextToken = this.contextTokens.get(sessionKey);
        await this.sender.sendText(userId, text, contextToken);
      },
      sendFile: async (cid: string, filePath: string, fileName: string) => {
        const userId = sessionKey.replace('user:', '');
        const contextToken = this.contextTokens.get(sessionKey);
        await this.sender.sendFile(userId, filePath, fileName, contextToken);
      },
    };
  }

  private async sendFinalResponseIfVisible(
    channel: ChannelCallbacks,
    result: HandleMessageResult,
  ): Promise<void> {
    if (result.finalResponseVisible && result.text) {
      await channel.reply(channel.chatId, result.text);
    }
  }

  async start(): Promise<void> {
    Logger.info('正在启动微信机器人...');
    await this.agentServices.skillManager.loadSkills();
    Logger.info(`已加载 ${this.agentServices.skillManager.getAllSkills().length} 个 skills`);

    this.isRunning = true;
    Logger.success('微信机器人已启动，开始长轮询...');

    this.poll();
  }

  private async poll(): Promise<void> {
    let backoff = 1000;
    const maxBackoff = 30000;

    while (this.isRunning) {
      try {
        const response = await axios.post(
          `${this.config.baseUrl}/ilink/bot/getupdates`,
          {
            get_updates_buf: this.getUpdatesBuf,
            base_info: { channel_version: CHANNEL_VERSION },
          },
          {
            headers: {
              'Authorization': `Bearer ${this.config.token}`,
              'AuthorizationType': 'ilink_bot_token',
              'Content-Type': 'application/json',
            },
            timeout: DEFAULT_LONGPOLL_MS + 5000,
          }
        );

        const { ret, errcode, errmsg, msgs = [], get_updates_buf } = response.data;

        if (errcode === -14) {
          Logger.error('[微信] 会话已过期，请重新登录');
          await new Promise(resolve => setTimeout(resolve, 3600000));
          continue;
        }

        if (get_updates_buf) {
          this.getUpdatesBuf = get_updates_buf;
          await this.saveState();
        }

        if (msgs.length > 0) {
          Logger.info(`[微信] 收到 ${msgs.length} 条消息`);
          for (const msg of msgs) {
            await this.handleMessage(msg);
          }
        }

        backoff = 1000;
      } catch (error: any) {
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') continue;
        Logger.error(`[微信] 轮询错误: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, maxBackoff);
      }
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    if (msg.message_type === 2) return;
    if (msg.message_type !== 0 && msg.message_type !== 1) return;

    const from = msg.from_user_id?.trim();
    if (!from) return;

    const sessionKey = `user:${from}`;
    if (msg.context_token) {
      this.contextTokens.set(sessionKey, msg.context_token);
      await this.saveState();
    }

    const parsed = this.handler.parseMessage(msg);
    if (!parsed || this.handler.shouldIgnoreMessage(parsed)) return;
    const turn = await recordVisibleInbound({
      surface: 'weixin',
      sessionKey,
      content: this.visibleInboundContent(parsed),
      sourceEventId: parsed.message_id,
    });

    const mediaFiles = await this.handler.downloadMedia(parsed);
    const hasMedia = mediaFiles.length > 0;

    const mediaDesc = hasMedia
      ? ` +${mediaFiles.filter(f => /\.(jpg|jpeg|png|gif)$/i.test(f)).length}图 +${mediaFiles.filter(f => !/\.(jpg|jpeg|png|gif)$/i.test(f)).length}文件`
      : '';

    const session = this.sessionManager.getOrCreate(sessionKey, msg.to_user_id);
    session.runWithLogContext(() => Logger.info(`[${sessionKey}] 收到消息: ${parsed.text?.slice(0, 50) || '[媒体消息]'}${mediaDesc}...`));
    const channel = journalVisibleChannel(this.withRole(turn), this.buildChannel(msg.to_user_id, sessionKey));
    SubAgentManager.getInstance().registerPlatformCallbacks(sessionKey, {
      injectMessage: text => this.handleSubAgentFeedback(sessionKey, msg.to_user_id, text),
    });

    let userText = parsed.text || '';
    if (hasMedia) {
      const attachmentLines = mediaFiles.map((file, i) => {
        const fileName = file.split(/[/\\]/).pop();
        const isImage = /\.(jpg|jpeg|png|gif)$/i.test(file);
        return `[${isImage ? '图片' : '文件'}${i + 1}] ${fileName}\n[路径] ${file}`;
      });
      const attachmentContext = `[用户已上传${mediaFiles.length}个附件]\n${attachmentLines.join('\n')}`;
      userText = userText ? `${userText}\n${attachmentContext}` : `[用户仅上传了附件，暂未给出明确任务]\n${attachmentContext}`;
    }

    const result = await session.handleMessage(userText, {
      channel,
      surface: 'weixin',
      traceId: turn.traceId,
    });
    await this.sendFinalResponseIfVisible(channel, result);
  }

  private async handleSubAgentFeedback(sessionKey: string, chatId: string, text: string): Promise<void> {
    const maxRetries = 10;
    const retryDelayMs = 5000;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }

      const session = this.sessionManager.getOrCreate(sessionKey, chatId);
      if (session.isBusy()) {
        session.runWithLogContext(() => Logger.info(`[${sessionKey}] 主会话忙，等待重试注入子智能体反馈 (${attempt + 1}/${maxRetries + 1})`));
        continue;
      }

      const turn = this.createTurnContext(sessionKey);
      const channel = journalVisibleChannel(turn, this.buildChannel(chatId, sessionKey));
      const result = await session.handleMessage(text, {
        channel,
        surface: 'weixin',
        traceId: turn.traceId,
      });
      if (result.text === BUSY_MESSAGE) {
        session.runWithLogContext(() => Logger.info(`[${sessionKey}] 主会话竞态忙碌，将重试`));
        continue;
      }
      await this.sendFinalResponseIfVisible(channel, result);
      return;
    }

    Logger.warning(`[${sessionKey}] 子智能体反馈注入失败：主会话持续忙碌`);
  }

  async destroy(): Promise<void> {
    this.isRunning = false;
    await this.sessionManager.destroy();
    Logger.info('[微信] 机器人已停止');
  }

  private createTurnContext(sessionKey: string): ConversationTurnContext {
    return this.withRole({
      surface: 'weixin',
      sessionKey,
      traceId: reserveConversationTraceId('weixin', sessionKey),
    });
  }

  private withRole(turn: ConversationTurnContext): ConversationTurnContext {
    return {
      ...turn,
      ...(this.agentServices.roleName ? { roleName: this.agentServices.roleName } : {}),
    };
  }

  private visibleInboundContent(message: WeixinMessage): ConversationContent[] {
    const content: ConversationContent[] = [];
    if (message.text) content.push({ type: 'text', text: message.text });
    for (const item of message.item_list || []) {
      if (item.type === 2) {
        content.push({ type: 'file', name: 'image.jpg' });
      } else if (item.type === 4) {
        content.push({ type: 'file', name: item.file_item?.file_name || 'unknown' });
      }
    }
    return content.length > 0 ? content : [{ type: 'text', text: '[媒体消息]' }];
  }
}
