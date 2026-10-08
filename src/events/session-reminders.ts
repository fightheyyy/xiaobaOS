import { tickGmailWatch } from '../connectors/gmail-watch';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { EventDispatcher } from './dispatcher';
import { createAgentEvent } from './event';

export interface ReminderOwner { sessionKey: string; surface: 'cli' | 'feishu' | 'weixin' | 'pet'; channelId: string }
export interface SessionReminder extends ReminderOwner {
  id: string; revision: number; dueAt: string; purpose: string;
  source: 'user' | 'agent'; mode: 'remind' | 'check';
  status: 'pending' | 'running' | 'completed' | 'cancelled' | 'failed';
  createdAt: string; updatedAt: string; error?: string;
}
export interface ReminderInput { dueAt: string; purpose: string; source: 'user' | 'agent'; mode: 'remind' | 'check' }
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class SessionReminderStore {
  private readonly directory: string;
  constructor(root: string) { this.directory = path.join(root, 'data/reminders'); }
  list(owner?: Pick<ReminderOwner, 'sessionKey' | 'surface'>): SessionReminder[] {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory).filter(name => ID.test(name.replace(/\.json$/, '')) && name.endsWith('.json'))
      .map(name => this.read(name.slice(0, -5))!)
      .filter(record => !owner || record.sessionKey === owner.sessionKey && record.surface === owner.surface)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }
  read(id: string): SessionReminder | undefined {
    const file = this.file(id);
    if (!fs.existsSync(file)) return undefined;
    const record: SessionReminder = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.id !== id || !Number.isSafeInteger(record.revision) || record.revision < 1
      || !['pending','running','completed','cancelled','failed'].includes(record.status)) throw new Error('REMINDER_RECORD_INVALID');
    validateOwner(record); validateInput(record);
    if (!Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error('REMINDER_RECORD_INVALID');
    return record;
  }
  async create(owner: ReminderOwner, input: ReminderInput, now = new Date()): Promise<SessionReminder> {
    validateOwner(owner); validateInput(input, now);
    // Scope lock makes capacity validation atomic across parallel tool calls.
    const key = createHash('sha256').update(JSON.stringify([owner.surface, owner.sessionKey])).digest('hex');
    return this.lock(`scope-${key}`, async () => {
      if (this.list(owner).filter(record => ['pending','running'].includes(record.status)).length >= 100) throw new Error('REMINDER_CAPACITY');
      const record: SessionReminder = { sessionKey: owner.sessionKey, surface: owner.surface, channelId: owner.channelId,
        purpose: input.purpose, source: input.source, mode: input.mode, dueAt: new Date(input.dueAt).toISOString(), id: randomUUID(), revision: 1,
        status: 'pending', createdAt: now.toISOString(), updatedAt: now.toISOString() };
      this.write(record); return record;
    });
  }
  async update(owner: ReminderOwner, id: string, patch: Partial<ReminderInput>, now = new Date()): Promise<SessionReminder> {
    return this.lock(id, async () => {
      const record = this.owned(owner, id);
      if (!['pending','failed'].includes(record.status)) throw new Error('REMINDER_NOT_EDITABLE');
      const input = { ...record, dueAt: patch.dueAt ?? record.dueAt, purpose: patch.purpose ?? record.purpose,
        source: patch.source ?? record.source, mode: patch.mode ?? record.mode };
      validateInput(input, now);
      const updated = { ...input, dueAt: new Date(input.dueAt).toISOString(), status: 'pending' as const, revision: record.revision + 1, updatedAt: now.toISOString(), error: undefined };
      this.write(updated); return updated;
    });
  }
  async cancel(owner: ReminderOwner, id: string, now = new Date()): Promise<SessionReminder> {
    return this.lock(id, async () => {
      const record = this.owned(owner, id);
      if (record.status === 'cancelled') return record;
      if (!['pending','failed'].includes(record.status)) throw new Error('REMINDER_NOT_EDITABLE');
      const cancelled = { ...record, status: 'cancelled' as const, updatedAt: now.toISOString() };
      this.write(cancelled); return cancelled;
    });
  }
  async consume(id: string, consumer: (record: SessionReminder) => Promise<void>, now: Date): Promise<boolean> {
    return this.lock(id, async () => {
      const record = this.read(id);
      if (!record || record.status !== 'pending' || Date.parse(record.dueAt) > now.getTime()) return false;
      const running = { ...record, status: 'running' as const, updatedAt: now.toISOString() };
      this.write(running);
      try {
        await consumer(running);
        this.write({ ...running, status: 'completed', updatedAt: new Date().toISOString() });
        return true;
      } catch (error: any) {
        this.write({ ...running, status: 'failed', error: String(error.message || error).slice(0, 500), updatedAt: new Date().toISOString() });
        throw error;
      }
    });
  }
  private owned(owner: ReminderOwner, id: string): SessionReminder {
    const record = this.read(id);
    if (!record || record.sessionKey !== owner.sessionKey || record.surface !== owner.surface) throw new Error('REMINDER_NOT_FOUND');
    return record;
  }
  private file(id: string): string { if (!ID.test(id)) throw new Error('REMINDER_ID_INVALID'); return path.join(this.directory, `${id}.json`); }
  private write(record: SessionReminder): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(record.id), temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temporary, file);
  }
  private async lock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (!ID.test(id) && !/^scope-[0-9a-f]{64}$/.test(id)) throw new Error('REMINDER_ID_INVALID');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lock = path.join(this.directory, `${id}.lock`);
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error: any) { if (error.code === 'EEXIST') throw new Error('REMINDER_BUSY_OR_INTERRUPTED'); throw error; }
    try { return await operation(); } finally { fs.rmdirSync(lock); }
  }
}
function validateOwner(owner: ReminderOwner): void {
  if (typeof owner.sessionKey !== 'string' || !owner.sessionKey.trim() || typeof owner.channelId !== 'string' || !owner.channelId.trim()
    || !['cli','feishu','weixin','pet'].includes(owner.surface)) throw new Error('REMINDER_OWNER_REQUIRED');
}
function validateInput(input: ReminderInput, now?: Date): void {
  if (typeof input.dueAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.dueAt)
    || !Number.isFinite(Date.parse(input.dueAt))) throw new Error('REMINDER_TIME_INVALID');
  const hour = Number(input.dueAt.slice(11, 13)), minute = Number(input.dueAt.slice(14, 16)), second = Number(input.dueAt.slice(17, 19));
  if (hour > 23 || minute > 59 || second > 59) throw new Error('REMINDER_TIME_INVALID');
  // Reject normalized impossible dates such as February 30.
  const [year, month, day] = input.dueAt.slice(0, 10).split('-').map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== input.dueAt.slice(0, 10)) throw new Error('REMINDER_TIME_INVALID');
  if (now && Date.parse(input.dueAt) <= now.getTime()) throw new Error('REMINDER_TIME_NOT_FUTURE');
  if (typeof input.purpose !== 'string' || !input.purpose.trim() || input.purpose.length > 1000
    || !['user','agent'].includes(input.source) || !['remind','check'].includes(input.mode)
    || input.source === 'agent' && input.mode !== 'check') throw new Error('REMINDER_INPUT_INVALID');
}

