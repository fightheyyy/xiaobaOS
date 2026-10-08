import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { assertAgentEvent } from './event';
import type { EventRecord, EventStatus, EventStore } from './store';

/** Atomic local records and exclusive cross-process claims; no automatic replay. */
export class FileEventStore implements EventStore {
  constructor(private readonly root = path.resolve(process.cwd(), 'data', 'events')) {}

  read(id: string): EventRecord | undefined {
    const file = this.file(id);
    return fs.existsSync(file) ? this.readFile(file) : undefined;
  }

  list(status?: EventStatus): EventRecord[] {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root)
      .filter(name => name.endsWith('.json'))
      .map(name => this.readFile(path.join(this.root, name)))
      .filter(record => !status || record.status === status);
  }

  async withEventLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.ensureRoot();
    const lock = `${this.file(id)}.lock`;
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      throw new Error(`EVENT_IN_PROGRESS_OR_INTERRUPTED: ${id}`);
    }
    try {
      return await operation();
    } finally {
      fs.rmdirSync(lock);
    }
  }

  write(record: EventRecord): void {
    this.ensureRoot();
    const { traceparent: _traceparent, ...durableEvent } = record.event;
    const file = this.file(record.event.id);
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ ...record, event: durableEvent }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, file);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }

  private readFile(file: string): EventRecord {
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8')) as EventRecord;
      assertAgentEvent(record.event);
      if (!['pending', 'running', 'handled', 'failed'].includes(record.status)
        || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))
        || this.file(record.event.id) !== file) throw new Error('invalid record');
      return record;
    } catch {
      // Never interpret corrupt state as a fresh event and repeat external effects.
      throw new Error(`EVENT_STORE_CORRUPT: ${path.basename(file)}`);
    }
  }

  private ensureRoot(): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  private file(id: string): string {
    return path.join(this.root, `${createHash('sha256').update(id).digest('hex')}.json`);
  }
}
