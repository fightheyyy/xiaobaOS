import * as path from 'path';
import {
  ArtifactManifestItem,
  Tool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutput,
} from '../../types/tool';
import {
  buildToolExecutionOutput,
  toolBlocked,
  toolFailure,
  toolSuccess,
} from '../../tools/tool-result';
import {
  CodexAccessMode,
  CodexExecutor,
  CodexExecutorResult,
  OfficialCodexSdkAdapter,
} from './codex-sdk-adapter';

const MAX_TASK_CHARS = 100_000;
const MAX_FINAL_RESPONSE_CHARS = 60_000;
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export class EngineerCodexRunTool implements Tool {
  definition: ToolDefinition = {
    name: 'codex_run',
    description: '把实质性代码任务交给本机 Codex 执行。工作区、网络和审批策略由 XiaoBa 固定；可用 thread_id 续接一次既有 Codex thread。Codex 不可用时改用原生 coding 工具。',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '给 Codex 的完整、可独立执行的工程任务，包含目标、约束和验收要求。',
        },
        access: {
          type: 'string',
          enum: ['read_only', 'workspace_write'],
          description: 'read_only 只检查；workspace_write 可修改当前工作区。默认 workspace_write。',
          default: 'workspace_write',
        },
        thread_id: {
          type: 'string',
          description: '可选：续接上一次 codex_run 返回的 thread_id。',
        },
      },
      required: ['task'],
    },
  };

  constructor(private readonly executor: CodexExecutor = new OfficialCodexSdkAdapter()) {}

  async execute(args: unknown, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    if (!context.roleName || !['engineer-cat', 'engineer', 'coder'].includes(context.roleName)) {
      return toolBlocked(
        JSON.stringify({ ok: false, error: 'codex_run is only available to EngineerCat.' }),
        'CODEX_ROLE_FORBIDDEN',
        'codex_run is only available to EngineerCat.',
      );
    }

    const record = asRecord(args);
    const task = optionalTrimmed(record.task);
    if (!task) {
      return toolFailure(
        JSON.stringify({ ok: false, error: 'task is required.' }),
        'INVALID_TOOL_ARGUMENTS',
      );
    }
    if (task.length > MAX_TASK_CHARS) {
      return toolFailure(
        JSON.stringify({ ok: false, error: `task exceeds ${MAX_TASK_CHARS} characters.` }),
        'INVALID_TOOL_ARGUMENTS',
      );
    }
    const access = normalizeAccess(record.access);
    if (!access) {
      return toolFailure(
        JSON.stringify({ ok: false, error: 'access must be read_only or workspace_write.' }),
        'INVALID_TOOL_ARGUMENTS',
      );
    }
    const threadId = optionalTrimmed(record.thread_id);
    if (threadId && !THREAD_ID_PATTERN.test(threadId)) {
      return toolFailure(
        JSON.stringify({ ok: false, error: 'thread_id has an invalid format.' }),
        'INVALID_TOOL_ARGUMENTS',
      );
    }

    try {
      const result = await this.executor.run({
        task,
        accessMode: access,
        workingDirectory: path.resolve(context.workingDirectory),
        abortSignal: context.abortSignal,
        ...(threadId ? { threadId } : {}),
      });
      return toolSuccess(JSON.stringify(buildSuccessPayload(result, access), null, 2));
    } catch (error) {
      return codexErrorOutput(error, context.abortSignal);
    }
  }

  getArtifactManifest(
    _args: unknown,
    result: string | import('../../types').ContentBlock[] | ToolExecutionOutput,
    context: ToolExecutionContext,
  ): ArtifactManifestItem[] {
    if (!isToolExecutionOutput(result) || result.status !== 'success' || typeof result.toolContent !== 'string') {
      return [];
    }
    let payload: unknown;
    try {
      payload = JSON.parse(result.toolContent);
    } catch {
      return [];
    }
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as any).changes)) return [];
    const root = path.resolve(context.workingDirectory);
    return (payload as any).changes.flatMap((change: unknown) => {
      if (!change || typeof change !== 'object') return [];
      const changePath = optionalTrimmed((change as any).path);
      const kind = (change as any).kind;
      if (!changePath || !['add', 'delete', 'update'].includes(kind)) return [];
      const absolute = path.resolve(root, changePath);
      const relative = path.relative(root, absolute);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return [];
      return [{
        path: relative,
        type: 'source_code',
        action: kind === 'add' ? 'created' : 'updated',
        metadata: { executor: 'codex', change_kind: kind },
      } as ArtifactManifestItem];
    });
  }
}

