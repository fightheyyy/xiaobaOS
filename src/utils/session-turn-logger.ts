import * as fs from 'fs';
import * as path from 'path';
import { Message, ContentBlock } from '../types';
import {
  ArtifactAction,
  ArtifactManifestItem,
  DeliveryEvidence,
  ExternalDeliveryReceipt,
  ToolResultStatus,
} from '../types/tool';
import { projectSessionLogEntryToObservability } from '../observability/session-log-projector';

const SESSION_LOG_DIR = path.join('logs', 'sessions');
const MAX_TOOL_RESULT_LENGTH = Number(process.env.XIAOBA_SESSION_TOOL_RESULT_LIMIT || 10000);
const SESSION_LOG_SCHEMA_VERSION = 3;
const CONTEXT_SNAPSHOT_DIR = 'context-snapshots';
const COMPACT_BOUNDARY_PREFIX = '[compact_boundary]';

type ToolCallStatus = ToolResultStatus;

export interface SessionTraceLogEntry {
  schema_version: number;
  entry_type: 'trace';
  trace_id: string;
  trace_index: number;
  /** @deprecated Compatibility alias for the previous episode migration. */
  episode_id: string;
  episode_index: number;
  /** @deprecated Compatibility alias for session-log-v2 fixtures. */
  turn_id: string;
  /** @deprecated Compatibility alias for session-log-v2 fixtures. */
  turn: number;
  timestamp: string;
  session_id: string;
  session_type: string;
  user: {
    text: string;
    images?: string[];
  };
  assistant: {
    text: string;
    tool_calls: ToolCallLog[];
  };
  tokens: {
    prompt: number;
    completion: number;
  };
  tool_visibility?: ToolVisibilityLog[];
  state_boundary?: SessionStateBoundaryLog;
  events?: SessionRuntimeEventLogEntry[];
}

export interface SessionLegacyTurnLogEntry extends Omit<SessionTraceLogEntry, 'entry_type' | 'trace_id' | 'trace_index'> {
  entry_type: 'turn';
}

export interface SessionRuntimeLogEntry {
  schema_version: number;
  entry_type: 'runtime';
  event_id: string;
  timestamp: string;
  session_id: string;
  session_type: string;
  level: string;
  message: string;
}

export interface SessionRuntimeEventLogEntry {
  schema_version: number;
  entry_type: 'runtime_event';
  event_id: string;
  event_type: string;
  timestamp: string;
  session_id: string;
  session_type: string;
  [key: string]: unknown;
}

export type SessionTurnLogEntry = SessionTraceLogEntry | SessionLegacyTurnLogEntry;
export type SessionLogEntry = SessionTraceLogEntry | SessionLegacyTurnLogEntry | SessionRuntimeLogEntry | SessionRuntimeEventLogEntry;

export interface ContextCompactionLogInput {
  source: 'agent_session_restore' | 'agent_session_pre_message' | 'conversation_runner' | string;
  status: 'success' | 'failed';
  reason?: string;
  surface?: string;
  turn?: number;
  tokens_before?: number;
  tokens_after?: number;
  message_tokens_before?: number;
  message_tokens_after?: number;
  tool_tokens_before?: number;
  tool_tokens_after?: number;
  max_tokens?: number;
  threshold_ratio?: number;
  threshold_tokens?: number;
  usage_percent_before?: number;
  usage_percent_after?: number;
  messages_before?: number;
  messages_after?: number;
  error_code?: string;
  error_message?: string;
  messages?: Message[];
}

interface ContextSnapshotLogEntry {
  schema_version: number;
  entry_type: 'context_snapshot';
  snapshot_id: string;
  event_id: string;
  timestamp: string;
  session_id: string;
  session_type: string;
  kind: 'compact_after';
  source: string;
  status: string;
  message_count: number;
  messages: Message[];
}

