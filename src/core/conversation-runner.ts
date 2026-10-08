import { cancellableDelay, throwIfCancelled, isCancellation } from '../utils/cancellation';
import * as crypto from 'crypto';
import { Message, ContentBlock } from '../types';
import { AIService } from '../utils/ai-service';
import { SkillActivationSignal } from '../types/skill';
import {
  ChannelDeliveryReceipt,
  DeliveryEvidence,
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutor,
  ToolResult,
  ToolTranscriptMode,
} from '../types/tool';
import { StreamCallbacks } from '../providers/provider';
import { Logger } from '../utils/logger';
import { Metrics } from '../utils/metrics';
import {
  ContextCompressor,
  DEFAULT_MAX_CONTEXT_TOKENS,
  resolveCompactionThreshold,
} from './context-compressor';
import { estimateMessagesTokens, estimateToolsTokens } from './token-estimator';
import { buildCanonicalToolResult, canonicalizeToolResult } from '../tools/tool-result';
import { normalizeExternalDeliveryReceipts } from '../tools/delivery-receipts';
import {
  parseSkillActivationSignal,
  upsertSkillSystemMessage,
} from '../skills/skill-activation-protocol';
import { getObservability, Observability, ObservabilityAttributes, ObservabilitySpanContext } from '../observability';
import type { ContextCompactionLogInput } from '../utils/session-turn-logger';

function contentToString(content: string | ContentBlock[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '[图片]';
  return content.map(block => block.type === 'text' ? block.text : '[图片]').join('');
}

const TOOL_NAME_ALIASES: Record<string, string> = {
  Bash: 'execute_shell',
  bash: 'execute_shell',
  Shell: 'execute_shell',
  shell: 'execute_shell',
  execute_bash: 'execute_shell',
};

function normalizeToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] ?? name;
}

const MIN_MESSAGE_BUDGET = 2000;
const OVERFLOW_REDUCTION_RATIO = 0.6;
const TRANSIENT_RUNNER_HINT_PREFIX = '[transient_runner_hint]';
const MAX_SHRUNK_TOOL_ARGUMENT_CHARS = 1200;
const MAX_AGGRESSIVE_TOOL_ARGUMENT_CHARS = 600;

/**
 * 对话运行回调
 */
export interface RunnerCallbacks {
  /** 流式文本片段 */
  onText?: (text: string) => void;
  /** AI 思考过程 */
  onThinking?: (thinking: string) => void;
  /** 工具开始执行 */
  onToolStart?: (name: string, toolUseId: string, input: any) => void;
  /** 工具执行完成 */
  onToolEnd?: (name: string, toolUseId: string, result: string) => void;
  /** 需要显示工具输出（如 task_planner） */
  onToolDisplay?: (name: string, content: string) => void;
  /** 重试通知 */
  onRetry?: (attempt: number, maxRetries: number) => void;
}

/**
 * 对话运行结果
 */
export interface RunResult {
  cancelled?: boolean;
  /** 最终文本回复 */
  response: string;
  /** 最终文本是否代表用户可见输出 */
  finalResponseVisible: boolean;
  /** session 消息列表 */
  messages: Message[];
  /** 本次 run() 期间新增的消息（不含最终纯文本回复） */
  newMessages: Message[];
  /** 本次 run() 期间真实执行过的工具结果，包含 outbound/suppress 工具。 */
  toolResults: RunToolResult[];
  /** 本次 run() 期间每次 provider request 的工具可见性快照。 */
  toolVisibility: ToolVisibilitySnapshot[];
}

export interface RunToolResult {
  toolCall: ToolCall;
  toolName: string;
  result: ToolResult;
}

export interface ToolVisibilitySnapshot {
  roleName?: string;
  activeSkillName?: string;
  mode?: string;
  visibleTools: string[];
  hiddenToolCount: number;
  gatedToolCount?: number;
}

interface ToolExecutionRecord {
  toolCall: ToolCall;
  toolName: string;
  toolContent: string | ContentBlock[];
  result: ToolResult;
  newMessages?: Message[];
}

export type ObservabilityMetricMode = 'local_and_mirror' | 'mirror_only';

/** ConversationRunner 构造选项 */
export interface RunnerOptions {
  maxTurns?: number;
  maxContextTokens?: number;
  /** false 时用 aiService.chat() 代替 chatStream()（默认 true） */
  stream?: boolean;
  /** 供 agent 检查 stop 状态，返回 false 时提前退出循环 */
  shouldContinue?: () => boolean;
  /** 是否启用上下文压缩（默认 true，agent 用 false） */
  enableCompression?: boolean;
  /** 透传给 ToolExecutor 的执行上下文（session/run/surface 等） */
  toolExecutionContext?: Partial<ToolExecutionContext>;
  /** 会话已激活 skill 名称（可选） */
  initialSkillName?: string;
  /** 会话已激活 skill 请求的 toolsets（可选） */
  initialSkillToolsets?: string[];
  /** 外部观测父 span context；默认不启用时为 no-op。 */
  observabilityContext?: ObservabilitySpanContext;
  /** AgentSession 已把 session log 当作 local summary 来源时，Runner 只做外部镜像。 */
  observabilityMetricMode?: ObservabilityMetricMode;
  /** Channel surface 是否把未显式 send_text/send_file 的 final text 兜底外发；默认 false。 */
  deliveryFallbackFinalReply?: boolean;
  /** AgentSession-owned session logger hook for compact evidence. */
  onContextCompaction?: (event: ContextCompactionLogInput) => void;
}

/**
 * ConversationRunner - 核心对话循环
 *
 * 封装 "发送消息 → 检查工具调用 → 执行工具 → 回传结果 → 继续推理" 的循环。
 * 依赖 ToolExecutor 抽象，同时支持 ToolManager（主会话）和 AgentToolExecutor（子 agent）。
 */
export class ConversationRunner {
  private maxTurns: number;
  private runId?: string;
  private compressor: ContextCompressor;
  private stream: boolean;
  private shouldContinue?: () => boolean;
  private enableCompression: boolean;
  private toolExecutionContext?: Partial<ToolExecutionContext>;
  private activeSkillName?: string;
  private activeSkillToolsets?: string[];
  private maxPromptTokens: number;
  private sessionLabel: string;
  private observabilityContext?: ObservabilitySpanContext;
  private observabilityMetricMode: ObservabilityMetricMode;
  private deliveryFallbackFinalReply: boolean;
  private onContextCompaction?: (event: ContextCompactionLogInput) => void;

  /** 截断字符串用于日志输出，避免日志过大 */
  private static truncateForLog(text: any, maxLen = 200): string {
    if (!text) return '(empty)';
    if (typeof text !== 'string') {
      text = JSON.stringify(text);
    }
    const oneLine = text.replace(/\n/g, '\\n');
    if (oneLine.length <= maxLen) return oneLine;
    return oneLine.slice(0, maxLen) + `...(${text.length}字符)`;
  }

  constructor(
    private aiService: AIService,
    private toolExecutor: ToolExecutor,
    options?: RunnerOptions,
  ) {
    this.maxTurns = options?.maxTurns ?? 150;
    this.stream = options?.stream ?? true;
    this.shouldContinue = options?.shouldContinue;
    this.enableCompression = options?.enableCompression ?? true;
    this.toolExecutionContext = options?.toolExecutionContext;
    this.activeSkillName = options?.initialSkillName;
    this.activeSkillToolsets = options?.initialSkillToolsets;
    this.observabilityContext = options?.observabilityContext;
    this.observabilityMetricMode = options?.observabilityMetricMode || 'local_and_mirror';
    this.deliveryFallbackFinalReply = options?.deliveryFallbackFinalReply === true;
    this.onContextCompaction = options?.onContextCompaction;

    this.maxPromptTokens = this.resolvePromptBudget(options?.maxContextTokens);
    this.sessionLabel = this.toolExecutionContext?.sessionId
      ? `${this.toolExecutionContext.sessionId} `
      : '';
    this.compressor = new ContextCompressor(this.aiService, {
      maxContextTokens: this.maxPromptTokens,
      compactionThreshold: resolveCompactionThreshold(),
    });
  }

