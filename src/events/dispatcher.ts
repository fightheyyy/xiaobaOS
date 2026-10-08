import { isDeepStrictEqual } from 'node:util';
import { AgentEvent, assertAgentEvent } from './event';
import { FileEventStore } from './file-event-store';
import type { EventRecord, EventStatus, EventStore } from './store';

export type { EventRecord, EventStatus } from './store';
export interface EventReceipt {
  id: string;
  status: EventStatus;
  duplicate: boolean;
}
export type EventHandler = (event: AgentEvent) => Promise<void>;

/** Shared admission and routing into existing consumers; no Agent loop or scheduler. */
export class EventDispatcher {
  private readonly handlers = new Map<string, EventHandler>();
  private readonly active = new Map<string, { event: AgentEvent; operation: Promise<EventReceipt> }>();
  private readonly store: EventStore;

  /** A directory remains supported for existing Surface construction. */
  constructor(storeOrRoot?: EventStore | string) {
    this.store = typeof storeOrRoot === 'object' ? storeOrRoot : new FileEventStore(storeOrRoot);
  }

  register(type: string, handler: EventHandler): void {
    if (!type.trim() || this.handlers.has(type)) throw new Error(`EVENT_ROUTE_CONFLICT: ${type}`);
    this.handlers.set(type, handler);
  }

  async dispatch(event: AgentEvent, handler?: EventHandler): Promise<EventReceipt> {
    assertAgentEvent(event);
    const consumer = handler ?? this.handlers.get(event.type);
    if (!consumer) throw new Error(`EVENT_ROUTE_MISSING: ${event.type}`);
    // Detach admission from producer mutation while a handler is awaiting work.
    event = JSON.parse(JSON.stringify(event)) as AgentEvent;
    assertAgentEvent(event);
    const active = this.active.get(event.id);
    if (active) {
      this.assertSameEvent(active.event, event);
      const receipt = await active.operation;
      return { ...receipt, duplicate: true };
    }
    const operation = this.store.withEventLock(event.id, () => this.consume(event, consumer));
    this.active.set(event.id, { event, operation });
    try {
      return await operation;
    } finally {
      this.active.delete(event.id);
    }
  }

  /** Inspect interrupted/failed events; they are never automatically replayed. */
  list(status?: EventStatus): EventRecord[] {
    return this.store.list(status);
  }

  private async consume(event: AgentEvent, handler: EventHandler): Promise<EventReceipt> {
    const record = this.store.read(event.id);
    if (record) {
      this.assertSameEvent(record.event, event);
      if (record.status === 'failed' || record.status === 'running') {
        throw new Error(`EVENT_REVIEW_REQUIRED: ${event.id}`);
      }
      if (record.status === 'handled') return { id: event.id, status: 'handled', duplicate: true };
      event = { ...record.event, traceparent: event.traceparent };
    } else {
      this.write(event, 'pending');
    }
    this.write(event, 'running');
    try {
      // Consumer mutations must not change durable identity or event content.
      await handler(JSON.parse(JSON.stringify(event)) as AgentEvent);
    } catch (error) {
      this.write(event, 'failed');
      throw error;
    }
    this.write(event, 'handled');
    return { id: event.id, status: 'handled', duplicate: false };
  }

  private assertSameEvent(stored: AgentEvent, incoming: AgentEvent): void {
    const content = ({ id, type, source, target, payload }: AgentEvent) =>
      JSON.parse(JSON.stringify({ id, type, source, target, payload }));
    if (!isDeepStrictEqual(content(stored), content(incoming))) {
      throw new Error(`EVENT_ID_CONFLICT: ${incoming.id}`);
    }
  }

  private write(event: AgentEvent, status: EventStatus): void {
    const { traceparent: _traceparent, ...durableEvent } = event;
    this.store.write({ event: durableEvent, status, updatedAt: new Date().toISOString() });
  }
}