interface ToolCallLog {
  id: string;
  tool_call_id?: string;
  name: string;
  arguments: any;
  result: string;
  duration_ms?: number;
  status?: ToolCallStatus;
  error_code?: string;
  retryable?: boolean;
  retry_count?: number;
  retry_budget?: number;
  retry_budget_exhausted?: boolean;
  blocked_reason?: string;
  artifact_manifest?: ArtifactManifestItem[];
  delivery_evidence?: DeliveryEvidence[];
  external_delivery_receipts?: ExternalDeliveryReceipt[];
  skill_id?: string;
}

interface ToolVisibilityLog {
  roleName?: string;
  activeSkillName?: string;
  mode?: string;
  visibleTools: string[];
  hiddenToolCount: number;
  gatedToolCount?: number;
}

export interface StateBoundaryRecord {
  kind: string;
  ref: string;
  scope?: string;
  schema?: string;
  mode?: string;
  status?: string;
  degraded?: boolean;
  degradation_reason?: string;
  error_code?: string;
  fallback_chain?: string[];
  blocked_reason?: string;
  raw_messages_stored?: boolean;
  tool_result_payload_stored?: boolean;
  raw_request_stored?: boolean;
  raw_response_stored?: boolean;
  raw_payload_stored?: boolean;
}

export interface SessionStateBoundaryLog {
  durable_session: StateBoundaryRecord;
  working_trace: StateBoundaryRecord;
  provider_transcript: StateBoundaryRecord;
  visible_history?: StateBoundaryRecord;
}

/**
 * SessionTurnLogger - 记录每轮对话的完整交互
 *
 * 默认开启，永久保留，用于分析、日报生成、skill 提取
 */
export class SessionTurnLogger {
  private sessionType: string;
  private sessionId: string;
  private sessionDirectoryPath: string;
  private traceFilePath: string;
  private runtimeLogFilePath: string;
  private contextSnapshotFilePath: string;
  private traceCounter = 0;
  private pendingRuntimeEvents: SessionRuntimeEventLogEntry[] = [];

  constructor(sessionType: string, sessionId: string) {
    this.sessionType = sessionType;
    this.sessionId = sessionId;

    const date = new Date();
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const safeSessionId = this.safeId(sessionId);

    this.sessionDirectoryPath = path.join(path.resolve(SESSION_LOG_DIR), sessionType, dateStr, safeSessionId);
    fs.mkdirSync(this.sessionDirectoryPath, { recursive: true });
    this.traceFilePath = path.join(this.sessionDirectoryPath, 'traces.jsonl');
    this.runtimeLogFilePath = path.join(this.sessionDirectoryPath, 'runtime.log');
    this.contextSnapshotFilePath = path.join(this.sessionDirectoryPath, CONTEXT_SNAPSHOT_DIR, `${safeSessionId}.jsonl`);
  }

  getLogFilePath(): string {
    return this.traceFilePath;
  }

  getTraceFilePath(): string {
    return this.traceFilePath;
  }

  getRuntimeLogFilePath(): string {
    return this.runtimeLogFilePath;
  }

  getContextSnapshotFilePath(): string {
    return this.contextSnapshotFilePath;
  }

  getSessionDirectoryPath(): string {
    return this.sessionDirectoryPath;
  }

  /**
   * Records one trace: a user request until its ConversationRunner loop stops.
   * Runner loop turns are the per-provider-request iterations inside a trace.
   */
  logTurn(
    userInput: string | ContentBlock[],
    assistantText: string,
    toolCalls: ToolCallLog[],
    tokens: { prompt: number; completion: number },
    toolVisibility?: ToolVisibilityLog[],
    stateBoundary?: SessionStateBoundaryLog,
    reservedTraceId?: string,
  ): void {
    this.traceCounter++;
    const traceIndex = this.traceCounter;
    const traceId = reservedTraceId?.trim()
      || `${this.safeId(this.sessionId)}.trace.${Date.now().toString(36)}.${traceIndex}`;
    const legacyTurnId = `${this.safeId(this.sessionId)}.turn.${traceIndex}`;

    const userText = this.extractText(userInput);
    const userImages = this.extractImages(userInput);
    const events = this.consumePendingRuntimeEvents();

    const traceLog: SessionTraceLogEntry = {
      schema_version: SESSION_LOG_SCHEMA_VERSION,
      entry_type: 'trace',
      trace_id: traceId,
      trace_index: traceIndex,
      episode_id: traceId,
      episode_index: traceIndex,
      turn_id: legacyTurnId,
      turn: traceIndex,
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      session_type: this.sessionType,
      user: {
        text: userText,
        ...(userImages.length > 0 && { images: userImages }),
      },
      assistant: {
        text: assistantText,
        tool_calls: toolCalls.map((tc, index) => this.normalizeToolCall(tc, traceId, index)),
      },
      tokens,
      ...(toolVisibility?.length && { tool_visibility: toolVisibility.map(entry => this.normalizeToolVisibility(entry)) }),
      ...(stateBoundary && { state_boundary: this.normalizeStateBoundary(stateBoundary) }),
      ...(events.length && { events }),
    };

    this.appendTrace(traceLog);
  }

