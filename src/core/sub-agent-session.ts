import { createSandboxPolicy } from '../sandbox/policy';
import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { SkillInvocationContext } from '../types/skill';
import { ToolCall, ToolDefinition, ToolExecutionContext, ToolExecutor, ToolResult } from '../types/tool';
import type { ObservabilitySpanContext } from '../observability';
import {
  buildSkillActivationSignal,
  upsertSkillSystemMessage,
} from '../skills/skill-activation-protocol';
import { ConversationRunner, RunnerCallbacks, RunToolResult } from './conversation-runner';
import { createRoleAwareToolManager } from '../bootstrap/tool-manager';
import { PromptManager } from '../utils/prompt-manager';
import { buildFileMemoryContext } from '../utils/file-memory-context';
import { Logger } from '../utils/logger';
import { buildCanonicalToolResult } from '../tools/tool-result';
import { SessionTurnLogger } from '../utils/session-turn-logger';
import { isWritePathWithinRoot } from '../utils/safety';
import * as path from 'path';

// ─── 类型定义 ───────────────────────────────────────────

export type SubAgentStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'waiting_for_input' | 'interrupted';

export type SubAgentSkillSelectionMode = 'preselected' | 'subagent_decides' | 'none';

export interface SubAgentInfo {
  id: string;
  skillName?: string;
  skillSelectionMode?: SubAgentSkillSelectionMode;
  roleName?: string;
  taskDescription: string;
  status: SubAgentStatus;
  createdAt: number;
  completedAt?: number;
  /** 进度日志 */
  progressLog: string[];
  /** 最终结果摘要 */
  resultSummary?: string;
  recoveryNote?: string;
  /** 子智能体挂起时的待确认问题 */
  pendingQuestion?: string;
  /** 子智能体执行期间创建的产出文件路径 */
  outputFiles: string[];
}

export interface SubAgentSpawnOptions {
  /** Runtime-owned state journal callback; no new execution authority. */
  onStateChange?: (info: SubAgentInfo) => void;
  /** Narrow runtime-owned turn budget; normal role dispatch keeps the existing default. */
  maxTurns?: number;
  skillName?: string;
  taskDescription: string;
  userMessage: string;
  workingDirectory: string;
  /** 子会话角色，用于给后台子智能体加载 role prompt、role skills 和 role tools */
  roleName?: string;
  /** 允许子智能体通过 skill 工具自行选择可见 skill；role-only dispatch 默认开启，no-skill dispatch 默认关闭。 */
  allowSkillSelection?: boolean;
  /** 向主 agent 投递消息（子智能体挂起时触发主 agent 推理） */
  notifyParent?: (subAgentId: string, taskDescription: string, question: string) => Promise<void>;
  /** Parent trace context inherited from spawn_subagent tool execution. */
  observabilityContext?: ObservabilitySpanContext;
  /** Trusted parent session identity inherited from the spawning runtime context. */
  parentSessionId?: string;
  /** Runtime-owned hard denylist for narrow workflows such as formal replay. */
  hiddenTools?: string[];
  /** An empty allowlist makes proposal-only workflows unable to call any tools. */
  allowedTools?: string[];
  /** Optional runtime-owned write boundary. When omitted, normal role write semantics are unchanged. */
  allowedWriteRoot?: string;
}

const SUB_AGENT_ALWAYS_HIDDEN_TOOLS = new Set([
  'schedule_reminder',
  'spawn_subagent',
  'check_subagent',
  'stop_subagent',
  'resume_subagent',
  'send_text',
  'send_file',
]);

const SUB_AGENT_TOOL_ALIASES: Record<string, string> = {
  Bash: 'execute_shell',
  bash: 'execute_shell',
  Shell: 'execute_shell',
  execute_bash: 'execute_shell',
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
};

const SUB_AGENT_WRITE_TOOLS = new Set(['write_file', 'edit_file']);

export class SubAgentToolExecutor implements ToolExecutor {
  private readonly hiddenTools: Set<string>;

