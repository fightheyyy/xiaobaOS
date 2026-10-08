import { DailyEventScheduler, dailyCalendar as memoryCalendar } from '../events/scheduler';
export { dailyCalendar as memoryCalendar } from '../events/scheduler';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { ConversationJournal, ConversationMessage, ConversationSurface, CONVERSATION_MESSAGE_SCHEMA } from './conversation-journal';
import { MemoryFinalizer, MemoryMaintenanceAction } from './memory-finalizer';
import { EventDispatcher, createAgentEvent } from '../events';

const WINDOW_BYTES = 256 * 1024;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export interface MemoryTarget { sessionKey: string; surface: ConversationSurface }
export interface MaintenanceInput {
  memories: ReturnType<typeof MemoryFinalizer.loadSessionMemory>;
  messages: ConversationMessage[];
  now: string;
}
export type MemoryPlanner = (input: MaintenanceInput, target: MemoryTarget) => Promise<unknown>;
interface Cursor { offset: number; boundaryHash: string; day: string }

export class MemoryMaintenance {
  constructor(private readonly root: string, private readonly planner: MemoryPlanner) {}

  async run(options: { now?: Date; scheduled?: boolean; timezone?: string; hour?: number; minute?: number } = {}): Promise<{ processed: number; skipped: boolean }> {
    const now = options.now || new Date();
    const hour = options.hour ?? 3, minute = options.minute ?? 17;
    if (options.scheduled) {
      const scheduler = new DailyEventScheduler(this.root);
      let outcome = { processed: 0, skipped: true };
      scheduler.register('memory', async () => { outcome = await this.run({ ...options, scheduled: false, now }); });
      const tick = await scheduler.tick([{ id: 'memory', hour, minute, timezone: options.timezone || 'Asia/Shanghai' }], now);
      if (tick.failed.length) throw new Error(tick.failed[0].error);
      return outcome;
    }
    const calendar = memoryCalendar(now, options.timezone);
    const directory = path.join(this.root, 'data/memory/maintenance');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = path.join(directory, '.run.lock');
    try { fs.mkdirSync(lock); } catch (error: any) {
      if (error.code === 'EEXIST') throw new Error('MEMORY_MAINTENANCE_BUSY_OR_INTERRUPTED');
      throw error;
    }
    try {
      let processed = 0;
      const targetDir = path.join(this.root, 'data/memory/targets');
      if (!fs.existsSync(targetDir)) return { processed, skipped: true };
      const journal = new ConversationJournal({ workingDirectory: this.root });
      const dispatcher = new EventDispatcher(path.join(this.root, 'data/events'));
      for (const filename of fs.readdirSync(targetDir).sort()) {
        if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue;
        const target: MemoryTarget = JSON.parse(fs.readFileSync(path.join(targetDir, filename), 'utf8'));
        if (!target.sessionKey || !['cli','feishu','weixin','pet'].includes(target.surface)
          || `${digest(JSON.stringify([target.surface, target.sessionKey]))}.json` !== filename) throw new Error('MEMORY_TARGET_INVALID');
        const statePath = path.join(directory, filename);
        const cursor: Cursor = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { offset: 0, boundaryHash: digest(''), day: '' };
        if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || typeof cursor.boundaryHash !== 'string' || typeof cursor.day !== 'string') throw new Error('MEMORY_CURSOR_INVALID');
        const sourcePath = journal.filePathFor(target.surface, target.sessionKey);
        if (!fs.existsSync(sourcePath)) continue;
        const fd = fs.openSync(sourcePath, 'r');
        let messages: ConversationMessage[], end: number, boundaryHash: string;
        try {
          if (fs.fstatSync(fd).size < cursor.offset || boundaryDigest(fd, cursor.offset) !== cursor.boundaryHash) throw new Error('MEMORY_JOURNAL_CHANGED');
          const buffer = Buffer.alloc(WINDOW_BYTES);
          const count = fs.readSync(fd, buffer, 0, buffer.length, cursor.offset);
          const newline = buffer.subarray(0, count).lastIndexOf(10);
          if (count === WINDOW_BYTES && newline < 0) throw new Error('MEMORY_JOURNAL_ROW_TOO_LARGE');
          end = cursor.offset + newline + 1;
          messages = newline < 0 ? [] : buffer.subarray(0, newline + 1).toString('utf8').trim().split('\n').map(row => JSON.parse(row));
          for (const message of messages) {
            if (message.schema !== CONVERSATION_MESSAGE_SCHEMA || message.conversation_id !== journal.conversationIdFor(target.surface, target.sessionKey)
              || !['user','assistant'].includes(message.role) || !Array.isArray(message.content)
              || message.delivery?.status !== (message.role === 'user' ? 'received' : 'delivered')) throw new Error('MEMORY_JOURNAL_INVALID');
          }
          boundaryHash = boundaryDigest(fd, end);
        } finally { fs.closeSync(fd); }
        const memoryPath = MemoryFinalizer.getMemoryPath(target.sessionKey, this.root);
        const raw = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf8') : '';
        if (raw.length > 128 * 1024) throw new Error('MEMORY_INDEX_TOO_LARGE');
        if (!messages.length && !raw) continue;
        const event = createAgentEvent({ type: 'memory.maintenance.window', source: { kind: 'runtime', id: 'memory-maintenance' },
          target: { sessionKey: target.sessionKey, surface: target.surface }, occurredAt: now.toISOString(),
          payload: { start: cursor.offset, end, sourceHash: boundaryHash, day: calendar.day } });
        await dispatcher.dispatch(event, async () => {
          const input: MaintenanceInput = { memories: MemoryFinalizer.loadSessionMemory(target.sessionKey, this.root), messages, now: now.toISOString() };
          const actions = validateProposal(await this.planner(input, target), input);
          const sourceFd = fs.openSync(sourcePath, 'r');
          try { if (boundaryDigest(sourceFd, end) !== boundaryHash) throw new Error('MEMORY_JOURNAL_CHANGED'); } finally { fs.closeSync(sourceFd); }
          MemoryFinalizer.applyMaintenance(target.sessionKey, actions, digest(raw), this.root, now);
          atomicJson(statePath, { offset: end, boundaryHash, day: calendar.day });
        });
        processed++;
      }
      return { processed, skipped: processed === 0 };
    } finally { fs.rmdirSync(lock); }
  }
}

