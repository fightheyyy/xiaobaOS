import { registerMemoryTarget } from './memory-target';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const CONVERSATION_MESSAGE_SCHEMA = 'xiaoba.conversation_message.v1' as const;
export const CONVERSATION_BATCH_SCHEMA = 'xiaoba.conversation_batch.v1' as const;

const MAX_CONTENT_PARTS = 16;
const MAX_VISIBLE_CONTENT_BYTES = 64 * 1024;
const MAX_IDENTIFIER_BYTES = 160;
const MAX_NAME_BYTES = 160;
const MAX_FILE_NAME_BYTES = 512;
const MAX_FILE_REF_BYTES = 2048;
const MAX_PLATFORM_MESSAGE_IDS = 16;
const MAX_PLATFORM_MESSAGE_ID_BYTES = 512;

export type ConversationSurface = 'cli' | 'feishu' | 'weixin' | 'pet';
export type ConversationRole = 'user' | 'assistant';
export type ConversationDeliveryStatus = 'received' | 'delivered';

export type ConversationContent =
  | { type: 'text'; text: string }
  | { type: 'file'; name: string; ref?: string };

export type ConversationContentPart = ConversationContent;

export interface ConversationDelivery {
  status: ConversationDeliveryStatus;
  platform_message_ids?: string[];
}

export interface ConversationMessage {
  schema: typeof CONVERSATION_MESSAGE_SCHEMA;
  message_id: string;
  conversation_id: string;
  sequence: number;
  occurred_at: string;
  runtime: 'xiaobaos';
  agent_id: string;
  agent_name?: string;
  surface: ConversationSurface;
  role: ConversationRole;
  role_name?: string;
  content: ConversationContent[];
  delivery: ConversationDelivery;
  trace_id?: string;
}

export interface ConversationBatch {
  schema: typeof CONVERSATION_BATCH_SCHEMA;
  messages: ConversationMessage[];
}

export interface RecordConversationMessageInput {
  surface: ConversationSurface;
  sessionKey: string;
  role: ConversationRole;
  content: ConversationContent[];
  delivery: ConversationDelivery;
  traceId?: string;
  messageId?: string;
  occurredAt?: string;
  agentName?: string;
  roleName?: string;
}

export interface RecordConversationMessageResult {
  message: ConversationMessage;
  created: boolean;
}

export type ConversationRecordInput = RecordConversationMessageInput;
export type ConversationRecordResult = RecordConversationMessageResult;

export interface ConversationJournalOptions {
  workingDirectory?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  exportTimeoutMs?: number;
}

interface JournalState {
  messages: ConversationMessage[];
  maxSequence: number;
  hasContent: boolean;
  endsWithNewline: boolean;
}

/** Raised when one stable id is reused for different visible-message facts. */
export class ConversationMessageConflictError extends Error {
  constructor(messageId: string) {
    super(`Conversation message id conflict: ${messageId}`);
    this.name = 'ConversationMessageConflictError';
  }
}

/**
 * Local-first append-only journal for messages that were actually visible to a user.
 * Catena export is deliberately a lossy, fail-open projection of successful appends.
 */
export class ConversationJournal {
  private readonly workingDirectory: string;
  private readonly enabled: boolean;
  private readonly agentId: string;
  private readonly now: () => Date;
  private readonly fetchImpl?: typeof fetch;
  private readonly catenaEndpoint?: string;
  private readonly catenaApiKey?: string;
  private readonly exportTimeoutMs: number;
  private readonly fileLocks = new Map<string, Promise<void>>();

