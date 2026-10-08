import { SANDBOX_FILE_TOOLS, executeFileToolInSandbox } from '../sandbox/tool-execution';
import * as crypto from 'crypto';
import * as path from 'path';
import { isDeepStrictEqual } from 'node:util';
import {
  ArtifactManifestItem,
  DeliveryEvidence,
  ExternalDeliveryReceipt,
  Tool,
  ToolDefinition,
  ToolCall,
  ToolExecutionOutput,
  ToolResult,
  ToolExecutionContext,
  ToolExecutor,
  ToolResultStatus,
} from '../types/tool';
import { Logger } from '../utils/logger';
import { ScheduleReminderTool } from './schedule-reminder-tool';
import { AgentConnectorService } from '../connectors/service';
import { createConnectorTools } from './connector-tools';
import { ReadTool } from './read-tool';
import { WriteTool } from './write-tool';
import { ShellTool } from './bash-tool';
import { EditTool } from './edit-tool';
import { GlobTool } from './glob-tool';
import { GrepTool } from './grep-tool';
import { SkillTool } from './skill-tool';
import { SendFileTool } from './send-file-tool';
import { SendTextTool } from './send-text-tool';
import { SpawnSubagentTool } from './spawn-subagent-tool';
import { CheckSubagentTool } from './check-subagent-tool';
import { StopSubagentTool } from './stop-subagent-tool';
import { ResumeSubagentTool } from './resume-subagent-tool';
import { AskParentTool } from './ask-parent-tool';
import { buildCanonicalToolResult, normalizeToolExecutionOutputFacts } from './tool-result';
import { RoleResolver } from '../utils/role-resolver';
import { RoleConfig, RoleToolVisibilityConfig } from '../types/role';

/**
 * 工具名别名映射（Claude Code 工具名 → XiaoBa 内部注册名）
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  Bash: 'execute_shell',
  bash: 'execute_shell',
  Shell: 'execute_shell',
  execute_bash: 'execute_shell',
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
};

export type ToolLayer = 'base' | 'role' | 'surface';

export interface ToolManagerOptions {
  inheritBaseTools?: boolean;
  baseToolAllowlist?: string[];
  baseToolDenylist?: string[];
  /** Explicit resolved role policy for isolated runtimes such as Arena overlays. */
  roleConfig?: RoleConfig;
}

const CHANNEL_SURFACES = new Set(['feishu', 'weixin', 'pet', 'dashboard']);
const DEFAULT_TOOL_VISIBILITY_MODE = 'all';
const CONFIRMATION_PAYLOAD_MISMATCH = 'TOOL_CONFIRMATION_PAYLOAD_MISMATCH';
const CONFIRMATION_NEGATION_PATTERN = /(^|\b)(no|not|never|cancel|stop|reject|denied|deny|don't|do not|dont|hold off|wait)(\b|$)|(?:不确认|不可以|不同意|不要|不用|别|先别|暂时别|取消|撤回|停止|拒绝)/i;
const CONFIRMATION_AFFIRMATIVE_PATTERN = /(^|\b)(confirm|confirmed|approve|approved|yes|ok|okay|go ahead|do it|looks good|ship it|send it|delete it|create it|update it)(\b|$)|(?:确认|可以|同意|批准|照做|就这样|没问题|按这个|按这样|发吧|发送吧|删吧|删除吧|创建吧|更新吧|执行吧)/i;
const CONFIRMATION_BINDING_SKIP_KEYS = new Set([
  'confirmed',
  'notify',
  'need_notification',
  'stop_on_error',
  'doc_format',
  'type',
  'format',
  'command',
  'action',
  'recipient_type',
]);

export interface ToolVisibilityInfo {
  roleName?: string;
  activeSkillName?: string;
  mode: 'all' | 'skill_scoped';
  visibleTools: string[];
  hiddenToolCount: number;
  gatedToolCount: number;
}

interface ImmediateConfirmationEvidence {
  confirmed: boolean;
  reason?: string;
  userText: string;
  proposalText: string;
}

function resolveToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] ?? name;
}

function normalizeRoleName(roleName?: string): string {
  return (roleName || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
}

function isRateLimitLikeMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('rate limit')
    || lower.includes('too many requests')
    || lower.includes('频率受限')
    || lower.includes('限流')
    || /(status(?:\s*code)?|http(?:\s*status)?|错误码|code)\s*[:=]?\s*429\b/i.test(message)
    || /\b429\b.{0,24}(too many requests|rate limit|频率受限|限流)/i.test(message)
    || /(too many requests|rate limit|频率受限|限流).{0,24}\b429\b/i.test(message);
}

/**
 * 工具管理器 - 管理所有可用的工具
 */
export class ToolManager implements ToolExecutor {
  private tools: Map<string, Tool> = new Map();
  private workingDirectory: string;
  private contextDefaults: Partial<ToolExecutionContext>;
  private extraTools: Tool[];
  private toolLayers: Map<string, ToolLayer> = new Map();
  private options: ToolManagerOptions;

  getWorkingDirectory(): string {
    return this.workingDirectory;
  }

  constructor(
    workingDirectory: string = process.cwd(),
    contextDefaults: Partial<ToolExecutionContext> = {},
    extraTools: Tool[] = [],
    options: ToolManagerOptions = {},
  ) {
    this.workingDirectory = workingDirectory;
    this.contextDefaults = contextDefaults;
    this.extraTools = extraTools;
    this.options = options;
    this.registerDefaultTools();
  }

  private registerDefaultTools(): void {
    // 基础文件工具 (6)
    this.registerBaseTool(new ReadTool());
    this.registerBaseTool(new WriteTool());
    this.registerBaseTool(new EditTool());
    this.registerBaseTool(new GlobTool());
    this.registerBaseTool(new GrepTool());
    this.registerBaseTool(new ShellTool());

    // Surface delivery tools: only visible/executable on channel-backed surfaces.
    this.registerSurfaceTool(new SendTextTool());
    this.registerSurfaceTool(new SendFileTool());

    // 元工具
    this.registerBaseTool(new SpawnSubagentTool());
    this.registerBaseTool(new ScheduleReminderTool());
    for (const tool of createConnectorTools(new AgentConnectorService(this.workingDirectory))) this.registerBaseTool(tool);

    // Sub-Agent 管理 (2)
    this.registerBaseTool(new CheckSubagentTool());
    this.registerBaseTool(new StopSubagentTool());
    this.registerBaseTool(new ResumeSubagentTool());
    this.registerBaseTool(new AskParentTool());

    // Skill 调用 (1)
    this.registerBaseTool(new SkillTool());

    // 额外工具由组合层注入，基础 runtime 不直接依赖 role registry。
    for (const tool of this.extraTools) {
      this.registerTool(tool, 'role');
    }
  }

