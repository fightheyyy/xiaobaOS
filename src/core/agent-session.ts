import * as crypto from 'crypto';
import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { SkillActivationSignal, SkillInvocationContext } from '../types/skill';
import { ChannelCallbacks, ToolResult, ToolSurface } from '../types/tool';
import {
  buildSkillActivationSignal,
  upsertSkillSystemMessage,
} from '../skills/skill-activation-protocol';
import { ConversationRunner, RunnerCallbacks, RunToolResult } from './conversation-runner';
import { SubAgentManager } from './sub-agent-manager';
import { PromptManager } from '../utils/prompt-manager';
import { RoleResolver } from '../utils/role-resolver';
import { Logger } from '../utils/logger';
import { SessionStateBoundaryLog, SessionTurnLogger } from '../utils/session-turn-logger';
import { SessionStore } from '../utils/session-store';
import { Metrics } from '../utils/metrics';
import { ContextCompressor, resolveCompactionThreshold } from './context-compressor';
import { MemoryFinalizer, MemoryFinalizationReason } from '../utils/memory-finalizer';
import { visibleHistoryFilePath } from '../utils/visible-history-paths';
import { getObservability, ObservabilitySpan, ObservabilitySpanContext } from '../observability';

const TRANSIENT_SUBAGENT_STATUS_PREFIX = '[transient_subagent_status]';
const TRANSIENT_RUNNER_HINT_PREFIX = '[transient_runner_hint]';
const TRANSIENT_SOFT_CHECK_PREFIX = '[transient_soft_check]';
const TRANSIENT_SKILLS_LIST_PREFIX = '[transient_skills_list]';
export const BUSY_MESSAGE = '正在处理上一条消息，请稍候...';
export const ERROR_MESSAGE = '不好意思，刚才处理出了点问题，你再试一次？';

// ─── 接口定义 ───────────────────────────────────────────

/** 共享服务集合 */
export interface AgentServices {
  aiService: AIService;
  toolManager: ToolManager;
  skillManager: SkillManager;
  roleName?: string;

}

/** 会话回调（由适配层提供） */
export interface SessionCallbacks {
  onText?: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolStart?: (name: string, toolUseId: string, input: any) => void;
  onToolEnd?: (name: string, toolUseId: string, result: string) => void;
  onToolDisplay?: (name: string, content: string) => void;
  onRetry?: (attempt: number, maxRetries: number) => void;
}

/** 消息处理选项（由平台适配层传入） */
export interface HandleMessageOptions {
  callbacks?: SessionCallbacks;
  /** 平台通道回调，注入到 ToolExecutionContext 供工具使用 */
  channel?: ChannelCallbacks;
  /** 显式入口 surface；平台层必须传入，避免从 session key 误判 */
  surface?: ToolSurface;
  /** 记录到 session turn log 的原始用户输入；用于平台层给模型补充 transient prompt 时保留用户可见文本 */
  logInput?: string | import('../types').ContentBlock[];
  /** 已解析的父级观测上下文，用于跨 surface / 跨进程 trace 串联。 */
  observabilityContext?: ObservabilitySpanContext;
  /** W3C traceparent；runtime 只在内存中解析为 parent context，不写入本地 evidence。 */
  traceparent?: string;
  /** XiaoBa 本地 trace identity；用于关联用户可见 Conversation Journal 与 session evidence。 */
  traceId?: string;
  /** Channel surface final text fallback；默认 false，开启后才把 final text 合成为 send_text 交付。 */
  deliveryFallbackFinalReply?: boolean;
}

/** 命令处理选项。skill slash 命令带参数时会继续进入 handleMessage，需要保留入口上下文。 */
export interface HandleCommandOptions {
  callbacks?: SessionCallbacks;
  channel?: ChannelCallbacks;
  surface?: ToolSurface;
  observabilityContext?: ObservabilitySpanContext;
  traceparent?: string;
  traceId?: string;
  deliveryFallbackFinalReply?: boolean;
}

/** 命令处理结果 */
export interface CommandResult {
  handled: boolean;
  reply?: string;
  /** True when reply is intended for direct surface delivery. */
  finalResponseVisible?: boolean;
}

export interface HandleMessageResult {
  text: string;
  visibleToUser: boolean;
  /** True when text itself should be delivered directly to the user. */
  finalResponseVisible?: boolean;
  /** code mode 过程数据（thinking / tool_use / tool_result） */
  newMessages?: import('../types').Message[];
}

interface ProviderFailureBudgetEvidence {
  status: 'failure' | 'blocked';
  error_code: string;
  retryable: boolean;
  retry_count: number;
  retry_budget: number;
  retry_budget_exhausted: boolean;
  blocked_reason?: string;
  provider_failure_budget: {
    scope: 'session';
    fingerprint: string;
    prior_failure_count: number;
  };
}

interface ProviderTranscriptDegradationInput {
  providerError: Record<string, unknown>;
  failureBudget: ProviderFailureBudgetEvidence;
}

// ─── AgentSession 核心类 ────────────────────────────────

/**
 * AgentSession - 统一的会话核心
 *
 * 持有独立的 messages[]，封装：
 * - 系统提示词构建（幂等）
 * - 上下文恢复和长期记忆落盘触发
 * - 完整消息处理管线（ConversationRunner）
 * - 内置命令 + skill 命令
 * - 并发保护（busy）
 * - 退出时提取长期记忆候选
 */
export class AgentSession {
  private static readonly PROVIDER_RETRY_BUDGET = 1;
  private messages: Message[] = [];
  private initialized = false;
  private busy = false;
  private activeSkillName?: string;
  private activeSkillMaxTurns?: number;
  private activeSkillToolsets?: string[];
  private pendingRestore?: Message[];
  /** 过期时主动唤醒用户的回调（由平台 SessionManager 注入） */
  private wakeupReply?: (text: string) => Promise<void>;
  /** 外部请求中断当前 run（例如用户在 busy 时发送"停止"） */
  private interruptRequested = false;
  lastActiveAt: number = Date.now();
  private sessionTurnLogger: SessionTurnLogger;
  private compressor: ContextCompressor;
  private providerFailureCounts = new Map<string, number>();

  constructor(
    public readonly key: string,
    private services: AgentServices,
    private sessionType?: string,
  ) {
    const type = sessionType || this.extractSessionType(key);
    this.sessionType = type;
    this.sessionTurnLogger = new SessionTurnLogger(type, key);
    this.compressor = new ContextCompressor(services.aiService);
  }

  private extractSessionType(key: string): string {
    if (key.startsWith('pet:')) return 'pet';
    if (key.startsWith('feishu:')) return 'feishu';
    if (key.startsWith('user:')) return 'weixin';
    return 'chat';
  }

  runWithLogContext<T>(fn: () => T): T {
    return Logger.withSessionContext(this.key, this.sessionTurnLogger, fn);
  }

  private withLogContext<T>(fn: () => T): T {
    return this.runWithLogContext(fn);
  }

  /** 注入主动唤醒回调（由平台 SessionManager 在创建/获取 session 时调用） */
  setWakeupReply(callback: (text: string) => Promise<void>): void {
    this.wakeupReply = callback;
  }

  // ─── 初始化 ─────────────────────────────────────────

  /** 构建系统提示词（幂等，仅首次生效） */
  async init(surface?: ToolSurface): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const resolvedSurface = this.resolveSurface(surface);
    const systemPrompt = await PromptManager.buildSystemPrompt({ roleName: this.services.roleName });
    const surfacePrompt = PromptManager.getSurfacePrompt();
    if (systemPrompt.trim()) {
      this.messages.push({ role: 'system', content: systemPrompt });
    }
    if (resolvedSurface === 'feishu') {
      const isGroup = this.key.startsWith('group:');
      const chatType = isGroup ? '群聊' : '私聊';
      this.messages.push({
        role: 'system',
        content: `[surface:feishu:${isGroup ? 'group' : 'private'}]\n当前是飞书${chatType}会话。\n${surfacePrompt}`,
      });
    } else if (resolvedSurface === 'weixin') {
      this.messages.push({
        role: 'system',
        content: `[surface:weixin]\n当前是微信会话。\n${surfacePrompt}`,
      });
    } else if (resolvedSurface === 'pet') {
      this.messages.push({
        role: 'system',
        content: `[surface:pet]\n当前是 XiaoBa Pet 本地具身交互平台。用户通过桌宠唤醒、输入消息并接收回复；pet 会表现你的等待、审查、运行、完成和失败状态。\n${surfacePrompt}`,
      });
    }

