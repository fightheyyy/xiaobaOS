export type NormalizedSurfaceName = 'cli' | 'feishu' | 'weixin' | 'pet';

export interface NormalizedSurfaceEvent {
  surface: NormalizedSurfaceName;
  adapterId: string;
  eventType: string;
  eventId?: string;
  /**
   * Optional W3C trace context supplied by the surface. This is consumed as an
   * in-memory parent context and must not be persisted as local user evidence.
   */
  traceparent?: string;
  sessionKey: string;
  channelId: string;
  userId?: string;
  userMessage: string;
  payloadType: string;
  mentionBot?: boolean;
  source?: string;
  metadata?: Record<string, unknown>;
}

const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}(?:-.+)?$/i;

export function normalizeSurfaceTraceparent(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const traceparent = raw.trim();
  return TRACEPARENT_PATTERN.test(traceparent) ? traceparent.toLowerCase() : undefined;
}

export function extractSurfaceTraceparent(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  return normalizeSurfaceTraceparent(record.traceparent)
    || normalizeSurfaceTraceparent(record.traceParent)
    || normalizeSurfaceTraceparent(asRecord(record.observability)?.traceparent)
    || normalizeSurfaceTraceparent(asRecord(record.metadata)?.traceparent)
    || normalizeSurfaceTraceparent(asRecord(record.headers)?.traceparent)
    || normalizeSurfaceTraceparent(asRecord(record.headers)?.['x-traceparent']);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}