  private registerBaseTool(tool: Tool): void {
    this.registerTool(tool, 'base');
  }

  private registerSurfaceTool(tool: Tool): void {
    this.registerTool(tool, 'surface');
  }

  registerTool(tool: Tool, layer: ToolLayer = 'role'): void {
    this.tools.set(tool.definition.name, tool);
    this.toolLayers.set(tool.definition.name, layer);
  }

  setContextDefaults(contextDefaults: Partial<ToolExecutionContext>): void {
    this.contextDefaults = {
      ...this.contextDefaults,
      ...contextDefaults,
    };
  }

  /**
   * 获取当前上下文可见的工具定义。
   */
  getToolDefinitions(contextOverrides?: Partial<ToolExecutionContext>): ToolDefinition[] {
    const context = this.resolveVisibilityContext(contextOverrides);
    return this.resolveVisibleDefinitions(context)
      .map(tool => tool.definition);
  }

  getToolVisibilityInfo(contextOverrides?: Partial<ToolExecutionContext>): ToolVisibilityInfo {
    const context = this.resolveVisibilityContext(contextOverrides);
    const visibleTools = this.resolveVisibleDefinitions(context).map(tool => tool.definition.name);
    const policy = this.resolveToolVisibilityPolicy(context.roleName);
    const gatedToolCount = Array.from(this.tools.keys())
      .filter(toolName => this.isConfirmedToolGated(toolName, context))
      .length;
    return {
      ...(context.roleName && { roleName: context.roleName }),
      ...(context.activeSkillName && { activeSkillName: context.activeSkillName }),
      mode: policy.mode,
      visibleTools,
      hiddenToolCount: Math.max(0, this.tools.size - visibleTools.length),
      gatedToolCount,
    };
  }

  private resolveVisibleDefinitions(context: Partial<ToolExecutionContext>): Tool[] {
    return Array.from(this.tools.values())
      .filter(tool => this.isToolVisible(tool.definition.name, context));
  }

  /**
   * 执行工具调用
   */
  async executeTool(
    toolCall: ToolCall,
    conversationHistory?: any[],
    contextOverrides?: Partial<ToolExecutionContext>,
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    const requestedName = toolCall.function.name;
    const toolName = resolveToolName(toolCall.function.name);
    const tool = this.tools.get(toolName);

    if (!tool) {
      return this.buildToolResult({
        tool_call_id: toolCall.id,
        name: toolName,
        content: `错误：未找到工具 "${toolName}"`,
        status: 'failure',
        errorCode: 'TOOL_NOT_FOUND',
        retryable: false,
        durationMs: Date.now() - startedAt,
      });
    }

    const executionContext = this.resolveVisibilityContext({
      ...contextOverrides,
      conversationHistory: conversationHistory || contextOverrides?.conversationHistory || [],
    });
    if (!this.isToolVisible(toolName, executionContext)) {
      const errorCode = this.resolveForbiddenErrorCode(toolName, executionContext);
      return this.buildToolResult({
        tool_call_id: toolCall.id,
        name: toolName,
        content: this.buildForbiddenMessage(toolName, executionContext),
        status: 'blocked',
        errorCode,
        blockedReason: this.buildForbiddenMessage(toolName, executionContext),
        retryable: false,
        durationMs: Date.now() - startedAt,
        deliveryEvidence: this.buildDeliveryEvidence(toolName, undefined, executionContext, 'blocked', errorCode),
      });
    }

    let context: ToolExecutionContext | undefined;
    let args: unknown;

    try {
      context = {
        workingDirectory: this.workingDirectory,
        conversationHistory: conversationHistory || [],
        ...this.contextDefaults,
        ...contextOverrides,
        toolCallId: toolCall.id,
      };

      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch (error: any) {
        return this.buildToolResult({
          tool_call_id: toolCall.id,
          name: requestedName,
          content: `工具参数解析错误: ${error.message}`,
          status: 'failure',
          errorCode: 'INVALID_TOOL_ARGUMENTS',
          retryable: false,
          durationMs: Date.now() - startedAt,
        });
      }

      const confirmationDecision = this.validateConfirmedToolExecution(toolName, args, context);
      if (!confirmationDecision.allowed) {
        return this.buildToolResult({
          tool_call_id: toolCall.id,
          name: requestedName,
          content: confirmationDecision.reason || `执行被阻止: 工具 "${toolName}" 缺少与本次操作匹配的确认`,
          status: 'blocked',
          errorCode: confirmationDecision.errorCode || CONFIRMATION_PAYLOAD_MISMATCH,
          blockedReason: confirmationDecision.reason,
          retryable: false,
          durationMs: Date.now() - startedAt,
        });
      }

      const output = SANDBOX_FILE_TOOLS.has(toolName) && process.env.XIAOBA_SANDBOXED !== '1'
        ? await executeFileToolInSandbox(toolName, args, context)
        : await tool.execute(args, context);
      let content: any;
      let newMessages: any[] | undefined;
      let explicitDeliveryEvidence: DeliveryEvidence[] = [];
      let externalDeliveryReceipts: ExternalDeliveryReceipt[] = [];

      // 处理特殊返回格式（如图片需要额外消息）
      if (this.isToolExecutionOutput(output)) {
        content = output.toolContent;
        newMessages = output.newMessages;
        explicitDeliveryEvidence = this.normalizeDeliveryEvidence(output.delivery_evidence);
        externalDeliveryReceipts = this.normalizeExternalDeliveryReceipts(output.external_delivery_receipts);
      } else {
        content = output;
      }

      const structuredFacts = this.isToolExecutionOutput(output)
        ? normalizeToolExecutionOutputFacts(output)
        : {};
      const classification = structuredFacts.status
        ? {
            status: structuredFacts.status,
            errorCode: structuredFacts.errorCode,
            blockedReason: structuredFacts.blockedReason,
            retryable: structuredFacts.retryable ?? false,
          }
        : this.classifyLegacyTextToolOutput(toolName, content);
      const artifactManifest = classification.status === 'success'
        ? this.buildArtifactManifest(tool, toolName, args, content, context)
        : [];
      const deliveryEvidence = this.buildDeliveryEvidence(
        toolName,
        args,
        context,
        classification.status,
        classification.errorCode,
      );
      const finalDeliveryEvidence = explicitDeliveryEvidence.length > 0
        ? explicitDeliveryEvidence
        : deliveryEvidence;

      return this.buildToolResult({
        tool_call_id: toolCall.id,
        name: requestedName,
        content,
        status: classification.status,
        errorCode: classification.errorCode,
        blockedReason: classification.blockedReason,
        retryable: classification.retryable,
        retryCount: structuredFacts.retryCount,
        retryBudget: structuredFacts.retryBudget,
        retryBudgetExhausted: structuredFacts.retryBudgetExhausted,
        durationMs: Date.now() - startedAt,
        artifactManifest,
        deliveryEvidence: finalDeliveryEvidence,
        externalDeliveryReceipts,
        controlSignal: tool.definition.controlMode,
        newMessages,
      });
    } catch (error: any) {
      const message = String(error?.message || error || '');
      const isRateLimit = isRateLimitLikeMessage(message);
      const content = `工具执行错误: ${message}`;
      const classification = this.classifyLegacyTextToolOutput(toolName, content);
      const errorCode = isRateLimit ? 'RATE_LIMIT' : classification.errorCode ?? 'TOOL_EXECUTION_ERROR';
      return this.buildToolResult({
        tool_call_id: toolCall.id,
        name: requestedName,
        content,
        status: classification.status === 'success' ? 'failure' : classification.status,
        errorCode,
        retryable: isRateLimit || classification.retryable === true,
        durationMs: Date.now() - startedAt,
        deliveryEvidence: this.buildDeliveryEvidence(toolName, args, context, 'failure', errorCode),
      });
    }
  }