  constructor(
    private readonly inner: ToolManager,
    private readonly options: {
      allowSkillTool?: boolean;
      hiddenTools?: Iterable<string>;
      allowedTools?: string[];
      allowedWriteRoot?: string;
      workingDirectory?: string;
    } = {},
  ) {
    this.hiddenTools = new Set(
      Array.from(options.hiddenTools || [], toolName => this.canonicalToolName(toolName)),
    );
  }

  getToolDefinitions(contextOverrides?: Partial<ToolExecutionContext>): ToolDefinition[] {
    return this.inner
      .getToolDefinitions(contextOverrides)
      .filter(tool => !this.isHiddenTool(tool.name));
  }

  async executeTool(
    toolCall: ToolCall,
    conversationHistory?: any[],
    contextOverrides?: Partial<ToolExecutionContext>,
  ): Promise<ToolResult> {
    const canonicalName = this.canonicalToolName(toolCall.function.name);
    if (this.isHiddenTool(canonicalName)) {
      return buildCanonicalToolResult({
        tool_call_id: toolCall.id,
        name: canonicalName,
        content: `错误：${toolCall.function.name} 是主会话控制面或外发工具，子智能体内部不可调用。`,
        status: 'blocked',
        errorCode: 'TOOL_FORBIDDEN_IN_SUBAGENT',
        blockedReason: `${toolCall.function.name} 是主会话控制面或外发工具，子智能体内部不可调用。`,
        retryable: false,
      });
    }

    const writeBoundaryResult = this.validateWriteBoundary(toolCall, canonicalName, contextOverrides);
    if (writeBoundaryResult) return writeBoundaryResult;

    if (this.options.allowedWriteRoot && canonicalName === 'execute_shell') {
      const cwd = contextOverrides?.workingDirectory || this.options.workingDirectory || this.options.allowedWriteRoot;
      const permission = isWritePathWithinRoot('.', cwd, this.options.allowedWriteRoot);
      if (!permission.allowed) return buildCanonicalToolResult({ tool_call_id: toolCall.id, name: canonicalName,
        content: permission.reason || 'Shell 工作目录超出隔离写入根目录。', status: 'blocked', errorCode: 'PATH_DENIED', retryable: false });
    }

    const sandboxPolicy = this.options.allowedWriteRoot ? createSandboxPolicy({
      cwd: this.options.allowedWriteRoot,
      scratchRoot: path.join(this.options.allowedWriteRoot, 'output', '.xiaoba-sandbox'),
      readRoots: [...(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean), path.resolve(__dirname, '..'), path.resolve(__dirname, '../../node_modules')],
      writeRoots: [this.options.allowedWriteRoot],
    }) : undefined;
    return this.inner.executeTool(toolCall, conversationHistory, { ...contextOverrides, ...(sandboxPolicy ? { sandboxPolicy } : {}) });
  }

  private isHiddenTool(toolName: string): boolean {
    const canonicalName = this.canonicalToolName(toolName);
    if (this.options.allowedTools && !this.options.allowedTools.includes(canonicalName)) return true;
    if (SUB_AGENT_ALWAYS_HIDDEN_TOOLS.has(canonicalName)) {
      return true;
    }
    if (this.hiddenTools.has(canonicalName)) {
      return true;
    }
    return canonicalName === 'skill' && !this.options.allowSkillTool;
  }

  private validateWriteBoundary(
    toolCall: ToolCall,
    canonicalName: string,
    contextOverrides?: Partial<ToolExecutionContext>,
  ): ToolResult | undefined {
    if (!this.options.allowedWriteRoot || !SUB_AGENT_WRITE_TOOLS.has(canonicalName)) {
      return undefined;
    }

    let args: unknown;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      return undefined;
    }
    if (!args || typeof args !== 'object' || typeof (args as Record<string, unknown>).file_path !== 'string') {
      return undefined;
    }

    const filePath = (args as Record<string, unknown>).file_path as string;
    const workingDirectory = contextOverrides?.workingDirectory
      || this.options.workingDirectory
      || this.options.allowedWriteRoot;
    const permission = isWritePathWithinRoot(
      filePath,
      workingDirectory,
      this.options.allowedWriteRoot,
    );
    if (permission.allowed) return undefined;

