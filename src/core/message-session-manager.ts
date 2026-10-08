import { registerReminderRoute, startReminderPolling, reminderCheckMessage, SessionReminder } from '../events';
import type { ChannelCallbacks } from '../types/tool';
import { BUSY_MESSAGE, AgentSession, AgentServices } from './agent-session';
import { Logger } from '../utils/logger';

/** 默认会话过期时间：60 分钟 */
const DEFAULT_SESSION_TTL = 60 * 60 * 1000;

/**
 * 统一唤醒回复函数签名
 * 平台层注入具体的发送实现
 */
export type WakeupSendFn = (channelId: string, text: string, sessionKey: string) => Promise<void>;
export type AgentServicesResolver = (sessionKey: string) => AgentServices;

/**
 * MessageSessionManager - 统一的消息会话生命周期管理器
 *
 * 核心特性：
 * - 每个 session key 独立运行，不阻塞
 * - 不同平台（Feishu/Weixin）共用同一套逻辑
 * - session 之间不污染
 * - 群聊和私聊独立
 */
export class MessageSessionManager {
  private static managers = new Map<string, MessageSessionManager>();
  private sessions = new Map<string, AgentSession>();
  private destroying = new Set<string>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private ttl: number;
  private reminderChannelFactory?: (record: SessionReminder) => Promise<ChannelCallbacks> | ChannelCallbacks;
  private stopReminderPoll?: () => void;
  private unregisterReminderRoute?: () => void;
  /** 记录每个 session 最近一次消息的通道 ID（topic/chatId，用于过期时主动唤醒） */
  private lastChannelIdMap = new Map<string, string>();
  private wakeupSendFn: WakeupSendFn | null = null;
  private contextInjector: ((session: AgentSession) => void) | null = null;
  private sessionType: string;

  constructor(
    private agentServices: AgentServices,
    sessionType: string,
    ttl?: number,
    private readonly agentServicesResolver?: AgentServicesResolver,
  ) {
    this.sessionType = sessionType;
    this.ttl = ttl ?? DEFAULT_SESSION_TTL;
    MessageSessionManager.managers.set(sessionType, this);
    this.startCleanup();
  }

  static getManager(sessionType: string): MessageSessionManager | null {
    return this.managers.get(sessionType) || null;
  }

  /** 注入唤醒发送函数（用于过期时主动唤醒） */
  setWakeupSendFn(fn: WakeupSendFn): void {
    this.wakeupSendFn = fn;
  }

  /** 设置上下文注入器，新建 session 时自动调用 */
  setContextInjector(injector: (session: AgentSession) => void): void {
    this.contextInjector = injector;
  }

  /**
   * 获取或创建会话
   * @param key - 会话唯一标识（如 group:chat123, user:usr3）
   * @param channelId - 通道 ID（topic 或 chatId，用于唤醒回复）
   */
  getOrCreate(key: string, channelId?: string): AgentSession {
    let session = this.sessions.get(key);
    if (!session) {
      const services = this.agentServicesResolver?.(key) || this.agentServices;
      session = new AgentSession(key, services, this.sessionType);
      session.restoreFromStore();
      if (this.contextInjector) {
        this.contextInjector(session);
      }
      this.sessions.set(key, session);
      session.runWithLogContext(() => Logger.info(`新建会话: ${key}`));
    }

    if (channelId) {
      this.lastChannelIdMap.set(key, channelId);
      this.injectWakeupReply(session, key);
    }

    session.lastActiveAt = Date.now();
    return session;
  }

  setReminderChannelFactory(factory: (record: SessionReminder) => Promise<ChannelCallbacks> | ChannelCallbacks): void {
    this.reminderChannelFactory = factory;
  }

  startReminderProcessing(): void {
    if (this.stopReminderPoll || !this.reminderChannelFactory) return;
    const root = this.agentServices.toolManager?.getWorkingDirectory?.() || process.cwd();
    this.unregisterReminderRoute = registerReminderRoute(root, this.sessionType, {
      available: record => !this.sessions.get(record.sessionKey)?.isBusy() && !this.destroying.has(record.sessionKey),
      consume: async record => {
        const channel = await this.reminderChannelFactory!(record);
        const session = this.getOrCreate(record.sessionKey, record.channelId);
        if (record.mode === 'remind') {
          await channel.reply(record.channelId, record.purpose);
          session.injectContext(`[scheduled_reminder_delivered] ${record.id}: ${record.purpose}`);
        } else {
          const result = await session.handleMessage(reminderCheckMessage(record), {
            surface: record.surface, channel,
          });
          if (result.text === BUSY_MESSAGE || result.failed) throw new Error('REMINDER_SESSION_RUN_FAILED');
          if (result.finalResponseVisible && result.text) await channel.reply(record.channelId, result.text);
        }
      },
    });
    this.stopReminderPoll = startReminderPolling(root, error => Logger.warning(`定时唤醒失败: ${String(error)}`));
  }

  injectContext(key: string, text: string, channelId?: string): void {
    const session = this.getOrCreate(key, channelId);
    session.injectContext(text);
  }

  /** 为 session 注入主动唤醒回调 */
  private injectWakeupReply(session: AgentSession, key: string): void {
    if (!this.wakeupSendFn) return;
    const sendFn = this.wakeupSendFn;
    session.setWakeupReply(async (text: string) => {
      const channelId = this.lastChannelIdMap.get(key);
      if (!channelId) {
        session.runWithLogContext(() => Logger.warning(`[${key}] 主动唤醒失败: 无 channelId`));
        return;
      }
      await sendFn(channelId, text, key);
    });
  }

  /** 启动定期清理（每分钟检查一次） */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, session] of this.sessions) {
        if (this.destroying.has(key)) continue;
        if (now - session.lastActiveAt > this.ttl) {
          this.destroying.add(key);
          this.sessions.delete(key);
          session.runWithLogContext(() => Logger.info(`会话已过期清理: ${key}`));
          session.cleanup({ checkWakeup: true, finalizeMemory: true, finalizationReason: 'ttl_cleanup' })
            .catch(err => session.runWithLogContext(() => Logger.warning(`会话 ${key} 清理失败: ${err}`)))
            .finally(() => this.destroying.delete(key));
        }
      }
    }, 60_000);
  }

  /** 停止清理定时器并保存所有会话 */
  async destroy(): Promise<void> {
    this.stopReminderPoll?.();
    this.unregisterReminderRoute?.();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // 保存所有活跃会话
    const cleanupPromises = Array.from(this.sessions.values()).map(session =>
      session.cleanup().catch(err =>
        session.runWithLogContext(() => Logger.warning(`会话 ${session.key} 清理失败: ${err}`))
      )
    );
    await Promise.all(cleanupPromises);

    this.sessions.clear();
    MessageSessionManager.managers.delete(this.sessionType);
  }
}
