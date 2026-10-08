import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { Message } from '../types';

const MAX_MEMORY_TEXT = 500;
const MAX_RECORDS_PER_KIND = 50;

export type MemoryFinalizationReason =
  | 'ttl_cleanup'
  | 'manual_archive'
  | 'session_close'
  | 'worker_complete'
  | 'recovery';

export type LongTermMemoryKind = 'preference' | 'habit' | 'instruction' | 'fact';
export type LongTermMemoryConfidence = 'high' | 'medium';

export interface MemorySourceRef {
  kind: 'compact_message' | 'transcript' | 'markdown' | 'tool' | 'conversation';
  messageIds?: string[];
  reason?: string;
  prefix?: string;
  messageIndex?: number;
  role?: Message['role'];
  toolName?: string;
}

export interface LongTermMemoryRecord {
  id: string;
  kind: LongTermMemoryKind;
  text: string;
  source: MemorySourceRef;
  confidence: LongTermMemoryConfidence;
  firstSeenAt: string;
  updatedAt: string;
}

export interface SessionLongTermMemory {
  version: 1;
  scope: 'session-person';
  sessionKeyHash: string;
  loadPolicy: 'on_demand';
  updatedAt: string;
  records: LongTermMemoryRecord[];
}

export interface MemoryFinalizationResult {
  version: 1;
  sessionKeyHash: string;
  sessionType?: string;
  source: MemoryFinalizationReason;
  updatedAt: string;
  memoryPath: string;
  added: LongTermMemoryRecord[];
  records: LongTermMemoryRecord[];
  totalRecords: number;
}

export interface FinalizeSessionOptions {
  rootDir?: string;
  reason?: MemoryFinalizationReason;
  sessionType?: string;
  now?: Date;
}

export interface MemoryMaintenanceAction {
  action: 'remember' | 'replace' | 'archive' | 'forget';
  recordId?: string;
  text?: string;
  kind?: LongTermMemoryKind;
  confidence?: LongTermMemoryConfidence;
  evidence: string[];
  reason: string;
}

export interface RememberMemoryOptions {
  confidence?: LongTermMemoryConfidence;
  evidence?: string;
  replaces?: string;
  kind?: LongTermMemoryKind;
  now?: Date;
  rootDir?: string;
}

export interface RememberMemoryResult {
  version: 1;
  sessionKeyHash: string;
  updatedAt: string;
  memoryPath: string;
  action: 'created' | 'updated';
  record: LongTermMemoryRecord;
  totalRecords: number;
}

interface IndexedText {
  text: string;
  source: MemorySourceRef;
}

const COMPACT_PREFIXES = {
  sessionMemory: '[session_memory]',
} as const;

const SECTION_BY_KIND: Record<LongTermMemoryKind, string> = {
  preference: 'Stable Preferences',
  habit: 'Work Habits',
  instruction: 'Instructions',
  fact: 'Facts',
};

const KIND_BY_SECTION = Object.fromEntries(
  Object.entries(SECTION_BY_KIND).map(([kind, title]) => [title, kind]),
) as Record<string, LongTermMemoryKind>;

const DURABLE_MEMORY_PATTERN = /(记住|以后|今后|默认|总是|始终|每次|偏好|喜欢|习惯|常用|叫我|称呼|不要|别|避免|prefer|preference|remember|always|default|habit|usually|call me|my name is)/i;
const TRANSIENT_PATTERN = /(当前任务|这次任务|下一步|待办|todo|刚才|本轮|临时|报错|失败|修复|实现|运行测试|npm test|文件路径|commit|pull request|\bPR\b)/i;

export class MemoryFinalizer {
  static hashSessionKey(sessionKey: string): string {
    return createHash('sha256').update(sessionKey).digest('hex').slice(0, 24);
  }

  static getSessionDir(sessionKey: string, rootDir?: string): string {
    const memoryRoot = path.resolve(rootDir || process.cwd(), 'memory');
    return path.join(memoryRoot, 'sessions', this.hashSessionKey(sessionKey));
  }

  static getMemoryPath(sessionKey: string, rootDir?: string): string {
    return path.join(this.getSessionDir(sessionKey, rootDir), 'MEMORY.md');
  }