  /**
   * 执行对话循环
   * @param messages 当前消息列表（会被原地修改，追加工具调用中间消息）
   * @param callbacks 可选的 UI 回调
   * @returns 最终文本回复和完整消息列表
   */
  async run(messages: Message[], callbacks?: RunnerCallbacks): Promise<RunResult> {
    this.runId = this.toolExecutionContext?.runId || crypto.randomUUID();
    const newMessages: Message[] = [];
    const toolResults: RunToolResult[] = [];
    const toolVisibility: ToolVisibilitySnapshot[] = [];
    const nonRetryableFailureCounts = new Map<string, number>();
    let nextTurnTransientHints: Message[] = [];
    let hasDeliveredMessageOutThisRun = false;
    let turns = 0;
    let thinkingCount = 0;

    while (turns++ < this.maxTurns) {
      if (this.toolExecutionContext?.abortSignal?.aborted || this.shouldContinue && !this.shouldContinue()) {
        break;
      }

      this.replaceMessages(messages, this.sanitizeToolTranscript(messages));
      let activeTools = this.resolveActiveTools(messages);

      if (this.enableCompression) {
        const toolTokens = estimateToolsTokens(activeTools);
        const messageTokens = estimateMessagesTokens(messages);
        const totalTokens = messageTokens + toolTokens;
        const usagePercent = Math.round((totalTokens / this.maxPromptTokens) * 100);
        Logger.info(`[${this.sessionLabel}Turn ${turns}] 上下文: ${messageTokens} + ${toolTokens} = ${totalTokens} tokens (${usagePercent}%)`);

        // 检查压缩：考虑工具tokens，留足安全边际
        const thresholdRatio = resolveCompactionThreshold();
        const threshold = this.maxPromptTokens * thresholdRatio;
        if (totalTokens > threshold) {
          Logger.info(`上下文使用率 ${usagePercent}%，触发压缩...`);
          const messagesBefore = messages.length;
          try {
            const compacted = await this.compressor.compactWithFallback(messages, undefined, { abortSignal: this.toolExecutionContext?.abortSignal });
            messages.length = 0;
            messages.push(...compacted);
            const messageTokensAfter = estimateMessagesTokens(messages);
            this.onContextCompaction?.({
              source: 'conversation_runner',
              status: 'success',
              reason: 'threshold_exceeded',
              ...(this.toolExecutionContext?.surface && { surface: this.toolExecutionContext.surface }),
              turn: turns,
              tokens_before: totalTokens,
              tokens_after: messageTokensAfter + toolTokens,
              message_tokens_before: messageTokens,
              message_tokens_after: messageTokensAfter,
              tool_tokens_before: toolTokens,
              tool_tokens_after: toolTokens,
              max_tokens: this.maxPromptTokens,
              threshold_ratio: thresholdRatio,
              threshold_tokens: Math.round(threshold),
              usage_percent_before: usagePercent,
              usage_percent_after: Math.round(((messageTokensAfter + toolTokens) / this.maxPromptTokens) * 100),
              messages_before: messagesBefore,
              messages_after: messages.length,
              messages,
            });
          } catch (error) {
            this.onContextCompaction?.({
              source: 'conversation_runner',
              status: 'failed',
              reason: 'threshold_exceeded',
              ...(this.toolExecutionContext?.surface && { surface: this.toolExecutionContext.surface }),
              turn: turns,
              tokens_before: totalTokens,
              message_tokens_before: messageTokens,
              tool_tokens_before: toolTokens,
              max_tokens: this.maxPromptTokens,
              threshold_ratio: thresholdRatio,
              threshold_tokens: Math.round(threshold),
              usage_percent_before: usagePercent,
              messages_before: messagesBefore,
              error_code: 'CONTEXT_COMPACTION_FAILED',
              error_message: this.errorMessage(error),
            });
            throw error;
          }
        }
      }

      activeTools = this.resolveActiveTools(messages);
      const toolDefinitions = new Map(activeTools.map(tool => [tool.name, tool]));
      const visibilitySnapshot = this.resolveToolVisibilitySnapshot(activeTools, messages);
      toolVisibility.push(visibilitySnapshot);
      const requestMessages = this.buildProviderInputMessages(messages, nextTurnTransientHints);
      nextTurnTransientHints = [];
      this.ensurePromptBudget(requestMessages, activeTools);
      const aiStartTime = Date.now();
      const observability = getObservability();
      const modelSpan = observability.startSpan('xiaoba.model.call', {
        ...this.baseObservabilityAttributes(),
        'xiaoba.turn': turns,
        'xiaoba.model.stream': this.stream,
        'xiaoba.model.visible_tool_count': activeTools.length,
        'xiaoba.model.hidden_tool_count': visibilitySnapshot.hiddenToolCount,
        ...(visibilitySnapshot.activeSkillName && { 'xiaoba.skill.name': visibilitySnapshot.activeSkillName }),
      }, this.observabilityContext);
      Logger.info(`[${this.sessionLabel}Turn ${turns}] 调用AI推理 (可用工具: ${activeTools.length}个, hidden=${visibilitySnapshot.hiddenToolCount}, activeSkill=${visibilitySnapshot.activeSkillName || 'none'})`);

      let response;
      try {
        throwIfCancelled(this.toolExecutionContext?.abortSignal);
        response = await this.requestModelResponse(requestMessages, activeTools, callbacks);
        throwIfCancelled(this.toolExecutionContext?.abortSignal);
        const aiDuration = Date.now() - aiStartTime;
        const modelAttrs = {
          ...this.baseObservabilityAttributes(),
          'xiaoba.turn': turns,
          'xiaoba.model.status': 'success',
          'xiaoba.model.duration_ms': aiDuration,
          'xiaoba.model.stream': this.stream,
          'xiaoba.model.visible_tool_count': activeTools.length,
          'xiaoba.model.response_tool_call_count': response.toolCalls?.length ?? 0,
          ...(response.usage && {
            'xiaoba.tokens.prompt': response.usage.promptTokens,
            'xiaoba.tokens.completion': response.usage.completionTokens,
            'xiaoba.tokens.total': response.usage.totalTokens,
          }),
        };
        this.recordObservabilityMetric(observability, 'xiaoba.model.call', 1, modelAttrs);
        this.recordObservabilityMetric(observability, 'xiaoba.model.duration_ms', aiDuration, modelAttrs, 'ms');
        if (response.usage) {
          this.recordObservabilityMetric(observability, 'xiaoba.tokens.prompt', response.usage.promptTokens, this.baseObservabilityAttributes(), 'token');
          this.recordObservabilityMetric(observability, 'xiaoba.tokens.completion', response.usage.completionTokens, this.baseObservabilityAttributes(), 'token');
          this.recordObservabilityMetric(observability, 'xiaoba.tokens.total', response.usage.totalTokens, this.baseObservabilityAttributes(), 'token');
        }
        observability.recordLog('xiaoba.model.call', modelAttrs, 'INFO', modelSpan.context);
        observability.endSpan(modelSpan, { status: 'ok', attributes: modelAttrs });
        Logger.info(`[${this.sessionLabel}Turn ${turns}] AI推理完成，耗时: ${aiDuration}ms`);
      } catch (error: any) {
        if (isCancellation(error) || this.toolExecutionContext?.abortSignal?.aborted) {
          observability.endSpan(modelSpan, { status: 'ok', attributes: { 'xiaoba.model.status': 'cancelled' } });
          return { cancelled:true, response:'',finalResponseVisible:false,messages,newMessages,toolResults,toolVisibility };
        }
        const errorAttrs = {
          ...this.baseObservabilityAttributes(),
          'xiaoba.turn': turns,
          'xiaoba.model.status': 'error',
          'xiaoba.model.duration_ms': Date.now() - aiStartTime,
          'xiaoba.error_code': this.errorCode(error),
          'xiaoba.error.message': this.errorMessage(error),
        };
        this.recordObservabilityMetric(observability, 'xiaoba.model.call', 1, errorAttrs);
        this.recordObservabilityMetric(observability, 'xiaoba.model.duration_ms', errorAttrs['xiaoba.model.duration_ms'], errorAttrs, 'ms');
        this.recordObservabilityMetric(observability, 'xiaoba.provider.error', 1, errorAttrs);
        observability.recordLog('xiaoba.provider.error', errorAttrs, 'ERROR', modelSpan.context);
        observability.endSpan(modelSpan, {
          status: 'error',
          message: this.errorMessage(error),
          attributes: errorAttrs,
        });
        if (hasDeliveredMessageOutThisRun && this.usesChannelDelivery()) {
          Logger.warning(`[${this.sessionLabel}Turn ${turns}] 已有外发消息送达，后续推理失败后直接收束: ${error.message}`);
          return {
            response: '',
            finalResponseVisible: false,
            messages,
            newMessages,
            toolResults,
            toolVisibility,
          };
        }
        throw error;
      }

      if (response.usage) {
        Metrics.recordAICall(this.stream ? 'stream' : 'chat', response.usage);
        Logger.info(`[${this.sessionLabel}Turn ${turns}] AI返回 tokens: ${response.usage.promptTokens}+${response.usage.completionTokens}=${response.usage.totalTokens}`);
      }

      if (!response.toolCalls || response.toolCalls.length === 0) {
        Logger.info(`[${this.sessionLabel}Turn ${turns}] AI最终回复: ${ConversationRunner.truncateForLog(response.content || '', 300)}`);

        if (this.usesChannelDelivery()) {
          let finalText = response.content || '';
          finalText = finalText.replace(/^\[已发送信息\]\s*/, '');
          finalText = finalText.replace(/^\[已发送文件\]\s*/, '');

          if (hasDeliveredMessageOutThisRun) {
            if (finalText.trim()) {
              Logger.warning(
                `[${this.sessionLabel}Turn ${turns}] delivery_contract_violation: 已通过外发工具发送用户可见消息，抑制后续最终文本 "${ConversationRunner.truncateForLog(finalText, 160)}"`
              );
            }
            return {
              response: '',
              finalResponseVisible: false,
              messages,
              newMessages,
              toolResults,
              toolVisibility,
            };
          }

          if (finalText && this.deliveryFallbackFinalReply) {
            const fallbackDelivery = await this.deliverFallbackFinalText(finalText, turns);
            if (fallbackDelivery) {
              toolResults.push(fallbackDelivery);
            }
          } else if (finalText) {
            Logger.info(
              `[${this.sessionLabel}Turn ${turns}] channel_final_text_hidden: 模型未调用 send_text/send_file，最终文本不会外发给用户`
            );
          }

          messages.push({ role: 'assistant', content: finalText || null });
          newMessages.push({ role: 'assistant', content: finalText || null });

          return {
            response: finalText,
            finalResponseVisible: Boolean(finalText && this.deliveryFallbackFinalReply),
            messages,
            newMessages,
            toolResults,
            toolVisibility,
          };
        }

        let cleanedResponse = response.content || '';
        cleanedResponse = cleanedResponse.replace(/^\[已发送信息\]\s*/, '');
        cleanedResponse = cleanedResponse.replace(/^\[已发送文件\]\s*/, '');

        // CLI 等非 channel surface 的最终文本就是正常用户可见输出。
        messages.push({ role: 'assistant', content: cleanedResponse || null });
        newMessages.push({ role: 'assistant', content: cleanedResponse || null });

        return {
          response: cleanedResponse,
          finalResponseVisible: true,
          messages,
          newMessages,
          toolResults,
          toolVisibility,
        };
      }

      if (response.content) {
        Logger.info(`[${this.sessionLabel}Turn ${turns}] AI文本: ${ConversationRunner.truncateForLog(response.content, 300)}`);
        // 发送 thinking 回调
        if (callbacks?.onThinking) {
          await callbacks.onThinking(response.content);
        }
      }
      const toolNames = response.toolCalls.map(tc => tc.function.name).join(', ');
      Logger.info(`[${this.sessionLabel}Turn ${turns}] AI选择工具: [${toolNames}]`);

      const assistantMsg: Message = {
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls,
      };
      const executionRecords: ToolExecutionRecord[] = [];
      let shouldPauseTurn = false;
      let shouldCancelRun = false;

      for (let toolIndex = 0; toolIndex < response.toolCalls.length; toolIndex++) {
        const toolCall = response.toolCalls[toolIndex];
        if (this.toolExecutionContext?.abortSignal?.aborted || this.shouldContinue && !this.shouldContinue()) {
          const reason = 'Runner interrupted before executing pending tool calls.';
          const cancelledToolCalls = response.toolCalls.slice(toolIndex);
          for (const cancelledToolCall of cancelledToolCalls) {
            const cancelledResult = this.buildCancelledToolResult(cancelledToolCall, reason);
            toolResults.push({
              toolCall: cancelledToolCall,
              toolName: cancelledToolCall.function.name,
              result: cancelledResult,
            });
          }
          Logger.warning(`[${this.sessionLabel}Turn ${turns}] 运行已中断，取消 ${cancelledToolCalls.length} 个未执行工具调用`);
          shouldCancelRun = true;
          break;
        }

        const toolName = toolCall.function.name;
        const toolUseId = toolCall.id;
        const toolInput = this.parseToolInputForCallback(toolCall.function.arguments);
        callbacks?.onToolStart?.(toolName, toolUseId, toolInput);
        Logger.info(`[${this.sessionLabel}Turn ${turns}] 执行工具: ${toolName} | 参数: ${ConversationRunner.truncateForLog(toolCall.function.arguments, 500)}`);
        const toolStart = Date.now();
        const toolSpan = observability.startSpan('xiaoba.tool.call', {
          ...this.baseObservabilityAttributes(),
          'xiaoba.turn': turns,
          'xiaoba.tool.name': toolName,
          'xiaoba.tool.call_id': toolUseId,
          ...observability.toolArgumentAttributes(toolCall.function.arguments),
        }, this.observabilityContext);
        observability.recordLog('xiaoba.tool.call', {
          ...this.baseObservabilityAttributes(),
          'xiaoba.turn': turns,
          'xiaoba.tool.name': toolName,
          'xiaoba.tool.call_id': toolUseId,
          ...observability.toolArgumentAttributes(toolCall.function.arguments),
        }, 'INFO', toolSpan.context);
        let result;
        try {
          result = await this.executeToolWithRetry(
            toolCall,
            messages,
            {
              ...this.toolExecutionContext,
              runId: this.runId,
              activeSkillName: this.activeSkillName,
              activeToolsets: this.activeSkillToolsets,
              observabilityContext: toolSpan.context,
            },
            turns,
          );
        } catch (error: any) {
          const errorAttrs = {
            ...this.baseObservabilityAttributes(),
            'xiaoba.turn': turns,
            'xiaoba.tool.name': toolName,
            'xiaoba.tool.call_id': toolUseId,
            'xiaoba.tool.status': 'failure',
            'xiaoba.tool.duration_ms': Date.now() - toolStart,
            'xiaoba.error_code': this.errorCode(error),
            'xiaoba.error.message': this.errorMessage(error),
          };
          this.recordObservabilityMetric(observability, 'xiaoba.tool.call', 1, errorAttrs);
          this.recordObservabilityMetric(observability, 'xiaoba.tool.result', 1, errorAttrs);
          this.recordObservabilityMetric(observability, 'xiaoba.tool.duration_ms', errorAttrs['xiaoba.tool.duration_ms'], errorAttrs, 'ms');
          observability.recordLog('xiaoba.tool.result', errorAttrs, 'ERROR', toolSpan.context);
          observability.endSpan(toolSpan, {
            status: 'error',
            message: this.errorMessage(error),
            attributes: errorAttrs,
          });
          throw error;
        }
        result = this.boundRepeatedNonRetryableFailure(
          toolCall,
          result,
          nonRetryableFailureCounts,
        );
        if (toolName === 'thinking') {
          thinkingCount++;
        }
        toolResults.push({
          toolCall,
          toolName,
          result,
        });
        const toolDuration = Date.now() - toolStart;
        Metrics.recordToolCall(toolName, toolDuration);
        const toolResultAttrs = {
          ...this.baseObservabilityAttributes(),
          'xiaoba.turn': turns,
          'xiaoba.tool.name': toolName,
          'xiaoba.tool.call_id': toolUseId,
          'xiaoba.tool.status': result.status || (result.ok === false ? 'failure' : 'success'),
          'xiaoba.tool.duration_ms': result.duration_ms ?? toolDuration,
          'xiaoba.tool.retryable': result.retryable === true,
          'xiaoba.tool.artifact_count': result.artifact_manifest?.length ?? 0,
          'xiaoba.tool.delivery_count': result.delivery_evidence?.length ?? 0,
          ...(result.error_code && { 'xiaoba.error_code': result.error_code }),
          ...(result.blocked_reason && { 'xiaoba.blocked_reason': result.blocked_reason }),
        };
        this.recordObservabilityMetric(observability, 'xiaoba.tool.call', 1, toolResultAttrs);
        this.recordObservabilityMetric(observability, 'xiaoba.tool.result', 1, toolResultAttrs);
        this.recordObservabilityMetric(observability, 'xiaoba.tool.duration_ms', result.duration_ms ?? toolDuration, toolResultAttrs, 'ms');
        observability.recordLog(
          'xiaoba.tool.result',
          toolResultAttrs,
          result.ok === false || this.hasStructuredFailure(result) ? 'ERROR' : 'INFO',
          toolSpan.context,
        );
        if (result.delivery_evidence?.length) {
          for (const delivery of result.delivery_evidence) {
            this.recordObservabilityMetric(observability, 'xiaoba.delivery.evidence', 1, {
              ...this.baseObservabilityAttributes(),
              'xiaoba.delivery.type': delivery.delivery_type,
              'xiaoba.delivery.status': delivery.status,
              ...(delivery.surface && { 'xiaoba.surface': delivery.surface }),
            });
            observability.recordLog('xiaoba.delivery.evidence', {
              ...this.baseObservabilityAttributes(),
              'xiaoba.delivery.type': delivery.delivery_type,
              'xiaoba.delivery.status': delivery.status,
              ...(delivery.file_name && { 'xiaoba.delivery.file_name': delivery.file_name }),
            }, delivery.status === 'delivered' ? 'INFO' : 'WARN', toolSpan.context);
          }
        }
        observability.endSpan(toolSpan, {
          status: result.ok === false || this.hasStructuredFailure(result) ? 'error' : 'ok',
          message: result.error_code,
          attributes: toolResultAttrs,
        });
        Logger.info(`[${this.sessionLabel}Turn ${turns}] 工具完成: ${toolName} | 耗时: ${toolDuration}ms | 结果: ${ConversationRunner.truncateForLog(result.content, 300)}`);
        callbacks?.onToolEnd?.(toolName, toolUseId, contentToString(result.content));

        const transcriptMode = this.getToolTranscriptMode(toolName, toolDefinitions);
        if (
          (transcriptMode === 'outbound_message' || transcriptMode === 'outbound_file')
          && result.ok
          && !this.hasStructuredFailure(result)
        ) {
          hasDeliveredMessageOutThisRun = true;
        }

        let toolContent = result.content;

        const activation = this.tryParseSkillActivation(toolCall, contentToString(result.content));
        if (activation) {
          this.activeSkillName = activation.skillName;
          this.activeSkillToolsets = activation.toolsets;

          if (activation.maxTurns && activation.maxTurns > 0) {
            this.maxTurns = Math.max(this.maxTurns, turns + activation.maxTurns);
          }

          upsertSkillSystemMessage(messages, activation);
          const systemMsg = upsertSkillSystemMessage(messages, activation);
          if (systemMsg) {
            newMessages.push(systemMsg);
          }

          toolContent = `Skill "${activation.skillName}" 已激活`;
        }

        this.handleToolDisplay(toolCall, contentToString(toolContent), callbacks);
        executionRecords.push({
          toolCall,
          toolName,
          toolContent,
          result,
          newMessages: (result as any).newMessages, // 保存图片等额外消息
        });

        if (result.controlSignal === 'pause_turn' && !this.hasStructuredFailure(result)) {
          shouldPauseTurn = true;
          break;
        }
      }

      const turnMessages = this.buildTurnMessages(
        assistantMsg,
        executionRecords,
        toolDefinitions,
      );
      messages.push(...turnMessages);
      newMessages.push(...turnMessages);

      if (shouldCancelRun) {
        Logger.info(`[${this.sessionLabel}Turn ${turns}] interrupt 已触发，本轮取消收束`);
        return {
          cancelled: true,
          response: '',
          finalResponseVisible: false,
          messages,
          newMessages,
          toolResults,
          toolVisibility,
        };
      }

      if (shouldPauseTurn) {
        Logger.info(`[${this.sessionLabel}Turn ${turns}] pause_turn 已触发，本轮收束`);
        return {
          response: '',
          finalResponseVisible: false,
          messages,
          newMessages,
          toolResults,
          toolVisibility,
        };
      }
    }

    if (this.toolExecutionContext?.abortSignal?.aborted || this.shouldContinue && !this.shouldContinue()) {
      return { cancelled:true,response:'',finalResponseVisible:false,messages,newMessages,toolResults,toolVisibility };
    }
    Logger.warning(`达到最大工具调用轮次 (${this.maxTurns})`);
    return {
      response: this.usesChannelDelivery() ? '' : '[达到最大工具调用轮次，请继续对话]',
      finalResponseVisible: !this.usesChannelDelivery(),
      messages,
      newMessages,
      toolResults,
      toolVisibility,
    };
  }