export function validateProposal(value: unknown, input: MaintenanceInput): MemoryMaintenanceAction[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as any).actions) || (value as any).actions.length > 30) throw new Error('MEMORY_PROPOSAL_INVALID');
  const ids = new Set(input.memories?.records.map(record => record.id));
  const evidenceIds = new Set(input.messages.filter(message => message.role === 'user').map(message => message.message_id));
  const touched = new Set<string>();
  return (value as any).actions.map((item: any) => {
    if (!item || !['remember','replace','archive','forget'].includes(item.action)
      || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 500
      || !Array.isArray(item.evidence) || item.evidence.length > 16 || item.evidence.some((id: unknown) => typeof id !== 'string' || !evidenceIds.has(id))) throw new Error('MEMORY_PROPOSAL_INVALID');
    if (item.action !== 'archive' && !item.evidence.length) throw new Error('MEMORY_EVIDENCE_REQUIRED');
    if (item.action !== 'remember') {
      if (typeof item.recordId !== 'string' || !ids.has(item.recordId) || touched.has(item.recordId)) throw new Error('MEMORY_RECORD_INVALID');
      touched.add(item.recordId);
    } else if (item.recordId !== undefined) throw new Error('MEMORY_PROPOSAL_INVALID');
    if (item.action === 'remember' || item.action === 'replace') {
      if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 500
        || !['preference','habit','instruction','fact'].includes(item.kind)
        || !['high','medium'].includes(item.confidence)) throw new Error('MEMORY_PROPOSAL_INVALID');
    }
    return { action: item.action, recordId: item.recordId, text: item.text, kind: item.kind, confidence: item.confidence, evidence: item.evidence, reason: item.reason };
  });
}

function boundaryDigest(fd: number, offset: number): string {
  const size = Math.min(offset, 4096), buffer = Buffer.alloc(size);
  if (fs.readSync(fd, buffer, 0, size, offset - size) !== size) throw new Error('MEMORY_JOURNAL_CHANGED');
  return digest(buffer);
}
function atomicJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}