  static loadSessionMemory(sessionKey: string, rootDir?: string): SessionLongTermMemory | null {
    const memoryPath = this.getMemoryPath(sessionKey, rootDir);
    if (!fs.existsSync(memoryPath)) {
      return null;
    }

    const records = readMemoryRecords(memoryPath);
    const raw = fs.readFileSync(memoryPath, 'utf-8');
    const updatedAt = readFrontmatterValue(raw, 'updatedAt') || newestUpdatedAt(records) || new Date(0).toISOString();
    return {
      version: 1,
      scope: 'session-person',
      sessionKeyHash: this.hashSessionKey(sessionKey),
      loadPolicy: 'on_demand',
      updatedAt,
      records,
    };
  }

  static finalizeSession(
    sessionKey: string,
    messages: Message[],
    options: FinalizeSessionOptions = {},
  ): MemoryFinalizationResult | null {
    if (messages.length === 0) {
      return null;
    }

    const now = options.now ?? new Date();
    const timestamp = now.toISOString();
    const sessionKeyHash = this.hashSessionKey(sessionKey);
    const memoryPath = this.getMemoryPath(sessionKey, options.rootDir);
    const candidates = extractLongTermRecords(messages, timestamp);
    if (candidates.length === 0) return null;
    return withMemoryLock(memoryPath, () => {
      const existing = fs.existsSync(memoryPath) ? readMemoryRecords(memoryPath) : [];
      const excluded = readExcludedIds(memoryPath);
      const { records, added } = mergeRecords(existing, candidates.filter(record => !excluded.has(record.id)));

      if (added.length === 0) {
        return null;
      }

      writeMemoryMarkdown(memoryPath, {
        version: 1,
        scope: 'session-person',
        sessionKeyHash,
        loadPolicy: 'on_demand',
        updatedAt: timestamp,
        records,
      }, excluded);

      return {
        version: 1,
        sessionKeyHash,
        sessionType: options.sessionType,
        source: options.reason ?? 'ttl_cleanup',
        updatedAt: timestamp,
        memoryPath,
        added,
        records,
        totalRecords: records.length,
      };
    });
  }

  static remember(
    sessionKey: string,
    value: string,
    options: RememberMemoryOptions = {},
  ): RememberMemoryResult {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) {
      throw new Error('session key is required');
    }

    const normalizedValue = value.trim();
    if (!normalizedValue) {
      throw new Error('memory content is required');
    }