  private normalizeToolVisibility(entry: ToolVisibilityLog): ToolVisibilityLog {
    return {
      ...(entry.roleName && { roleName: entry.roleName }),
      ...(entry.activeSkillName && { activeSkillName: entry.activeSkillName }),
      ...(entry.mode && { mode: entry.mode }),
      visibleTools: entry.visibleTools,
      hiddenToolCount: Math.max(0, Number(entry.hiddenToolCount) || 0),
      ...(entry.gatedToolCount !== undefined && { gatedToolCount: Math.max(0, Number(entry.gatedToolCount) || 0) }),
    };
  }

  private normalizeStateBoundary(boundary: SessionStateBoundaryLog): SessionStateBoundaryLog {
    const normalized: SessionStateBoundaryLog = {
      durable_session: this.normalizeStateBoundaryRecord(boundary.durable_session, 'durable_session'),
      working_trace: this.normalizeStateBoundaryRecord(boundary.working_trace, 'working_trace'),
      provider_transcript: this.normalizeProviderTranscriptBoundary(boundary.provider_transcript),
    };

    if (boundary.visible_history) {
      normalized.visible_history = this.normalizeStateBoundaryRecord(boundary.visible_history, 'visible_history');
    }

    return normalized;
  }

  private normalizeProviderTranscriptBoundary(record: StateBoundaryRecord): StateBoundaryRecord {
    const normalized = this.normalizeStateBoundaryRecord(record, 'provider_transcript_ref');
    return {
      ...normalized,
      kind: 'provider_transcript_ref',
      mode: 'reference',
      raw_messages_stored: false,
      tool_result_payload_stored: false,
      raw_request_stored: false,
      raw_response_stored: false,
      raw_payload_stored: false,
    };
  }

  private normalizeStateBoundaryRecord(record: StateBoundaryRecord, fallbackKind: string): StateBoundaryRecord {
    return {
      kind: record.kind || fallbackKind,
      ref: this.normalizeStateBoundaryRef(record.ref),
      ...(record.scope && { scope: record.scope }),
      ...(record.schema && { schema: record.schema }),
      ...(record.mode && { mode: record.mode }),
      ...(record.status && { status: record.status }),
      ...(record.degraded !== undefined && { degraded: Boolean(record.degraded) }),
      ...(record.degradation_reason && { degradation_reason: record.degradation_reason }),
      ...(record.error_code && { error_code: record.error_code }),
      ...(record.fallback_chain?.length && { fallback_chain: record.fallback_chain }),
      ...(record.blocked_reason && { blocked_reason: record.blocked_reason }),
      ...(record.raw_messages_stored !== undefined && { raw_messages_stored: Boolean(record.raw_messages_stored) }),
      ...(record.tool_result_payload_stored !== undefined && { tool_result_payload_stored: Boolean(record.tool_result_payload_stored) }),
      ...(record.raw_request_stored !== undefined && { raw_request_stored: Boolean(record.raw_request_stored) }),
      ...(record.raw_response_stored !== undefined && { raw_response_stored: Boolean(record.raw_response_stored) }),
      ...(record.raw_payload_stored !== undefined && { raw_payload_stored: Boolean(record.raw_payload_stored) }),
    };
  }