  private buildToolResult(params: {
    tool_call_id: string;
    name: string;
    content: any;
    status: ToolResultStatus;
    errorCode?: string;
    blockedReason?: string;
    retryable?: boolean;
    retryCount?: number;
    retryBudget?: number;
    retryBudgetExhausted?: boolean;
    durationMs: number;
    artifactManifest?: ArtifactManifestItem[];
    deliveryEvidence?: DeliveryEvidence[];
    externalDeliveryReceipts?: ExternalDeliveryReceipt[];
    controlSignal?: ToolDefinition['controlMode'];
    newMessages?: any[];
  }): ToolResult {
    return buildCanonicalToolResult({
      tool_call_id: params.tool_call_id,
      name: params.name,
      content: params.content,
      status: params.status,
      errorCode: params.errorCode,
      blockedReason: params.blockedReason,
      retryable: params.retryable,
      retryCount: params.retryCount,
      retryBudget: params.retryBudget,
      retryBudgetExhausted: params.retryBudgetExhausted,
      durationMs: params.durationMs,
      artifactManifest: params.artifactManifest,
      deliveryEvidence: params.deliveryEvidence,
      externalDeliveryReceipts: params.externalDeliveryReceipts,
      controlSignal: params.controlSignal,
      newMessages: params.newMessages,
    });
  }

  private isToolExecutionOutput(value: unknown): value is ToolExecutionOutput {
    return Boolean(
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && 'toolContent' in value
    );
  }