    const reason = permission.reason || '写入路径超出隔离子会话允许目录。';
    return buildCanonicalToolResult({
      tool_call_id: toolCall.id,
      name: canonicalName,
      content: `执行被阻止: ${reason}`,
      status: 'blocked',
      errorCode: 'PATH_DENIED',
      blockedReason: reason,
      retryable: false,
    });
  }

  private canonicalToolName(toolName: string): string {
    return SUB_AGENT_TOOL_ALIASES[toolName] ?? toolName;
  }
}

export function createSubAgentToolManager(
  workingDirectory: string,
  subAgentId: string,
  roleName?: string,
  contextOptions: { parentSessionId?: string; abortSignal?: AbortSignal } = {},
): ToolManager {
  return createRoleAwareToolManager(
    workingDirectory,
    {
      sessionId: `subagent:${subAgentId}`,
      surface: 'agent',
      permissionProfile: 'strict',
      ...(roleName ? { roleName } : {}),
      ...(contextOptions.parentSessionId ? { parentSessionId: contextOptions.parentSessionId } : {}),
      ...(contextOptions.abortSignal ? { abortSignal: contextOptions.abortSignal } : {}),
    },
    roleName,
  );
}

export function createSubAgentToolExecutor(
  workingDirectory: string,
  subAgentId: string,
  roleName?: string,
  options: {
    allowSkillTool?: boolean;
    parentSessionId?: string;
    abortSignal?: AbortSignal;
    hiddenTools?: string[];
    allowedTools?: string[];
    allowedWriteRoot?: string;
  } = {},
): SubAgentToolExecutor {
  return new SubAgentToolExecutor(
    createSubAgentToolManager(workingDirectory, subAgentId, roleName, {
      parentSessionId: options.parentSessionId,
      abortSignal: options.abortSignal,
    }),
    { ...options, workingDirectory },
  );
}

// ─── SubAgentSession ────────────────────────────────────

/**
 * SubAgentSession - 独立运行的后台子智能体
 *
 * 拥有自己的 messages[]、ConversationRunner、skill 上下文。
 * 不直接和用户通信，仅通过 injectMessage 向主 Agent 报告状态。
 * 主会话不 await 它，fire-and-forget。
 */
export class SubAgentSession {
  readonly id: string;
  readonly skillName?: string;
  readonly taskDescription: string;
  status: SubAgentStatus = 'running';
  progressLog: string[] = [];
  resultSummary?: string;
  createdAt = Date.now();
  completedAt?: number;

  private messages: Message[] = [];
  private stopped = false;
  /** 子智能体执行期间创建的文件路径（用于自动发送产出） */
  private outputFiles: string[] = [];
  private selectedSkillName?: string;
  private readonly abortController = new AbortController();
  /** 挂起等待主 agent 回答的问题 */
  private pendingQuestion: string | null = null;
  private pendingResolve: ((answer: string) => void) | null = null;
  private pendingWaitPromise: Promise<string> | null = null;
  private readonly sessionTurnLogger: SessionTurnLogger;
  private traceRecorded = false;
  private runStartedAt = 0;

  // ─── 会话级重试配置 ──────────────────────────────────
  private static readonly SESSION_MAX_RETRIES = 2;
  private static readonly SESSION_RETRY_BASE_DELAY_MS = 5000;

  private static isRetryableError(err: any): boolean {
    const msg = String(err?.message || '').toLowerCase();
    return /429|rate.?limit|too many requests|overloaded|频率|并发/.test(msg)
      || /\b50[023]\b|529/.test(msg)
      || /econnreset|etimedout|econnaborted/.test(msg);
  }

  constructor(
    id: string,
    private aiService: AIService,
    private skillManager: SkillManager,
    private options: SubAgentSpawnOptions,
  ) {
    this.id = id;
    this.skillName = options.skillName;
    this.taskDescription = options.taskDescription;
    this.sessionTurnLogger = new SessionTurnLogger('subagent', `subagent:${id}`);
  }