  private resolveActiveTools(messages: Message[]): ToolDefinition[] {
    return this.toolExecutor.getToolDefinitions({
      ...this.toolExecutionContext,
      activeSkillName: this.activeSkillName,
      activeToolsets: this.activeSkillToolsets,
      conversationHistory: messages,
    });
  }

  private baseObservabilityAttributes() {
    const observability = getObservability();
    return {
      ...(this.toolExecutionContext?.sessionId && { 'xiaoba.session.id_hash': observability.sessionIdHash(this.toolExecutionContext.sessionId) }),
      ...(this.toolExecutionContext?.surface && { 'xiaoba.surface': this.toolExecutionContext.surface }),
      ...(this.toolExecutionContext?.roleName && { 'xiaoba.role.name': this.toolExecutionContext.roleName }),
      ...(this.activeSkillName && { 'xiaoba.skill.name': this.activeSkillName }),
    };
  }

  private recordObservabilityMetric(
    observability: Observability,
    name: string,
    value: number,
    attributes: ObservabilityAttributes,
    unit = '1',
  ): void {
    if (this.observabilityMetricMode === 'mirror_only') {
      observability.mirrorMetric(name, value, attributes, unit);
      return;
    }
    observability.recordMetric(name, value, attributes, unit);
  }

  private errorMessage(error: any): string {
    return error?.message ? String(error.message).slice(0, 500) : String(error).slice(0, 500);
  }

