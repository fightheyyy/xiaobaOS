import { cancellableDelay, throwIfCancelled, isCancellation } from './cancellation';
import { Message, ChatConfig, ChatResponse } from '../types';
import { ConfigManager } from './config';
import { ToolDefinition } from '../types/tool';
import { AIProvider, StreamCallbacks, ProviderCallOptions } from '../providers/provider';
import { AnthropicProvider } from '../providers/anthropic-provider';
import { OpenAIProvider } from '../providers/openai-provider';
import { OllamaProvider } from '../providers/ollama-provider';
import { Logger } from './logger';
import {
  ArenaProviderCallComponent,
  arenaLiveAuditEnabled,
  arenaLiveProviderConfig,
  runArenaAuditedProviderCall,
} from '../arena/live-audit';

/**
 * AI 服务 - 统一的 AI 调用入口
 * 内部委托给对应的 Provider 实现
 */
/** 可重试的 HTTP 状态码 */
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 529]);
const FAILOVER_STATUS_CODES = new Set([401, 403]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_BACKUP_SLOTS = 5;

type ProviderKind = 'openai' | 'anthropic' | 'ollama';

interface ProviderEndpoint {
  label: string;
  config: ChatConfig;
  provider: AIProvider;
}

interface BackupEnvConfig {
  hasAnyValue: boolean;
  provider?: ProviderKind;
  apiUrl?: string;
  apiKey?: string;
  model?: string;
}

interface StreamFailoverError extends Error {
  __streamTextEmitted?: boolean;
}

interface ProviderCallError extends Error {
  provider?: string;
  model?: string;
  endpoint?: string;
  status?: number;
  error_code?: string;
  retryable?: boolean;
}

export interface AIServiceOptions {
  arenaComponent?: ArenaProviderCallComponent;
}

/**
 * Keep test/custom AgentServices compatible while preventing a custom service
 * from silently bypassing live-audit telemetry in a paid Arena run.
 */
export async function runWithArenaAuditScope<T>(
  service: unknown,
  scopeId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const scoped = service as {
    withArenaAuditScope?: (scope: string, action: () => Promise<T>) => Promise<T>;
  };
  if (typeof scoped?.withArenaAuditScope === 'function') {
    return scoped.withArenaAuditScope(scopeId, fn);
  }
  if (arenaLiveAuditEnabled()) {
    throw new Error('Arena live audit requires an AI service with scoped provider telemetry');
  }
  return fn();
}

export class AIService {
  private config: ChatConfig;
  private providerChain: ProviderEndpoint[];
  private arenaComponent?: ArenaProviderCallComponent;
  private arenaScopeId?: string;

  constructor(overrides?: Partial<ChatConfig>, options: AIServiceOptions = {}) {
    this.config = {
      ...ConfigManager.getConfig(),
      ...(arenaLiveProviderConfig() || {}),
      ...(overrides || {})
    };
    this.arenaComponent = options.arenaComponent;
    this.providerChain = this.buildProviderChain();
  }

  async withArenaAuditScope<T>(scopeId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.arenaScopeId;
    this.arenaScopeId = scopeId;
    try {
      return await fn();
    } finally {
      this.arenaScopeId = previous;
    }
  }

  /**
   * 根据配置创建对应的 Provider
   */
  private createProvider(config: ChatConfig): AIProvider {
    if (config.provider === 'anthropic') {
      return new AnthropicProvider(config);
    } else if (config.provider === 'ollama') {
      return new OllamaProvider(config);
    } else {
      return new OpenAIProvider(config);
    }
  }

  /**
   * 构建主备模型链路（主模型 + 可选备模型）
   */
  private buildProviderChain(): ProviderEndpoint[] {
    const chain: ProviderEndpoint[] = [];

    const primaryConfig = this.withResolvedProvider(this.config);
    chain.push({
      label: 'primary',
      config: primaryConfig,
      provider: this.createProvider(primaryConfig),
    });

    for (const backup of arenaLiveAuditEnabled() ? [] : this.loadBackupConfigsFromEnv()) {
      chain.push({
        label: backup.label,
        config: backup.config,
        provider: this.createProvider(backup.config),
      });
    }

    if (chain.length > 1) {
      const hops = chain.map(endpoint => `${endpoint.label}:${endpoint.config.provider}/${endpoint.config.model || 'default'}`);
      Logger.info(`[AIService] 已启用模型主备链路: ${hops.join(' -> ')}`);
    }

    return chain;
  }

  /**
   * 加载备模型配置
   * 支持两种写法：
   * 1) XIAOBA_LLM_BACKUP_*
   * 2) XIAOBA_LLM_BACKUP_1_* / XIAOBA_LLM_BACKUP_2_* ...
   */
  private loadBackupConfigsFromEnv(): Array<{ label: string; config: ChatConfig }> {
    const backups: Array<{ label: string; config: ChatConfig }> = [];

    const slot1 = this.readBackupEnvConfig('XIAOBA_LLM_BACKUP_1_');
    const hasSlot1 = slot1.hasAnyValue;
    const aliasBackup = this.readBackupEnvConfig('XIAOBA_LLM_BACKUP_');

    // 兼容旧格式：若未配置编号备份，则使用无编号备份
    if (!hasSlot1 && aliasBackup.hasAnyValue) {
      const config = this.toBackupChatConfig(aliasBackup, 'backup-1');
      if (config) {
        backups.push({ label: 'backup-1', config });
      }
    }

    for (let i = 1; i <= MAX_BACKUP_SLOTS; i++) {
      const envConfig = this.readBackupEnvConfig(`XIAOBA_LLM_BACKUP_${i}_`);
      if (!envConfig.hasAnyValue) {
        continue;
      }
      const label = `backup-${i}`;
      const config = this.toBackupChatConfig(envConfig, label);
      if (config) {
        backups.push({ label, config });
      }
    }

    return backups;
  }

  /**
   * 读取单个备模型 env 配置
   */
  private readBackupEnvConfig(prefix: string): BackupEnvConfig {
    const providerRaw = (process.env[`${prefix}PROVIDER`] || '').trim().toLowerCase();
    const apiUrl = (process.env[`${prefix}API_BASE`] || '').trim();
    const apiKey = (process.env[`${prefix}API_KEY`] || '').trim();
    const model = (process.env[`${prefix}MODEL`] || '').trim();

    const hasAnyValue = Boolean(providerRaw || apiUrl || apiKey || model);

    let provider: ProviderKind | undefined;
    if (providerRaw) {
      if (providerRaw === 'openai' || providerRaw === 'anthropic' || providerRaw === 'ollama') {
        provider = providerRaw;
      } else {
        Logger.warning(`[AIService] 忽略 ${prefix}PROVIDER=${providerRaw}，仅支持 openai/anthropic/ollama`);
      }
    }

    return {
      hasAnyValue,
      provider,
      apiUrl: apiUrl || undefined,
      apiKey: apiKey || undefined,
      model: model || undefined,
    };
  }

  /**
   * 将备模型 env 配置转换为 ChatConfig
   */
  private toBackupChatConfig(envConfig: BackupEnvConfig, label: string): ChatConfig | null {
    const provider = envConfig.provider ?? this.resolveProvider({
      apiUrl: envConfig.apiUrl,
      model: envConfig.model,
    });

    if (!envConfig.apiUrl || !envConfig.model || (provider !== 'ollama' && !envConfig.apiKey)) {
      Logger.warning(
        `[AIService] 跳过 ${label}：配置不完整（${provider === 'ollama' ? '需要 API_BASE/MODEL' : '需要 API_BASE/API_KEY/MODEL'}）`
      );
      return null;
    }

    return {
      ...this.config,
      provider,
      apiUrl: envConfig.apiUrl,
      apiKey: envConfig.apiKey,
      model: envConfig.model,
    };
  }

  /**
   * 自动补全 provider
   */
  private withResolvedProvider(config: ChatConfig): ChatConfig {
    return {
      ...config,
      provider: this.resolveProvider(config),
    };
  }

  private resolveProvider(config: Partial<ChatConfig>): ProviderKind {
    if (config.provider === 'openai' || config.provider === 'anthropic' || config.provider === 'ollama') {
      return config.provider;
    }

    const apiUrl = (config.apiUrl || '').toLowerCase();
    const model = (config.model || '').toLowerCase();

    if (apiUrl.includes('anthropic') || apiUrl.includes('claude') || model.includes('claude')) {
      return 'anthropic';
    }

    if (
      apiUrl.includes('ollama')
      || apiUrl.includes(':11434')
      || apiUrl.endsWith('/api/chat')
      || model.includes('ollama')
    ) {
      return 'ollama';
    }

    return 'openai';
  }

  private hasUsableCredentials(endpoint: ProviderEndpoint): boolean {
    return endpoint.config.provider === 'ollama' || Boolean(endpoint.config.apiKey);
  }

  /**
   * 普通调用（非流式），带自动重试 + 主备切换
   */
  async chat(messages: Message[], tools?: ToolDefinition[], options?: ProviderCallOptions): Promise<ChatResponse> {
    throwIfCancelled(options?.abortSignal);
    if (!this.providerChain.some(endpoint => this.hasUsableCredentials(endpoint))) {
      throw new Error('API密钥未配置。请先运行: xiaoba config');
    }

    return this.executeWithFailover(
      endpoint => this.withRetry(
        () => this.auditedProviderCall(endpoint, messages, tools, () => endpoint.provider.chat(messages, tools, options)),
        endpoint, undefined, options?.abortSignal,
      ),
      'chat'
    );
  }

  /**
   * 流式调用（默认仅在首个片段输出前允许切换备模型）
   * 默认不重试，避免部分 token 已输出后出现重复文本。
   * 如需强制开启重试，可设置 XIAOBA_STREAM_RETRY=true（需自行保证幂等）。
   */
  async chatStream(messages: Message[], tools?: ToolDefinition[], callbacks?: StreamCallbacks, options?: ProviderCallOptions): Promise<ChatResponse> {
    throwIfCancelled(options?.abortSignal);
    if (!this.providerChain.some(endpoint => this.hasUsableCredentials(endpoint))) {
      throw new Error('API密钥未配置。请先运行: xiaoba config');
    }

    const allowStreamRetry = process.env.XIAOBA_STREAM_RETRY === 'true';
    const allowFailoverOnPartial = process.env.XIAOBA_STREAM_FAILOVER_ON_PARTIAL === 'true';

    try {
      return await this.executeWithFailover(
        async endpoint => {
          let emittedText = false;
          const streamCallbacks: StreamCallbacks | undefined = callbacks
            ? {
                onText: (text: string) => {
                  emittedText = true;
                  callbacks.onText?.(text);
                },
                onComplete: callbacks.onComplete,
                // 中间失败会自动切换，此处不透传 onError，避免误报
              }
            : undefined;

          try {
            if (allowStreamRetry) {
              return await this.withRetry(
                () => this.auditedProviderCall(
                  endpoint,
                  messages,
                  tools,
                  () => endpoint.provider.chatStream(messages, tools, streamCallbacks, options),
                ),
                endpoint,
                callbacks, options?.abortSignal
              );
            }
            return await this.auditedProviderCall(
              endpoint,
              messages,
              tools,
              () => endpoint.provider.chatStream(messages, tools, streamCallbacks, options),
            );
          } catch (error) {
            const streamError = (error instanceof Error ? error : new Error(String(error))) as StreamFailoverError;
            streamError.__streamTextEmitted = emittedText;
            throw streamError;
          }
        },
        'chatStream',
        (error) => {
          const streamError = error as StreamFailoverError;
          if (streamError.__streamTextEmitted && !allowFailoverOnPartial) {
            Logger.warning('[AIService] 流式输出已开始，默认不切换备模型。可设置 XIAOBA_STREAM_FAILOVER_ON_PARTIAL=true 强制切换。');
            return false;
          }
          return this.isFailoverEligible(streamError);
        }
      );
    } catch (error: any) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      callbacks?.onError?.(wrapped);
      throw wrapped;
    }
  }

  /**
   * 统一错误处理
   */
  private wrapError(error: any, endpoint?: ProviderEndpoint): Error {
    if (isCancellation(error)) return error;
    const provider = endpoint?.config.provider || this.config.provider;
    const model = endpoint?.config.model || this.config.model;

    Logger.error(
      `API调用失败 | Provider: ${provider} | Model: ${model}${endpoint ? ` | Endpoint: ${endpoint.label}` : ''}`
    );

    const status = this.extractStatus(error);
    const errorMessage = error?.response?.data?.error?.message
      || error?.response?.data?.message
      || error?.error?.message
      || error?.message
      || String(error);

    const wrapped = new Error(status ? `API错误 (${status}): ${errorMessage}` : `请求失败: ${errorMessage}`) as ProviderCallError;
    wrapped.provider = provider || 'unknown';
    if (model) {
      wrapped.model = model;
    }
    if (endpoint?.label) {
      wrapped.endpoint = endpoint.label;
    }
    if (status) {
      wrapped.status = status;
    }
    wrapped.error_code = this.classifyProviderErrorCode(error, status, errorMessage);
    wrapped.retryable = this.isRetryable(error);
    return wrapped;
  }

  private classifyProviderErrorCode(error: any, status: number | null, message: string): string {
    const code = String(error?.code || error?.error?.code || '').toUpperCase();
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
    if (status && RETRYABLE_STATUS_CODES.has(status)) {
      return 'PROVIDER_UPSTREAM_ERROR';
    }
    return 'PROVIDER_ERROR';
  }

  /**
   * 判断错误是否可重试
   */
  private isRetryable(error: any): boolean {
    if (isCancellation(error)) return false;
    // HTTP 状态码可重试
    const status = this.extractStatus(error);
    if (status && RETRYABLE_STATUS_CODES.has(status)) {
      return true;
    }

    // 网络错误可重试
    const code = String(error?.code || '').toUpperCase();
    if (['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
      return true;
    }

    const message = String(error?.message || '');
    if (/timeout|timed out|socket hang up|network error|fetch failed|premature close|ECONNREFUSED/i.test(message)) {
      return true;
    }

    // Anthropic SDK overloaded_error
    if (error?.error?.type === 'overloaded_error') {
      return true;
    }

    return false;
  }

  /**
   * 判断错误是否可触发备模型切换
   */
  private isFailoverEligible(error: any): boolean {
    if (isCancellation(error)) return false;
    if (this.isRetryable(error)) {
      return true;
    }

    const status = this.extractStatus(error);
    if (status && FAILOVER_STATUS_CODES.has(status)) {
      return true;
    }

    return process.env.XIAOBA_LLM_FAILOVER_ON_ANY_ERROR === 'true';
  }

  /**
   * 从错误中提取 HTTP 状态码
   */
  private extractStatus(error: any): number | null {
    const status = error?.response?.status || error?.status;
    if (typeof status === 'number') {
      return status;
    }
    return null;
  }

  /**
   * 从错误中提取 Retry-After 头（秒）
   */
  private getRetryAfter(error: any): number | null {
    const retryAfter = error?.response?.headers?.['retry-after'] || error?.headers?.['retry-after'];
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) return seconds;
    }
    return null;
  }

  /**
   * 错误摘要（用于日志）
   */
  private summarizeError(error: any): string {
    const status = this.extractStatus(error);
    if (status) return `HTTP ${status}`;
    const code = error?.code ? `CODE ${error.code}` : '';
    const message = error?.message ? String(error.message) : 'unknown';
    return `${code}${code ? ' | ' : ''}${message}`.trim();
  }

  /**
   * 带指数退避的重试包装器
   */
  private async withRetry<T>(fn: () => Promise<T>, endpoint: ProviderEndpoint, callbacks?: StreamCallbacks, signal?: AbortSignal): Promise<T> {
    let lastError: any;
    const maxRetries = arenaLiveAuditEnabled() ? 0 : MAX_RETRIES;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        throwIfCancelled(signal);
        return await fn();
      } catch (error: any) {
        if (isCancellation(error)) throw error;
        lastError = error;

        if (attempt >= maxRetries || !this.isRetryable(error)) {
          throw error;
        }

        // 通知用户正在重试
        if (attempt === 0 && callbacks?.onRetry) {
          callbacks.onRetry(attempt + 1, maxRetries);
        }

        // 计算等待时间：优先用 Retry-After，否则指数退避
        const retryAfter = this.getRetryAfter(error);
        const delay = retryAfter
          ? retryAfter * 1000
          : BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;

        const status = this.extractStatus(error) || error?.code || 'unknown';
        Logger.warning(
          `API 调用失败 (${status})，${delay.toFixed(0)}ms 后重试 (${attempt + 1}/${MAX_RETRIES})... `
          + `[${endpoint.label}:${endpoint.config.provider}/${endpoint.config.model || 'default'}]`
        );

        await cancellableDelay(delay, signal);
      }
    }

    throw lastError;
  }

  private auditedProviderCall(
    endpoint: ProviderEndpoint,
    messages: Message[],
    tools: ToolDefinition[] | undefined,
    invoke: () => Promise<ChatResponse>,
  ): Promise<ChatResponse> {
    return runArenaAuditedProviderCall({
      component: this.arenaComponent,
      scopeId: this.arenaScopeId,
      provider: endpoint.config.provider || 'openai',
      model: endpoint.config.model || '',
      requestedOutputLimit: endpoint.config.maxTokens ?? 8192,
      messages,
      tools,
      invoke,
    });
  }

  /**
   * 执行调用（失败后按主备链路切换）
   */
  private async executeWithFailover<T>(
    execute: (endpoint: ProviderEndpoint) => Promise<T>,
    actionName: string,
    shouldFailover?: (error: any, endpoint: ProviderEndpoint) => boolean,
  ): Promise<T> {
    let lastError: any;
    let lastEndpoint: ProviderEndpoint | undefined;

    for (let i = 0; i < this.providerChain.length; i++) {
      const endpoint = this.providerChain[i];
      lastEndpoint = endpoint;

      try {
        return await execute(endpoint);
      } catch (error: any) {
        if (isCancellation(error)) throw error;
        lastError = error;
        const hasNext = i < this.providerChain.length - 1;
        const allowFailover = hasNext && (shouldFailover
          ? shouldFailover(error, endpoint)
          : this.isFailoverEligible(error));

        if (allowFailover) {
          const nextEndpoint = this.providerChain[i + 1];
          Logger.warning(
            `[AIService] ${actionName} 失败，切换备模型：`
            + `${endpoint.label}:${endpoint.config.provider}/${endpoint.config.model || 'default'} -> `
            + `${nextEndpoint.label}:${nextEndpoint.config.provider}/${nextEndpoint.config.model || 'default'} `
            + `| 原因: ${this.summarizeError(error)}`
          );
          continue;
        }

        throw this.wrapError(error, endpoint);
      }
    }

    throw this.wrapError(lastError, lastEndpoint);
  }
}