  constructor(options: ConversationJournalOptions = {}) {
    const env = options.env || process.env;
    this.workingDirectory = path.resolve(options.workingDirectory || process.cwd());
    this.enabled = recordingEnabled(env);
    this.agentId = normalizeAgentIdentifier(firstNonEmpty(
      env.XIAOBA_CONVERSATION_AGENT_ID,
      env.XIAOBA_OBSERVABILITY_SERVICE_NAME,
      env.OTEL_SERVICE_NAME,
    ) || 'xiaobaos');
    this.now = options.now || (() => new Date());
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.exportTimeoutMs = positiveInteger(options.exportTimeoutMs, 5_000);

    const baseUrl = firstNonEmpty(env.CATENA_BASE_URL);
    const apiKey = firstNonEmpty(env.CATENA_API_KEY);
    if (baseUrl && apiKey) {
      this.catenaEndpoint = catenaEndpoint(baseUrl);
      this.catenaApiKey = apiKey;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  conversationIdFor(surface: ConversationSurface, sessionKey: string): string {
    const normalizedSurface = requireSurface(surface);
    return `conv_${conversationHash(normalizedSurface, requiredString(sessionKey, 'sessionKey'))}`;
  }

  filePathFor(surface: ConversationSurface, sessionKey: string): string {
    const normalizedSurface = requireSurface(surface);
    return path.join(
      this.workingDirectory,
      'data',
      'conversations',
      normalizedSurface,
      `${conversationHash(normalizedSurface, requiredString(sessionKey, 'sessionKey'))}.jsonl`,
    );
  }

  async record(input: RecordConversationMessageInput): Promise<RecordConversationMessageResult> {
    const surface = requireSurface(input.surface);
    const sessionKey = requiredString(input.sessionKey, 'sessionKey');
    const content = normalizeContent(input.content);
    const delivery = normalizeDelivery(input.delivery);
    validateRoleDelivery(input.role, delivery.status);
    const traceId = normalizeTraceId(input.traceId);
    const conversationId = this.conversationIdFor(surface, sessionKey);
    const occurredAt = normalizeOccurredAt(input.occurredAt, this.now);
    const messageId = requireIdentifier(
      optionalString(input.messageId) || stableId(
        conversationId,
        traceId || createTraceId(),
        input.role,
        content,
        delivery,
      ),
      'messageId',
      MAX_IDENTIFIER_BYTES,
    );
    const agentName = normalizeOptionalVisibleText(input.agentName, MAX_NAME_BYTES);
    const roleName = normalizeOptionalVisibleText(input.roleName, MAX_NAME_BYTES);
    const baseMessage = {
      schema: CONVERSATION_MESSAGE_SCHEMA,
      message_id: messageId,
      conversation_id: conversationId,
      occurred_at: occurredAt,
      runtime: 'xiaobaos' as const,
      agent_id: this.agentId,
      ...(agentName && { agent_name: agentName }),
      surface,
      role: input.role,
      ...(roleName && { role_name: roleName }),
      content,
      delivery,
      ...(traceId && { trace_id: traceId }),
    };

    if (!this.enabled) {
      return {
        message: { ...baseMessage, sequence: 1 },
        created: false,
      };
    }

    const filePath = this.filePathFor(surface, sessionKey);
    const localResult = await this.withFileLock(filePath, () => {
      const state = readJournalState(filePath);
      const existing = state.messages.find(message => message.message_id === messageId);
      if (existing) {
        if (!sameMessageFact(existing, baseMessage)) {
          throw new ConversationMessageConflictError(messageId);
        }
        return { message: existing, created: false };
      }

      const message: ConversationMessage = {
        ...baseMessage,
        sequence: state.maxSequence + 1,
      };
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const separator = state.hasContent && !state.endsWithNewline ? '\n' : '';
      fs.appendFileSync(filePath, `${separator}${JSON.stringify(message)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      return { message, created: true };
    });

    registerMemoryTarget(this.workingDirectory, { surface, sessionKey });
    if (localResult.created) void this.exportMessage(localResult.message);
    return localResult;
  }

  private async exportMessage(message: ConversationMessage): Promise<void> {
    if (!this.catenaEndpoint || !this.catenaApiKey || !this.fetchImpl) return;
    const batch: ConversationBatch = {
      schema: CONVERSATION_BATCH_SCHEMA,
      messages: [message],
    };
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    try {
      const response = await Promise.race([
        this.fetchImpl(this.catenaEndpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.catenaApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(batch),
          signal: controller.signal,
        }),
        new Promise<Response>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error('Catena conversation export timed out'));
          }, this.exportTimeoutMs);
          timeout.unref?.();
        }),
      ]);
      if (!response.ok) return;
    } catch {
      // Catena is a best-effort projection. The local append is authoritative.
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async withFileLock<T>(filePath: string, operation: () => T): Promise<T> {
    const previous = this.fileLocks.get(filePath) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const tail = previous.then(() => gate, () => gate);
    this.fileLocks.set(filePath, tail);
    await previous.catch(() => undefined);
    try {
      return operation();
    } finally {
      release();
      if (this.fileLocks.get(filePath) === tail) this.fileLocks.delete(filePath);
    }
  }
}

let defaultJournal: ConversationJournal | undefined;

export function getConversationJournal(): ConversationJournal {
  if (!defaultJournal) defaultJournal = new ConversationJournal();
  return defaultJournal;
}

export function resetConversationJournalForTests(
  options: ConversationJournalOptions = {},
): ConversationJournal {
  defaultJournal = new ConversationJournal(options);
  return defaultJournal;
}

export async function recordConversationMessage(
  input: RecordConversationMessageInput,
): Promise<RecordConversationMessageResult> {
  return getConversationJournal().record(input);
}

export function stableId(...parts: unknown[]): string {
  const digest = crypto
    .createHash('sha256')
    .update(canonicalJson(parts))
    .digest('hex')
    .slice(0, 32);
  return `msg_${digest}`;
}

export function createConversationMessageId(...parts: unknown[]): string {
  return stableId(...parts);
}

export function createTraceId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export function createConversationTraceId(
  surface: ConversationSurface,
  sessionKey: string,
  sourceEventId?: string,
): string {
  const normalizedSurface = requireSurface(surface);
  const sourceId = optionalString(sourceEventId);
  if (!sourceId) return createTraceId();
  const digest = crypto
    .createHash('sha256')
    .update(canonicalJson(['xiaobaos', normalizedSurface, requiredString(sessionKey, 'sessionKey'), sourceId]))
    .digest('hex')
    .slice(0, 32);
  return digest;
}

function conversationHash(surface: ConversationSurface, sessionKey: string): string {
  return crypto
    .createHash('sha256')
    .update(canonicalJson(['xiaobaos', surface, sessionKey]))
    .digest('hex')
    .slice(0, 32);
}

function recordingEnabled(env: NodeJS.ProcessEnv): boolean {
  const configured = env.XIAOBA_CONVERSATION_RECORDING_ENABLED;
  if (configured !== undefined && configured.trim() !== '') {
    return parseBoolean(configured, true);
  }
  return !isTestEnvironment(env);
}

function isTestEnvironment(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV?.trim().toLowerCase() === 'test'
    || env.NODE_TEST_CONTEXT !== undefined
    || env.VITEST !== undefined
    || env.JEST_WORKER_ID !== undefined;
}

function parseBoolean(value: string, fallback: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function catenaEndpoint(baseUrl: string): string | undefined {
  try {
    const normalized = new URL(baseUrl);
    if (normalized.protocol !== 'http:' && normalized.protocol !== 'https:') return undefined;
    return `${normalized.toString().replace(/\/+$/, '')}/v1/ingest/conversations`;
  } catch {
    return undefined;
  }
}

function readJournalState(filePath: string): JournalState {
  if (!fs.existsSync(filePath)) {
    return { messages: [], maxSequence: 0, hasContent: false, endsWithNewline: true };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const messages: ConversationMessage[] = [];
  let maxSequence = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Partial<ConversationMessage>;
      if (value.schema !== CONVERSATION_MESSAGE_SCHEMA) continue;
      if (typeof value.message_id !== 'string') continue;
      if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) continue;
      messages.push(value as ConversationMessage);
      maxSequence = Math.max(maxSequence, Number(value.sequence));
    } catch {
      // Preserve malformed evidence in place and continue from the last valid row.
    }
  }
  return {
    messages,
    maxSequence,
    hasContent: raw.length > 0,
    endsWithNewline: raw.length === 0 || raw.endsWith('\n'),
  };
}

function sameMessageFact(
  existing: ConversationMessage,
  candidate: Omit<ConversationMessage, 'sequence'>,
): boolean {
  const { sequence: _sequence, occurred_at: _occurredAt, ...existingFact } = existing;
  const { occurred_at: _candidateOccurredAt, ...candidateFact } = candidate;
  return canonicalJson(existingFact) === canonicalJson(candidateFact);
}

function normalizeContent(content: ConversationContent[]): ConversationContent[] {
  if (!Array.isArray(content) || content.length === 0 || content.length > MAX_CONTENT_PARTS) {
    throw new TypeError(`content must contain between 1 and ${MAX_CONTENT_PARTS} visible items`);
  }
  let totalBytes = 0;
  const normalized = content.map((item, index) => {
    if (item?.type === 'text' && typeof item.text === 'string') {
      const text = item.text.trim();
      if (!text) throw new TypeError(`content[${index}].text must be non-empty`);
      totalBytes += Buffer.byteLength(text, 'utf8');
      return { type: 'text' as const, text };
    }
    if (item?.type === 'file') {
      const name = normalizeRequiredVisibleText(
        item.name,
        MAX_FILE_NAME_BYTES,
        `content[${index}].name`,
      );
      const ref = normalizeOptionalVisibleText(item.ref, MAX_FILE_REF_BYTES);
      totalBytes += Buffer.byteLength(name, 'utf8') + (ref ? Buffer.byteLength(ref, 'utf8') : 0);
      return { type: 'file' as const, name, ...(ref && { ref }) };
    }
    throw new TypeError(`content[${index}] is not a supported visible item`);
  });
  if (totalBytes > MAX_VISIBLE_CONTENT_BYTES) {
    throw new TypeError(`visible content must not exceed ${MAX_VISIBLE_CONTENT_BYTES} bytes`);
  }
  return normalized;
}

function normalizeDelivery(delivery: ConversationDelivery): ConversationDelivery {
  if (!delivery || (delivery.status !== 'received' && delivery.status !== 'delivered')) {
    throw new TypeError('delivery.status must be received or delivered');
  }
  const ids = Array.from(new Set((delivery.platform_message_ids || [])
    .map(value => normalizeOptionalVisibleText(value, MAX_PLATFORM_MESSAGE_ID_BYTES))
    .filter((value): value is string => Boolean(value))))
    .slice(0, MAX_PLATFORM_MESSAGE_IDS);
  return {
    status: delivery.status,
    ...(ids.length > 0 && { platform_message_ids: ids }),
  };
}

function validateRoleDelivery(role: ConversationRole, status: ConversationDeliveryStatus): void {
  if (role !== 'user' && role !== 'assistant') {
    throw new TypeError('role must be user or assistant');
  }
  if (role === 'user' && status !== 'received') {
    throw new TypeError('user messages must use received delivery status');
  }
  if (role === 'assistant' && status !== 'delivered') {
    throw new TypeError('assistant messages must use delivered delivery status');
  }
}

function requireSurface(value: ConversationSurface): ConversationSurface {
  if (value !== 'cli' && value !== 'feishu' && value !== 'weixin' && value !== 'pet') {
    throw new TypeError('surface must be cli, feishu, weixin, or pet');
  }
  return value;
}

function normalizeOccurredAt(value: string | undefined, now: () => Date): string {
  const date = value === undefined ? now() : new Date(value);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('occurredAt must be a valid date-time');
  }
  return date.toISOString();
}

function requiredString(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeTraceId(value: string | undefined): string | undefined {
  const traceId = optionalString(value);
  if (traceId && (!/^[0-9a-f]{32}$/.test(traceId) || /^0{32}$/.test(traceId))) {
    throw new TypeError('traceId must be 32 lowercase hexadecimal characters');
  }
  return traceId;
}

function normalizeAgentIdentifier(value: string): string {
  const normalized = Array.from(value.trim())
    .map(char => /[A-Za-z0-9._:-]/.test(char) ? char : '_')
    .join('');
  return truncateUtf8(normalized, MAX_IDENTIFIER_BYTES) || 'xiaobaos';
}

function requireIdentifier(value: string, name: string, maxBytes: number): string {
  if (
    !value
    || Buffer.byteLength(value, 'utf8') > maxBytes
    || !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new TypeError(`${name} is not a valid Conversation identifier`);
  }
  return value;
}

function normalizeRequiredVisibleText(value: string, maxBytes: number, name: string): string {
  const normalized = normalizeOptionalVisibleText(value, maxBytes);
  if (!normalized) throw new TypeError(`${name} must be non-empty`);
  return normalized;
}

function normalizeOptionalVisibleText(value: string | undefined, maxBytes: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\x00\r\n]+/g, ' ').trim();
  if (!normalized) return undefined;
  return truncateUtf8(normalized, maxBytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  let used = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > maxBytes) break;
    result += char;
    used += size;
  }
  return result;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = optionalString(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(value));
}

function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForCanonicalJson);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) result[key] = sortForCanonicalJson(item);
  }
  return result;
}
