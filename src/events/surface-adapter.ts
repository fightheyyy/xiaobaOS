import type { NormalizedSurfaceEvent } from '../types/surface-event';
import { createAgentEvent, AgentEvent } from './event';

/** Persist only message content and routing, never raw platform metadata. */
export function surfaceAgentEvent(event: NormalizedSurfaceEvent, sourceId = event.adapterId): AgentEvent {
  return createAgentEvent({
    type: event.eventType,
    source: { kind: 'surface', id: sourceId },
    sourceEventId: event.eventId,
    target: {
      sessionKey: event.sessionKey, surface: event.surface,
      channelId: event.channelId, userId: event.userId,
    },
    payload: { text: event.userMessage, payloadType: event.payloadType },
    traceparent: event.traceparent,
  });
}
