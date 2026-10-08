import { ContentBlock } from './index';
import type { ObservabilitySpanContext } from '../observability';

/**
 * 工具参数定义
 */
export interface ToolParameter {
  type: string;
  description?: string;
  required?: boolean;
  enum?: string[];
  items?: ToolParameter | {
    type: string;
    properties?: Record<string, ToolParameter>;
    required?: string[];
  };
  properties?: Record<string, ToolParameter>;
  default?: any;
}

/**
 * 工具定义
 */
export type ToolTranscriptMode = 'default' | 'outbound_message' | 'outbound_file' | 'suppress';
export type ToolControlMode = 'pause_turn';
export type ToolResultStatus = 'success' | 'failure' | 'timeout' | 'cancelled' | 'blocked';
export type ArtifactAction = 'created' | 'updated' | 'sent' | 'generated' | 'captured';
export type DeliveryEvidenceStatus = 'delivered' | 'failed' | 'blocked';
export type DeliveryEvidenceType = 'text' | 'file';
export type ExternalDeliveryReceiptType = 'message' | 'file' | 'upload' | 'download';
export type ExternalDeliveryReceiptStatus = 'accepted' | 'available' | 'delivered' | 'failed' | 'blocked';

export interface ArtifactManifestItem {
  path: string;
  type: string;
  action: ArtifactAction;
  metadata?: Record<string, unknown>;
}

export interface DeliveryEvidence {
  delivery_id?: string;
  surface?: ToolSurface;
  channel_id?: string;
  delivery_type: DeliveryEvidenceType;
  status: DeliveryEvidenceStatus;
  timestamp: string;
  text_preview?: string;
  file_name?: string;
  file_path?: string;
  error_code?: string;
}

export interface ExternalDeliveryReceipt {
  receipt_id?: string;
  receipt_type: ExternalDeliveryReceiptType;
  surface?: ToolSurface;
  status: ExternalDeliveryReceiptStatus;
  timestamp: string;
  platform_message_id?: string;
  platform_file_key?: string;
  delivery_id?: string;
  file_name?: string;
  artifact_path?: string;
  evidence_refs?: string[];
  error_code?: string;
  metadata?: Record<string, unknown>;
}

export type ChannelDeliveryReceipt = ExternalDeliveryReceipt | ExternalDeliveryReceipt[];