  private normalizeDeliveryEvidence(value: unknown): DeliveryEvidence[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const deliveryType = typeof record.delivery_type === 'string' ? record.delivery_type : '';
      const status = typeof record.status === 'string' ? record.status : '';
      const timestamp = typeof record.timestamp === 'string' ? record.timestamp : '';
      if ((deliveryType !== 'text' && deliveryType !== 'file') || !status || !timestamp) return [];
      return [{
        ...(typeof record.delivery_id === 'string' && { delivery_id: record.delivery_id }),
        ...(typeof record.surface === 'string' && { surface: record.surface as DeliveryEvidence['surface'] }),
        ...(typeof record.channel_id === 'string' && { channel_id: record.channel_id }),
        delivery_type: deliveryType as DeliveryEvidence['delivery_type'],
        status: status as DeliveryEvidence['status'],
        timestamp,
        ...(typeof record.text_preview === 'string' && { text_preview: record.text_preview }),
        ...(typeof record.file_name === 'string' && { file_name: record.file_name }),
        ...(typeof record.file_path === 'string' && { file_path: record.file_path }),
        ...(typeof record.error_code === 'string' && { error_code: record.error_code }),
      }];
    });
  }

  private normalizeExternalDeliveryReceipts(value: unknown): ExternalDeliveryReceipt[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const receiptType = typeof record.receipt_type === 'string' ? record.receipt_type : '';
      const status = typeof record.status === 'string' ? record.status : '';
      const timestamp = typeof record.timestamp === 'string' ? record.timestamp : '';
      if (!receiptType || !status || !timestamp) return [];
      return [{
        ...(typeof record.receipt_id === 'string' && { receipt_id: record.receipt_id }),
        receipt_type: receiptType as ExternalDeliveryReceipt['receipt_type'],
        ...(typeof record.surface === 'string' && { surface: record.surface as ExternalDeliveryReceipt['surface'] }),
        status: status as ExternalDeliveryReceipt['status'],
        timestamp,
        ...(typeof record.platform_message_id === 'string' && { platform_message_id: record.platform_message_id }),
        ...(typeof record.platform_file_key === 'string' && { platform_file_key: record.platform_file_key }),
        ...(typeof record.delivery_id === 'string' && { delivery_id: record.delivery_id }),
        ...(typeof record.file_name === 'string' && { file_name: record.file_name }),
        ...(typeof record.artifact_path === 'string' && { artifact_path: record.artifact_path }),
        ...(Array.isArray(record.evidence_refs) && { evidence_refs: record.evidence_refs.map(valueItem => String(valueItem || '')).filter(Boolean) }),
        ...(typeof record.error_code === 'string' && { error_code: record.error_code }),
        ...(record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
          ? { metadata: record.metadata as Record<string, unknown> }
          : {}),
      }];
    });
  }

  private classifyLegacyTextToolOutput(
    toolName: string,
    content: unknown,
  ): {
    status: ToolResultStatus;
    errorCode?: string;
    blockedReason?: string;
    retryable?: boolean;
  } {
    const text = this.contentToString(content).trim();
    if (!text) {
      return { status: 'success', retryable: false };
    }

    const isRateLimit = isRateLimitLikeMessage(text);
    if (isRateLimit && this.hasExplicitFailurePrefix(toolName, text)) {
      return { status: 'failure', errorCode: 'RATE_LIMIT', retryable: true };
    }

    if (this.hasExplicitBlockedPrefix(toolName, text)) {
      return {
        status: 'blocked',
        errorCode: this.inferBlockedErrorCode(text),
        blockedReason: text.slice(0, 500),
        retryable: false,
      };
    }

    if (this.hasExplicitTimeoutPrefix(toolName, text)) {
      return { status: 'timeout', errorCode: 'TOOL_TIMEOUT', retryable: true };
    }

    if (this.hasExplicitFailurePrefix(toolName, text)) {
      return {
        status: 'failure',
        errorCode: this.inferFailureErrorCode(toolName, text),
        retryable: false,
      };
    }

    return { status: 'success', retryable: false };
  }

  private hasExplicitBlockedPrefix(toolName: string, text: string): boolean {
    if (/^执行被阻止:/i.test(text)) return true;
    if (/^错误：工具 ".+" 不允许/.test(text)) return true;
    if (/^错误：工具 ".+" 只允许/.test(text)) return true;
    if (toolName === 'execute_shell' && /^命令执行失败:/i.test(text) && /permission denied|denied|blocked/i.test(text)) return true;
    return false;
  }

  private hasExplicitTimeoutPrefix(toolName: string, text: string): boolean {
    if (toolName === 'execute_shell' && /^命令执行失败:/i.test(text) && /timeout|timed out|超时/i.test(text)) return true;
    return /^(工具执行错误|文件发送失败|写入文件失败|编辑文件失败):/i.test(text) && /timeout|timed out|超时/i.test(text);
  }

  private hasExplicitFailurePrefix(toolName: string, text: string): boolean {
    if (/^(工具执行错误|工具参数解析错误|文件发送失败|写入文件失败|编辑文件失败):/i.test(text)) return true;
    if (toolName === 'execute_shell' && /^命令执行失败:/i.test(text)) return true;
    if (toolName === 'edit_file' && /^错误：/.test(text)) return true;
    if (toolName === 'read_file' && /^错误：/.test(text)) return true;
    if (toolName === 'send_file' && /^(当前不在聊天会话中|文件路径不能为空|文件名不能为空)/.test(text)) return true;
    if ((toolName === 'glob' || toolName === 'grep') && /^{"error":/.test(text)) return true;
    return false;
  }

  private inferBlockedErrorCode(text: string): string {
    if (/path|路径|workspace|目录/i.test(text)) return 'PATH_DENIED';
    return 'TOOL_BLOCKED';
  }

  private inferFailureErrorCode(toolName: string, text: string): string {
    if (isRateLimitLikeMessage(text)) return 'RATE_LIMIT';
    if (/timeout|timed out|超时/i.test(text)) return 'TOOL_TIMEOUT';
    if (/文件不存在|not found/i.test(text)) return toolName === 'read_file' || toolName === 'edit_file'
      ? 'FILE_NOT_FOUND'
      : 'TOOL_NOT_FOUND';
    if (toolName === 'edit_file' && /未找到要替换的字符串|找到 \d+ 个匹配项/.test(text)) return 'EDIT_TARGET_NOT_FOUND';
    if (toolName === 'send_file') return 'DELIVERY_FAILED';
    if (toolName === 'execute_shell') return 'COMMAND_FAILED';
    return 'TOOL_EXECUTION_ERROR';
  }

  private buildArtifactManifest(
    tool: Tool,
    toolName: string,
    args: unknown,
    content: unknown,
    context: ToolExecutionContext,
  ): ArtifactManifestItem[] {
    const explicit = this.buildToolOwnedArtifactManifest(tool, args, content, context);
    if (explicit.length > 0) {
      return explicit;
    }

    const record = this.asRecord(args);
    const filePath = typeof record.file_path === 'string' ? record.file_path.trim() : '';

    if (filePath && toolName === 'write_file') {
      const text = this.contentToString(content);
      return [{
        path: filePath,
        type: this.artifactType(filePath),
        action: /成功创建文件/.test(text) ? 'created' : 'updated',
      }];
    }

    if (filePath && toolName === 'edit_file') {
      return [{
        path: filePath,
        type: this.artifactType(filePath),
        action: 'updated',
      }];
    }

    if (filePath && toolName === 'send_file') {
      return [{
        path: filePath,
        type: this.artifactType(filePath),
        action: 'sent',
      }];
    }

    return this.buildRoleArtifactManifest(toolName, content);
  }

  private buildToolOwnedArtifactManifest(
    tool: Tool,
    args: unknown,
    content: unknown,
    context: ToolExecutionContext,
  ): ArtifactManifestItem[] {
    if (typeof tool.getArtifactManifest !== 'function') {
      return [];
    }
    try {
      return this.normalizeArtifactManifest(
        tool.getArtifactManifest(args, content as string | any[], context),
        'tool_owned',
      );
    } catch (err: any) {
      Logger.warning(`[${tool.definition.name}] tool-owned artifact manifest failed: ${err.message}`);
      return [];
    }
  }

  private normalizeArtifactManifest(
    items: unknown,
    source: string,
  ): ArtifactManifestItem[] {
    if (!Array.isArray(items)) {
      return [];
    }
    const seen = new Set<string>();
    const manifest: ArtifactManifestItem[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const pathValue = typeof record.path === 'string' ? this.normalizeArtifactCandidate(record.path) : '';
      if (!pathValue || !this.looksLikeArtifactPath(pathValue)) continue;
      const action = this.isArtifactAction(record.action) ? record.action : 'captured';
      const type = typeof record.type === 'string' && record.type.trim()
        ? record.type.trim()
        : this.artifactType(pathValue);
      const key = `${pathValue.replace(/\\/g, '/')}::${action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      manifest.push({
        path: pathValue,
        type,
        action,
        metadata: {
          ...(record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
            ? record.metadata as Record<string, unknown>
            : {}),
          source,
        },
      });
      if (manifest.length >= 50) {
        break;
      }
    }
    return manifest;
  }

  private isArtifactAction(value: unknown): value is ArtifactManifestItem['action'] {
    return value === 'created'
      || value === 'updated'
      || value === 'sent'
      || value === 'generated'
      || value === 'captured';
  }

  private buildRoleArtifactManifest(
    toolName: string,
    content: unknown,
  ): ArtifactManifestItem[] {
    if (!this.shouldInferRoleArtifactManifest(toolName)) {
      return [];
    }

    const candidates = [
      ...this.extractArtifactPathsFromStructuredContent(content),
      ...this.extractArtifactPathsFromText(this.contentToManifestText(content)),
    ];
    const seen = new Set<string>();
    const manifest: ArtifactManifestItem[] = [];
    for (const candidate of candidates) {
      const normalized = this.normalizeArtifactCandidate(candidate);
      if (!normalized) continue;
      const key = normalized.replace(/\\/g, '/');
      if (seen.has(key)) continue;
      seen.add(key);
      manifest.push({
        path: normalized,
        type: this.artifactType(normalized),
        action: 'captured',
        metadata: {
          inferred: true,
          source: 'tool_output',
        },
      });
      if (manifest.length >= 20) {
        break;
      }
    }
    return manifest;
  }

  private shouldInferRoleArtifactManifest(toolName: string): boolean {
    if (this.toolLayers.get(toolName) === 'role') {
      return true;
    }
    return /^(engineer_|research_|reviewer_|inspector_|auto_research_|case_|surface_)/.test(toolName);
  }

  private extractArtifactPathsFromStructuredContent(content: unknown): string[] {
    const text = this.contentToManifestText(content).trim();
    if (!text || (!text.startsWith('{') && !text.startsWith('['))) {
      return [];
    }
    try {
      return this.collectArtifactPathsFromValue(JSON.parse(text));
    } catch {
      return [];
    }
  }

  private collectArtifactPathsFromValue(value: unknown, keyHint: string = '', depth: number = 0): string[] {
    if (depth > 8) {
      return [];
    }
    if (typeof value === 'string') {
      return this.isArtifactKey(keyHint) && this.looksLikeArtifactPath(value) ? [value] : [];
    }
    if (Array.isArray(value)) {
      return value.flatMap(item => this.collectArtifactPathsFromValue(item, keyHint, depth + 1));
    }
    if (!value || typeof value !== 'object') {
      return [];
    }
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const nextHint = this.isArtifactKey(key) ? key : keyHint;
      return this.collectArtifactPathsFromValue(child, nextHint, depth + 1);
    });
  }

  private extractArtifactPathsFromText(text: string): string[] {
    const candidates: string[] = [];
    const quotedKeyValue = /["']?([A-Za-z][A-Za-z0-9_-]*)["']?\s*:\s*["']([^"'\r\n]+)["']/g;
    const plainKeyValue = /\b([A-Za-z][A-Za-z0-9_-]*)\s*=\s*([^\s,;]+)/g;

    for (const pattern of [quotedKeyValue, plainKeyValue]) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const key = match[1] || '';
        const value = match[2] || '';
        if (this.isArtifactKey(key) && this.looksLikeArtifactPath(value)) {
          candidates.push(value);
        }
      }
    }
    return candidates;
  }

  private isArtifactKey(key: string): boolean {
    const normalized = key.trim().toLowerCase();
    if (!normalized) return false;
    if (/^(cwd|working_directory|session_id|run_id|task_id|project|status|route)$/.test(normalized)) {
      return false;
    }
    return /(^|_)(artifact|artifacts|file|path|plan|validation|final_summary|summary|report|scorecard|manifest|handoff|aggregate|board|output|log)(_|$)/.test(normalized)
      || /^(artifact|artifacts|file|path|plan|validation|final_summary|summary|report|scorecard|manifest|handoff|aggregate|board)$/.test(normalized);
  }

  private looksLikeArtifactPath(value: string): boolean {
    const normalized = this.normalizeArtifactCandidate(value);
    if (!normalized) return false;
    if (/^(https?|data|mailto):/i.test(normalized)) return false;
    if (/[\r\n]/.test(normalized)) return false;
    if (/^(true|false|null|undefined|running|queued|completed|failed|blocked|cancelled|unknown)$/i.test(normalized)) {
      return false;
    }

    const slashNormalized = normalized.replace(/\\/g, '/');
    const basename = path.basename(slashNormalized);
    if (!basename || basename === '.' || basename === '..') {
      return false;
    }
    return slashNormalized.includes('/')
      || /^[A-Za-z]:\//.test(slashNormalized)
      || /\.[A-Za-z0-9]{1,12}$/.test(basename);
  }

  private normalizeArtifactCandidate(value: string): string {
    let normalized = String(value || '').trim();
    normalized = normalized.replace(/^["']|["']$/g, '');
    normalized = normalized.replace(/[)\],;]+$/g, '');
    return normalized;
  }

  private contentToManifestText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return this.contentToString(content);
    if (content && typeof content === 'object') {
      try {
        return JSON.stringify(content);
      } catch {
        return '';
      }
    }
    return '';
  }

  private buildDeliveryEvidence(
    toolName: string,
    args: unknown,
    context: Partial<ToolExecutionContext> | undefined,
    status: ToolResultStatus,
    errorCode?: string,
  ): DeliveryEvidence[] {
    if (toolName !== 'send_text' && toolName !== 'send_file') {
      return [];
    }

    const record = this.asRecord(args);
    const deliveryStatus: DeliveryEvidence['status'] = status === 'success'
      ? 'delivered'
      : status === 'blocked'
        ? 'blocked'
        : 'failed';
    const base = {
      surface: context?.surface,
      channel_id: context?.channel?.chatId ? this.hashIdentifier(context.channel.chatId) : undefined,
      status: deliveryStatus,
      timestamp: new Date().toISOString(),
      ...(errorCode && { error_code: errorCode }),
    };

    if (toolName === 'send_text') {
      const text = typeof record.text === 'string' ? record.text.trim() : '';
      return [{
        ...base,
        delivery_type: 'text',
        ...(text && { text_preview: this.truncate(text, 200) }),
      }];
    }

    const filePath = typeof record.file_path === 'string' ? record.file_path.trim() : '';
    const fileName = typeof record.file_name === 'string' ? record.file_name.trim() : '';
    return [{
      ...base,
      delivery_type: 'file',
      ...(filePath && { file_path: filePath }),
      ...(fileName && { file_name: fileName }),
    }];
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private contentToString(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) {
      if (content && typeof content === 'object' && '_imageForNewMessage' in content) {
        const image = content as { filePath?: unknown };
        return `已读取图片: ${typeof image.filePath === 'string' ? image.filePath : 'unknown'}`;
      }
      return '';
    }
    return content
      .map(block => block.type === 'text' ? block.text : '[非文本内容]')
      .join('');
  }

  private artifactType(filePath: string): string {
    const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
    return ext || 'file';
  }

  private hashIdentifier(value: string): string {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
  }

  private truncate(text: string, maxLength: number): string {
    return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
  }

  getToolCount(): number {
    return this.tools.size;
  }

  getTool<T extends Tool = Tool>(name: string): T | undefined {
    const toolName = resolveToolName(name);
    return this.isToolVisible(toolName, this.resolveVisibilityContext())
      ? this.tools.get(toolName) as T | undefined
      : undefined;
  }

  getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  private resolveVisibilityContext(contextOverrides: Partial<ToolExecutionContext> = {}): Partial<ToolExecutionContext> {
    return {
      ...this.contextDefaults,
      ...contextOverrides,
    };
  }

  private isToolVisible(toolName: string, context: Partial<ToolExecutionContext>): boolean {
    return this.isLayerToolVisible(toolName, context)
      && this.isScopedToolVisible(toolName, context)
      && this.tools.get(toolName)?.isAvailable?.(context) !== false
      && !this.isConfirmedToolGated(toolName, context);
  }

  private isLayerToolVisible(toolName: string, context: Partial<ToolExecutionContext>): boolean {
    const resolvedName = resolveToolName(toolName);
    const layer = this.toolLayers.get(resolvedName);
    if (!layer) {
      return false;
    }

    if (layer === 'role') {
      return true;
    }

    if (layer === 'surface') {
      return this.isSurfaceToolVisible(context);
    }

    return this.isBaseToolVisible(resolvedName, context);
  }

  private isScopedToolVisible(toolName: string, context: Partial<ToolExecutionContext>): boolean {
    const resolvedName = resolveToolName(toolName);
    const policy = this.resolveToolVisibilityPolicy(context.roleName);
    if (policy.mode !== 'skill_scoped') {
      return true;
    }

    return this.resolveScopedToolNames(policy, context.activeSkillName, context.activeToolsets).has(resolvedName);
  }

  private resolveScopedToolNames(
    policy: ResolvedToolVisibilityPolicy,
    activeSkillName?: string,
    activeToolsets?: string[],
  ): Set<string> {
    const toolNames = new Set(policy.defaultTools);
    const toolsets = this.resolveActiveToolsets(policy, activeSkillName, activeToolsets);
    for (const toolsetName of toolsets) {
      for (const toolName of policy.skillToolsets[toolsetName] || []) {
        toolNames.add(toolName);
      }
    }
    return toolNames;
  }

  private resolveActiveToolsets(
    policy: ResolvedToolVisibilityPolicy,
    activeSkillName?: string,
    activeToolsets?: string[],
  ): string[] {
    const skillName = this.normalizePolicyKey(activeSkillName);
    const requested = Array.isArray(activeToolsets)
      ? activeToolsets.map(value => this.normalizePolicyKey(value)).filter(Boolean)
      : [];
    if (!skillName) {
      return this.unique(requested);
    }
    const explicit = policy.skillToolsets[skillName] ? [skillName] : [];
    const aliases = policy.skillToolsetAliases[skillName] || [];
    return this.unique([...requested, ...explicit, ...aliases]);
  }

  private isConfirmedToolGated(toolName: string, context: Partial<ToolExecutionContext>): boolean {
    if (!this.isConfirmedToolConfigured(toolName, context)) {
      return false;
    }
    if (!this.requiresImmediateConfirmation(toolName, context)) {
      return false;
    }
    return !this.resolveImmediateUserConfirmation(context.conversationHistory || []).confirmed;
  }

  private validateConfirmedToolExecution(
    toolName: string,
    args: unknown,
    context: Partial<ToolExecutionContext>,
  ): { allowed: boolean; errorCode?: string; reason?: string } {
    if (!this.isConfirmedToolConfigured(toolName, context) || !this.requiresImmediateConfirmation(toolName, context)) {
      return { allowed: true };
    }

    const confirmation = this.resolveImmediateUserConfirmation(context.conversationHistory || []);
    if (!confirmation.confirmed) {
      return {
        allowed: false,
        errorCode: 'TOOL_CONFIRMATION_REQUIRED',
        reason: confirmation.reason || `执行被阻止: 工具 "${toolName}" 需要上一条用户消息明确确认后才能使用`,
      };
    }

    const keys = this.tools.get(resolveToolName(toolName))?.definition.confirmationPayloadKeys;
    const binding = keys?.length
      ? { allowed: this.matchesCompleteJsonProposal(args, keys, confirmation, context), anchorCount: keys.length }
      : this.hasConfirmationPayloadBinding(args, confirmation);
    if (!binding.allowed) {
      return {
        allowed: false,
        errorCode: CONFIRMATION_PAYLOAD_MISMATCH,
        reason: [
          `执行被阻止: 工具 "${toolName}" 的参数没有和最近确认内容或上一条提案形成可验证匹配`,
          binding.anchorCount > 0 ? `checked_payload_anchors=${binding.anchorCount}` : 'checked_payload_anchors=0',
        ].join('；'),
      };
    }

    return { allowed: true };
  }

  private isConfirmedToolConfigured(toolName: string, context: Partial<ToolExecutionContext>): boolean {
    const resolvedName = resolveToolName(toolName);
    if (this.tools.get(resolvedName)?.definition.requiresConfirmation) return true;
    const gate = this.resolveRoleConfig(context.roleName)?.confirmedToolGate;
    return Boolean(gate?.tools?.map(resolveToolName).includes(resolvedName));
  }

  private requiresImmediateConfirmation(toolName: string, context: Partial<ToolExecutionContext>): boolean {
    if (this.tools.get(resolveToolName(toolName))?.definition.requiresConfirmation) return true;
    if (!this.isConfirmedToolConfigured(toolName, context)) {
      return false;
    }
    return this.resolveRoleConfig(context.roleName)?.confirmedToolGate?.requireImmediateUserConfirmation !== false;
  }

  private resolveImmediateUserConfirmation(conversationHistory: unknown): ImmediateConfirmationEvidence {
    if (!Array.isArray(conversationHistory)) {
      return { confirmed: false, reason: 'conversation history is not available', userText: '', proposalText: '' };
    }

    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      const message = conversationHistory[i] as { role?: unknown; content?: unknown; __injected?: boolean };
      if (message?.role !== 'user') {
        continue;
      }
      const text = this.contentToString(message.content).trim();
      if (message.__injected || text.startsWith('[scheduled_wakeup]')) {
        return { confirmed: false, reason: 'internal context is not a user confirmation', userText: '', proposalText: '' };
      }
      if (!text) {
        return { confirmed: false, reason: 'latest user confirmation turn is empty', userText: '', proposalText: '' };
      }
      const proposalText = this.findPreviousAssistantText(conversationHistory, i);
      if (CONFIRMATION_NEGATION_PATTERN.test(text)) {
        return {
          confirmed: false,
          reason: 'latest user turn contains a negated or cancelled confirmation',
          userText: text,
          proposalText,
        };
      }
      return {
        confirmed: CONFIRMATION_AFFIRMATIVE_PATTERN.test(text),
        reason: CONFIRMATION_AFFIRMATIVE_PATTERN.test(text)
          ? undefined
          : 'latest user turn does not contain an explicit confirmation marker',
        userText: text,
        proposalText,
      };
    }
    return { confirmed: false, reason: 'no latest user confirmation turn found', userText: '', proposalText: '' };
  }

  private findPreviousAssistantText(conversationHistory: unknown[], latestUserIndex: number): string {
    for (let i = latestUserIndex - 1; i >= 0; i--) {
      const message = conversationHistory[i] as { role?: unknown; content?: unknown };
      if (message?.role === 'assistant') {
        return this.contentToString(message.content).trim();
      }
    }
    return '';
  }

  private hasConfirmationPayloadBinding(
    args: unknown,
    confirmation: ImmediateConfirmationEvidence,
  ): { allowed: boolean; anchorCount: number } {
    const anchors = this.collectConfirmationAnchors(args);
    if (anchors.length === 0) {
      return { allowed: false, anchorCount: 0 };
    }

    const contextText = this.normalizeConfirmationText([
      confirmation.userText,
      confirmation.proposalText,
    ].filter(Boolean).join('\n'));
    const allowed = anchors.some(anchor => contextText.includes(anchor));
    return { allowed, anchorCount: anchors.length };
  }

  private matchesCompleteJsonProposal(args: unknown, keys: string[], confirmation: ImmediateConfirmationEvidence, context: Partial<ToolExecutionContext>): boolean {
    if (!args || typeof args !== 'object') return false;
    const expected = args as Record<string,unknown>;
    const history = context.conversationHistory || [];
    // Scan balanced JSON objects, preserving field structure rather than matching a single string anchor.
    const sources = [confirmation.userText];
    let pastConfirmation = false;
    let confirmationIndex = history.length;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]?.role === 'user') { if (pastConfirmation) break; pastConfirmation = true; confirmationIndex = i; continue; }
      if (pastConfirmation && history[i]?.role === 'assistant') {
        // Channel final text can be hidden. Bind only a successful send_text proposal there.
        if (!CHANNEL_SURFACES.has(context.surface || '')) sources.push(this.contentToString(history[i].content));
        for (const call of [...(history[i].tool_calls || [])].reverse()) {
          if (call.function?.name !== 'send_text') continue;
          const receipt = history.slice(i + 1, confirmationIndex).find((message: any) => message.role === 'tool' && message.name === 'send_text' && message.tool_call_id === call.id);
          if (receipt?.content !== '已发送') continue;
          try { const sent = JSON.parse(call.function.arguments); if (typeof sent.text === 'string') sources.push(sent.text); } catch {}
        }
      }
    }
    for (const source of sources) {
      if (source.length > 256 * 1024) continue;
      let start = -1, depth = 0, quoted = false, escaped = false;
      const proposals: Record<string,unknown>[] = [];
      for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (start < 0) { if (char === '{') { start = i; depth = 1; quoted = false; escaped = false; } continue; }
        if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
        if (char === '"') quoted = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) {
          try {
            const proposal = JSON.parse(source.slice(start,i + 1));
            if (keys.every(key => Object.prototype.hasOwnProperty.call(proposal,key))) proposals.push(proposal);
          } catch {}
          start = -1;
        }
      }
      const latest = proposals[proposals.length - 1];
      if (latest) return keys.every(key => isDeepStrictEqual(latest[key],expected[key]));
    }
    return false;
  }

  private collectConfirmationAnchors(value: unknown, keyHint = '', depth = 0): string[] {
    if (depth > 8) {
      return [];
    }
    if (typeof value === 'string') {
      return this.confirmationAnchorsFromString(value);
    }
    if (Array.isArray(value)) {
      return value.flatMap(item => this.collectConfirmationAnchors(item, keyHint, depth + 1));
    }
    if (!value || typeof value !== 'object') {
      return [];
    }

    return this.unique(Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const normalizedKey = key.trim().toLowerCase();
      if (CONFIRMATION_BINDING_SKIP_KEYS.has(normalizedKey)) {
        return [];
      }
      return this.collectConfirmationAnchors(child, normalizedKey, depth + 1);
    }));
  }

  private confirmationAnchorsFromString(value: string): string[] {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    const structured = this.tryParseConfirmationString(trimmed);
    if (structured !== undefined) {
      return this.collectConfirmationAnchors(structured);
    }

    const candidates = trimmed
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
    if (candidates.length <= 1) {
      candidates.push(trimmed);
    }

    return this.unique(candidates.flatMap(candidate => {
      const normalized = this.normalizeConfirmationText(candidate);
      if (!this.isUsefulConfirmationAnchor(normalized)) {
        return [];
      }
      if (normalized.length <= 160) {
        return [normalized];
      }
      return [
        normalized.slice(0, 120).trim(),
        normalized.slice(-120).trim(),
      ].filter(anchor => this.isUsefulConfirmationAnchor(anchor));
    }));
  }

  private tryParseConfirmationString(value: string): unknown | undefined {
    const first = value[0];
    if (first !== '{' && first !== '[') {
      return undefined;
    }
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  private normalizeConfirmationText(value: string): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  private isUsefulConfirmationAnchor(value: string): boolean {
    if (!value) {
      return false;
    }
    if (/^(true|false|null|undefined|me|user|chat|primary|json|xml|markdown)$/i.test(value)) {
      return false;
    }
    if (/[\u4e00-\u9fff]/.test(value)) {
      return value.length >= 2;
    }
    return value.length >= 4 || /^[a-z]{1,4}[_-][a-z0-9_-]{3,}$/i.test(value);
  }

  private isSurfaceToolVisible(context: Partial<ToolExecutionContext>): boolean {
    const surface = String(context.surface || '').trim().toLowerCase();
    return CHANNEL_SURFACES.has(surface) && Boolean(context.channel);
  }

  private isBaseToolVisible(toolName: string, context: Partial<ToolExecutionContext>): boolean {
    const policy = this.resolveBaseToolPolicy(context.roleName);
    if (policy.inheritBaseTools) {
      return !policy.baseToolDenylist.has(toolName);
    }
    return policy.baseToolAllowlist.has(toolName);
  }

  private resolveBaseToolPolicy(roleName?: string): {
    inheritBaseTools: boolean;
    baseToolAllowlist: Set<string>;
    baseToolDenylist: Set<string>;
  } {
    const roleConfig = this.resolveRoleConfig(roleName);
    const inheritBaseTools = this.options.inheritBaseTools
      ?? roleConfig?.inheritBaseTools
      ?? true;
    const baseToolAllowlist = new Set(
      (this.options.baseToolAllowlist ?? roleConfig?.baseToolAllowlist ?? [])
        .map(resolveToolName),
    );
    const baseToolDenylist = new Set(
      (this.options.baseToolDenylist ?? roleConfig?.baseToolDenylist ?? [])
        .map(resolveToolName),
    );
    return { inheritBaseTools, baseToolAllowlist, baseToolDenylist };
  }

  private resolveToolVisibilityPolicy(roleName?: string): ResolvedToolVisibilityPolicy {
    const roleConfig = this.resolveRoleConfig(roleName);
    const config = roleConfig?.toolVisibility;
    const mode = config?.mode === 'skill_scoped' ? 'skill_scoped' : DEFAULT_TOOL_VISIBILITY_MODE;
    return {
      mode,
      defaultTools: this.normalizeToolList(config?.defaultTools || []),
      skillToolsets: this.normalizeToolsets(config),
      skillToolsetAliases: this.normalizeToolsetAliases(roleConfig?.skillToolsetAliases || {}),
    };
  }

  private normalizeToolsets(config?: RoleToolVisibilityConfig): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    const toolsets = config?.skillToolsets || {};
    for (const [name, tools] of Object.entries(toolsets)) {
      const key = this.normalizePolicyKey(name);
      if (!key) continue;
      result[key] = this.normalizeToolList(Array.isArray(tools) ? tools : []);
    }
    return result;
  }

  private normalizeToolsetAliases(aliases: Record<string, string | string[]>): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [name, target] of Object.entries(aliases)) {
      const key = this.normalizePolicyKey(name);
      if (!key) continue;
      const targets = Array.isArray(target) ? target : [target];
      result[key] = this.unique(targets.map(value => this.normalizePolicyKey(value)).filter(Boolean));
    }
    return result;
  }

  private normalizeToolList(tools: string[]): string[] {
    return this.unique(tools.map(resolveToolName).filter(Boolean));
  }

  private unique(values: string[]): string[] {
    return Array.from(new Set(values));
  }

  private normalizePolicyKey(value?: string): string {
    return String(value || '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .toLowerCase();
  }

  private resolveRoleConfig(roleName?: string): RoleConfig | undefined {
    if (this.options.roleConfig) {
      return this.options.roleConfig;
    }
    const normalizedRole = normalizeRoleName(roleName);
    const resolvedRole = normalizedRole
      ? RoleResolver.resolveRoleDirectoryName(normalizedRole)
      : undefined;
    return resolvedRole ? RoleResolver.getRoleConfig(resolvedRole) : undefined;
  }

  private buildForbiddenMessage(toolName: string, context: Partial<ToolExecutionContext>): string {
    if (this.isConfirmedToolGated(toolName, context)) {
      return `执行被阻止: 工具 "${toolName}" 需要上一条用户消息明确确认后才能使用`;
    }

    const policy = this.resolveToolVisibilityPolicy(context.roleName);
    if (policy.mode === 'skill_scoped' && this.isLayerToolVisible(toolName, context) && !this.isScopedToolVisible(toolName, context)) {
      const activeSkill = context.activeSkillName || 'none';
      return `错误：工具 "${toolName}" 不属于当前 role skill-scoped 可见工具集 (activeSkill=${activeSkill})`;
    }

    const layer = this.toolLayers.get(toolName);
    if (layer === 'surface') {
      const surface = context.surface || 'unknown';
      const channelState = context.channel ? 'present' : 'missing';
      return `错误：工具 "${toolName}" 只允许在带 channel 上下文的 channel surface 中使用，当前 surface=${surface}, channel=${channelState}`;
    }

    const roleName = context.roleName || 'default';
    return `错误：工具 "${toolName}" 不允许在当前角色 "${roleName}" 中使用`;
  }

  private resolveForbiddenErrorCode(toolName: string, _context: Partial<ToolExecutionContext>): string {
    if (this.isConfirmedToolGated(toolName, _context)) {
      return 'TOOL_CONFIRMATION_REQUIRED';
    }
    const policy = this.resolveToolVisibilityPolicy(_context.roleName);
    if (policy.mode === 'skill_scoped' && this.isLayerToolVisible(toolName, _context) && !this.isScopedToolVisible(toolName, _context)) {
      return 'TOOL_FORBIDDEN_FOR_ACTIVE_SKILL';
    }
    const layer = this.toolLayers.get(toolName);
    return layer === 'surface' ? 'TOOL_FORBIDDEN_FOR_SURFACE' : 'TOOL_FORBIDDEN_FOR_ROLE';
  }
}

interface ResolvedToolVisibilityPolicy {
  mode: 'all' | 'skill_scoped';
  defaultTools: string[];
  skillToolsets: Record<string, string[]>;
  skillToolsetAliases: Record<string, string[]>;
}