  private normalizeStateBoundaryRef(value: string): string {
    const raw = String(value ?? '').trim().replace(/\\/g, '/');
    if (!raw) return '[missing-ref]';

    const hashIndex = raw.indexOf('#');
    const rawPath = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
    const fragment = hashIndex >= 0 ? raw.slice(hashIndex) : '';
    const normalizedPath = this.normalizePathRef(rawPath);
    return normalizedPath.startsWith('[') ? normalizedPath : `${normalizedPath}${fragment}`;
  }

  private normalizePathRef(value: string): string {
    let ref = value.trim();
    if (!ref) return '[missing-ref]';

    if (ref.startsWith('file://')) {
      try {
        ref = new URL(ref).pathname;
      } catch {
        return ref;
      }
    }

    if (path.isAbsolute(ref) || path.win32.isAbsolute(ref)) {
      const relative = path.relative(process.cwd(), ref);
      if (!relative.startsWith('..') && !path.isAbsolute(relative) && !path.win32.isAbsolute(relative)) {
        return relative.replace(/\\/g, '/') || '.';
      }
      return ref.replace(/\\/g, '/');
    }

    const normalized = path.posix.normalize(ref.replace(/\\/g, '/')).replace(/^\.\/+/, '');
    if (!normalized || normalized === '.') return '[missing-ref]';
    return normalized;
  }

  logRuntime(level: string, message: string): void {
    this.appendRuntimeLine(level, message);
  }

  logRuntimeEvent(eventType: string, payload: Record<string, unknown> = {}): SessionRuntimeEventLogEntry {
    const runtimeEntry: SessionRuntimeEventLogEntry = {
      ...this.normalizeRuntimeEventPayload(payload),
      schema_version: SESSION_LOG_SCHEMA_VERSION,
      entry_type: 'runtime_event',
      event_id: this.nextRuntimeEventId(),
      event_type: eventType,
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      session_type: this.sessionType,
    };
    this.stageRuntimeEvent(runtimeEntry);
    return runtimeEntry;
  }

  logContextCompaction(input: ContextCompactionLogInput): SessionRuntimeEventLogEntry {
    const timestamp = new Date().toISOString();
    const eventId = this.nextRuntimeEventId();
    const snapshot = input.status === 'success' && input.messages
      ? this.writeContextSnapshot(eventId, timestamp, input)
      : undefined;
    const boundary = input.messages ? this.latestCompactBoundary(input.messages) : undefined;
    const runtimeEntry: SessionRuntimeEventLogEntry = {
      ...this.normalizeRuntimeEventPayload({
        source: input.source,
        status: input.status,
        reason: input.reason || 'threshold_exceeded',
        ...(input.surface && { surface: input.surface }),
        ...(input.turn !== undefined && { turn: input.turn }),
        ...(input.tokens_before !== undefined && { tokens_before: input.tokens_before }),
        ...(input.tokens_after !== undefined && { tokens_after: input.tokens_after }),
        ...(input.message_tokens_before !== undefined && { message_tokens_before: input.message_tokens_before }),
        ...(input.message_tokens_after !== undefined && { message_tokens_after: input.message_tokens_after }),
        ...(input.tool_tokens_before !== undefined && { tool_tokens_before: input.tool_tokens_before }),
        ...(input.tool_tokens_after !== undefined && { tool_tokens_after: input.tool_tokens_after }),
        ...(input.max_tokens !== undefined && { max_tokens: input.max_tokens }),
        ...(input.threshold_ratio !== undefined && { threshold_ratio: input.threshold_ratio }),
        ...(input.threshold_tokens !== undefined && { threshold_tokens: input.threshold_tokens }),
        ...(input.usage_percent_before !== undefined && { usage_percent_before: input.usage_percent_before }),
        ...(input.usage_percent_after !== undefined && { usage_percent_after: input.usage_percent_after }),
        ...(input.messages_before !== undefined && { messages_before: input.messages_before }),
        ...(input.messages_after !== undefined && { messages_after: input.messages_after }),
        ...(boundary?.text && { boundary_preview: this.truncate(boundary.text, 500) }),
        ...(boundary?.olderMessagesSummarized !== undefined && { older_messages_summarized: boundary.olderMessagesSummarized }),
        ...(boundary?.preCompactTokens !== undefined && { pre_compact_tokens: boundary.preCompactTokens }),
        ...(boundary?.fallbackUsed !== undefined && { fallback_used: boundary.fallbackUsed }),
        ...(snapshot?.ref && {
          snapshot_kind: 'compact_after',
          snapshot_id: snapshot.snapshotId,
          snapshot_ref: snapshot.ref,
          snapshot_status: 'written',
        }),
        ...(snapshot?.error && {
          snapshot_status: 'failed',
          snapshot_error: snapshot.error,
        }),
        ...(input.error_code && { error_code: input.error_code }),
        ...(input.error_message && { error_message: this.truncate(input.error_message, 500) }),
      }),
      schema_version: SESSION_LOG_SCHEMA_VERSION,
      entry_type: 'runtime_event',
      event_id: eventId,
      event_type: 'context_compaction',
      timestamp,
      session_id: this.sessionId,
      session_type: this.sessionType,
    };
    this.stageRuntimeEvent(runtimeEntry);
    return runtimeEntry;
  }