function buildSuccessPayload(result: CodexExecutorResult, access: CodexAccessMode): Record<string, unknown> {
  const truncated = result.finalResponse.length > MAX_FINAL_RESPONSE_CHARS;
  return {
    version: 1,
    ok: true,
    backend: 'codex',
    executor_output_trust: 'untrusted_model_output',
    thread_id: result.threadId,
    access,
    final_response: truncated
      ? `${result.finalResponse.slice(0, MAX_FINAL_RESPONSE_CHARS)}\u2026`
      : result.finalResponse,
    final_response_truncated: truncated,
    usage: result.usage,
    changes: result.changes,
    commands: result.commands,
    external_tools: result.externalTools,
    errors: result.errors,
  };
}

function codexErrorOutput(error: unknown, signal?: AbortSignal): ToolExecutionOutput {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = redactAndTruncate(rawMessage);
  const code = typeof (error as any)?.code === 'string' ? String((error as any).code) : '';
  const name = error instanceof Error ? error.name : '';
  const lower = `${code} ${name} ${message}`.toLowerCase();

  if (signal?.aborted || name === 'AbortError' || lower.includes('aborted')) {
    return buildToolExecutionOutput(
      JSON.stringify({ ok: false, error: 'Codex execution was cancelled.' }),
      'cancelled',
      { errorCode: 'CODEX_CANCELLED', retryable: false },
    );
  }
  if (code === 'CODEX_ARENA_FORBIDDEN') {
    const reason = 'Codex execution is disabled inside Arena clean runtimes.';
    return toolBlocked(
      JSON.stringify({ ok: false, error: reason }),
      'CODEX_ARENA_FORBIDDEN',
      reason,
      { retryable: false },
    );
  }
  if (code === 'ENOENT' || lower.includes('cannot find module') || lower.includes('missing optional dependency')) {
    const reason = 'The official Codex SDK or its local executable is unavailable.';
    return toolBlocked(
      JSON.stringify({ ok: false, error: reason, detail: message }),
      'CODEX_UNAVAILABLE',
      reason,
      { retryable: false },
    );
  }
  if (
    lower.includes('authentication')
    || lower.includes('not logged in')
    || lower.includes('unauthorized')
    || lower.includes('401')
    || lower.includes('api key')
  ) {
    const reason = 'Codex authentication is required. Run `codex login` or configure CODEX_API_KEY, then retry.';
    return toolBlocked(
      JSON.stringify({ ok: false, error: reason }),
      'CODEX_AUTH_REQUIRED',
      reason,
      { retryable: false },
    );
  }
  if (lower.includes('thread') && (lower.includes('not found') || lower.includes('resume'))) {
    return toolFailure(
      JSON.stringify({ ok: false, error: message }),
      'CODEX_THREAD_UNAVAILABLE',
      { retryable: false },
    );
  }
  return toolFailure(
    JSON.stringify({ ok: false, error: message || 'Codex execution failed.' }),
    'CODEX_EXECUTION_FAILED',
    { retryable: false },
  );
}

function normalizeAccess(value: unknown): CodexAccessMode | undefined {
  if (value === undefined || value === null || value === '') return 'workspace_write';
  return value === 'read_only' || value === 'workspace_write' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalTrimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function redactAndTruncate(value: string): string {
  const redacted = value.replace(/(?:sk|sess|key)-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
  return redacted.length <= 1_000 ? redacted : `${redacted.slice(0, 1_000)}\u2026`;
}

function isToolExecutionOutput(value: unknown): value is ToolExecutionOutput {
  return Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'toolContent'));
}