  private errorCode(error: any): string {
    return String(error?.error_code || error?.errorCode || error?.code || 'RUNTIME_ERROR');
  }

  private resolveToolVisibilitySnapshot(
    activeTools: ToolDefinition[],
    messages: Message[],
  ): ToolVisibilitySnapshot {
    const executor = this.toolExecutor as ToolExecutor & {
      getToolVisibilityInfo?: (contextOverrides?: Partial<ToolExecutionContext>) => ToolVisibilitySnapshot;
    };
    if (typeof executor.getToolVisibilityInfo === 'function') {
      return executor.getToolVisibilityInfo({
        ...this.toolExecutionContext,
        activeSkillName: this.activeSkillName,
        activeToolsets: this.activeSkillToolsets,
        conversationHistory: messages,
      });
    }
    return {
      ...(this.toolExecutionContext?.roleName && { roleName: this.toolExecutionContext.roleName }),
      ...(this.activeSkillName && { activeSkillName: this.activeSkillName }),
      visibleTools: activeTools.map(tool => tool.name),
      hiddenToolCount: 0,
    };
  }

  /**
   * 处理需要显示输出的工具
   */
  private parseToolInputForCallback(argumentsJson: string): unknown {
    try {
      return JSON.parse(argumentsJson || '{}');
    } catch {
      return {
        _invalidJson: true,
        raw: argumentsJson,
      };
    }
  }