  private stageRuntimeEvent(entry: SessionRuntimeEventLogEntry): void {
    this.pendingRuntimeEvents.push(entry);
    this.appendRuntimeLine('EVENT', this.runtimeEventLine(entry));
  }

  private nextRuntimeEventId(): string {
    return `${this.safeId(this.sessionId)}.runtime_event.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  }

  private writeContextSnapshot(
    eventId: string,
    timestamp: string,
    input: ContextCompactionLogInput,
  ): { snapshotId?: string; ref?: string; error?: string } {
    const messages = input.messages || [];
    const snapshotId = `${eventId}.compact_after`;
    const safeSessionId = this.safeId(this.sessionId);
    const ref = `${path.posix.join(CONTEXT_SNAPSHOT_DIR, `${safeSessionId}.jsonl`)}#${snapshotId}`;
    const entry: ContextSnapshotLogEntry = {
      schema_version: SESSION_LOG_SCHEMA_VERSION,
      entry_type: 'context_snapshot',
      snapshot_id: snapshotId,
      event_id: eventId,
      timestamp,
      session_id: this.sessionId,
      session_type: this.sessionType,
      kind: 'compact_after',
      source: input.source,
      status: input.status,
      message_count: messages.length,
      messages: messages.map(message => this.normalizeSnapshotMessage(message)),
    };

    try {
      fs.mkdirSync(path.dirname(this.contextSnapshotFilePath), { recursive: true });
      fs.appendFileSync(this.contextSnapshotFilePath, JSON.stringify(entry) + '\n', 'utf-8');
      return { snapshotId, ref };
    } catch (error) {
      return {
        snapshotId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private normalizeSnapshotMessage(message: Message): Message {
    if (!Array.isArray(message.content)) {
      return message;
    }

    return {
      ...message,
      content: message.content.map(block => {
        if (block.type === 'image' && (block as any).source?.data) {
          const filePath = (block as any).filePath || 'unknown';
          return { type: 'text' as const, text: `[图片: ${filePath}]` };
        }
        return block;
      }),
    };
  }

  private latestCompactBoundary(messages: Message[]): {
    text: string;
    olderMessagesSummarized?: number;
    preCompactTokens?: number;
    fallbackUsed?: boolean;
  } | undefined {
    const boundary = [...messages]
      .reverse()
      .find(message => message.role === 'system'
        && typeof message.content === 'string'
        && message.content.startsWith(COMPACT_BOUNDARY_PREFIX));
    if (!boundary || typeof boundary.content !== 'string') return undefined;
    const text = boundary.content;
    const olderMatch = text.match(/\[compact_boundary\]\s+(\d+)\s+older messages summarized/i);
    const tokenMatch = text.match(/Pre-compact tokens:\s*(\d+)/i);
    return {
      text,
      ...(olderMatch && { olderMessagesSummarized: Number(olderMatch[1]) }),
      ...(tokenMatch && { preCompactTokens: Number(tokenMatch[1]) }),
      fallbackUsed: /deterministic fallback/i.test(text),
    };
  }

  private normalizeRuntimeEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {};
    }
    return payload;
  }

  private extractText(content: string | ContentBlock[]): string {
    if (typeof content === 'string') return content;
    return content
      .filter(block => block.type === 'text')
      .map(block => (block as any).text)
      .join('');
  }

  private extractImages(content: string | ContentBlock[]): string[] {
    if (typeof content === 'string') return [];
    return content
      .filter(block => block.type === 'image')
      .map((block, idx) => `image_${idx}`);
  }

  private normalizeToolCall(tc: ToolCallLog, traceId: string, index: number): ToolCallLog {
    const rawResult = String(tc.result ?? '');
    const result = this.truncate(rawResult, MAX_TOOL_RESULT_LENGTH);
    const status = tc.status || this.inferToolStatus(result);
    const rawErrorCode = tc.error_code || this.inferErrorCode(result);
    const errorCode = status === 'success' ? undefined : rawErrorCode;
    const blockedReason = status === 'success' ? undefined : tc.blocked_reason;
    const artifactManifest = tc.artifact_manifest?.length
      ? tc.artifact_manifest.map(item => ({
        ...item,
        path: item.path,
      }))
      : this.inferArtifactManifest(tc.name, tc.arguments, rawResult);
    const deliveryEvidence = tc.delivery_evidence?.length
      ? tc.delivery_evidence.map(item => this.normalizeDeliveryEvidence(item))
      : [];
    const externalDeliveryReceipts = tc.external_delivery_receipts?.length
      ? tc.external_delivery_receipts.map(item => this.normalizeExternalDeliveryReceipt(item))
      : [];

    return {
      ...tc,
      arguments: tc.arguments,
      tool_call_id: tc.tool_call_id || tc.id || `${traceId}.tool.${index + 1}`,
      result,
      status,
      ...(tc.duration_ms !== undefined && { duration_ms: tc.duration_ms }),
      error_code: errorCode,
      ...(tc.retryable !== undefined && { retryable: tc.retryable }),
      ...(tc.retry_count !== undefined && { retry_count: tc.retry_count }),
      ...(tc.retry_budget !== undefined && { retry_budget: tc.retry_budget }),
      ...(tc.retry_budget_exhausted !== undefined && { retry_budget_exhausted: tc.retry_budget_exhausted }),
      blocked_reason: blockedReason,
      ...(artifactManifest.length > 0 && { artifact_manifest: artifactManifest }),
      ...(deliveryEvidence.length > 0 && { delivery_evidence: deliveryEvidence }),
      ...(externalDeliveryReceipts.length > 0 && { external_delivery_receipts: externalDeliveryReceipts }),
      ...(tc.skill_id && { skill_id: tc.skill_id }),
    };
  }

  private inferToolStatus(result: string): ToolCallStatus {
    if (/timeout|超时/i.test(result)) return 'timeout';
    if (/blocked|执行被阻止/i.test(result)) return 'blocked';
    return /(失败|错误|error|fail|denied|blocked|not recognized|不是内部或外部命令|timeout|超时)/i.test(result)
      ? 'failure'
      : 'success';
  }

  private inferErrorCode(result: string): string | undefined {
    if (/timeout|超时/i.test(result)) return 'TOOL_TIMEOUT';
    if (/429|rate limit|too many requests|限流/i.test(result)) return 'RATE_LIMIT';
    if (/读取路径超出工作目录|outside.*workspace|permission denied|denied|blocked/i.test(result)) return 'PATH_DENIED';
    if (/not recognized as an internal or external command|不是内部或外部命令/i.test(result)) return 'PLATFORM_COMMAND_MISMATCH';
    if (/API调用失败|Connection error|ENOTFOUND|ECONNRESET|ETIMEDOUT|PROVIDER_ERROR/i.test(result)) return 'PROVIDER_ERROR';
    if (/(失败|错误|error|fail)/i.test(result)) return 'TOOL_ERROR';
    return undefined;
  }

  private inferArtifactManifest(toolName: string, args: any, result: string): ArtifactManifestItem[] {
    const action = this.inferArtifactAction(toolName, result);
    if (!action) return [];

    const includeArgs = /^(send_file|write_file|edit_file)$/i.test(toolName);
    const paths = includeArgs
      ? [...this.extractArtifactPaths(this.stringify(args)), ...this.extractArtifactPaths(result)]
      : this.extractArtifactPaths(result);

    return this.unique(paths)
      .map(filePath => ({
        path: filePath,
        type: this.artifactType(filePath),
        action,
      }))
      .slice(0, 20);
  }

  private inferArtifactAction(toolName: string, result: string): ArtifactAction | undefined {
    if (toolName === 'send_file') return 'sent';
    if (/^(write_file|edit_file)$/i.test(toolName)) return 'updated';
    if (/saved|created|generated|wrote|写入|保存|生成|导出/i.test(result)) return 'created';
    return undefined;
  }

  private normalizeDeliveryEvidence(item: DeliveryEvidence): DeliveryEvidence {
    return {
      ...item,
      ...(item.text_preview && { text_preview: this.truncate(item.text_preview, 500) }),
    };
  }

  private normalizeExternalDeliveryReceipt(item: ExternalDeliveryReceipt): ExternalDeliveryReceipt {
    return item;
  }

  private extractArtifactPaths(text: string): string[] {
    const matches = text.match(/(?:[A-Za-z]:[\\/]+[^\s"'`]+|\/[^\s"'`]+|[\w.-]+\/[^\s"'`]+|[\w.-]+\.(?:png|pdf|r|R|csv|tsv|xlsx|html|zip|rds|Rds|RDS))/g) || [];
    return matches
      .filter(value => /\.(?:png|pdf|r|R|csv|tsv|xlsx|html|zip|rds|Rds|RDS)(?:$|[?#])/i.test(value))
      .map(value => value.replace(/\\/g, '/').replace(/[),.;:]+$/g, ''))
      .filter(Boolean);
  }

  private artifactType(filePath: string): string {
    const match = filePath.match(/\.([A-Za-z0-9]+)(?:$|[?#])/);
    return match ? match[1].toLowerCase() : 'file';
  }

  private stringify(value: any): string {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private safeId(value: string): string {
    return value.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'session';
  }

  private unique(values: string[]): string[] {
    return Array.from(new Set(values));
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '... [truncated]';
  }

  private consumePendingRuntimeEvents(): SessionRuntimeEventLogEntry[] {
    const events = this.pendingRuntimeEvents;
    this.pendingRuntimeEvents = [];
    return events;
  }

  private runtimeEventLine(entry: SessionRuntimeEventLogEntry): string {
    const summary: Record<string, unknown> = {
      event_type: entry.event_type,
      ...(typeof entry.surface === 'string' && { surface: entry.surface }),
      ...(typeof entry.status === 'string' && { status: entry.status }),
      ...(typeof entry.error_code === 'string' && { error_code: entry.error_code }),
      ...(typeof entry.duration_ms === 'number' && { duration_ms: entry.duration_ms }),
    };
    return JSON.stringify(summary);
  }

  private appendRuntimeLine(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const normalizedLevel = String(level || 'INFO').toUpperCase();
    const safeSessionId = this.safeId(this.sessionId);
    const line = `${timestamp} ${normalizedLevel} [${this.sessionType} session=${safeSessionId}] ${message}\n`;
    try {
      fs.appendFileSync(this.runtimeLogFilePath, line);
    } catch (error) {
      // 日志写入失败不影响主流程
      console.error('[SessionTurnLogger] Failed to write runtime log:', error);
    }
  }

  private appendTrace(entry: SessionTraceLogEntry): void {
    let written = false;
    try {
      fs.appendFileSync(this.traceFilePath, JSON.stringify(entry) + '\n');
      written = true;
    } catch (error) {
      // 日志写入失败不影响主流程
      console.error('[SessionTurnLogger] Failed to write trace log:', error);
    }
    if (written) {
      projectSessionLogEntryToObservability(entry);
    }
  }
}
