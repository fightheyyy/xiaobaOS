import * as path from 'path';
import {
  ArtifactManifestItem,
  Tool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutput,
} from '../../../types/tool';
import {
  LongTermMemoryKind,
  MemoryFinalizer,
} from '../../../utils/memory-finalizer';
import { toolFailure, toolSuccess } from '../../../tools/tool-result';

const MEMORY_KINDS = new Set<LongTermMemoryKind>([
  'preference',
  'habit',
  'instruction',
  'fact',
]);

interface RememberToolResult {
  ok: true;
  action: 'created' | 'updated' | 'forgotten' | 'archived';
  memory_path: string;
  record_id: string;
  kind?: LongTermMemoryKind;
  text?: string;
  total_records: number;
  load_policy: 'on_demand';
}

export class EvolutionRememberTool implements Tool {
  definition: ToolDefinition = {
    name: 'remember',
    description: 'EvolutionCat 专属文件记忆工具：记住稳定偏好、习惯、指令或事实；纠正时用 replaces 指定旧记录 ID；用户要求忘记时用 action=forget 和 record_id。失效或重复记录可用 action=archive 和 record_id 归档，提供 evidence 说明；稳定事实不因年龄自动删除。先读取当前 MEMORY.md 获取 ID。不要记录当前任务进度或临时待办。',
    parameters: {
      type: 'object',
      properties: {
        confidence: { type: 'string', enum: ['high', 'medium'], description: '明确事实 high；有依据的推断 medium，正文注明不确定性。' },
        evidence: { type: 'string', description: '原话或经验来源、时间和适用范围，最多500字。' },
        action: { type: 'string', enum: ['remember', 'forget', 'archive'], description: '默认 remember；forget 用于遗忘请求；archive 归档失效或重复记录，必须提供 evidence 说明。' },
        replaces: { type: 'string', description: '纠正旧记忆时指定被替换的记录 ID。' },
        record_id: { type: 'string', description: 'forget/archive 时必须指定的记录 ID。' },
        content: {
          type: 'string',
          description: '要长期记住的单条稳定内容。',
        },
        kind: {
          type: 'string',
          enum: ['preference', 'habit', 'instruction', 'fact'],
          description: '可选分类；省略时由 runtime 确定性分类。',
        },
      },
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const content = typeof args?.content === 'string' ? args.content.trim() : '';
    const action = args?.action ?? 'remember';
    if (!['remember', 'forget', 'archive'].includes(action)) {
      return toolFailure('action 必须是 remember、forget 或 archive。', 'INVALID_TOOL_ARGUMENTS');
    }
    if (action === 'remember' && !content) {
      return toolFailure('remember 需要非空 content。', 'INVALID_TOOL_ARGUMENTS');
    }

    const parentSessionId = typeof context.parentSessionId === 'string'
      ? context.parentSessionId.trim()
      : '';
    const sessionId = parentSessionId
      || (typeof context.sessionId === 'string' ? context.sessionId.trim() : '');
    if (!sessionId) {
      return toolFailure('remember 需要 runtime 提供 sessionId。', 'SESSION_ID_REQUIRED');
    }

    if (args?.confidence !== undefined && !['high','medium'].includes(args.confidence)) return toolFailure('confidence 无效。', 'INVALID_TOOL_ARGUMENTS');
    if (args?.evidence !== undefined && (typeof args.evidence !== 'string' || args.evidence.length > 500)) return toolFailure('evidence 无效。', 'INVALID_TOOL_ARGUMENTS');
    const kind = normalizeKind(args?.kind);
    if (args?.kind !== undefined && !kind) {
      return toolFailure('kind 必须是 preference、habit、instruction 或 fact。', 'INVALID_TOOL_ARGUMENTS');
    }

    try {
      if (action === 'forget' || action === 'archive') {
        const recordId = typeof args?.record_id === 'string' ? args.record_id.trim() : '';
        if (!recordId) return toolFailure('forget/archive 需要 record_id。', 'INVALID_TOOL_ARGUMENTS');
        if (action === 'archive' && !args?.evidence?.trim()) return toolFailure('archive 需要 evidence 说明归档依据。', 'INVALID_TOOL_ARGUMENTS');
        const result = action === 'archive'
          ? MemoryFinalizer.archive(sessionId, recordId, args.evidence, context.workingDirectory)
          : MemoryFinalizer.forget(sessionId, recordId, context.workingDirectory);
        return toolSuccess(JSON.stringify({
          ok: true, action: action === 'archive' ? 'archived' : 'forgotten', memory_path: displayPath(result.memoryPath, context.workingDirectory),
          record_id: recordId, total_records: result.totalRecords, load_policy: 'on_demand',
        }, null, 2));
      }
      if (args?.replaces !== undefined && (typeof args.replaces !== 'string' || !args.replaces.trim())) {
        return toolFailure('replaces 需要有效记录 ID。', 'INVALID_TOOL_ARGUMENTS');
      }
      const result = MemoryFinalizer.remember(sessionId, content, {
        ...(args?.replaces ? { replaces: args.replaces.trim() } : {}),
        ...(kind ? { kind } : {}),
        confidence: args?.confidence, evidence: args?.evidence,
        rootDir: context.workingDirectory,
      });
      const payload: RememberToolResult = {
        ok: true,
        action: result.action,
        memory_path: displayPath(result.memoryPath, context.workingDirectory),
        record_id: result.record.id,
        kind: result.record.kind,
        text: result.record.text,
        total_records: result.totalRecords,
        load_policy: 'on_demand',
      };
      return toolSuccess(JSON.stringify(payload, null, 2));
    } catch (error: any) {
      return toolFailure(
        `remember 写入失败：${error?.message || String(error)}`,
        ['MEMORY_RECORD_NOT_FOUND', 'MEMORY_BUSY_OR_INTERRUPTED', 'MEMORY_BLOCK_INVALID'].includes(error?.message)
          ? error.message : 'MEMORY_WRITE_FAILED',
      );
    }
  }

  getArtifactManifest(
    _args: any,
    result: string,
    _context: ToolExecutionContext,
  ): ArtifactManifestItem[] {
    const payload = parseResult(result);
    if (!payload) return [];
    return [{
      path: payload.memory_path,
      type: 'md',
      action: (payload.action === 'forgotten' || payload.action === 'archived') ? 'updated' : payload.action,
      metadata: {
        artifact_role: 'session_person_memory',
        record_id: payload.record_id,
        kind: payload.kind,
      },
    }];
  }
}

function normalizeKind(value: unknown): LongTermMemoryKind | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim() as LongTermMemoryKind;
  return MEMORY_KINDS.has(normalized) ? normalized : undefined;
}

function displayPath(filePath: string, workingDirectory: string): string {
  const relative = path.relative(workingDirectory, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : filePath;
}

function parseResult(result: string): RememberToolResult | undefined {
  try {
    const payload = JSON.parse(result) as Partial<RememberToolResult>;
    if (
      payload.ok === true
      && typeof payload.memory_path === 'string'
      && typeof payload.record_id === 'string'
      && (payload.action === 'created' || payload.action === 'updated' || payload.action === 'forgotten' || payload.action === 'archived')
    ) {
      return payload as RememberToolResult;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
