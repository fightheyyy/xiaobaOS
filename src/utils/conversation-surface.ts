import { Logger } from './logger';
import {
  ConversationContent,
  ConversationSurface,
  createConversationTraceId,
  getConversationJournal,
  stableId,
} from './conversation-journal';
import {
  ChannelCallbacks,
  ChannelDeliveryReceipt,
} from '../types/tool';

export interface ConversationTurnContext {
  surface: ConversationSurface;
  sessionKey: string;
  traceId: string;
  roleName?: string;
}

export interface RecordVisibleInboundInput {
  surface: ConversationSurface;
  sessionKey: string;
  content: ConversationContent[];
  sourceEventId?: string;
  traceId?: string;
  occurredAt?: string;
}

export interface RecordVisibleAssistantInput extends ConversationTurnContext {
  content: ConversationContent[];
  deliveryKey: string;
  platformMessageIds?: string[];
  occurredAt?: string;
}

/**
 * Reserve the local trace identity at ingress. Platform event ids make retries
 * converge on the same trace; local/direct events use a fresh opaque id.
 */
export function reserveConversationTraceId(
  surface: ConversationSurface,
  sessionKey: string,
  sourceEventId?: string,
): string {
  return createConversationTraceId(surface, sessionKey, sourceEventId);
}

/** Record a normal user-visible inbound event before commands, queues, or runtime transforms consume it. */
export async function recordVisibleInbound(
  input: RecordVisibleInboundInput,
): Promise<ConversationTurnContext> {
  const traceId = input.traceId
    || reserveConversationTraceId(input.surface, input.sessionKey, input.sourceEventId);
  await recordFailOpen({
    surface: input.surface,
    sessionKey: input.sessionKey,
    role: 'user',
    content: input.content,
    delivery: {
      status: 'received',
      ...(input.sourceEventId?.trim()
        ? { platform_message_ids: [input.sourceEventId.trim()] }
        : {}),
    },
    traceId,
    messageId: stableId(
      'conversation-inbound-v1',
      input.surface,
      input.sessionKey,
      input.sourceEventId?.trim() || traceId,
    ),
    occurredAt: input.occurredAt,
  });
  return {
    surface: input.surface,
    sessionKey: input.sessionKey,
    traceId,
  };
}

/** Record one already-visible direct reply (CLI output, command reply, or visible stream aggregate). */
export async function recordVisibleAssistant(
  input: RecordVisibleAssistantInput,
): Promise<void> {
  await recordFailOpen({
    surface: input.surface,
    sessionKey: input.sessionKey,
    role: 'assistant',
    content: input.content,
    delivery: {
      status: 'delivered',
      ...(input.platformMessageIds?.length
        ? { platform_message_ids: uniqueStrings(input.platformMessageIds) }
        : {}),
    },
    traceId: input.traceId,
    messageId: stableId(
      'conversation-outbound-v1',
      input.surface,
      input.sessionKey,
      input.traceId,
      input.deliveryKey,
    ),
    roleName: input.roleName,
    occurredAt: input.occurredAt,
  });
}

/**
 * Wrap per-turn channel callbacks. The Journal append occurs only after the
 * underlying platform callback resolves, so failed or retried attempts never
 * become user-visible assistant rows.
 */
export function journalVisibleChannel(
  context: ConversationTurnContext,
  channel: ChannelCallbacks,
): ChannelCallbacks {
  let deliveredCount = 0;
  return {
    chatId: channel.chatId,
    reply: async (chatId, text) => {
      const receipts = await channel.reply(chatId, text);
      const deliveryIndex = ++deliveredCount;
      await recordVisibleAssistant({
        ...context,
        content: [{ type: 'text', text }],
        deliveryKey: `channel:${deliveryIndex}:text`,
        platformMessageIds: platformMessageIds(receipts),
      });
      return receipts;
    },
    sendFile: async (chatId, filePath, fileName) => {
      const receipts = await channel.sendFile(chatId, filePath, fileName);
      const deliveryIndex = ++deliveredCount;
      await recordVisibleAssistant({
        ...context,
        content: [{ type: 'file', name: fileName }],
        deliveryKey: `channel:${deliveryIndex}:file`,
        platformMessageIds: platformMessageIds(receipts),
      });
      return receipts;
    },
  };
}

function platformMessageIds(receipts: ChannelDeliveryReceipt | void): string[] {
  const values = Array.isArray(receipts) ? receipts : receipts ? [receipts] : [];
  return uniqueStrings(values.map(receipt => receipt.platform_message_id || ''));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
}

async function recordFailOpen(
  input: Parameters<ReturnType<typeof getConversationJournal>['record']>[0],
): Promise<void> {
  try {
    await getConversationJournal().record(input);
  } catch (error: any) {
    Logger.warning(`[conversation] journal append failed: ${error?.message || error}`);
  }
}