  /**
   * 后台执行（带会话级重试）。调用方不 await，fire-and-forget。
   */
  async run(): Promise<void> {
    return Logger.withSessionContext(`subagent:${this.id}`, this.sessionTurnLogger, async () => {
      await this.runWithTraceContext();
    });
  }

  private async runWithTraceContext(): Promise<void> {
    this.runStartedAt = Date.now();
    this.sessionTurnLogger.logRuntimeEvent('session_started', this.lifecycleEvidence('started'));
    let lastError: any;

    for (let attempt = 0; attempt <= SubAgentSession.SESSION_MAX_RETRIES; attempt++) {
      if (this.stopped) {
        this.status = 'stopped';
        this.completedAt = Date.now();
        this.recordStoppedTrace();
        return;
      }

      // 重试前：等待 + 重置状态
      if (attempt > 0) {
        const delay = SubAgentSession.SESSION_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        Logger.warning(`[SubAgent ${this.id}] 第 ${attempt} 次重试，${delay}ms 后开始`);
        this.reportProgress(`第 ${attempt} 次重试（${lastError?.message}）`);
        const retryReady = await this.waitForRetryDelay(delay);
        if (!retryReady) {
          this.status = 'stopped';
          this.completedAt = this.completedAt ?? Date.now();
          this.recordStoppedTrace();
          return;
        }
        this.messages = [];
        this.outputFiles = [];
      }

      try {
        await this._executeOnce();
        return; // 成功，直接返回
      } catch (err: any) {
        lastError = err;
        if (this.stopped) break;
        if (!SubAgentSession.isRetryableError(err) || attempt === SubAgentSession.SESSION_MAX_RETRIES) {
          break; // 不可重试 或 重试次数用尽
        }
        Logger.warning(`[SubAgent ${this.id}] 可重试错误: ${err.message}`);
      }
    }

    // 最终失败
    this.status = this.stopped ? 'stopped' : 'failed';
    this.completedAt = Date.now();
    this.resultSummary = `执行失败: ${lastError?.message}`;
    Logger.error(`[SubAgent ${this.id}] ${this.stopped ? '已停止' : '失败'}: ${lastError?.message}`);
    if (this.stopped) {
      this.recordStoppedTrace();
    } else {
      this.recordFailureTrace(lastError);
    }
  }

