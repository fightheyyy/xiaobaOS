import type { AgentEvent } from './event';

export type EventStatus = 'pending' | 'running' | 'handled' | 'failed';
export interface EventRecord {
  event: AgentEvent;
  status: EventStatus;
  updatedAt: string;
}

/** Storage owns exclusive claims; Dispatcher owns record transitions.
 * Implementations must return detached records and exclude transient traceparent.
 * Reads and writes during dispatch occur inside withEventLock.
 */
export interface EventStore {
  read(id: string): EventRecord | undefined;
  write(record: EventRecord): void;
  list(status?: EventStatus): EventRecord[];
  withEventLock<T>(id: string, operation: () => Promise<T>): Promise<T>;
}
