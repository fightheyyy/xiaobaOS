import { tickGmailWatch } from '../connectors/gmail-watch';
import { tickSessionReminders } from './session-reminders';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { createAgentEvent, AgentEvent } from './event';
import { EventDispatcher, EventHandler } from './dispatcher';
import { FileEventStore } from './file-event-store';

export type ScheduledJobId = 'evolution' | 'memory';
export const SCHEDULED_EVENT_TYPES: Record<ScheduledJobId, string> = {
  evolution: 'evolution.sleep.due', memory: 'memory.maintenance.due',
};
export interface DailySchedule { id: ScheduledJobId; hour: number; minute: number; timezone: string }
export interface CrontabAdapter { read(): string; write(content: string): void }
export interface ScheduleOptions {
  workingDirectory: string; hour?: number; minute?: number; timezone?: string;
  entryFile?: string; nodeExecutable?: string; crontab?: CrontabAdapter;
}
export function dailyCalendar(now: Date, timezone = 'Asia/Shanghai'): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const value = (kind: string) => parts.find(part => part.type === kind)!.value;
  return { day: `${value('year')}-${value('month')}-${value('day')}`, minutes: Number(value('hour')) * 60 + Number(value('minute')) };
}
function validateSchedule(schedule: DailySchedule): void {
  if (!schedule || !Object.prototype.hasOwnProperty.call(SCHEDULED_EVENT_TYPES, schedule.id)
    || !Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23
    || !Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59
    || typeof schedule.timezone !== 'string') throw new Error('SCHEDULE_INVALID');
  dailyCalendar(new Date(), schedule.timezone);
}
export function runtimeJobEvent(root: string, id: ScheduledJobId, payload: unknown, now = new Date()): AgentEvent {
  return createAgentEvent({ type: SCHEDULED_EVENT_TYPES[id], source: { kind: 'runtime', id: `job:${id}` },
    target: { sessionKey: projectKey(root) }, occurredAt: now.toISOString(), payload });
}
function projectKey(root: string): string { return `project:${createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24)}`; }

/** Time produces Events; named consumers retain business execution and safety boundaries. */
export class DailyEventScheduler {
  private readonly store: FileEventStore;
  private readonly dispatcher: EventDispatcher;
  private readonly handlers = new Map<ScheduledJobId, EventHandler>();
  constructor(private readonly root: string) {
    this.store = new FileEventStore(path.join(root, 'data/events'));
    this.dispatcher = new EventDispatcher(this.store);
  }
  register(id: ScheduledJobId, handler: EventHandler): void {
    if (this.handlers.has(id)) throw new Error(`SCHEDULE_ROUTE_CONFLICT: ${id}`);
    this.handlers.set(id, handler);
    this.dispatcher.register(SCHEDULED_EVENT_TYPES[id], handler);
  }
  async dispatch(id: ScheduledJobId, payload: unknown, now = new Date()): Promise<void> {
    await this.dispatcher.dispatch(runtimeJobEvent(this.root, id, payload, now));
  }
  async tick(schedules: DailySchedule[], now = new Date()): Promise<{ handled: string[]; skipped: string[]; failed: Array<{ id: string; error: string }> }> {
    const result = { handled: [] as string[], skipped: [] as string[], failed: [] as Array<{ id: string; error: string }> };
    for (const schedule of schedules) validateSchedule(schedule);
    if (new Set(schedules.map(schedule => schedule.id)).size !== schedules.length) throw new Error('SCHEDULE_DUPLICATE_JOB');
    for (const schedule of schedules) {
      const calendar = dailyCalendar(now, schedule.timezone);
      if (calendar.minutes < schedule.hour * 60 + schedule.minute) { result.skipped.push(schedule.id); continue; }
      const event = createAgentEvent({ type: SCHEDULED_EVENT_TYPES[schedule.id], source: { kind: 'timer', id: 'daily-scheduler' },
        target: { sessionKey: projectKey(this.root) }, sourceEventId: `${schedule.id}:${calendar.day}`,
        occurredAt: now.toISOString(), payload: { scheduledDay: calendar.day, timezone: schedule.timezone } });
      try {
        // Every prior attempt, including failed/running, requires explicit retry rather than a minute replay.
        if (this.store.read(event.id)) { result.skipped.push(schedule.id); continue; }
        await this.dispatcher.dispatch(event);
        result.handled.push(schedule.id);
      } catch (error: any) {
        if (String(error.message).startsWith('EVENT_IN_PROGRESS_OR_INTERRUPTED:')) result.skipped.push(schedule.id);
        else result.failed.push({ id: schedule.id, error: error.message || String(error) });
      }
    }
    try {const mail=await tickGmailWatch(this.root,now);if(mail.admitted) result.handled.push('gmail-watch');}
    catch(error:any) {result.failed.push({id:'gmail-watch',error:error.message||String(error)});}
    const reminders = await tickSessionReminders(this.root, now);
    result.handled.push(...reminders.handled.map(id => `reminder:${id}`));
    result.skipped.push(...reminders.deferred.map(id => `reminder:${id}`));
    result.failed.push(...reminders.failed.map(item => ({ ...item, id: `reminder:${item.id}` })));
    return result;
  }
}