    const now = options.now ?? new Date();
    const timestamp = now.toISOString();
    const memoryPath = this.getMemoryPath(normalizedSessionKey, options.rootDir);
    return withMemoryLock(memoryPath, () => {
      const existing = fs.existsSync(memoryPath) ? readMemoryRecords(memoryPath) : [];
      const text = normalizeMemoryText(normalizedValue);
      const kind = options.kind ?? classifyMemoryKind(text);
      const candidate = makeRecord(
        kind,
        text,
        { kind: 'tool', toolName: 'remember', ...(options.evidence ? { reason: options.evidence } : {}) },
        timestamp,
        options.confidence || 'high',
      );
      const replaced = options.replaces ? existing.find(record => record.id === options.replaces) : undefined;
      if (options.replaces && !replaced) throw new Error('MEMORY_RECORD_NOT_FOUND');
      const previous = existing.find(record => record.id === candidate.id) || replaced;
      const record: LongTermMemoryRecord = previous
        ? { ...candidate, firstSeenAt: previous.firstSeenAt }
        : candidate;
      const excluded = readExcludedIds(memoryPath);
      if (replaced && replaced.id !== record.id) excluded.add(replaced.id);
      excluded.delete(record.id);
      const retained = existing.filter(item => item.id !== replaced?.id);
      const otherKinds = retained.filter(item => item.kind !== record.kind);
      const sameKind = retained
        .filter(item => item.kind === record.kind && item.id !== record.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, MAX_RECORDS_PER_KIND - 1);
      const records = sortRecords([...otherKinds, ...sameKind, record]);

      writeMemoryMarkdown(memoryPath, {
        version: 1,
        scope: 'session-person',
        sessionKeyHash: this.hashSessionKey(normalizedSessionKey),
        loadPolicy: 'on_demand',
        updatedAt: timestamp,
        records,
      }, excluded);

      return {
        version: 1,
        sessionKeyHash: this.hashSessionKey(normalizedSessionKey),
        updatedAt: timestamp,
        memoryPath,
        action: previous ? 'updated' : 'created',
        record,
        totalRecords: records.length,
      };
    });
  }

  /** One validated batch writes the active index once; archive-first preserves data on interruption. */
  static applyMaintenance(sessionKey: string, actions: MemoryMaintenanceAction[], expectedDigest: string,
    rootDir: string, now = new Date()): void {
    const memoryPath = this.getMemoryPath(sessionKey, rootDir);
    withMemoryLock(memoryPath, () => {
      const raw = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf8') : '';
      if (createHash('sha256').update(raw).digest('hex') !== expectedDigest) throw new Error('MEMORY_CHANGED');
      let records = fs.existsSync(memoryPath) ? readMemoryRecords(memoryPath) : [];
      const excluded = readExcludedIds(memoryPath);
      const archived: Array<{ record: LongTermMemoryRecord; reason: string }> = [];
      for (const action of actions) {
        const old = action.recordId ? records.find(record => record.id === action.recordId) : undefined;
        if (action.action !== 'remember' && !old) throw new Error('MEMORY_RECORD_NOT_FOUND');
        if (old) {
          records = records.filter(record => record.id !== old.id);
          excluded.add(old.id);
          if (action.action === 'archive') archived.push({ record: old, reason: action.reason });
        }
        if (action.action === 'remember' || action.action === 'replace') {
          const record = makeRecord(action.kind!, normalizeMemoryText(action.text!),
            { kind: 'conversation', messageIds: action.evidence, reason: action.reason },
            now.toISOString(), action.confidence || 'medium');
          record.firstSeenAt = old?.firstSeenAt || records.find(item => item.id === record.id)?.firstSeenAt || record.firstSeenAt;
          records = records.filter(item => item.id !== record.id);
          if (Object.keys(SECTION_BY_KIND).some(kind => excluded.has(stableId(kind, record.text)) && stableId(kind, record.text) !== old?.id)) throw new Error('MEMORY_EXCLUDED_RECORD');
          if (old?.id === record.id) excluded.delete(record.id);
          records.push(record);
        }
      }
      // Never silently evict stable facts to fit a cap. EvolutionCat must explicitly consolidate.
      if (Object.keys(SECTION_BY_KIND).some(kind => records.filter(record => record.kind === kind).length > MAX_RECORDS_PER_KIND)) {
        throw new Error('MEMORY_CAPACITY_REQUIRES_CONSOLIDATION');
      }
      if (archived.length) {
        const archivePath = path.join(path.dirname(memoryPath), 'ARCHIVE.md');
        let archive = fs.existsSync(archivePath) ? fs.readFileSync(archivePath, 'utf8') : '# Archived memory\n\nRead on demand; these records are inactive.\n';
        for (const { record, reason } of archived) {
          if (!archive.includes(`<!-- archived:${record.id}:${record.updatedAt} -->`)) archive += `\n<!-- archived:${record.id}:${record.updatedAt} -->\n${record.text}\n\nSource: ${record.source.kind}; first seen: ${record.firstSeenAt}; archived: ${now.toISOString()}\nReason: ${reason.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;')}\n\n<!-- metadata:${JSON.stringify(record).replace(/-->/g, '--&gt;').replace(/<!--/g, '&lt;!--')} -->\n`;
        }
        const temporary = `${archivePath}.${randomUUID()}.tmp`;
        fs.writeFileSync(temporary, archive, { mode: 0o600 });
        fs.renameSync(temporary, archivePath);
      }
      if (actions.length) writeMemoryMarkdown(memoryPath, {
        version: 1, scope: 'session-person', sessionKeyHash: this.hashSessionKey(sessionKey),
        loadPolicy: 'on_demand', updatedAt: now.toISOString(), records: sortRecords(records),
      }, excluded);
    });
  }

  static archive(sessionKey: string, recordId: string, reason: string, rootDir: string): { memoryPath: string; totalRecords: number } {
    const memoryPath = this.getMemoryPath(sessionKey, rootDir);
    const raw = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf8') : '';
    this.applyMaintenance(sessionKey, [{ action: 'archive', recordId, reason, evidence: [] }],
      createHash('sha256').update(raw).digest('hex'), rootDir);
    return { memoryPath, totalRecords: this.loadSessionMemory(sessionKey, rootDir)?.records.length || 0 };
  }

  static forget(sessionKey: string, recordId: string, rootDir?: string): { memoryPath: string; totalRecords: number } {
    if (!sessionKey.trim() || !recordId.trim()) throw new Error('MEMORY_RECORD_REQUIRED');
    const memoryPath = this.getMemoryPath(sessionKey, rootDir);
    return withMemoryLock(memoryPath, () => {
      const existing = fs.existsSync(memoryPath) ? readMemoryRecords(memoryPath) : [];
      if (!existing.some(record => record.id === recordId)) throw new Error('MEMORY_RECORD_NOT_FOUND');
      const records = existing.filter(record => record.id !== recordId);
      const excluded = readExcludedIds(memoryPath);
      excluded.add(recordId);
      writeMemoryMarkdown(memoryPath, {
        version: 1, scope: 'session-person', sessionKeyHash: this.hashSessionKey(sessionKey),
        loadPolicy: 'on_demand', updatedAt: new Date().toISOString(), records,
      }, excluded);
      return { memoryPath, totalRecords: records.length };
    });
  }

}