  private handleToolDisplay(toolCall: ToolCall, content: string, callbacks?: RunnerCallbacks): void {
    const toolName = toolCall.function.name;
    if (!callbacks?.onToolDisplay) {
      return;
    }

    if (toolName === 'task_planner') {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        if (args.action === 'create' || args.action === 'update') {
          callbacks.onToolDisplay(toolName, content);
        }
      } catch {
        callbacks.onToolDisplay(toolName, content);
      }
    }
  }

  private tryParseSkillActivation(
    toolCall: ToolCall,
    content: string,
  ): SkillActivationSignal | null {
    if (toolCall.function.name !== 'skill') {
      return null;
    }

    return parseSkillActivationSignal(content);
  }

  private buildTurnMessages(
    assistantMsg: Message,
    executionRecords: ToolExecutionRecord[],
    toolDefinitions: Map<string, ToolDefinition>,
  ): Message[] {
    const messages: Message[] = [];
    const transcriptRecords = executionRecords.filter(record =>
      this.shouldIncludeToolResult(record, toolDefinitions)
    );
    const transcriptToolCalls = this.normalizeToolCallsForTranscript(
      transcriptRecords.map(record => record.toolCall)
    );

    const assistant: Message = {
      role: 'assistant',
      content: assistantMsg.content,
      ...(transcriptToolCalls.length ? { tool_calls: transcriptToolCalls } : {}),
    };

    if (assistant.content || assistant.tool_calls?.length) {
      messages.push(assistant);
    }

    for (const record of transcriptRecords) {
      // 检测图片读取结果的特殊标记
      if (typeof record.toolContent === 'object' && record.toolContent && '_imageForNewMessage' in record.toolContent) {
        const imageData = record.toolContent as any;
        // tool result 包含文本 + 图片（避免产生连续的 user 消息）
        messages.push({
          role: 'tool',
          content: [
            { type: 'text', text: `已读取图片: ${imageData.filePath}` },
            imageData.imageBlock,
          ],
          tool_call_id: record.result.tool_call_id,
          name: record.result.name,
        });
      } else {
        // 正常的 tool result
        messages.push({
          role: 'tool',
          content: record.toolContent,
          tool_call_id: record.result.tool_call_id,
          name: record.result.name,
        });

        // 插入额外消息（如图片）
        if (record.newMessages) {
          messages.push(...record.newMessages);
        }
      }
    }

    return this.sanitizeToolTranscript(messages);
  }

  private buildProviderInputMessages(messages: Message[], transientHints: Message[]): Message[] {
    const sanitizedBase = messages.filter(message => {
      if (message.role !== 'system' || typeof message.content !== 'string') {
        return true;
      }
      return !message.content.startsWith(TRANSIENT_RUNNER_HINT_PREFIX);
    });

    const collapsed: Message[] = [];
    for (const message of sanitizedBase) {
      const previous = collapsed[collapsed.length - 1];
      if (
        previous
        && previous.role === 'assistant'
        && message.role === 'assistant'
        && !previous.tool_calls?.length
        && !message.tool_calls?.length
        && typeof previous.content === 'string'
        && typeof message.content === 'string'
        && previous.content.trim()
        && previous.content === message.content
      ) {
        continue;
      }
      collapsed.push(message);
    }

    if (transientHints.length === 0) {
      return collapsed;
    }

    return [...collapsed, ...transientHints];
  }

  private usesChannelDelivery(): boolean {
    const surface = this.toolExecutionContext?.surface;
    return surface === 'feishu' || surface === 'weixin' || surface === 'pet';
  }

  private async deliverFallbackFinalText(finalText: string, turn: number): Promise<RunToolResult | null> {
    const text = finalText.trim();
    if (!text) {
      return null;
    }

    const toolCallId = `delivery-fallback-turn-${turn}`;
    const deliveryId = `${this.toolExecutionContext?.surface || 'surface'}.fallback_final_reply.${turn}`;
    const toolCall: ToolCall = {
      id: toolCallId,
      type: 'function',
      function: {
        name: 'send_text',
        arguments: JSON.stringify({
          text,
          _delivery_fallback: true,
        }),
      },
    };

    const channel = this.toolExecutionContext?.channel;
    if (!channel) {
      const errorCode = 'DELIVERY_CHANNEL_MISSING';
      Logger.error(`[${this.sessionLabel}Turn ${turn}] delivery_fallback_failed: channel context missing`);
      return {
        toolCall,
        toolName: 'send_text',
        result: this.buildFallbackDeliveryResult(toolCallId, text, deliveryId, 'failure', errorCode, []),
      };
    }

    try {
      const receipts = await channel.reply(channel.chatId, text) as ChannelDeliveryReceipt | void;
      const preview = text.length > 100 ? text.slice(0, 100) + '...' : text;
      Logger.info(`[${this.sessionLabel}Turn ${turn}] delivery_fallback_final_reply: fallback 已显式开启，发送最终文本 "${preview}"`);
      const externalReceipts = normalizeExternalDeliveryReceipts(receipts, {
        receiptType: 'message',
        surface: this.toolExecutionContext?.surface,
        deliveryId,
      });
      return {
        toolCall,
        toolName: 'send_text',
        result: this.buildFallbackDeliveryResult(toolCallId, text, deliveryId, 'success', undefined, externalReceipts),
      };
    } catch (err: any) {
      const errorCode = 'DELIVERY_FAILED';
      Logger.error(`[${this.sessionLabel}Turn ${turn}] delivery_fallback_failed: ${err.message}`);
      return {
        toolCall,
        toolName: 'send_text',
        result: this.buildFallbackDeliveryResult(toolCallId, text, deliveryId, 'failure', errorCode, []),
      };
    }
  }

  private buildFallbackDeliveryResult(
    toolCallId: string,
    text: string,
    deliveryId: string,
    status: 'success' | 'failure',
    errorCode: string | undefined,
    externalReceipts: ReturnType<typeof normalizeExternalDeliveryReceipts>,
  ): ToolResult {
    const deliveryStatus: DeliveryEvidence['status'] = status === 'success' ? 'delivered' : 'failed';
    return buildCanonicalToolResult({
      tool_call_id: toolCallId,
      name: 'send_text',
      content: status === 'success' ? '已通过 fallback 发送' : 'fallback 发送失败',
      status,
      errorCode,
      retryable: false,
      durationMs: 0,
      deliveryEvidence: [{
        delivery_id: deliveryId,
        surface: this.toolExecutionContext?.surface,
        channel_id: this.toolExecutionContext?.channel?.chatId
          ? this.hashIdentifier(this.toolExecutionContext.channel.chatId)
          : undefined,
        delivery_type: 'text',
        status: deliveryStatus,
        timestamp: new Date().toISOString(),
        text_preview: this.truncateDeliveryPreview(text),
        ...(errorCode && { error_code: errorCode }),
      }],
      externalDeliveryReceipts: status === 'success' ? externalReceipts : [],
    });
  }

  private hashIdentifier(value: string): string {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
  }

  private truncateDeliveryPreview(text: string): string {
    return text.length <= 200 ? text : `${text.slice(0, 200)}...`;
  }

  private getToolTranscriptMode(
    toolName: string,
    toolDefinitions: Map<string, ToolDefinition>,
  ): ToolTranscriptMode {
    return toolDefinitions.get(toolName)?.transcriptMode ?? 'default';
  }

  private hasStructuredFailure(result: ToolResult): boolean {
    return result.ok === false
      || Boolean(result.error_code || result.errorCode)
      || (Boolean(result.status) && result.status !== 'success');
  }

  private shouldIncludeToolResult(
    record: ToolExecutionRecord,
    toolDefinitions: Map<string, ToolDefinition>,
  ): boolean {
    const transcriptMode = this.getToolTranscriptMode(record.toolName, toolDefinitions);
    return transcriptMode !== 'suppress' || this.hasStructuredFailure(record.result);
  }

  private shouldNormalizeOutboundRecord(
    record: ToolExecutionRecord,
    transcriptMode: ToolTranscriptMode,
  ): boolean {
    if (this.hasStructuredFailure(record.result)) {
      return false;
    }

    return transcriptMode === 'outbound_message' || transcriptMode === 'outbound_file';
  }

  private buildOutboundAssistantMessage(
    record: ToolExecutionRecord,
    toolDefinitions: Map<string, ToolDefinition>,
  ): Message | null {
    const transcriptMode = this.getToolTranscriptMode(record.toolName, toolDefinitions);
    let args: Record<string, unknown> = {};

    try {
      args = JSON.parse(record.toolCall.function.arguments || '{}');
    } catch {
      return null;
    }

    if (transcriptMode === 'outbound_message') {
      const text = this.extractOutboundMessage(record.toolName, args);
      if (!text) {
        return null;
      }
      return {
        role: 'assistant',
        content: text,
      };
    }

    if (transcriptMode === 'outbound_file') {
      const fileName = typeof args.file_name === 'string' ? args.file_name.trim() : '';
      if (!fileName) {
        return null;
      }
      return {
        role: 'assistant',
        content: fileName,
      };
    }

    return null;
  }

  private extractOutboundMessage(
    toolName: string,
    args: Record<string, unknown>,
  ): string | null {
    if (toolName === 'reply') {
      const text = typeof args.message === 'string' ? args.message.trim() : '';
      return text || null;
    }

    if (toolName === 'feishu_mention') {
      const message = typeof args.message === 'string' ? args.message.trim() : '';
      const mentions = Array.isArray(args.mentions)
        ? args.mentions
          .map(item => typeof item === 'object' && item && typeof (item as { name?: unknown }).name === 'string'
            ? `@${String((item as { name: string }).name).trim()}`
            : '')
          .filter(Boolean)
        : [];
      const prefix = mentions.join(' ').trim();
      const combined = [prefix, message].filter(Boolean).join(' ').trim();
      return combined || null;
    }

    return null;
  }

  private async requestModelResponse(
    messages: Message[],
    activeTools: ToolDefinition[],
    callbacks?: RunnerCallbacks,
  ) {
    try {
      if (this.stream) {
        const streamCallbacks: StreamCallbacks = {
          onText: this.usesChannelDelivery() ? undefined : (text) => { if (!this.toolExecutionContext?.abortSignal?.aborted) callbacks?.onText?.(text); },
          onRetry: (attempt, maxRetries) => callbacks?.onRetry?.(attempt, maxRetries),
        };
        return await this.aiService.chatStream(messages, activeTools, streamCallbacks, { abortSignal: this.toolExecutionContext?.abortSignal });
      }
      return await this.aiService.chat(messages, activeTools, { abortSignal: this.toolExecutionContext?.abortSignal });
    } catch (error: any) {
      if (!this.isPromptTooLongError(error)) {
        throw error;
      }

      Logger.warning('检测到提示词超长，执行紧急上下文裁剪后重试一次');
      this.forceTrimForOverflow(messages);
      this.ensurePromptBudget(messages, activeTools);

      if (this.stream) {
        const streamCallbacks: StreamCallbacks = {
          onText: this.usesChannelDelivery() ? undefined : (text) => { if (!this.toolExecutionContext?.abortSignal?.aborted) callbacks?.onText?.(text); },
          onRetry: (attempt, maxRetries) => callbacks?.onRetry?.(attempt, maxRetries),
        };
        return await this.aiService.chatStream(messages, activeTools, streamCallbacks, { abortSignal: this.toolExecutionContext?.abortSignal });
      }
      return await this.aiService.chat(messages, activeTools, { abortSignal: this.toolExecutionContext?.abortSignal });
    }
  }

  private ensurePromptBudget(messages: Message[], tools: ToolDefinition[]): void {
    const toolTokens = estimateToolsTokens(tools);
    const messageBudget = Math.max(MIN_MESSAGE_BUDGET, this.maxPromptTokens - toolTokens);
    let messageTokens = estimateMessagesTokens(messages);

    if (messageTokens <= messageBudget) {
      return;
    }

    Logger.warning(
      `[上下文守门] 估算超预算: messages=${messageTokens}, tools=${toolTokens}, budget=${this.maxPromptTokens}`
    );

    // 纯机械裁剪（同步，不调用 AI）
    for (let pass = 0; pass < 3 && messageTokens > messageBudget; pass++) {
      const trimmed = this.hardTrimMessages(messages, messageBudget);
      this.replaceMessages(messages, trimmed);
      messageTokens = estimateMessagesTokens(messages);
    }

    if (messageTokens > messageBudget) {
      const minimal = this.buildMinimalFallback(messages);
      this.replaceMessages(messages, minimal);
      messageTokens = estimateMessagesTokens(messages);
    }

    Logger.info(
      `[上下文守门] 裁剪后: messages=${messageTokens}, tools=${toolTokens}, budget=${this.maxPromptTokens}`
    );
  }

  private forceTrimForOverflow(messages: Message[]): void {
    const before = estimateMessagesTokens(messages);
    const target = Math.max(MIN_MESSAGE_BUDGET, Math.floor(before * OVERFLOW_REDUCTION_RATIO));
    const trimmed = this.hardTrimMessages(messages, target);
    this.replaceMessages(messages, trimmed);
  }

  private hardTrimMessages(messages: Message[], targetTokens: number): Message[] {
    const system = messages.filter(msg => msg.role === 'system');
    const groups = this.groupTranscriptMessages(messages.filter(msg => msg.role !== 'system'));

    const recentCount = Math.min(8, groups.length);
    const oldGroups = groups
      .slice(0, -recentCount)
      .map(group => group.map(msg => this.shrinkMessage(msg, true)));
    const recentGroups = groups
      .slice(-recentCount)
      .map(group => group.map(msg => this.shrinkMessage(msg, false)));

    let candidate = this.sanitizeToolTranscript([
      ...system,
      ...oldGroups.flat(),
      ...recentGroups.flat(),
    ]);

    while (estimateMessagesTokens(candidate) > targetTokens && oldGroups.length > 0) {
      oldGroups.shift();
      candidate = this.sanitizeToolTranscript([
        ...system,
        ...oldGroups.flat(),
        ...recentGroups.flat(),
      ]);
    }

    while (estimateMessagesTokens(candidate) > targetTokens && recentGroups.length > 1) {
      recentGroups.shift();
      candidate = this.sanitizeToolTranscript([
        ...system,
        ...oldGroups.flat(),
        ...recentGroups.flat(),
      ]);
    }

    if (estimateMessagesTokens(candidate) > targetTokens && system.length > 1) {
      const trimmedSystem = [
        system[0],
        ...system.slice(1).map(msg => this.shrinkMessage(msg, true)),
      ];
      candidate = this.sanitizeToolTranscript([
        ...trimmedSystem,
        ...oldGroups.flat(),
        ...recentGroups.flat(),
      ]);
    }

    return candidate;
  }

  private groupTranscriptMessages(messages: Message[]): Message[][] {
    const groups: Message[][] = [];

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];

      if (message.role === 'tool') {
        continue;
      }

      if (message.role !== 'assistant' || !message.tool_calls?.length) {
        groups.push([message]);
        continue;
      }

      const toolCalls = this.normalizeToolCallsForTranscript(message.tool_calls);
      if (toolCalls.length === 0) {
        if (contentToString(message.content).trim()) {
          const assistantWithoutToolCalls: Message = { ...message };
          delete assistantWithoutToolCalls.tool_calls;
          groups.push([assistantWithoutToolCalls]);
        }
        continue;
      }

      const expectedToolCallIds = new Set(toolCalls.map(toolCall => toolCall.id));
      const group: Message[] = [message];
      let j = i + 1;

      while (j < messages.length && messages[j].role === 'tool') {
        const toolMessage = messages[j];
        if (toolMessage.tool_call_id && expectedToolCallIds.has(toolMessage.tool_call_id)) {
          group.push(toolMessage);
        }
        j++;
      }

      groups.push(group);
      i = j - 1;
    }

    return groups;
  }

  private sanitizeToolTranscript(messages: Message[]): Message[] {
    const sanitized: Message[] = [];

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];

      if (message.role === 'tool') {
        continue;
      }

      if (message.role !== 'assistant' || !message.tool_calls?.length) {
        sanitized.push(message);
        continue;
      }

      const toolCalls = this.normalizeToolCallsForTranscript(message.tool_calls);
      if (toolCalls.length === 0) {
        const assistantWithoutToolCalls: Message = { ...message };
        delete assistantWithoutToolCalls.tool_calls;
        if (contentToString(assistantWithoutToolCalls.content).trim()) {
          sanitized.push(assistantWithoutToolCalls);
        }
        continue;
      }

      const expectedToolCallIds = new Set(toolCalls.map(toolCall => toolCall.id));
      const seenToolCallIds = new Set<string>();
      const toolMessages: Message[] = [];
      let j = i + 1;

      while (j < messages.length && messages[j].role === 'tool') {
        const toolMessage = messages[j];
        const toolCallId = toolMessage.tool_call_id;
        if (toolCallId && expectedToolCallIds.has(toolCallId) && !seenToolCallIds.has(toolCallId)) {
          seenToolCallIds.add(toolCallId);
          toolMessages.push(toolMessage);
        }
        j++;
      }

      if (seenToolCallIds.size === expectedToolCallIds.size) {
        sanitized.push({
          ...message,
          tool_calls: toolCalls,
        }, ...toolMessages);
      } else {
        const assistantWithoutToolCalls: Message = { ...message };
        delete assistantWithoutToolCalls.tool_calls;
        if (contentToString(assistantWithoutToolCalls.content).trim()) {
          sanitized.push(assistantWithoutToolCalls);
        }
      }

      i = j - 1;
    }

    return sanitized;
  }

  private normalizeToolCallsForTranscript(toolCalls: ToolCall[] | undefined): ToolCall[] {
    if (!toolCalls?.length) {
      return [];
    }

    const seen = new Set<string>();
    const normalized: ToolCall[] = [];

    for (const toolCall of toolCalls) {
      if (!toolCall.id || seen.has(toolCall.id)) {
        continue;
      }
      seen.add(toolCall.id);
      normalized.push(toolCall);
    }

    return normalized;
  }

  private buildMinimalFallback(messages: Message[]): Message[] {
    const system = messages.find(msg => msg.role === 'system');
    const nonSystem = messages.filter(msg => msg.role !== 'system');
    const tail = this.groupTranscriptMessages(nonSystem)
      .slice(-2)
      .flatMap(group => group.map(msg => this.shrinkMessage(msg, true)));

    const result: Message[] = [];
    if (system) {
      result.push(this.shrinkMessage(system, true));
    }
    result.push(...tail);

    return this.sanitizeToolTranscript(result);
  }

  private shrinkMessage(message: Message, aggressive: boolean): Message {
    const maxChars = this.resolveMessageCharLimit(message, aggressive);
    const content = message.content || '';
    let nextContent = content;

    if (content.length > maxChars) {
      nextContent = content.slice(0, maxChars) + `\n...[已截断，原始 ${content.length} 字符]`;
    }

    if (message.role === 'tool') {
      const toolName = message.name || 'unknown';
      nextContent = `[tool:${toolName}] 历史输出已省略`;
    }

    const next: Message = {
      ...message,
      content: nextContent,
    };

    if (next.tool_calls?.length) {
      next.tool_calls = next.tool_calls.map(toolCall => ({
        ...toolCall,
        function: {
          ...toolCall.function,
          arguments: this.shrinkToolArguments(
            toolCall.function.arguments,
            aggressive ? MAX_AGGRESSIVE_TOOL_ARGUMENT_CHARS : MAX_SHRUNK_TOOL_ARGUMENT_CHARS,
          ),
        },
      }));
    }

    return next;
  }

  private shrinkToolArguments(args: string, maxChars: number): string {
    if (!args || args.length <= maxChars) {
      return args;
    }

    let preview = args.slice(0, maxChars);
    try {
      const parsed = JSON.parse(args);
      preview = JSON.stringify(parsed).slice(0, maxChars);
    } catch {
      // Keep the raw prefix below; historical malformed args should stay harmless.
    }

    return JSON.stringify({
      _truncated: true,
      preview,
      originalChars: args.length,
    });
  }

  private resolveMessageCharLimit(message: Message, aggressive: boolean): number {
    if (message.role === 'system') return aggressive ? 1200 : 2400;
    if (message.role === 'user') return aggressive ? 600 : 1200;
    if (message.role === 'assistant') return aggressive ? 400 : 900;
    return aggressive ? 120 : 240;
  }

  private replaceMessages(target: Message[], next: Message[]): void {
    target.length = 0;
    target.push(...next);
  }

  private resolvePromptBudget(maxContextTokens?: number): number {
    const envBudget = Number(process.env.XIAOBA_LLM_MAX_PROMPT_TOKENS);
    if (Number.isFinite(envBudget) && envBudget > 0) {
      return envBudget;
    }

    if (maxContextTokens && maxContextTokens > 0) {
      return maxContextTokens;
    }

    return DEFAULT_MAX_CONTEXT_TOKENS;
  }

  private isPromptTooLongError(error: any): boolean {
    const text = String(error?.message || error || '').toLowerCase();
    return (
      text.includes('prompt is too long') ||
      text.includes('maximum context length') ||
      text.includes('context_length_exceeded') ||
      text.includes('input is too long') ||
      text.includes('premature close')
    );
  }

  // ─── 429 重试逻辑 ──────────────────────────────────

  private static readonly MAX_RETRIES = 2;
  private static readonly MAX_NON_RETRYABLE_FAILURES = 2;
  private static readonly RETRY_BASE_DELAY_MS = 5000;
  private static readonly RATE_LIMIT_ERROR_CODES = new Set([
    'RATE_LIMIT',
    'HTTP_429',
    'TOO_MANY_REQUESTS',
  ]);

  private static hasRateLimitMarkers(text: string): boolean {
    if (!text) {
      return false;
    }

    const lower = text.toLowerCase();
    if (
      lower.includes('rate limit')
      || lower.includes('too many requests')
      || lower.includes('频率受限')
      || lower.includes('限流')
    ) {
      return true;
    }

    return /(status(?:\s*code)?|http(?:\s*status)?|错误码|code)\s*[:=]?\s*429\b/i.test(text)
      || /\b429\b.{0,24}(too many requests|rate limit|频率受限|限流)/i.test(text)
      || /(too many requests|rate limit|频率受限|限流).{0,24}\b429\b/i.test(text);
  }

  /** 检测工具结果是否为 429 限流错误（避免把正文里的数字 429 误判为限流） */
  private static isRateLimitError(result: ToolResult): boolean {
    const content = String(result.content || '');
    const errorCode = result.error_code || result.errorCode;
    if (errorCode && ConversationRunner.RATE_LIMIT_ERROR_CODES.has(errorCode)) {
      return true;
    }

    const isFailure = result.ok === false
      || Boolean(errorCode)
      || (Boolean(result.status) && result.status !== 'success')
      || result.retryable === true;

    if (!isFailure) {
      return false;
    }

    return ConversationRunner.hasRateLimitMarkers(content);
  }

  private static shouldRetryToolResult(result: ToolResult): boolean {
    if (result.retryable === true) {
      return result.ok === false
        || Boolean(result.error_code || result.errorCode)
        || (Boolean(result.status) && result.status !== 'success');
    }

    return ConversationRunner.isRateLimitError(result);
  }

  private boundRepeatedNonRetryableFailure(
    toolCall: ToolCall,
    result: ToolResult,
    failureCounts: Map<string, number>,
  ): ToolResult {
    if (!ConversationRunner.shouldTrackNonRetryableFailure(result)) {
      return result;
    }

    const fingerprint = this.repeatedNonRetryableFailureFingerprint(toolCall, result);
    const previousCount = failureCounts.get(fingerprint) ?? 0;

    if (previousCount >= ConversationRunner.MAX_NON_RETRYABLE_FAILURES) {
      return this.buildRepeatedNonRetryableBlockedResult(toolCall, result, previousCount);
    }

    failureCounts.set(fingerprint, previousCount + 1);
    return result;
  }

  private static shouldTrackNonRetryableFailure(result: ToolResult): boolean {
    if (result.status === 'success' || result.ok === true) {
      return false;
    }
    if (result.status === 'blocked' || result.status === 'cancelled') {
      return false;
    }
    if (result.retryable === true || ConversationRunner.shouldRetryToolResult(result)) {
      return false;
    }

    return result.ok === false
      || Boolean(result.error_code || result.errorCode)
      || Boolean(result.status);
  }

  private repeatedNonRetryableFailureFingerprint(toolCall: ToolCall, result: ToolResult): string {
    const toolName = normalizeToolName(toolCall.function.name);
    const args = this.normalizeToolArgumentsForFailureFingerprint(toolCall.function.arguments);
    const errorKey = result.error_code
      || result.errorCode
      || result.status
      || ConversationRunner.truncateForLog(contentToString(result.content), 120);

    return `${toolName}\n${args}\n${errorKey}`;
  }

  private normalizeToolArgumentsForFailureFingerprint(argsJson: string): string {
    try {
      return this.stableStringify(JSON.parse(argsJson || '{}')).slice(0, 2000);
    } catch {
      return String(argsJson || '').trim().slice(0, 2000);
    }
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map(item => this.stableStringify(item)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${this.stableStringify(item)}`);
      return `{${entries.join(',')}}`;
    }
    return JSON.stringify(value);
  }

  /** 带预算的可重试工具执行 */
  private async executeToolWithRetry(
    toolCall: ToolCall,
    messages: Message[],
    context: Partial<ToolExecutionContext>,
    turn: number,
  ): Promise<ToolResult> {
    if (context.abortSignal?.aborted) return this.buildCancelledToolResult(toolCall, 'Tool execution cancelled.');
    let lastResult = await this.toolExecutor.executeTool(toolCall, messages, context);
    let retryCount = 0;

    for (let attempt = 1; attempt <= ConversationRunner.MAX_RETRIES; attempt++) {
      if (!ConversationRunner.shouldRetryToolResult(lastResult)) {
        return this.withRetryEvidence(lastResult, retryCount);
      }
      const delay = ConversationRunner.RETRY_BASE_DELAY_MS * attempt;
      const retryReason = this.describeRetryReason(lastResult);
      Logger.warning(`[${this.sessionLabel}Turn ${turn}] ${toolCall.function.name} 触发可重试工具失败 (${retryReason})，${delay}ms 后重试 (${attempt}/${ConversationRunner.MAX_RETRIES})`);
      try { await cancellableDelay(delay, context.abortSignal); }
      catch (error) { if (isCancellation(error)) return this.buildCancelledToolResult(toolCall, 'Tool retry cancelled.'); throw error; }
      if (context.abortSignal?.aborted || this.shouldContinue && !this.shouldContinue()) return this.buildCancelledToolResult(toolCall, 'Tool retry cancelled.');
      retryCount = attempt;
      lastResult = await this.toolExecutor.executeTool(toolCall, messages, context);
    }

    if (ConversationRunner.shouldRetryToolResult(lastResult)) {
      return this.buildRetryBudgetBlockedResult(toolCall, lastResult, retryCount);
    }

    return this.withRetryEvidence(lastResult, retryCount);
  }

  private buildRepeatedNonRetryableBlockedResult(
    toolCall: ToolCall,
    result: ToolResult,
    previousFailureCount: number,
  ): ToolResult {
    const errorCode = result.error_code || result.errorCode || 'REPEATED_NON_RETRYABLE_FAILURE';
    const lastError = contentToString(result.content);
    const blockedReason = [
      `Repeated identical non-retryable failure reached bounded failure budget after ${previousFailureCount} prior failures for ${toolCall.function.name}.`,
      `error_code=${errorCode}.`,
      lastError ? `Last error: ${ConversationRunner.truncateForLog(lastError, 300)}` : '',
    ].filter(Boolean).join(' ');

    return canonicalizeToolResult({
      ...result,
      status: 'blocked',
      error_code: errorCode,
      errorCode,
      retryable: false,
      blocked_reason: blockedReason,
      retry_count: previousFailureCount,
      retry_budget: ConversationRunner.MAX_NON_RETRYABLE_FAILURES,
      retry_budget_exhausted: true,
      content: `重复不可重试工具失败已收束: ${lastError || errorCode}`,
      delivery_evidence: result.delivery_evidence?.map(item => ({
        ...item,
        status: 'blocked',
        error_code: item.error_code || errorCode,
      })),
    }, {
      fallbackToolCallId: toolCall.id,
      fallbackName: toolCall.function.name,
      fallbackStatus: 'blocked',
      fallbackErrorCode: errorCode,
      fallbackBlockedReason: blockedReason,
    });
  }

  private describeRetryReason(result: ToolResult): string {
    const errorCode = result.error_code || result.errorCode;
    if (errorCode) {
      return errorCode;
    }
    if (result.status && result.status !== 'success') {
      return result.status;
    }
    return 'retryable';
  }

  private withRetryEvidence(result: ToolResult, retryCount: number): ToolResult {
    if (retryCount <= 0) {
      return result;
    }

    return {
      ...result,
      retry_count: retryCount,
      retry_budget: ConversationRunner.MAX_RETRIES,
      retry_budget_exhausted: false,
    };
  }

  private buildRetryBudgetBlockedResult(
    toolCall: ToolCall,
    result: ToolResult,
    retryCount: number,
  ): ToolResult {
    const errorCode = result.error_code || result.errorCode || 'RATE_LIMIT';
    const lastError = contentToString(result.content);
    const blockedReason = [
      `Retry budget exhausted after ${retryCount} retr${retryCount === 1 ? 'y' : 'ies'} for ${toolCall.function.name}.`,
      lastError ? `Last error: ${ConversationRunner.truncateForLog(lastError, 300)}` : '',
    ].filter(Boolean).join(' ');

    return canonicalizeToolResult({
      ...result,
      status: 'blocked',
      error_code: errorCode,
      errorCode,
      retryable: false,
      blocked_reason: blockedReason,
      retry_count: retryCount,
      retry_budget: ConversationRunner.MAX_RETRIES,
      retry_budget_exhausted: true,
      content: `重试预算已耗尽: ${lastError || errorCode}`,
      delivery_evidence: result.delivery_evidence?.map(item => ({
        ...item,
        status: 'blocked',
        error_code: item.error_code || errorCode,
      })),
    }, {
      fallbackToolCallId: toolCall.id,
      fallbackName: toolCall.function.name,
      fallbackStatus: 'blocked',
      fallbackErrorCode: errorCode,
      fallbackBlockedReason: blockedReason,
    });
  }

  private buildCancelledToolResult(toolCall: ToolCall, reason: string): ToolResult {
    return buildCanonicalToolResult({
      tool_call_id: toolCall.id,
      name: toolCall.function.name,
      content: `工具调用已取消: ${reason}`,
      status: 'cancelled',
      errorCode: 'TOOL_CANCELLED',
      retryable: false,
      blockedReason: reason,
      durationMs: 0,
    });
  }
}