/** One cron tick and one small configuration for this workspace's two daily consumers. */
export class WorkspaceSchedule {
  private readonly root: string;
  private readonly crontab: CrontabAdapter;
  private readonly configPath: string;
  private readonly marker: string;
  private readonly command: string;
  private editing = false;
  constructor(private readonly options: ScheduleOptions) {
    validateSchedule({ id: 'memory', hour: options.hour ?? 3, minute: options.minute ?? 17, timezone: options.timezone || 'Asia/Shanghai' });
    this.root = path.resolve(options.workingDirectory);
    this.crontab = options.crontab || new SystemCrontabAdapter();
    this.configPath = path.join(this.root, 'data/scheduler/jobs.json');
    this.marker = createHash('sha256').update(this.root).digest('hex').slice(0, 12);
    const entry = path.resolve(options.entryFile || process.argv[1]);
    const invocation = entry.endsWith('.ts')
      ? `${shellQuote(options.nodeExecutable || process.execPath)} ${shellQuote(path.join(this.root, 'node_modules/tsx/dist/cli.mjs'))} ${shellQuote(entry)}`
      : `${shellQuote(options.nodeExecutable || process.execPath)} ${shellQuote(entry)}`;
    this.command = `cd ${shellQuote(this.root)} && ${invocation} schedule tick >> ${shellQuote(path.join(this.root, 'logs/scheduler.log'))} 2>&1`;
  }
  schedules(): DailySchedule[] {
    if (!this.editing && fs.existsSync(`${this.configPath}.lock`)) throw new Error('SCHEDULE_CONFIG_BUSY_OR_INTERRUPTED');
    if (!fs.existsSync(this.configPath)) return [];
    const config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    if (config.version !== 1 || !Array.isArray(config.jobs)) throw new Error('SCHEDULE_CONFIG_INVALID');
    config.jobs.forEach(validateSchedule);
    if (new Set(config.jobs.map((job: DailySchedule) => job.id)).size !== config.jobs.length) throw new Error('SCHEDULE_DUPLICATE_JOB');
    return config.jobs;
  }
  status(id?: ScheduledJobId) {
    const content = this.crontab.read();
    const jobs = this.jobsWithLegacy(content);
    const job = jobs.find(job => job.id === id);
    const owned = ownedCronLine(content, this.start(), this.end());
    return { installed: id ? Boolean(job && (owned || this.legacyLine(content, id))) : Boolean(owned),
      schedule: job ? `${job.minute} ${job.hour} * * *` : '* * * * *',
      command: owned?.replace(/^(?:\S+\s+){5}/, '') || this.command, line: owned || `* * * * * ${this.command}`, jobs, marker: this.marker,
      migrationRequired: ['evolution','memory'].some(id => Boolean(this.legacyLine(content, id as ScheduledJobId))) };
  }
  install(ids: ScheduledJobId[]) {
    for (const id of ids) {
      if (!Object.prototype.hasOwnProperty.call(SCHEDULED_EVENT_TYPES, id)) throw new Error('SCHEDULE_INVALID_JOB');
    }
    if (!['linux','darwin'].includes(process.platform) && !this.options.crontab) throw new Error('SCHEDULE_UNSUPPORTED');
    return this.mutate(jobs => {
      for (const id of ids) {
        const schedule = { id, hour: this.options.hour ?? 3, minute: this.options.minute ?? 17, timezone: this.options.timezone || 'Asia/Shanghai' };
        validateSchedule(schedule);
        jobs = [...jobs.filter(job => job.id !== id), schedule];
      }
      return jobs;
    });
  }
  remove(ids: ScheduledJobId[]) { return this.mutate(jobs => jobs.filter(job => !ids.includes(job.id))); }
  private mutate(update: (jobs: DailySchedule[]) => DailySchedule[]) {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true, mode: 0o700 });
    const lock = `${this.configPath}.lock`;
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error: any) { if (error.code === 'EEXIST') throw new Error('SCHEDULE_CONFIG_BUSY_OR_INTERRUPTED'); throw error; }
    try {
      this.editing = true;
      const current = this.crontab.read();
      const jobs = update(this.jobsWithLegacy(current)).sort((a, b) => a.id.localeCompare(b.id));
      let next = current;
      for (const kind of ['xiaoba-evolution-sleep','xiaoba-memory','xiaoba-scheduler']) next = removeBlock(next, `# BEGIN ${kind}:${this.marker}`, `# END ${kind}:${this.marker}`);
      if (jobs.length) next = appendBlock(next, `${this.start()}\n* * * * * ${this.command.replace(/%/g, '\\%')}\n${this.end()}`);
      const config = JSON.stringify({ version: 1, jobs }, null, 2) + '\n';
      const previous = fs.existsSync(this.configPath) ? fs.readFileSync(this.configPath, 'utf8') : undefined;
      const changed = previous !== config || normalizeCrontab(current) !== normalizeCrontab(next);
      if (changed) {
        fs.mkdirSync(path.join(this.root, 'logs'), { recursive: true });
        atomicWrite(this.configPath, config);
        try { if (normalizeCrontab(current) !== normalizeCrontab(next)) this.crontab.write(next); }
        catch (error) { if (previous === undefined) fs.unlinkSync(this.configPath); else atomicWrite(this.configPath, previous); throw error; }
      }
      return { ...this.status(), changed };
    } finally { this.editing = false; fs.rmdirSync(lock); }
  }
  private jobsWithLegacy(content: string): DailySchedule[] {
    const jobs = this.schedules();
    for (const id of ['evolution','memory'] as ScheduledJobId[]) {
      const line = this.legacyLine(content, id);
      if (!line || jobs.some(job => job.id === id)) continue;
      const time = line.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*\s+/);
      const hour = line.match(/--hour\s+(\d+)/), minute = line.match(/--minute\s+(\d+)/), zone = line.match(/--timezone\s+'([^']+)'/);
      if (!time && id === 'evolution') throw new Error('SCHEDULE_LEGACY_INVALID');
      const job = { id, hour: id === 'evolution' ? Number(time![2]) : Number(hour?.[1] ?? 3), minute: id === 'evolution' ? Number(time![1]) : Number(minute?.[1] ?? 17),
        timezone: id === 'evolution' ? Intl.DateTimeFormat().resolvedOptions().timeZone : zone?.[1] || 'Asia/Shanghai' };
      validateSchedule(job); jobs.push(job);
    }
    return jobs;
  }
  private legacyLine(content: string, id: ScheduledJobId) {
    const kind = id === 'evolution' ? 'xiaoba-evolution-sleep' : 'xiaoba-memory';
    return ownedCronLine(content, `# BEGIN ${kind}:${this.marker}`, `# END ${kind}:${this.marker}`);
  }
  private start() { return `# BEGIN xiaoba-scheduler:${this.marker}`; }
  private end() { return `# END xiaoba-scheduler:${this.marker}`; }
}

