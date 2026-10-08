import { createHash, randomUUID } from 'crypto';

export type EventSourceKind = 'surface' | 'connector' | 'timer' | 'runtime';
export interface EventSource { kind: EventSourceKind; id: string }
export interface EventTarget {
  sessionKey: string;
  surface?: string;
  channelId?: string;
  userId?: string;
}

/** Trigger input to existing sessions; distinct from observability trace events. */
export interface AgentEvent<T = unknown> {
  id: string;
  type: string;
  source: EventSource;
  target: EventTarget;
  occurredAt: string;
  payload: T;
  /** In-memory tracing only; excluded from durable records. */
  traceparent?: string;
}

export function createAgentEvent<T>(
  input: Omit<AgentEvent<T>, 'id' | 'occurredAt'> & { sourceEventId?: string; occurredAt?: string },
): AgentEvent<T> {
  const { sourceEventId, ...event } = input;
  const result: AgentEvent<T> = {
    ...event,
    id: randomUUID(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  };
  assertAgentEvent(result);
  if (sourceEventId !== undefined && typeof sourceEventId !== 'string') throw new Error('EVENT_INVALID');
  if (sourceEventId?.trim()) {
    result.id = createHash('sha256').update(JSON.stringify([
      result.source.kind, result.source.id, result.type, result.target.sessionKey, sourceEventId.trim(),
    ])).digest('hex');
  }
  return result;
}

/** Validate the envelope at admission and when reading durable records. */
export function assertAgentEvent(value: unknown): asserts value is AgentEvent {
  const event = value as AgentEvent | undefined;
  const nonempty = (input: unknown): input is string => typeof input === 'string' && Boolean(input.trim());
  if (!event || !nonempty(event.id) || !nonempty(event.type)
    || !nonempty(event.source?.id)
    || !['surface', 'connector', 'timer', 'runtime'].includes(event.source.kind)
    || !nonempty(event.target?.sessionKey)
    || !nonempty(event.occurredAt) || !Number.isFinite(Date.parse(event.occurredAt))
    || !Object.prototype.hasOwnProperty.call(event, 'payload') || event.payload === undefined
    || [event.target.surface, event.target.channelId, event.target.userId, event.traceparent]
      .some(field => field !== undefined && typeof field !== 'string')) {
    throw new Error('EVENT_INVALID');
  }
}
