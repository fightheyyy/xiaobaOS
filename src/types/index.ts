export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string } };

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentBlock[] | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  name?: string;
  /** 标记由 injectContext 注入的消息，用于滑动窗口清理 */
  __injected?: boolean;
}

export interface ChatConfig {
  apiKey?: string;
  apiUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  provider?: 'openai' | 'anthropic' | 'ollama';
  ollama?: {
    think?: boolean;
    keepAlive?: string;
    numCtx?: number;
  };
  feishu?: {
    appId?: string;
    appSecret?: string;
    sessionTTL?: number;
    botOpenId?: string;
    botAliases?: string[];
  };
  weixin?: {
    token?: string;
    baseUrl?: string;
    cdnBaseUrl?: string;
    allowFrom?: string[];
    sessionTTL?: number;
    longPollTimeout?: number;
  };
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  content: string | null;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  usage?: TokenUsage;
}

export interface CommandOptions {
  interactive?: boolean;
  message?: string;
  config?: string;
  skill?: string;
  role?: string;
  resume?: boolean;
  verbose?: boolean;
  /** Internal one-shot session identity; normal CLI callers should omit it. */
  sessionKey?: string;
  /** Internal one-shot durable session bucket; normal CLI callers should omit it. */
  sessionType?: string;
  /** Internal jobs can disable transcript-derived long-term memory finalization. */
  finalizeMemory?: boolean;
}

// 导出 Agent 相关类型
export * from './agent';
export * from './role';
export * from './tool';
export * from './skill';