export interface ToolExecutionOutput {
  toolContent: string | ContentBlock[];
  /** Explicit terminal execution state. New tools should set this instead of relying on prose prefixes. */
  status?: ToolResultStatus;
  /** Stable snake_case execution error code for non-success states. */
  error_code?: string;
  /** Backward-compatible camelCase execution error code. Prefer error_code for new code. */
  errorCode?: string;
  /** Human-readable reason when status is blocked. */
  blocked_reason?: string;
  retryable?: boolean;
  retry_count?: number;
  retry_budget?: number;
  retry_budget_exhausted?: boolean;
  newMessages?: import('./index').Message[];
  delivery_evidence?: DeliveryEvidence[];
  external_delivery_receipts?: ExternalDeliveryReceipt[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
  /**
   * 控制工具结果如何进入后续 transcript。
   * default: 保留 tool_result；
   * outbound_message/outbound_file: 成功后代表用户已经看到对应文本/文件，runner 会据此避免重复最终回复并记录 delivery fallback。
   * suppress: 成功后不进入后续 transcript（适合控制类工具）。
   */
  transcriptMode?: ToolTranscriptMode;
  /**
   * 控制工具对当前 run 的控制语义。
   * 例如 pause_turn 会显式结束当前这一轮推理，等待新的外部事件。
   */
  controlMode?: ToolControlMode;
  /** Runtime-enforced confirmation for app writes, independent of a role package. */
  requiresConfirmation?: boolean;
  /** Bind these argument fields to the complete JSON proposal, including nested keys. */
  confirmationPayloadKeys?: string[];
}

/**
 * 工具调用请求
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON字符串
  };
}

/**
 * 工具调用结果
 */
export interface ToolResult {
  tool_call_id: string;
  role: 'tool';
  name: string;
  content: string | import('./index').ContentBlock[];
  /** Canonical structured terminal state for this tool call. */
  status?: ToolResultStatus;
  /** Canonical snake_case error code used by evidence logs and eval gates. */
  error_code?: string;
  /** Human-readable reason when status is blocked. */
  blocked_reason?: string;
  duration_ms?: number;
  retry_count?: number;
  retry_budget?: number;
  retry_budget_exhausted?: boolean;
  artifact_manifest?: ArtifactManifestItem[];
  delivery_evidence?: DeliveryEvidence[];
  external_delivery_receipts?: ExternalDeliveryReceipt[];
  /** Backward-compatible boolean success marker. Prefer status for new code. */
  ok?: boolean;
  /** Backward-compatible camelCase error code. Prefer error_code for new code. */
  errorCode?: string;
  retryable?: boolean;
  controlSignal?: ToolControlMode;
  newMessages?: import('./index').Message[];
}

export type ToolSurface = 'cli' | 'feishu' | 'weixin' | 'pet' | 'agent' | 'research' | 'unknown';
export type ToolPermissionProfile = 'strict' | 'default' | 'relaxed';

/**
 * 平台通道回调（通过 ToolExecutionContext 传递给工具，替代 bind/unbind 模式）
 * 飞书、微信等平台共用此接口，chatId 对应各平台的会话标识。
 */
export interface ChannelCallbacks {
  /** 当前会话的 chatId（飞书 chatId / 微信会话 ID） */
  chatId: string;
  /** 发送文本消息 */
  reply: (chatId: string, text: string) => Promise<ChannelDeliveryReceipt | void>;
  /** 发送文件 */
  sendFile: (chatId: string, filePath: string, fileName: string) => Promise<ChannelDeliveryReceipt | void>;
}

/** @deprecated Use ChannelCallbacks instead */
export type FeishuChannelCallbacks = ChannelCallbacks;

export interface SubAgentServiceFactoryInput {
  roleName?: string;
  skillName?: string;
  allowSkillSelection?: boolean;
  workingDirectory: string;
  parentSessionId?: string;
}

export interface SubAgentServiceFactoryResult {
  aiService: unknown;
  skillManager: unknown;
}

/**
 * 工具执行上下文
 */
export interface ToolExecutionContext {
  workingDirectory: string;
  /** Runtime-owned SDK execution policy; never populated from model arguments. */
  sandboxPolicy?: import('../sandbox/policy').SandboxPolicy;
  conversationHistory: any[];
  sessionId?: string;
  /** Trusted parent session identity injected by the runtime for child agents. */
  parentSessionId?: string;
  surface?: ToolSurface;
  permissionProfile?: ToolPermissionProfile;
  runId?: string;
  /** Trusted tool call identity injected by ToolManager; never a model argument. */
  toolCallId?: string;
  abortSignal?: AbortSignal;
  activeSkillName?: string;
  activeToolsets?: string[];
  roleName?: string;
  /** Parent trace context for tool-owned sub-runs or child processes. */
  observabilityContext?: ObservabilitySpanContext;
  /** 平台通道回调（飞书/微信等聊天会话时由平台层注入） */
  channel?: ChannelCallbacks;
  /** Optional factory used by deterministic eval/runtime harnesses to inject sub-agent services. */
  subAgentServiceFactory?: (
    input: SubAgentServiceFactoryInput
  ) => Promise<SubAgentServiceFactoryResult> | SubAgentServiceFactoryResult;
}

/**
 * 工具接口
 */
export interface Tool {
  definition: ToolDefinition;
  execute(args: any, context: ToolExecutionContext): Promise<string | ContentBlock[] | ToolExecutionOutput>;
  /** Trusted runtime availability; execution must still enforce the same authorization. */
  isAvailable?(context: Partial<ToolExecutionContext>): boolean;
  /**
   * Optional tool-owned artifact evidence. Prefer this over ToolManager output
   * inference when the tool knows exactly which artifacts it created/updated.
   */
  getArtifactManifest?(
    args: any,
    result: string | ContentBlock[] | ToolExecutionOutput,
    context: ToolExecutionContext
  ): ArtifactManifestItem[];
}

/**
 * 工具执行器接口 — ConversationRunner 依赖此抽象
 * ToolManager 和 AgentToolExecutor 均实现此接口
 */
export interface ToolExecutor {
  getToolDefinitions(contextOverrides?: Partial<ToolExecutionContext>): ToolDefinition[];
  executeTool(
    toolCall: ToolCall,
    conversationHistory?: any[],
    contextOverrides?: Partial<ToolExecutionContext>
  ): Promise<ToolResult>;
}