class SystemCrontabAdapter implements CrontabAdapter {
  read(): string {
    const result = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
    if (result.status === 0) return result.stdout || '';
    if (result.status === 1 && /no crontab/i.test(result.stderr || '')) return '';
    throw new Error(`读取 crontab 失败：${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  }
  write(content: string): void {
    const result = spawnSync('crontab', ['-'], { input: normalizeCrontab(content), encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`写入 crontab 失败：${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  }
}
function atomicWrite(file: string, value: string): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, value, { mode: 0o600 }); fs.renameSync(temporary, file);
}
function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }
function normalizeCrontab(content: string): string { return `${content.replace(/\r\n/g, '\n').trimEnd()}\n`; }
function ownedCronLine(content: string, start: string, end: string): string | undefined {
  const lines = content.split(/\r?\n/), begin = lines.findIndex(line => line.trim() === start), finish = lines.findIndex(line => line.trim() === end);
  if (begin < 0 && finish < 0) return undefined;
  if (begin < 0 || finish <= begin || lines.filter(line => line.trim() === start).length !== 1 || lines.filter(line => line.trim() === end).length !== 1) throw new Error('SCHEDULE_CRON_BLOCK_INVALID');
  return lines.slice(begin + 1, finish).map(line => line.trim()).find(line => line && !line.startsWith('#'));
}
function removeBlock(content: string, start: string, end: string): string {
  ownedCronLine(content, start, end);
  const lines = content.split(/\r?\n/), begin = lines.findIndex(line => line.trim() === start), finish = lines.findIndex(line => line.trim() === end);
  if (begin < 0) return content;
  return [...lines.slice(0, begin), ...lines.slice(finish + 1)].join('\n');
}
function appendBlock(content: string, block: string): string { return `${content.trimEnd()}${content.trim() ? '\n' : ''}${block}\n`; }