  private waitForRetryDelay(delayMs: number): Promise<boolean> {
    if (this.stopped || this.abortController.signal.aborted) {
      return Promise.resolve(false);
    }

    return new Promise(resolve => {
      let settled = false;
      const finish = (elapsed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.abortController.signal.removeEventListener('abort', onAbort);
        resolve(elapsed && !this.stopped);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(true), delayMs);
      this.abortController.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * 单次执行核心逻辑（不含重试）
   */
  private async _executeOnce(): Promise<void> {
    // 1. 构建独立的 system prompt
    const systemPrompt = await PromptManager.buildSystemPrompt({ roleName: this.options.roleName });
    this.messages.push({ role: 'system', content: systemPrompt });
    try {
      const memory = buildFileMemoryContext(this.options.parentSessionId || this.id, this.options.workingDirectory);
      if (memory) this.messages.push(memory);
    } catch (error: any) {
      Logger.warning(`[子会话 ${this.id}] memory 读取失败: ${error.code || 'MEMORY_READ_FAILED'}`);
    }

    // 2. 注入预选 skill；role-only dispatch 可让目标 role 子智能体自行选择。
    const skill = this.skillName ? this.skillManager.getSkill(this.skillName) : undefined;
    if (this.skillName && !skill) {
      throw new Error(`Skill "${this.skillName}" 未找到`);
    }

    if (skill) {
      const invocationContext: SkillInvocationContext = {
        skillName: this.skillName!,
        arguments: [],
        rawArguments: '',
        userMessage: this.options.userMessage,
      };
      const activation = buildSkillActivationSignal(skill, invocationContext);
      upsertSkillSystemMessage(this.messages, activation);
      this.selectedSkillName = activation.skillName;
    } else {
      this.messages.push({
        role: 'system',
        content: this.buildNoPreselectedSkillContext(this.shouldAllowSkillSelection()),
      });
    }

    // 3. 注入用户消息
    this.messages.push({ role: 'user', content: this.options.userMessage });

    // 4. 创建独立的 ToolManager
    const toolExecutor = createSubAgentToolExecutor(
      this.options.workingDirectory,
      this.id,
      this.options.roleName,
      {
        allowSkillTool: this.shouldAllowSkillSelection(),
        parentSessionId: this.options.parentSessionId,
        abortSignal: this.abortController.signal,
        hiddenTools: this.options.hiddenTools,
        allowedTools: this.options.allowedTools,
        allowedWriteRoot: this.options.allowedWriteRoot,
      },
    );

    // 创建独立的 ConversationRunner（不注入 channel，子智能体不直接和用户通信）
    const runner = new ConversationRunner(this.aiService, toolExecutor, {
      maxTurns: this.options.maxTurns ?? skill?.metadata.maxTurns ?? 100,
      initialSkillName: this.skillName,
      initialSkillToolsets: skill?.metadata.toolsets,
      enableCompression: true,
      shouldContinue: () => !this.stopped,
      toolExecutionContext: {
        sessionId: `subagent:${this.id}`,
        surface: 'agent',
        permissionProfile: 'strict',
        abortSignal: this.abortController.signal,
        observabilityContext: this.options.observabilityContext,
        ...(this.options.roleName ? { roleName: this.options.roleName } : {}),
        ...(this.options.parentSessionId ? { parentSessionId: this.options.parentSessionId } : {}),
      },
      observabilityContext: this.options.observabilityContext,
    });

    // 7. 用 callbacks 捕获进度
    const callbacks: RunnerCallbacks = {
      onToolEnd: (name, _toolUseId, result) => {
        this.detectAndReportProgress(name, result);
      },
    };

    this.reportProgress(`开始执行：${this.taskDescription}`);
    const runResult = await runner.run(this.messages, callbacks);
    this.captureSelectedSkill(runResult.newMessages);

    if (this.stopped) {
      this.status = 'stopped';
      this.completedAt = this.completedAt ?? Date.now();
      this.recordStoppedTrace();
      return;
    }

    // 8. 完成（不直接发文件，由主 Agent 根据 outputFiles 决定）
    this.status = 'completed';
    this.completedAt = Date.now();
    this.resultSummary = runResult.response;

    this.sessionTurnLogger.logRuntimeEvent('session_completed', {
      ...this.lifecycleEvidence('success'),
      duration_ms: Math.max(0, this.completedAt - this.runStartedAt),
      tool_call_count: runResult.toolResults.length,
    });
    this.sessionTurnLogger.logTurn(
      this.options.userMessage,
      runResult.response || '',
      runResult.toolResults.map(record => this.toSessionToolCallLog(record)),
      { prompt: 0, completion: 0 },
      runResult.toolVisibility,
    );
    this.traceRecorded = true;

    Logger.success(`[SubAgent ${this.id}] 完成: ${this.taskDescription}`);
  }

  stop(): void {
    this.stopped = true;
    this.status = 'stopped';
    this.completedAt = Date.now();
    this.abortController.abort();
    // 如果正在挂起等待，解除阻塞
    if (this.pendingResolve) {
      this.pendingResolve('（任务已被停止）');
      this.pendingResolve = null;
      this.pendingQuestion = null;
      this.pendingWaitPromise = null;
    }
    this.options.onStateChange?.(this.getInfo());
  }

  /**
   * 恢复挂起的子智能体（由主 agent 通过 resume_subagent 调用）
   * @returns 是否成功恢复
   */
  resume(answer: string): boolean {
    if (!this.pendingResolve || this.status !== 'waiting_for_input') {
      return false;
    }
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    this.pendingQuestion = null;
    this.status = 'running';
    this.reportProgress(`收到回复，继续执行`);
    resolve(answer);
    return true;
  }

  /**
   * 挂起当前子智能体，向父会话请求输入。
   */
  async waitForParentInput(question: string): Promise<string> {
    if (this.stopped) {
      return '（任务已被停止）';
    }
    if (this.status === 'waiting_for_input') {
      throw new Error('子智能体已经在等待输入');
    }

    this.status = 'waiting_for_input';
    this.pendingQuestion = question;
    this.reportProgress(`等待主会话输入：${question}`);

    const waitPromise = new Promise<string>(resolve => {
      this.pendingResolve = resolve;
    });
    this.pendingWaitPromise = waitPromise;

    if (!this.options.notifyParent) {
      this.status = 'running';
      this.pendingQuestion = null;
      this.pendingResolve = null;
      this.pendingWaitPromise = null;
      throw new Error('父会话回调不可用，无法请求输入');
    }

    try {
      await this.options.notifyParent(this.id, this.taskDescription, question);
    } catch (err) {
      this.status = 'running';
      this.pendingQuestion = null;
      this.pendingResolve = null;
      this.pendingWaitPromise = null;
      throw err;
    }

    return waitPromise;
  }

  getInfo(): SubAgentInfo {
    return {
      id: this.id,
      ...(this.selectedSkillName ? { skillName: this.selectedSkillName } : {}),
      skillSelectionMode: this.getSkillSelectionMode(),
      ...(this.options.roleName ? { roleName: this.options.roleName } : {}),
      taskDescription: this.taskDescription,
      status: this.status,
      createdAt: this.createdAt,
      completedAt: this.completedAt,
      progressLog: [...this.progressLog],
      resultSummary: this.resultSummary,
      pendingQuestion: this.pendingQuestion ?? undefined,
      outputFiles: [...this.outputFiles],
    };
  }

  // ─── 私有方法 ──────────────────────────────────────

  private reportProgress(message: string): void {
    this.progressLog.push(message);
    this.options.onStateChange?.(this.getInfo());
    // 仅记录到 progressLog，不推飞书
    // 主 agent 通过 check_subagent 查看进度后自行决定是否告知用户
  }

  private shouldAllowSkillSelection(): boolean {
    return this.options.allowSkillSelection ?? Boolean(this.options.roleName && !this.skillName);
  }

  private getSkillSelectionMode(): SubAgentSkillSelectionMode {
    if (this.skillName) {
      return 'preselected';
    }
    return this.shouldAllowSkillSelection() ? 'subagent_decides' : 'none';
  }

  private buildNoPreselectedSkillContext(allowSkillSelection: boolean): string {
    if (!allowSkillSelection) {
      const canAskParent = !(this.options.hiddenTools || []).includes('ask_parent');
      return [
        '[subagent-no-skill]',
        '主会话没有为你预设 skill。请直接按 system prompt、用户消息和当前可见工具执行任务。',
        canAskParent
          ? '不要尝试切换 skill；如果任务范围、权限或验收不清楚，先用 ask_parent 请求主会话确认。'
          : '不要尝试切换 skill；这是自治的固定工作流，无法安全完成时按任务合同 fail closed，不要等待或请求父会话。',
      ].join('\n');
    }

    const skills = this.skillManager.getUserInvocableSkills?.() ?? [];
    const skillLines = skills.length > 0
      ? skills.map(skill => `- ${skill.metadata.name}: ${skill.metadata.description}`).join('\n')
      : '- （当前 role 没有可通过 skill 工具调用的 skills）';

    return [
      '[subagent-skill-selection]',
      '主会话只指定了子智能体 role，没有指定 skill。原因是主会话可能看不到目标 role 的 role-local skills。',
      '你需要先判断当前任务是否应该调用某个 skill。若合适，请用 skill 工具从当前 role 可调用 skills 中选择；若没有合适 skill，可以直接按 role prompt 和可见工具执行。',
      '',
      '当前 role 可调用 skills:',
      skillLines,
    ].join('\n');
  }

  private captureSelectedSkill(messages: Message[]): void {
    for (const msg of messages) {
      if (msg.role !== 'system' || typeof msg.content !== 'string') {
        continue;
      }
      const match = msg.content.match(/^\[skill:([^\]]+)\]/);
      if (match) {
        this.selectedSkillName = match[1];
      }
    }
  }

  private detectAndReportProgress(toolName: string, result: string): void {
    // 从工具结果中提取文件路径，用于自动发送产出
    if (toolName === 'write_file' || toolName === 'pptx_generator') {
      const filePath = this.extractFilePath(toolName, result);
      if (filePath) {
        this.outputFiles.push(filePath);
      }
    }

    // 记录有意义的进度（基于章节分析文件，而非所有 write_file）
    if (toolName === 'write_file' && result.includes('chapters/')) {
      const match = result.match(/chapters\/\d+_([^/]+)\//);
      const chapterSlug = match ? match[1] : null;
      this.reportProgress(chapterSlug ? `已完成章节: ${chapterSlug}` : `已完成 ${this.progressLog.length} 个阶段`);
    } else if (toolName === 'pptx_generator') {
      this.reportProgress('PPT 生成完成');
    } else if (toolName === 'write_file' && result.includes('summary.md')) {
      this.reportProgress('全文总结完成');
    }
  }

  private lifecycleEvidence(status: string): Record<string, unknown> {
    return {
      source: 'subagent',
      environment: process.env.NODE_TEST_CONTEXT ? 'test' : 'runtime',
      surface: 'agent',
      status,
      subagent_id: this.id,
      ...(this.options.parentSessionId ? { parent_session_id: this.options.parentSessionId } : {}),
      ...(this.options.roleName ? { role_name: this.options.roleName } : {}),
      ...(this.selectedSkillName || this.skillName
        ? { skill_name: this.selectedSkillName || this.skillName }
        : {}),
    };
  }

  private recordStoppedTrace(): void {
    if (this.traceRecorded) return;
    this.sessionTurnLogger.logRuntimeEvent('session_completed', {
      ...this.lifecycleEvidence('stopped'),
      duration_ms: Math.max(0, (this.completedAt || Date.now()) - this.runStartedAt),
      error_code: 'SUBAGENT_STOPPED',
    });
    this.sessionTurnLogger.logTurn(
      this.options.userMessage,
      this.resultSummary || 'Subagent stopped before completion.',
      [],
      { prompt: 0, completion: 0 },
    );
    this.traceRecorded = true;
  }

  private recordFailureTrace(error: unknown): void {
    if (this.traceRecorded) return;
    const message = error instanceof Error ? error.message : String(error || 'Unknown subagent failure');
    this.sessionTurnLogger.logRuntimeEvent('provider_error', {
      ...this.lifecycleEvidence('failure'),
      duration_ms: Math.max(0, (this.completedAt || Date.now()) - this.runStartedAt),
      error_code: 'SUBAGENT_RUN_FAILED',
      retryable: false,
      provider_error: {
        error_code: 'SUBAGENT_RUN_FAILED',
        message: message.slice(0, 500),
      },
    });
    this.sessionTurnLogger.logTurn(
      this.options.userMessage,
      this.resultSummary || `执行失败: ${message}`,
      [],
      { prompt: 0, completion: 0 },
    );
    this.traceRecorded = true;
  }

  private toSessionToolCallLog(record: RunToolResult) {
    const toolResult = record.result;
    const errorCode = toolResult.error_code || toolResult.errorCode;
    return {
      id: record.toolCall.id,
      tool_call_id: toolResult.tool_call_id || record.toolCall.id,
      name: toolResult.name || record.toolName || record.toolCall.function.name,
      arguments: this.parseToolArguments(record.toolCall.function.arguments),
      result: this.toolResultContent(toolResult.content),
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

  private parseToolArguments(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private toolResultContent(content: ToolResult['content']): string {
    if (typeof content === 'string') return content;
    return content
      .map(block => block.type === 'text' ? block.text : '[image]')
      .join('');
  }

  /** 从工具结果中提取文件路径 */
  private extractFilePath(toolName: string, result: string): string | null {
    if (toolName === 'pptx_generator') {
      // pptx_generator 返回 JSON，包含 output_path
      try {
        const parsed = JSON.parse(result);
        return parsed.output_path || null;
      } catch {
        return null;
      }
    }
    // write_file 返回格式: "成功创建文件: <path>\n..."
    const match = result.match(/成功(?:创建|覆盖)文件:\s*(.+?)(?:\n|$)/);
    return match ? match[1].trim() : null;
  }
}