function extractLongTermRecords(messages: Message[], timestamp: string): LongTermMemoryRecord[] {
  const items = collectIndexedTexts(messages);
  const records: LongTermMemoryRecord[] = [];

  for (const item of items) {
    for (const line of splitCandidateLines(item.text)) {
      if (!looksLikeLongTermMemory(line)) continue;
      const text = normalizeMemoryText(line);
      if (!text) continue;
      const kind = classifyMemoryKind(text);
      records.push(makeRecord(kind, text, item.source, timestamp, item.source.kind === 'compact_message' ? 'medium' : 'high'));
    }
  }

  return dedupeAndLimit(records);
}

function collectIndexedTexts(messages: Message[]): IndexedText[] {
  const items: IndexedText[] = [];

  messages.forEach((message, index) => {
    if (message.__injected || typeof message.content === 'string' && message.content.startsWith('[scheduled_wakeup]')) return;
    if (message.role === 'user') {
      const text = contentToString(message.content).trim();
      if (text) {
        items.push({
          text,
          source: { kind: 'transcript', messageIndex: index, role: message.role },
        });
      }
      return;
    }

    if (message.role !== 'system' || typeof message.content !== 'string') return;
    if (message.content.startsWith(COMPACT_PREFIXES.sessionMemory)) {
      items.push({
        text: stripPrefix(message.content, COMPACT_PREFIXES.sessionMemory),
        source: { kind: 'compact_message', prefix: COMPACT_PREFIXES.sessionMemory },
      });
    }
  });

  return items;
}