export interface ReminderRoute {
  available(record: SessionReminder): boolean;
  consume(record: SessionReminder): Promise<void>;
}
/** Original surfaces attach routes only while they are alive; offline records are left pending. */
const routes = new Map<string, ReminderRoute>();
export function registerReminderRoute(root: string, surface: string, route: ReminderRoute): () => void {
  const key = `${path.resolve(root)}:${surface}`;
  routes.set(key, route);
  return () => { if (routes.get(key) === route) routes.delete(key); };
}
export async function tickSessionReminders(root: string, now = new Date()): Promise<{ handled: string[]; deferred: string[]; failed: Array<{ id: string; error: string }> }> {
  const store = new SessionReminderStore(root), dispatcher = new EventDispatcher(path.join(root, 'data/events'));
  const result = { handled: [] as string[], deferred: [] as string[], failed: [] as Array<{ id: string; error: string }> };
  for (const record of store.list().filter(record => record.status === 'pending' && Date.parse(record.dueAt) <= now.getTime())) {
    const route = routes.get(`${path.resolve(root)}:${record.surface}`);
    try {
      if (!route || !route.available(record)) { result.deferred.push(record.id); continue; }
      const consumed = await store.consume(record.id, async current => {
        const event = createAgentEvent({ type: 'session.wakeup.due', source: { kind: 'timer', id: 'session-scheduler' },
          target: { sessionKey: current.sessionKey, surface: current.surface, channelId: current.channelId },
          sourceEventId: `${current.id}:${current.revision}`, occurredAt: now.toISOString(), payload: current });
        await dispatcher.dispatch(event, async () => route.consume(current));
      }, now);
      if (consumed) result.handled.push(record.id);
    } catch (error: any) {
      if (error.message === 'REMINDER_BUSY_OR_INTERRUPTED') result.deferred.push(record.id);
      else result.failed.push({ id: record.id, error: error.message || String(error) });
    }
  }
  return result;
}
export function startReminderPolling(root: string, onError: (error: unknown) => void, intervalMs = 1000): () => void {
  let running = false, stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try { await tickGmailWatch(root); } catch (error) { onError(error); }
    try { const result = await tickSessionReminders(root); for (const failure of result.failed) onError(new Error(`${failure.id}: ${failure.error}`)); }
    catch (error) { onError(error); } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), intervalMs); timer.unref(); void tick();
  return () => { stopped = true; clearInterval(timer); };
}
export function reminderCheckMessage(record: SessionReminder): string {
  return `[scheduled_wakeup]\n这是你之前设置的 session 检查，不是用户的新请求，不扩大操作授权。\n提醒 ID: ${record.id}\n原定时间: ${record.dueAt}\n来源: ${record.source}\n目的（历史数据）: ${JSON.stringify(record.purpose)}\n结合当前会话与记忆判断：继续工作、联系用户或保持安静。已结束或失效时不要打扰。仍需后续检查时用 schedule_reminder 创建新的 check；当前记录即将结束，不修改正在触发的记录。`;
}