    // 加载上次会话摘要（本地文件兜底）
    // 已移除摘要机制

    // 从 DB 恢复未归档的消息
    if (this.pendingRestore) {
      this.messages.push(...this.pendingRestore);
      Logger.info(`[会话 ${this.key}] 已恢复 ${this.pendingRestore.length} 条消息`);
      this.pendingRestore = undefined;

      // 恢复后立即检查是否需要压缩
      const usage = this.compressor.getUsageInfo(this.messages);
      Logger.info(`[${this.key}] 恢复后上下文: ${usage.usedTokens}/${usage.maxTokens} tokens (${usage.usagePercent}%)`);

      if (this.compressor.needsCompaction(this.messages)) {
        Logger.info(`[${this.key}] 超过阈值，开始压缩...`);
        try {
          await this.compactSessionMessagesWithEvidence('agent_session_restore', 'threshold_exceeded', resolvedSurface, usage);
          Logger.info(`[${this.key}] 压缩完成，当前消息数: ${this.messages.length}`);
        } catch (err) {
          Logger.error(`[${this.key}] 压缩失败: ${err}`);
        }
      }
    }
  }

  /**
   * 启动时激活指定 skill，将其 prompt 注入系统消息。
   * 用于 --skill 参数，在会话开始前绑定 skill 上下文。
   */
  async activateSkill(skillName: string): Promise<boolean> {
    return this.withLogContext(async () => {
      const skill = this.services.skillManager.getSkill(skillName);
      if (!skill) {
        Logger.warning(`Skill "${skillName}" 未找到`);
        return false;
      }

      await this.init();

      const context: SkillInvocationContext = {
        skillName,
        arguments: [],
        rawArguments: '',
        userMessage: '',
      };
      const activation = buildSkillActivationSignal(skill, context);
      this.applySkillActivation(activation);

      Logger.info(`[${this.key}] 启动时激活 skill: ${skill.metadata.name}${skill.metadata.maxTurns ? ` (maxTurns=${skill.metadata.maxTurns})` : ''}`);
      return true;
    });
  }

  // ─── 消息处理 ───────────────────────────────────────

  private static readonly MAX_INJECTED_CONTEXT = 30;

  /** 静默注入上下文消息，不触发 AI 推理。超过上限自动丢弃最早的注入消息。 */
  injectContext(text: string): void {
    this.messages.push({ role: 'user', content: text, __injected: true });
    this.lastActiveAt = Date.now();

    // 滑动窗口：超过上限时丢弃最早的注入消息
    const injectedCount = this.messages.filter(m => m.__injected).length;
    if (injectedCount > AgentSession.MAX_INJECTED_CONTEXT) {
      const idx = this.messages.findIndex(m => m.__injected);
      if (idx >= 0) this.messages.splice(idx, 1);
    }
  }

  /**
   * 完整消息处理管线：记忆搜索 → AI 推理 → 工具循环 → 同步历史
   *
   * @param text 用户消息文本
   * @param callbacksOrOptions 旧签名兼容 SessionCallbacks，新签名用 HandleMessageOptions
   */
  async handleMessage(
    text: string | import('../types').ContentBlock[],
    callbacksOrOptions?: SessionCallbacks | HandleMessageOptions,
  ): Promise<HandleMessageResult> {
    return this.withLogContext(async () => {
      // 兼容旧签名：如果传入的对象有 onText/onToolStart 等字段，视为 SessionCallbacks
      let callbacks: SessionCallbacks | undefined;
      let channel: ChannelCallbacks | undefined;
      let explicitSurface: ToolSurface | undefined;
      let explicitObservabilityContext: ObservabilitySpanContext | undefined;
      let explicitTraceparent: string | undefined;
      let explicitTraceId: string | undefined;
      let deliveryFallbackFinalReply = false;

      if (callbacksOrOptions) {
        if (this.isHandleMessageOptions(callbacksOrOptions)) {
          // 新签名 HandleMessageOptions
          const opts = callbacksOrOptions as HandleMessageOptions;
          callbacks = opts.callbacks;
          channel = opts.channel;
          explicitSurface = opts.surface;
          explicitObservabilityContext = opts.observabilityContext;
          explicitTraceparent = opts.traceparent;
          explicitTraceId = opts.traceId;
          deliveryFallbackFinalReply = opts.deliveryFallbackFinalReply === true;
        } else {
          // 旧签名 SessionCallbacks
          callbacks = callbacksOrOptions as SessionCallbacks;
        }
      }
      const logInput = callbacksOrOptions && this.isHandleMessageOptions(callbacksOrOptions)
        ? (callbacksOrOptions as HandleMessageOptions).logInput
        : undefined;
      const surface = this.resolveSurface(explicitSurface);

      if (this.busy) {
        return { text: BUSY_MESSAGE, visibleToUser: true, finalResponseVisible: true };
      }

      const observability = getObservability();
      const parentObservabilityContext = explicitObservabilityContext
        || observability.parseTraceparent(explicitTraceparent);
      const baseObservabilityAttrs = {
        'xiaoba.session.id_hash': observability.sessionIdHash(this.key),
        'xiaoba.session.type': this.sessionType || this.extractSessionType(this.key),
        'xiaoba.surface': surface,
        ...(parentObservabilityContext && { 'xiaoba.trace.parent_propagated': true }),
        ...(this.services.roleName && { 'xiaoba.role.name': this.services.roleName }),
        ...observability.userInputAttributes(logInput ?? text),
      };
      const sessionSpan: ObservabilitySpan = observability.startSpan(
        'xiaoba.session',
        baseObservabilityAttrs,
        parentObservabilityContext,
      );
      const sessionStartMs = Date.now();
      let sessionSpanEnded = false;
      const finishSessionSpan = (status: 'ok' | 'error', attrs: Record<string, unknown> = {}, message?: string) => {
        if (sessionSpanEnded) return;
        sessionSpanEnded = true;
        observability.endSpan(sessionSpan, {
          status,
          message,
          attributes: attrs as any,
        });
      };
      this.sessionTurnLogger.logRuntimeEvent('session_started', {
        surface,
        status: 'started',
        environment: process.env.NODE_TEST_CONTEXT ? 'test' : 'runtime',
      });
      observability.mirrorMetric('xiaoba.session.started', 1, baseObservabilityAttrs);
      observability.recordLog('xiaoba.session.started', baseObservabilityAttrs, 'INFO', sessionSpan.context);

      // 按"单次消息"统计 metrics，避免跨轮次累积导致定位困难
      Metrics.reset();

      this.busy = true;
      this.interruptRequested = false;
      this.lastActiveAt = Date.now();

      // 检查是否需要压缩上下文
      if (this.compressor.needsCompaction(this.messages)) {
        const usage = this.compressor.getUsageInfo(this.messages);
        Logger.info(`[${this.key}] 上下文即将压缩: ${usage.usedTokens}/${usage.maxTokens} tokens (${usage.usagePercent}%)`);
        try {
          await this.compactSessionMessagesWithEvidence('agent_session_pre_message', 'threshold_exceeded', surface, usage);
          Logger.info(`[${this.key}] 压缩完成，当前消息数: ${this.messages.length}`);
        } catch (err) {
          Logger.error(`[${this.key}] 压缩失败: ${err}`);
        }
      }

      try {
        await this.init(surface);
        const textContent = typeof text === 'string' ? text : '';
        this.tryAutoActivateSkill(textContent);
        this.messages.push({ role: 'user', content: text });


        // 构建上下文消息
        let contextMessages: Message[] = [...this.messages];

        // 注入后台子智能体状态（临时上下文，不持久化）
        const subAgentManager = SubAgentManager.getInstance();
        const subAgents = subAgentManager.listByParent(this.key);
        if (subAgents.length > 0) {
          const activeCount = subAgents.filter(s => (
            s.status === 'running' || s.status === 'waiting_for_input'
          )).length;
          const statusLines = subAgents.map(s => {
            const statusLabel = s.status === 'running'
              ? '运行中'
              : s.status === 'waiting_for_input'
                ? '等待输入'
                : s.status === 'completed'
                  ? '已完成'
                  : s.status === 'failed'
                    ? '失败'
                    : '已停止';
            const latest = s.progressLog[s.progressLog.length - 1] ?? '';
            const summary = s.status === 'completed' && s.resultSummary ? `\n  结果: ${s.resultSummary.slice(0, 200)}` : '';
            const pending = s.status === 'waiting_for_input' && s.pendingQuestion
              ? `\n  待回复问题: ${s.pendingQuestion.slice(0, 500)}`
              : '';
            return `- [${s.id}] ${s.taskDescription} (${statusLabel}) ${latest}${pending}${summary}`;
          }).join('\n');
          const retainedCount = subAgents.length - activeCount;
          const statusSummary = `当前有 ${activeCount} 个活跃后台子任务`
            + (retainedCount > 0 ? `，另保留 ${retainedCount} 个已结束任务记录` : '');

          const subagentStatusMsg: Message = {
            role: 'system',
            content: `${TRANSIENT_SUBAGENT_STATUS_PREFIX}\n${statusSummary}：\n${statusLines}\n\n用户如果询问任务进度，请基于以上信息回答。等待输入的任务应使用 resume_subagent 回复；用户如果要求停止任务，使用 stop_subagent。`,
          };
          // 插入到最后一条用户消息之前
          const lastUserIdx = contextMessages.length - 1;
          contextMessages.splice(lastUserIdx, 0, subagentStatusMsg);
        }

        // 动态注入当前可用 skills 列表（临时上下文，不持久化）
        // 每次处理消息时重新从磁盘加载 skills，确保 Dashboard 的禁用/启用/安装/删除立即生效
        await this.services.skillManager.loadSkills();
        if (this.revokeUnavailableActiveSkill()) {
          contextMessages = contextMessages.filter(message => !this.isSkillSystemMessage(message));
        }

        const skills = this.services.skillManager.getUserInvocableSkills();
        if (skills.length > 0) {
          const skillList = skills.map(s => `- ${s.metadata.name}: ${s.metadata.description}`).join('\n');
          const skillsListMsg: Message = {
            role: 'system',
            content: `${TRANSIENT_SKILLS_LIST_PREFIX}\n你可以使用以下skills（通过skill工具调用）：\n\n${skillList}`,
          };
          const lastUserIdx = contextMessages.length - 1;
          contextMessages.splice(lastUserIdx, 0, skillsListMsg);
        }

        // 运行对话循环（优先用显式设置的 maxTurns，否则从 messages 中检测已激活 skill）
        const detectedSkillName = this.activeSkillName ?? this.detectActiveSkillName();
        if (detectedSkillName) {
          const detectedSkill = this.services.skillManager.getSkill(detectedSkillName);
          this.activeSkillName = detectedSkillName;
          this.activeSkillMaxTurns = detectedSkill?.metadata.maxTurns;
          this.activeSkillToolsets = detectedSkill?.metadata.toolsets;
        }

        const effectiveMaxTurns = this.activeSkillMaxTurns ?? this.detectSkillMaxTurns();
        const runner = new ConversationRunner(
          this.services.aiService,
          this.services.toolManager,
          {
            ...(effectiveMaxTurns ? { maxTurns: effectiveMaxTurns } : {}),
            initialSkillName: this.activeSkillName,
            initialSkillToolsets: this.activeSkillToolsets,
            shouldContinue: () => !this.interruptRequested,
            toolExecutionContext: {
              sessionId: this.key,
              surface,
              permissionProfile: 'strict',
              channel,
              ...(this.services.roleName ? { roleName: this.services.roleName } : {}),
            },
            observabilityContext: sessionSpan.context,
            observabilityMetricMode: 'mirror_only',
            deliveryFallbackFinalReply,
            onContextCompaction: event => this.sessionTurnLogger.logContextCompaction(event),
          },
        );
        const runnerCallbacks: RunnerCallbacks = {
          onText: callbacks?.onText,
          onToolStart: callbacks?.onToolStart,
          onToolEnd: callbacks?.onToolEnd,
          onToolDisplay: callbacks?.onToolDisplay,
          onRetry: callbacks?.onRetry,
        };

        const result = await runner.run(contextMessages, runnerCallbacks);
        this.providerFailureCounts.clear();
        const persistedMessages = this.removeTransientMessages(result.messages);
        this.messages = [...persistedMessages];

        // 同步 skill 激活状态
        for (const msg of result.newMessages) {
          const activation = this.parseActivationFromSystemMessage(msg);
          if (activation) {
            this.applySkillActivation(activation);
          }
        }

        // 输出本次请求的 metrics 摘要
        const metrics = Metrics.getSummary();
        if (metrics.aiCalls > 0 || metrics.toolCalls > 0) {
          Logger.info(
            `[Metrics] AI调用: ${metrics.aiCalls}次, ` +
            `tokens: ${metrics.totalPromptTokens}+${metrics.totalCompletionTokens}=${metrics.totalTokens}, ` +
            `工具调用: ${metrics.toolCalls}次, 工具耗时: ${metrics.toolDurationMs}ms`
          );
        }

        // 替换 base64 图片数据为路径占位符，避免撑爆 context
        for (const msg of this.messages) {
          if (Array.isArray(msg.content)) {
            msg.content = msg.content.map(block => {
              if (block.type === 'image' && block.source?.data) {
                const filePath = (block as any).filePath || '未知路径';
                return { type: 'text' as const, text: `[图片: ${filePath}]` };
              }
              return block;
            });
          }
        }

        // 默认 skill activation is run-scoped. Roles that opt into skill_scoped
        // tool visibility keep only the active domain state so confirmation turns
        // can still see the relevant confirmed tools.
        if (!this.shouldPersistActiveSkillForToolVisibility()) {
          this.activeSkillName = undefined;
          this.activeSkillMaxTurns = undefined;
          this.activeSkillToolsets = undefined;
        }

        // 移除 skill 系统消息（下一轮需要时会重新注入）
        this.messages = this.messages.filter(m => {
          if (m.role === 'system' && typeof m.content === 'string') {
            return !m.content.match(/^\[skill:[^\]]+\]/);
          }
          return true;
        });

        const visibleToUser = result.finalResponseVisible || this.hasDeliveredOutput(result.toolResults);
        const completionAttrs = {
          ...baseObservabilityAttrs,
          'xiaoba.session.status': 'success',
          'xiaoba.session.duration_ms': Date.now() - sessionStartMs,
          'xiaoba.session.visible_to_user': visibleToUser,
          'xiaoba.session.final_response_visible': result.finalResponseVisible,
          'xiaoba.tokens.prompt': metrics.totalPromptTokens,
          'xiaoba.tokens.completion': metrics.totalCompletionTokens,
          'xiaoba.tokens.total': metrics.totalTokens,
          'xiaoba.model.call_count': metrics.aiCalls,
          'xiaoba.tool.call_count': metrics.toolCalls,
          'xiaoba.tool.duration_ms': metrics.toolDurationMs,
        };
        this.sessionTurnLogger.logRuntimeEvent('session_completed', {
          surface,
          status: 'success',
          duration_ms: completionAttrs['xiaoba.session.duration_ms'],
          model_call_count: metrics.aiCalls,
          tool_call_count: metrics.toolCalls,
          tool_duration_ms: metrics.toolDurationMs,
          visible_to_user: visibleToUser,
          final_response_visible: result.finalResponseVisible,
        });

        // 记录本次用户请求 trace；pending lifecycle events are embedded into it.
        const toolCalls = result.toolResults.map(record => this.toSessionToolCallLog(record));

        this.sessionTurnLogger.logTurn(
          logInput ?? text,
          result.response || '',
          toolCalls,
          { prompt: metrics.totalPromptTokens, completion: metrics.totalCompletionTokens },
          result.toolVisibility,
          this.buildStateBoundary(surface),
          explicitTraceId,
        );

        observability.mirrorMetric('xiaoba.session.completed', 1, completionAttrs);
        observability.mirrorMetric('xiaoba.session.result', 1, completionAttrs);
        observability.mirrorMetric('xiaoba.session.duration_ms', completionAttrs['xiaoba.session.duration_ms'], completionAttrs, 'ms');
        observability.recordLog('xiaoba.session.completed', completionAttrs, 'INFO', sessionSpan.context);
        finishSessionSpan('ok', completionAttrs);

        return {
          text: result.finalResponseVisible ? (result.response || '[无回复]') : '',
          visibleToUser,
          finalResponseVisible: result.finalResponseVisible,
          newMessages: result.newMessages,
        };
      } catch (err: any) {
        // 不删除用户消息，而是添加一个错误回复，保持上下文连贯
        // 这样用户说"继续"时可以接上
        const providerErrorEvidence = this.toProviderErrorEvidence(err);
        const providerFailureBudget = this.recordProviderFailureBudget(providerErrorEvidence);
        const providerErrorCode = String(providerErrorEvidence.error_code || 'PROVIDER_ERROR');
        const providerStatus = providerErrorEvidence.status ? ` status=${providerErrorEvidence.status}` : '';
        const providerBudgetStatus = providerFailureBudget.retry_budget_exhausted ? ' retry_budget_exhausted=true' : '';
        Logger.error(`[会话 ${this.key}] 处理失败: ${providerErrorCode}${providerStatus}${providerBudgetStatus}`);

        // 识别多模态相关错误
        const errorMsg = err.message || String(err);
        const isVisionError = errorMsg.match(/image|vision|multimodal|media_type|base64.*not supported/i);

        let errorReply = ERROR_MESSAGE;
        if (isVisionError) {
          errorReply = '当前模型不支持图片识别。请使用支持多模态的模型（如 Claude 3.5 Sonnet 或 GPT-4V），或者用文字描述图片内容。';
        } else if (providerFailureBudget.status === 'blocked') {
          errorReply = this.providerBlockedReply(providerErrorEvidence, providerFailureBudget);
        }

        // 添加错误回复到上下文，保持对话连贯性
        this.messages.push({
          role: 'assistant',
          content: `[处理失败: ${providerErrorCode}${providerStatus}${providerBudgetStatus}]`
        });
        const metrics = Metrics.getSummary();
        const providerAttrs = {
          ...baseObservabilityAttrs,
          'xiaoba.session.status': providerFailureBudget.status,
          'xiaoba.session.duration_ms': Date.now() - sessionStartMs,
          'xiaoba.error_code': providerErrorCode,
          'xiaoba.provider.retryable': providerFailureBudget.retryable,
          'xiaoba.provider.retry_count': providerFailureBudget.retry_count,
          'xiaoba.provider.retry_budget': providerFailureBudget.retry_budget,
          'xiaoba.provider.retry_budget_exhausted': providerFailureBudget.retry_budget_exhausted,
          'xiaoba.tokens.prompt': metrics.totalPromptTokens,
          'xiaoba.tokens.completion': metrics.totalCompletionTokens,
          'xiaoba.tokens.total': metrics.totalTokens,
          'xiaoba.model.call_count': metrics.aiCalls,
          'xiaoba.tool.call_count': metrics.toolCalls,
          'xiaoba.tool.duration_ms': metrics.toolDurationMs,
          ...(String(providerErrorEvidence.provider || '') && { 'xiaoba.provider.name': String(providerErrorEvidence.provider) }),
          ...(String(providerErrorEvidence.model || '') && { 'xiaoba.provider.model': String(providerErrorEvidence.model) }),
          ...(providerFailureBudget.blocked_reason && { 'xiaoba.blocked_reason': providerFailureBudget.blocked_reason }),
        };
        observability.mirrorMetric('xiaoba.provider.error', 1, providerAttrs);
        observability.mirrorMetric('xiaoba.session.result', 1, providerAttrs);
        observability.mirrorMetric('xiaoba.session.duration_ms', providerAttrs['xiaoba.session.duration_ms'], providerAttrs, 'ms');
        observability.recordLog('xiaoba.provider.error', providerAttrs, 'ERROR', sessionSpan.context);
        this.sessionTurnLogger.logRuntimeEvent('provider_error', {
          surface,
          status: providerFailureBudget.status,
          duration_ms: providerAttrs['xiaoba.session.duration_ms'],
          error_code: providerFailureBudget.error_code,
          retryable: providerFailureBudget.retryable,
          retry_count: providerFailureBudget.retry_count,
          retry_budget: providerFailureBudget.retry_budget,
          retry_budget_exhausted: providerFailureBudget.retry_budget_exhausted,
          ...(providerFailureBudget.blocked_reason && { blocked_reason: providerFailureBudget.blocked_reason }),
          provider_failure_budget: providerFailureBudget.provider_failure_budget,
          provider_error: providerErrorEvidence,
          tokens: { prompt: metrics.totalPromptTokens, completion: metrics.totalCompletionTokens },
        });
        this.sessionTurnLogger.logTurn(
          logInput ?? text,
          errorReply,
          [],
          { prompt: metrics.totalPromptTokens, completion: metrics.totalCompletionTokens },
          undefined,
          this.buildStateBoundary(surface, {
            providerError: providerErrorEvidence,
            failureBudget: providerFailureBudget,
          }),
          explicitTraceId,
        );

        finishSessionSpan('error', {
          ...providerAttrs,
        }, providerErrorCode);

        return { text: errorReply, visibleToUser: true, finalResponseVisible: true };
      } finally {
        finishSessionSpan('error', {
          ...baseObservabilityAttrs,
          'xiaoba.error_code': 'SESSION_ABORTED',
        }, 'Session ended before completion evidence was recorded.');
        this.saveRestorableContext();
        this.busy = false;
      }
    });
  }

  private toSessionToolCallLog(record: RunToolResult) {
    const toolResult = record.result;
    const errorCode = toolResult.error_code || toolResult.errorCode;
    return {
      id: record.toolCall.id,
      tool_call_id: toolResult.tool_call_id || record.toolCall.id,
      name: toolResult.name || record.toolName || record.toolCall.function.name,
      arguments: this.parseToolArgumentsForLog(record.toolCall.function.arguments),
      result: this.toolResultContentToString(toolResult),
      ...(toolResult.duration_ms !== undefined && { duration_ms: toolResult.duration_ms }),
      ...(toolResult.status && { status: toolResult.status }),
      ...(errorCode && { error_code: errorCode }),
      ...(toolResult.retryable !== undefined && { retryable: toolResult.retryable }),
      ...(toolResult.retry_count !== undefined && { retry_count: toolResult.retry_count }),
      ...(toolResult.retry_budget !== undefined && { retry_budget: toolResult.retry_budget }),
      ...(toolResult.retry_budget_exhausted !== undefined && { retry_budget_exhausted: toolResult.retry_budget_exhausted }),
      ...(toolResult.blocked_reason && { blocked_reason: toolResult.blocked_reason }),
      ...(toolResult.artifact_manifest?.length && { artifact_manifest: toolResult.artifact_manifest }),
      ...(toolResult.delivery_evidence?.length && { delivery_evidence: toolResult.delivery_evidence }),
      ...(toolResult.external_delivery_receipts?.length && { external_delivery_receipts: toolResult.external_delivery_receipts }),
    };
  }

  private hasDeliveredOutput(records: RunToolResult[]): boolean {
    return records.some(record => {
      return record.result.delivery_evidence?.some(delivery => delivery.status === 'delivered') === true;
    });
  }

  private toProviderErrorEvidence(error: any): Record<string, unknown> {
    const message = this.errorMessage(error);
    const status = this.extractProviderStatus(error, message);
    const providerError: Record<string, unknown> = {
      provider: this.firstString(
        error?.provider,
        error?.provider_kind,
        error?.providerKind,
        error?.providerName,
      ) || 'unknown',
      error_code: this.classifyProviderErrorCode(error, status, message),
      retryable: this.isRetryableProviderError(error, status, message),
      message,
    };

    const model = this.firstString(error?.model, error?.model_name, error?.modelName);
    if (model) {
      providerError.model = model;
    }

    const endpoint = this.firstString(error?.endpoint, error?.endpoint_label, error?.endpointLabel);
    if (endpoint) {
      providerError.endpoint = endpoint;
    }

    if (status !== undefined) {
      providerError.status = status;
    }

    return providerError;
  }

  private recordProviderFailureBudget(providerError: Record<string, unknown>): ProviderFailureBudgetEvidence {
    const errorCode = String(providerError.error_code || 'PROVIDER_ERROR');
    const retryable = providerError.retryable === true;
    const retryBudget = retryable ? AgentSession.PROVIDER_RETRY_BUDGET : 0;
    const fingerprint = this.providerFailureFingerprint(providerError);
    const priorFailureCount = this.providerFailureCounts.get(fingerprint) ?? 0;
    const retryBudgetExhausted = priorFailureCount >= retryBudget;
    this.providerFailureCounts.set(fingerprint, priorFailureCount + 1);

    const blockedReason = retryBudgetExhausted
      ? this.providerBlockedReason(errorCode, retryable, priorFailureCount)
      : undefined;

    return {
      status: retryBudgetExhausted ? 'blocked' : 'failure',
      error_code: errorCode,
      retryable,
      retry_count: priorFailureCount,
      retry_budget: retryBudget,
      retry_budget_exhausted: retryBudgetExhausted,
      ...(blockedReason && { blocked_reason: blockedReason }),
      provider_failure_budget: {
        scope: 'session',
        fingerprint,
        prior_failure_count: priorFailureCount,
      },
    };
  }

  private providerFailureFingerprint(providerError: Record<string, unknown>): string {
    const parts = [
      providerError.provider,
      providerError.model,
      providerError.endpoint,
      providerError.status,
      providerError.error_code,
    ].map(value => String(value ?? '').trim().toLowerCase());
    const digest = crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
    return `sha256:${digest}`;
  }

  private providerBlockedReason(errorCode: string, retryable: boolean, priorFailureCount: number): string {
    if (!retryable) {
      return `Provider returned non-retryable error ${errorCode}; blocked until provider configuration, credentials, or request compatibility changes.`;
    }
    return `Provider retry budget exhausted after ${priorFailureCount} prior failure${priorFailureCount === 1 ? '' : 's'} for ${errorCode}.`;
  }

  private providerBlockedReply(
    providerError: Record<string, unknown>,
    budget: ProviderFailureBudgetEvidence,
  ): string {
    const errorCode = String(providerError.error_code || budget.error_code || 'PROVIDER_ERROR');
    if (errorCode === 'PROVIDER_AUTH_ERROR') {
      return '当前模型服务鉴权失败，已停止继续请求。请检查 API Key、模型权限或 provider 配置后再试。';
    }
    if (errorCode === 'MODEL_RATE_LIMIT') {
      return '模型服务连续限流，已停止继续请求。请稍后再试，或者切换模型/provider。';
    }
    if (errorCode === 'PROVIDER_TIMEOUT' || errorCode === 'PROVIDER_NETWORK_ERROR' || errorCode === 'PROVIDER_UPSTREAM_ERROR') {
      return '模型服务连续不可用，已停止继续请求。请稍后再试，或者切换模型/provider。';
    }
    return '模型服务连续失败，已停止继续请求。请检查 provider 配置或稍后再试。';
  }

  private errorMessage(error: any): string {
    return String(error?.message || error || 'unknown provider error');
  }

  private extractProviderStatus(error: any, message: string): number | undefined {
    const status = Number(error?.status ?? error?.response?.status);
    if (Number.isInteger(status) && status > 0) {
      return status;
    }

    const match = message.match(/(?:API错误|HTTP)\s*\(?(\d{3})\)?/i);
    if (match) {
      return Number(match[1]);
    }

    return undefined;
  }

  private classifyProviderErrorCode(error: any, status: number | undefined, message: string): string {
    const explicitCode = this.firstString(error?.error_code, error?.errorCode);
    if (explicitCode) {
      return explicitCode;
    }

    const code = this.firstString(error?.code, error?.error?.code)?.toUpperCase() || '';
    if (status === 429 || /rate limit|too many requests|限流/i.test(message)) {
      return 'MODEL_RATE_LIMIT';
    }
    if (status === 401 || status === 403 || /unauthorized|forbidden|api key|api密钥|鉴权|认证|权限/i.test(message)) {
      return 'PROVIDER_AUTH_ERROR';
    }
    if (status === 408 || /timeout|timed out|ETIMEDOUT/i.test(`${message} ${code}`)) {
      return 'PROVIDER_TIMEOUT';
    }
    if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network error|fetch failed|socket hang up/i.test(`${message} ${code}`)) {
      return 'PROVIDER_NETWORK_ERROR';
    }
    if (status && [500, 502, 503, 504, 529].includes(status)) {
      return 'PROVIDER_UPSTREAM_ERROR';
    }
    return 'PROVIDER_ERROR';
  }

  private isRetryableProviderError(error: any, status: number | undefined, message: string): boolean {
    if (typeof error?.retryable === 'boolean') {
      return error.retryable;
    }

    const code = this.firstString(error?.code, error?.error?.code)?.toUpperCase() || '';
    if (status && [408, 429, 500, 502, 503, 504, 529].includes(status)) {
      return true;
    }
    return /rate limit|too many requests|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network error|fetch failed|socket hang up|限流/i
      .test(`${message} ${code}`);
  }

  private firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  }

  private parseToolArgumentsForLog(argumentsJson: string): unknown {
    try {
      return JSON.parse(argumentsJson || '{}');
    } catch {
      return argumentsJson;
    }
  }

  private toolResultContentToString(toolResult: ToolResult): string {
    const content = toolResult.content as unknown;
    if (typeof content === 'string') {
      return content;
    }
    if (!Array.isArray(content)) {
      if (content && typeof content === 'object' && '_imageForNewMessage' in content) {
        const image = content as { filePath?: unknown };
        return `已读取图片: ${typeof image.filePath === 'string' ? image.filePath : 'unknown'}`;
      }
      return '';
    }
    return content
      .map(block => block.type === 'text' ? (block as any).text : '[非文本内容]')
      .join('');
  }

  // ─── 命令处理 ───────────────────────────────────────

  /** 内置命令 + skill 命令统一入口 */
  async handleCommand(
    command: string,
    args: string[],
    callbacksOrOptions?: SessionCallbacks | HandleCommandOptions,
  ): Promise<CommandResult> {
    return this.withLogContext(async () => {
      const commandOptions = this.normalizeCommandOptions(callbacksOrOptions);
      const commandName = command.toLowerCase();

      // /stop - 中断当前正在运行的请求
      if (commandName === 'stop') {
        this.requestInterrupt();
        return { handled: true, reply: '正在停止当前请求...', finalResponseVisible: true };
      }

      // /clear
      if (commandName === 'clear') {
        if (args.includes('--all')) {
          this.clear();
          return { handled: true, reply: '历史已清空，文件已删除', finalResponseVisible: true };
        }
        this.reset();
        return { handled: true, reply: '历史已清空', finalResponseVisible: true };
      }

      // /skills
      if (commandName === 'skills') {
        return this.handleSkillsCommand();
      }

      // /history
      if (commandName === 'history') {
        return {
          handled: true,
          reply: `对话历史信息:\n当前历史长度: ${this.messages.length} 条消息\n上下文压缩: 由 ConversationRunner 自动管理`,
          finalResponseVisible: true,
        };
      }

      // /exit
      if (commandName === 'exit') {
        await this.summarizeAndDestroy();
        return { handled: true, reply: '再见！期待下次与你对话。', finalResponseVisible: true };
      }


      // skill 斜杠命令
      return this.handleSkillCommand(commandName, args, commandOptions);
    });
  }

  // ─── 生命周期 ──────────────────────────────────────

  /** 重置会话状态（仅清内存，保留历史文件） */
  reset(): void {
    this.messages = [];
    this.initialized = false;
    this.activeSkillName = undefined;
    this.activeSkillMaxTurns = undefined;
    this.activeSkillToolsets = undefined;
    this.lastActiveAt = Date.now();
  }

  /** 清空历史（同时删除文件） */
  clear(): void {
    SessionStore.getInstance().deleteSession(this.key, this.sessionStoreType());
    this.reset();
  }

  async summarizeAndDestroy(): Promise<boolean> {
    return this.withLogContext(async () => {
      const hasUserMessages = this.messages.some(m => m.role === 'user');
      if (this.messages.length === 0 || !hasUserMessages) {
        return false;
      }

      try {
        const conversationText = this.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => `${m.role === 'user' ? '\u7528\u6237' : 'AI'}: ${m.content}`)
          .join('\n');

      // \u540c\u65f6\u751f\u6210\u6458\u8981 + \u5224\u65ad\u662f\u5426\u9700\u8981\u4e3b\u52a8\u5524\u9192\uff08\u4e0d\u589e\u52a0\u989d\u5916 AI \u8c03\u7528\uff09
      const summaryPrompt = this.wakeupReply
        ? `\u8bf7\u5bf9\u4ee5\u4e0b\u5bf9\u8bdd\u8fdb\u884c\u5206\u6790\uff0c\u8fd4\u56de JSON \u683c\u5f0f\u7684\u7ed3\u679c\u3002

\u5bf9\u8bdd\u5185\u5bb9\uff1a
${conversationText}

\u8bf7\u8fd4\u56de\u4ee5\u4e0b JSON \u683c\u5f0f\uff08\u4e0d\u8981\u5305\u542b markdown \u4ee3\u7801\u5757\u6807\u8bb0\uff09\uff1a
{
  "summary": "\u7b80\u6d01\u7684\u5bf9\u8bdd\u6458\u8981\uff0c\u4fdd\u7559\u5173\u952e\u4fe1\u606f\u3001\u91cd\u8981\u4e8b\u5b9e\u548c\u4e0a\u4e0b\u6587",
  "wakeup": null \u6216 "\u4e00\u6761\u81ea\u7136\u7684\u6d88\u606f"
}

\u5173\u4e8e wakeup \u5b57\u6bb5\u7684\u5224\u65ad\u89c4\u5219\uff1a
- \u5982\u679c\u6709\u672a\u5b8c\u6210\u7684\u4efb\u52a1\u6216\u627f\u8bfa\uff08\u5982 AI \u8bf4\u201c\u7a0d\u540e\u5e2e\u4f60\u67e5\u201d\u4f46\u6ca1\u505a\uff09\u2192 \u9700\u8981\u5524\u9192
- \u5982\u679c\u6709\u540e\u53f0\u4efb\u52a1\u5df2\u5b8c\u6210\u4f46\u7ed3\u679c\u8fd8\u6ca1\u544a\u8bc9\u7528\u6237 \u2192 \u9700\u8981\u5524\u9192
- \u5982\u679c\u7528\u6237\u6700\u540e\u7684\u95ee\u9898\u6ca1\u6709\u5f97\u5230\u5b8c\u6574\u56de\u7b54 \u2192 \u9700\u8981\u5524\u9192
- \u5982\u679c\u5bf9\u8bdd\u81ea\u7136\u7ed3\u675f\u3001\u7528\u6237\u4e3b\u52a8\u544a\u522b\u3001\u6216\u53ea\u662f\u95f2\u804a \u2192 \u4e0d\u9700\u8981\u5524\u9192\uff08\u8fd4\u56de null\uff09
- \u5524\u9192\u6d88\u606f\u8981\u81ea\u7136\uff0c\u50cf\u52a9\u7406\u4e3b\u52a8\u8ddf\u8fdb\uff0c\u4e0d\u8981\u751f\u786c`
        : `\u8bf7\u5bf9\u4ee5\u4e0b\u5bf9\u8bdd\u8fdb\u884c\u7b80\u6d01\u7684\u6458\u8981\uff0c\u4fdd\u7559\u5173\u952e\u4fe1\u606f\u3001\u91cd\u8981\u4e8b\u5b9e\u548c\u4e0a\u4e0b\u6587\u3002\u6458\u8981\u5e94\u8be5\u7b80\u6d01\u4f46\u5b8c\u6574\uff0c\u4ee5\u4fbf\u672a\u6765\u56de\u5fc6\u65f6\u80fd\u7406\u89e3\u5bf9\u8bdd\u7684\u4e3b\u8981\u5185\u5bb9\u3002

\u5bf9\u8bdd\u5185\u5bb9\uff1a
${conversationText}

\u8bf7\u751f\u6210\u6458\u8981\uff1a`;

        const result = await this.services.aiService.chat([
          { role: 'user', content: summaryPrompt },
        ]);

      // \u89e3\u6790 AI \u8fd4\u56de\u7684\u7ed3\u679c
        let summaryText: string;
        let wakeupMessage: string | null = null;

        if (this.wakeupReply) {
        // \u5c1d\u8bd5\u89e3\u6790 JSON \u683c\u5f0f
        try {
          const raw = result.content || '{}';
          // \u5904\u7406 AI \u53ef\u80fd\u8fd4\u56de\u7684 markdown \u4ee3\u7801\u5757\u5305\u88f9
          const jsonStr = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```$/i, '').trim();
          const parsed = JSON.parse(jsonStr);
          summaryText = `[\u5bf9\u8bdd\u6458\u8981 - ${new Date().toISOString()}]\n${parsed.summary || result.content || ''}`;
          wakeupMessage = parsed.wakeup || null;
        } catch {
          // JSON \u89e3\u6790\u5931\u8d25\uff0c\u964d\u7ea7\u4e3a\u7eaf\u6458\u8981\uff0c\u4e0d\u5524\u9192
          summaryText = `[\u5bf9\u8bdd\u6458\u8981 - ${new Date().toISOString()}]\n${result.content || ''}`;
          Logger.warning(`[\u4f1a\u8bdd ${this.key}] \u6458\u8981+\u5524\u9192 JSON \u89e3\u6790\u5931\u8d25\uff0c\u964d\u7ea7\u4e3a\u7eaf\u6458\u8981`);
        }
        } else {
          summaryText = `[\u5bf9\u8bdd\u6458\u8981 - ${new Date().toISOString()}]\n${result.content || ''}`;
        }

      // \u4e3b\u52a8\u5524\u9192\uff1a\u5982\u679c AI \u5224\u65ad\u9700\u8981\u901a\u77e5\u7528\u6237\uff0c\u4e14\u6709\u56de\u8c03\u53ef\u7528
        if (wakeupMessage && this.wakeupReply) {
          try {
            await this.wakeupReply(wakeupMessage);
            Logger.info(`[\u4f1a\u8bdd ${this.key}] \u4e3b\u52a8\u5524\u9192\u7528\u6237: ${wakeupMessage.slice(0, 100)}`);
          } catch (err: any) {
            Logger.warning(`[\u4f1a\u8bdd ${this.key}] \u4e3b\u52a8\u5524\u9192\u5931\u8d25: ${err.message}`);
          }
        }


      // \u5f52\u6863\u6301\u4e45\u5316\u6587\u4ef6
        SessionStore.getInstance().saveContext(this.key, this.messages, this.sessionStoreType());
        try {
          const memoryUpdate = MemoryFinalizer.finalizeSession(this.key, this.messages, {
            reason: 'manual_archive',
            sessionType: this.sessionType || this.extractSessionType(this.key),
          });
          if (memoryUpdate) {
            Logger.info(`[会话 ${this.key}] 长期 memory 已更新: +${memoryUpdate.added.length}, total=${memoryUpdate.totalRecords}`);
          }
        } catch (err: any) {
          Logger.warning(`[会话 ${this.key}] 长期 memory 更新失败: ${err.message || String(err)}`);
        }

        this.messages = [];
        return true;
      } catch (error) {
        Logger.error('\u538b\u7f29\u5386\u53f2\u5931\u8d25: ' + String(error));
        await this.cleanup({ finalizeMemory: true, finalizationReason: 'session_close' });
        return false;
      }
    });
  }

  /** 过期或退出时清理内存（保存完整 context） */
  async cleanup(options?: { checkWakeup?: boolean; finalizeMemory?: boolean; finalizationReason?: MemoryFinalizationReason }): Promise<void> {
    return this.withLogContext(async () => {
      if (this.messages.length === 0) return;

      try {
        // 判断是否需要主动唤醒用户（仅在会话过期时）
        if (options?.checkWakeup && this.wakeupReply) {
          const hasUserMessages = this.messages.some(m => m.role === 'user');
          if (hasUserMessages) {
            const conversationText = this.messages
              .filter(m => m.role === 'user' || m.role === 'assistant')
              .slice(-10)
              .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
              .join('\n');

          const wakeupPrompt = `请判断以下对话是否需要主动唤醒用户。返回 JSON 格式（不要包含 markdown 代码块）：
{ "wakeup": null 或 "一条自然的消息" }

判断规则：
- 有未完成的任务或承诺 → 需要唤醒
- 后台任务已完成但结果还没告诉用户 → 需要唤醒
- 用户最后的问题没有得到完整回答 → 需要唤醒
- 对话自然结束、用户主动告别、或只是闲聊 → 不需要唤醒（返回 null）

对话内容：
${conversationText}`;

            try {
              const result = await this.services.aiService.chat([
                { role: 'user', content: wakeupPrompt },
              ]);

              const raw = result.content || '{}';
              const jsonStr = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```$/i, '').trim();
              const parsed = JSON.parse(jsonStr);

              if (parsed && parsed.wakeup && this.wakeupReply) {
                await this.wakeupReply(parsed.wakeup);
                Logger.info(`[会话 ${this.key}] 主动唤醒用户: ${parsed.wakeup.slice(0, 100)}`);
              }
            } catch (err: any) {
              Logger.warning(`[会话 ${this.key}] 唤醒判断失败: ${err.message}`);
            }
          }
        }
        // 保存完整 context 到 SessionStore
        SessionStore.getInstance().saveContext(this.key, this.messages, this.sessionStoreType());
        Logger.info(`会话已保存: ${this.key}, ${this.messages.length} 条消息`);

        if (options?.finalizeMemory) {
          try {
            const memoryUpdate = MemoryFinalizer.finalizeSession(this.key, this.messages, {
              reason: options.finalizationReason ?? 'ttl_cleanup',
              sessionType: this.sessionType || this.extractSessionType(this.key),
            });
            if (memoryUpdate) {
              Logger.info(`[会话 ${this.key}] 长期 memory 已更新: +${memoryUpdate.added.length}, total=${memoryUpdate.totalRecords}`);
            }
          } catch (err: any) {
            Logger.warning(`[会话 ${this.key}] 长期 memory 更新失败: ${err.message || String(err)}`);
          }
        }

        // 清理内存
        this.messages = [];
      } catch (error) {
        Logger.error(`清理会话失败: ${error}`);
      }
    });
  }

  // ─── 查询方法 ──────────────────────────────────────

  isBusy(): boolean {
    return this.busy;
  }

  /** 请求中断当前运行中的对话回合 */
  requestInterrupt(): void {
    if (!this.busy) return;
    this.interruptRequested = true;
  }

  /** 从 DB 恢复消息（进程重启后调用） */
  restoreFromStore(): boolean {
    return this.withLogContext(() => {
      const store = SessionStore.getInstance();
      const sessionType = this.sessionStoreType();
      const msgs = store.hasSession(this.key, sessionType) ? store.loadContext(this.key, sessionType) : [];
      if (msgs.length === 0) return false;
      this.pendingRestore = msgs.length > 0 ? msgs : undefined;
      Logger.info(`[会话 ${this.key}] 标记恢复: transcript=${msgs.length}, longTermMemory=on_demand`);
      return true;
    });
  }

  private saveRestorableContext(): void {
    if (this.messages.length === 0) return;
    SessionStore.getInstance().saveContext(this.key, this.messages, this.sessionStoreType());
  }

  private async compactSessionMessagesWithEvidence(
    source: 'agent_session_restore' | 'agent_session_pre_message',
    reason: string,
    surface: ToolSurface,
    beforeUsage = this.compressor.getUsageInfo(this.messages),
  ): Promise<void> {
    const messagesBefore = this.messages.length;
    const thresholdRatio = resolveCompactionThreshold();
    const thresholdTokens = Math.round(beforeUsage.maxTokens * thresholdRatio);
    try {
      const compacted = await this.compressor.compactWithFallback(this.messages);
      const afterUsage = this.compressor.getUsageInfo(compacted);
      this.messages = compacted;
      this.sessionTurnLogger.logContextCompaction({
        source,
        status: 'success',
        reason,
        surface,
        tokens_before: beforeUsage.usedTokens,
        tokens_after: afterUsage.usedTokens,
        message_tokens_before: beforeUsage.usedTokens,
        message_tokens_after: afterUsage.usedTokens,
        max_tokens: beforeUsage.maxTokens,
        threshold_ratio: thresholdRatio,
        threshold_tokens: thresholdTokens,
        usage_percent_before: beforeUsage.usagePercent,
        usage_percent_after: afterUsage.usagePercent,
        messages_before: messagesBefore,
        messages_after: compacted.length,
        messages: compacted,
      });
    } catch (error) {
      this.sessionTurnLogger.logContextCompaction({
        source,
        status: 'failed',
        reason,
        surface,
        tokens_before: beforeUsage.usedTokens,
        message_tokens_before: beforeUsage.usedTokens,
        max_tokens: beforeUsage.maxTokens,
        threshold_ratio: thresholdRatio,
        threshold_tokens: thresholdTokens,
        usage_percent_before: beforeUsage.usagePercent,
        messages_before: messagesBefore,
        error_code: 'CONTEXT_COMPACTION_FAILED',
        error_message: this.errorMessage(error),
      });
      throw error;
    }
  }

  private sessionStoreType(): string {
    return this.sessionType || this.extractSessionType(this.key);
  }

  private buildStateBoundary(
    surface: ToolSurface,
    providerDegradation?: ProviderTranscriptDegradationInput,
  ): SessionStateBoundaryLog {
    const store = SessionStore.getInstance();
    const durableSessionRef = store.getContextFilePath(this.key, this.sessionStoreType());
    const workingTraceRef = this.sessionTurnLogger.getLogFilePath();
    const boundary: SessionStateBoundaryLog = {
      durable_session: {
        kind: 'durable_session',
        ref: durableSessionRef,
        scope: 'surface_restore',
      },
      working_trace: {
        kind: 'working_trace',
        ref: workingTraceRef,
        schema: 'session-log-v3',
      },
      provider_transcript: {
        kind: 'provider_transcript_ref',
        ref: this.providerTranscriptDigestRef(workingTraceRef),
        mode: 'reference',
        raw_messages_stored: false,
        tool_result_payload_stored: false,
        raw_request_stored: false,
        raw_response_stored: false,
        raw_payload_stored: false,
        ...(providerDegradation && this.providerTranscriptDegradationFields(providerDegradation)),
      },
    };

    if (surface === 'pet') {
      boundary.visible_history = {
        kind: 'visible_history',
        ref: visibleHistoryFilePath('pet', this.key),
        scope: 'surface_visible_history',
      };
    }

    return boundary;
  }

  private providerTranscriptDigestRef(workingTraceRef: string): string {
    const digest = crypto.createHash('sha256')
      .update([
        'provider_transcript_ref',
        this.key,
        this.sessionStoreType(),
        workingTraceRef,
      ].join('\n'))
      .digest('hex');
    return `provider-transcripts/sha256:${digest}`;
  }

  private providerTranscriptDegradationFields(input: ProviderTranscriptDegradationInput): Partial<SessionStateBoundaryLog['provider_transcript']> {
    const provider = String(input.providerError.provider || 'unknown');
    const endpoint = String(input.providerError.endpoint || '').trim();
    const terminalStatus = input.failureBudget.status === 'blocked' ? 'blocked' : 'degraded';
    const fallbackChain = [
      endpoint ? `${provider}:${endpoint}` : provider,
      terminalStatus === 'blocked' ? 'runtime_blocked_fallback' : 'runtime_error_fallback',
    ];

    return {
      status: terminalStatus,
      degraded: true,
      degradation_reason: input.failureBudget.error_code,
      error_code: input.failureBudget.error_code,
      fallback_chain: fallbackChain,
      blocked_reason: input.failureBudget.blocked_reason
        || `Provider transcript degraded after ${input.failureBudget.error_code}; raw provider payload omitted.`,
    };
  }

  // ─── 私有方法 ──────────────────────────────────────

  /** 从 messages 中检测已激活 skill 的 maxTurns（兜底机制） */
  private detectSkillMaxTurns(): number | undefined {
    for (const msg of this.messages) {
      if (msg.role === 'system' && typeof msg.content === 'string') {
        const match = msg.content.match(/^\[skill:([^\]]+)\]/);
        if (match) {
          const skill = this.services.skillManager.getSkill(match[1]);
          if (skill?.metadata.maxTurns) {
            return skill.metadata.maxTurns;
          }
        }
      }
    }
    return undefined;
  }

  private detectActiveSkillName(): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role !== 'system' || typeof msg.content !== 'string') continue;
      const match = msg.content.match(/^\[skill:([^\]]+)\]/);
      if (match) {
        return match[1];
      }
    }
    return undefined;
  }

  private tryAutoActivateSkill(userText: string): void {
    const input = userText.trim();
    if (!input) return;

    // 斜杠命令路径由 handleCommand 处理，这里不重复自动激活
    if (input.startsWith('/')) return;
    if (this.isAttachmentOnlyInput(input)) return;

    // 已有激活 skill 时不自动切换，避免任务中途漂移
    if (this.activeSkillName) return;

    const matched = this.services.skillManager.findAutoInvocableSkillByText(input);
    if (!matched) return;

    const context: SkillInvocationContext = {
      skillName: matched.metadata.name,
      arguments: [],
      rawArguments: '',
      userMessage: input,
    };
    const activation = buildSkillActivationSignal(matched, context);
    this.applySkillActivation(activation);

    Logger.info(`[${this.key}] 自动激活 skill: ${matched.metadata.name}`);
  }

  private isAttachmentOnlyInput(input: string): boolean {
    if (input.startsWith('[文件]') || input.startsWith('[图片]')) {
      return true;
    }

    if (input.startsWith('[用户仅上传了附件，暂未给出明确任务]')) {
      return true;
    }

    const attachmentMarker = '[用户已上传附件]';
    const markerIndex = input.indexOf(attachmentMarker);
    if (markerIndex >= 0) {
      const prefix = input.slice(0, markerIndex).trim();
      if (!prefix) {
        return true;
      }
    }

    return false;
  }

  private isHandleMessageOptions(value: SessionCallbacks | HandleMessageOptions): value is HandleMessageOptions {
    return (
      'channel' in value
      || 'callbacks' in value
      || 'logInput' in value
      || 'surface' in value
      || 'observabilityContext' in value
      || 'traceparent' in value
      || 'traceId' in value
      || 'deliveryFallbackFinalReply' in value
    );
  }

  private normalizeCommandOptions(callbacksOrOptions?: SessionCallbacks | HandleCommandOptions): HandleCommandOptions {
    if (!callbacksOrOptions) return {};
    if (
      'channel' in callbacksOrOptions
      || 'callbacks' in callbacksOrOptions
      || 'surface' in callbacksOrOptions
      || 'observabilityContext' in callbacksOrOptions
      || 'traceparent' in callbacksOrOptions
      || 'traceId' in callbacksOrOptions
      || 'deliveryFallbackFinalReply' in callbacksOrOptions
    ) {
      return callbacksOrOptions as HandleCommandOptions;
    }
    return { callbacks: callbacksOrOptions as SessionCallbacks };
  }

  private resolveSurface(explicitSurface?: ToolSurface): ToolSurface {
    if (explicitSurface) return explicitSurface;

    if (this.sessionType === 'feishu' || this.sessionType === 'weixin' || this.sessionType === 'pet') {
      return this.sessionType;
    }

    if (this.sessionType === 'agent' || this.sessionType === 'research') {
      return this.sessionType;
    }

    if (this.key.startsWith('pet:')) return 'pet';
    if (this.key.startsWith('group:')) return 'feishu';
    if (this.key.startsWith('user:')) return 'weixin';
    return 'cli';
  }

  private removeTransientMessages(messages: Message[]): Message[] {
    return messages.filter(msg => {
      if (msg.role !== 'system' || typeof msg.content !== 'string') return true;
      if (msg.content.startsWith(TRANSIENT_SUBAGENT_STATUS_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_RUNNER_HINT_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_SOFT_CHECK_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_SKILLS_LIST_PREFIX)) return false;
      return true;
    });
  }

  /** /skills 命令 */
  private handleSkillsCommand(): CommandResult {
    const skills = this.services.skillManager.getUserInvocableSkills();
    if (skills.length === 0) {
      return { handled: true, reply: '暂无可用的 skills。', finalResponseVisible: true };
    }
    const lines = skills.map(s => {
      const hint = s.metadata.argumentHint ? ` ${s.metadata.argumentHint}` : '';
      return `/${s.metadata.name}${hint}\n  ${s.metadata.description}`;
    });
    return { handled: true, reply: '可用的 Skills:\n\n' + lines.join('\n\n'), finalResponseVisible: true };
  }

  /** skill 斜杠命令处理 */
  private async handleSkillCommand(
    commandName: string,
    args: string[],
    options: HandleCommandOptions = {},
  ): Promise<CommandResult> {
    const skill = this.services.skillManager.getSkill(commandName);
    if (!skill) return { handled: false };

    if (!skill.metadata.userInvocable) {
      return { handled: true, reply: `Skill "${commandName}" 不允许用户调用`, finalResponseVisible: true };
    }

    // 执行 skill，生成 prompt
    const context: SkillInvocationContext = {
      skillName: commandName,
      arguments: args,
      rawArguments: args.join(' '),
      userMessage: `/${commandName} ${args.join(' ')}`.trim(),
    };
    const activation = buildSkillActivationSignal(skill, context);

    await this.init(options.surface);
    this.applySkillActivation(activation);
    Logger.info(`[${this.key}] 已激活 skill: ${skill.metadata.name}${skill.metadata.maxTurns ? ` (maxTurns=${skill.metadata.maxTurns})` : ''}`);

    // 如果有参数，自动作为用户消息发送给 AI
    if (args.length > 0) {
      const reply = await this.handleMessage(args.join(' '), {
        callbacks: options.callbacks,
        channel: options.channel,
        surface: options.surface,
        logInput: context.userMessage,
        observabilityContext: options.observabilityContext,
        traceparent: options.traceparent,
        traceId: options.traceId,
        deliveryFallbackFinalReply: options.deliveryFallbackFinalReply,
      });
      return {
        handled: true,
        reply: reply.text,
        finalResponseVisible: reply.finalResponseVisible,
      };
    }

    return { handled: true, reply: `已激活 skill: ${skill.metadata.name}`, finalResponseVisible: true };
  }

  private applySkillActivation(activation: SkillActivationSignal): void {
    upsertSkillSystemMessage(this.messages, activation);
    this.activeSkillName = activation.skillName;
    this.activeSkillMaxTurns = activation.maxTurns;
    this.activeSkillToolsets = activation.toolsets;
  }

  private revokeUnavailableActiveSkill(): boolean {
    const skillName = this.activeSkillName ?? this.detectActiveSkillName();
    if (!skillName || this.services.skillManager.getSkill(skillName)) {
      return false;
    }

    this.messages = this.messages.filter(message => !this.isSkillSystemMessage(message));
    this.activeSkillName = undefined;
    this.activeSkillMaxTurns = undefined;
    this.activeSkillToolsets = undefined;
    Logger.warning(`[${this.key}] 已撤销不可用 skill: ${skillName}`);
    return true;
  }

  private isSkillSystemMessage(message: Message): boolean {
    return message.role === 'system'
      && typeof message.content === 'string'
      && /^\[skill:[^\]]+\]/.test(message.content);
  }

  private shouldPersistActiveSkillForToolVisibility(): boolean {
    const roleName = this.services.roleName;
    if (!roleName) return false;
    const resolvedRole = RoleResolver.resolveRoleDirectoryName(roleName);
    if (!resolvedRole) return false;
    return RoleResolver.getRoleConfig(resolvedRole)?.toolVisibility?.mode === 'skill_scoped';
  }

  private parseActivationFromSystemMessage(msg: Message): SkillActivationSignal | null {
    if (msg.role !== 'system' || typeof msg.content !== 'string') {
      return null;
    }

    const markerMatch = msg.content.match(/^\[skill:([^\]]+)\]/);
    if (!markerMatch) {
      return null;
    }

    const skillName = markerMatch[1];
    const prompt = msg.content.slice(markerMatch[0].length).replace(/^\n/, '');
    const skill = this.services.skillManager.getSkill(skillName);
    if (!skill) {
      return null;
    }

    return {
      __type__: 'skill_activation',
      skillName,
      prompt,
      maxTurns: skill?.metadata.maxTurns,
      toolsets: skill?.metadata.toolsets,
    };
  }
}