function splitCandidateLines(text: string): string[] {
  return text
    .split(/\r?\n|[。！？!?；;]/)
    .map(line => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

function looksLikeLongTermMemory(line: string): boolean {
  if (line.length < 4) return false;
  if (!DURABLE_MEMORY_PATTERN.test(line)) return false;
  return !TRANSIENT_PATTERN.test(line);
}

function normalizeMemoryText(line: string): string {
  let text = line
    .replace(/^用户(?:说|要求)?[:：]\s*/, '用户')
    .replace(/^请(?:你)?/, '')
    .trim();

  const rememberMatch = text.match(/^(?:帮我)?记住[:：]?\s*(.+)$/);
  if (rememberMatch) {
    text = `用户要求记住${rememberMatch[1].trim()}`;
  } else if (text.startsWith('我')) {
    text = `用户${text.slice(1)}`;
  } else if (/^(以后|今后|默认|总是|始终|每次|不要|别|避免)/.test(text)) {
    text = `用户希望${text}`;
  } else if (/^(叫我|称呼我)/.test(text)) {
    text = `用户希望${text}`;
  } else if (!text.startsWith('用户')) {
    text = `用户记忆：${text}`;
  }

  return ensureSentence(limitText(text.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;'), MAX_MEMORY_TEXT));
}

function classifyMemoryKind(text: string): LongTermMemoryKind {
  if (/(喜欢|偏好|prefer|preference)/i.test(text)) return 'preference';
  if (/(习惯|常用|usually|habit)/i.test(text)) return 'habit';
  if (/(叫我|称呼|名字|用户名|GitHub|记住|remember|my name is)/i.test(text)) return 'fact';
  return 'instruction';
}

function makeRecord(
  kind: LongTermMemoryKind,
  text: string,
  source: MemorySourceRef,
  timestamp: string,
  confidence: LongTermMemoryConfidence,
): LongTermMemoryRecord {
  return {
    id: stableId(kind, text),
    kind,
    text,
    source,
    confidence,
    firstSeenAt: timestamp,
    updatedAt: timestamp,
  };
}

function mergeRecords(
  existing: LongTermMemoryRecord[],
  candidates: LongTermMemoryRecord[],
): { records: LongTermMemoryRecord[]; added: LongTermMemoryRecord[] } {
  const byId = new Map<string, LongTermMemoryRecord>();
  for (const record of existing) {
    byId.set(record.id, record);
  }

  const added: LongTermMemoryRecord[] = [];
  for (const candidate of candidates) {
    if (byId.has(candidate.id)) continue;
    byId.set(candidate.id, candidate);
    added.push(candidate);
  }

  return {
    records: sortRecords([...byId.values()]),
    added,
  };
}

function dedupeAndLimit(records: LongTermMemoryRecord[]): LongTermMemoryRecord[] {
  const byId = new Map<string, LongTermMemoryRecord>();
  for (const record of records) {
    if (byId.has(record.id)) continue;
    byId.set(record.id, record);
  }
  return sortRecords([...byId.values()]).filter((record, index, all) => {
    const sameKindBefore = all.slice(0, index).filter(item => item.kind === record.kind).length;
    return sameKindBefore < MAX_RECORDS_PER_KIND;
  });
}

function sortRecords(records: LongTermMemoryRecord[]): LongTermMemoryRecord[] {
  const order: LongTermMemoryKind[] = ['preference', 'habit', 'instruction', 'fact'];
  return records.sort((a, b) => {
    const kindDiff = order.indexOf(a.kind) - order.indexOf(b.kind);
    if (kindDiff !== 0) return kindDiff;
    return a.text.localeCompare(b.text);
  });
}

function writeMemoryMarkdown(memoryPath: string, doc: SessionLongTermMemory, excluded = new Set<string>()): void {
  fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
  const lines: string[] = [
    '---',
    'version: 1',
    'scope: session-person',
    'loadPolicy: on_demand',
    `sessionKeyHash: ${doc.sessionKeyHash}`,
    `updatedAt: ${doc.updatedAt}`,
    '---',
    '',
    '# Long-Term Memory',
    '',
    'Runtime reads a bounded index each request. Read linked files only when relevant.',
  ];

  const header = lines.join('\n');
  lines.length = 0;
  lines.push('<!-- xiaoba:records:start -->');
  for (const kind of ['preference', 'habit', 'instruction', 'fact'] as LongTermMemoryKind[]) {
    lines.push('', `## ${SECTION_BY_KIND[kind]}`, '');
    const records = doc.records.filter(record => record.kind === kind);
    if (records.length === 0) {
      lines.push('- _None yet._');
      continue;
    }

    for (const record of records) {
      lines.push(`- ${record.text} <!-- id: ${record.id}; source: ${sourceLabel(record.source)}; sourceRef: ${encodeURIComponent(JSON.stringify(record.source))}; confidence: ${record.confidence}; firstSeenAt: ${record.firstSeenAt}; updated: ${record.updatedAt} -->`);
    }
  }

  if (excluded.size) lines.push('', `<!-- xiaoba:excluded: ${[...excluded].join(' ')} -->`);
  lines.push('<!-- xiaoba:records:end -->');
  const block = lines.join('\n');
  let raw = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf8') : header;
  const starts = raw.match(/<!-- xiaoba:records:start -->/g) || [];
  const ends = raw.match(/<!-- xiaoba:records:end -->/g) || [];
  if (starts.length !== ends.length || starts.length > 1
    || (starts.length && raw.indexOf('<!-- xiaoba:records:end -->') < raw.indexOf('<!-- xiaoba:records:start -->'))) {
    throw new Error('MEMORY_BLOCK_INVALID');
  }
  if (raw.includes('<!-- xiaoba:records:start -->')) {
    raw = raw.replace(/<!-- xiaoba:records:start -->[\s\S]*?<!-- xiaoba:records:end -->/, block);
  } else {
    // Upgrade legacy generated sections; keep free prose, custom headings and links.
    let managedSection = false;
    raw = raw.split(/\r?\n/).filter(line => {
      const heading = line.match(/^##\s+(.+?)\s*$/);
      if (heading) {
        managedSection = Boolean(KIND_BY_SECTION[heading[1]]);
        return !managedSection;
      }
      if (managedSection && line.trim().startsWith('- ')) return false;
      return !line.startsWith('These notes are not loaded by default.');
    }).join('\n').trimEnd() + '\n\n' + block;
  }
  raw = raw.replace(/^updatedAt:.*$/m, `updatedAt: ${doc.updatedAt}`);
  const temp = `${memoryPath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${raw.trimEnd()}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, memoryPath);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function readMemoryRecords(memoryPath: string): LongTermMemoryRecord[] {
  const raw = fs.readFileSync(memoryPath, 'utf-8');
  const records: LongTermMemoryRecord[] = [];
  let currentKind: LongTermMemoryKind | undefined;

  for (const rawLine of raw.split(/\r?\n/)) {
    const sectionMatch = rawLine.match(/^##\s+(.+?)\s*$/);
    if (sectionMatch) {
      currentKind = KIND_BY_SECTION[sectionMatch[1]];
      continue;
    }

    if (!currentKind) continue;
    const line = rawLine.trim();
    if (!line.startsWith('- ') || line.includes('_None yet._')) continue;

    const commentMatch = line.match(/<!--\s*(.*?)\s*-->/);
    const text = line
      .replace(/^-\s*/, '')
      .replace(/\s*<!--.*?-->\s*$/, '')
      .trim();
    if (!text) continue;

    const meta = parseMetadata(commentMatch?.[1] || '');
    const updatedAt = meta.updated || new Date(0).toISOString();
    records.push({
      id: meta.id || stableId(currentKind, text),
      kind: currentKind,
      text,
      source: parseSourceRef(meta.sourceRef),
      confidence: parseConfidence(meta.confidence),
      firstSeenAt: meta.firstSeenAt || updatedAt,
      updatedAt,
    });
  }

  return dedupeAndLimit(records);
}

function parseMetadata(raw: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const [key, ...valueParts] = part.split(':');
    if (!key || valueParts.length === 0) continue;
    meta[key.trim()] = valueParts.join(':').trim();
  }
  return meta;
}

function parseSourceRef(value?: string): MemorySourceRef {
  try { if (value) return JSON.parse(decodeURIComponent(value)); } catch { /* legacy metadata */ }
  return { kind: 'markdown' };
}

function parseConfidence(value?: string): LongTermMemoryConfidence {
  return value === 'high' ? 'high' : 'medium';
}

function readFrontmatterValue(raw: string, key: string): string | undefined {
  const match = raw.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim();
}

function newestUpdatedAt(records: LongTermMemoryRecord[]): string | undefined {
  const sorted = records.map(record => record.updatedAt).sort();
  return sorted[sorted.length - 1];
}

function contentToString(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => block.type === 'text' ? block.text : '[图片]').join('');
}

function stripPrefix(text: string, prefix: string): string {
  return text.slice(prefix.length).trim();
}

function stableId(kind: string, value: string): string {
  return `${kind}-${createHash('sha1').update(value).digest('hex').slice(0, 12)}`;
}

function sourceLabel(source: MemorySourceRef): string {
  if (source.kind === 'compact_message') return 'compact_session_memory';
  if (source.kind === 'transcript' && source.role === 'user') return 'user_message';
  if (source.kind === 'tool') return source.toolName || 'runtime_tool';
  return source.kind;
}

function ensureSentence(text: string): string {
  return /[。.!?]$/.test(text) ? text : `${text}。`;
}

function limitText(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}


function readExcludedIds(memoryPath: string): Set<string> {
  if (!fs.existsSync(memoryPath)) return new Set();
  const raw = fs.readFileSync(memoryPath, 'utf8');
  const match = raw.match(/<!-- xiaoba:excluded:\s*([^]*?)-->/);
  return new Set((match?.[1] || '').trim().split(/\s+/).filter(Boolean));
}

function withMemoryLock<T>(memoryPath: string, operation: () => T): T {
  fs.mkdirSync(path.dirname(memoryPath), { recursive: true, mode: 0o700 });
  const lock = `${memoryPath}.lock`;
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error: any) {
    if (error.code === 'EEXIST') throw new Error('MEMORY_BUSY_OR_INTERRUPTED');
    throw error;
  }
  try { return operation(); } finally { fs.rmdirSync(lock); }
}
