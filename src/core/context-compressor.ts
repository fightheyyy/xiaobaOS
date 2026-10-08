import { ProviderCallOptions } from '../providers/provider';
import { throwIfCancelled, isCancellation } from '../utils/cancellation';
import { Message, ContentBlock } from '../types';
import { AIService } from '../utils/ai-service';
import { estimateMessagesTokens } from './token-estimator';
import { Logger } from '../utils/logger';
import { Metrics } from '../utils/metrics';

const COMPACT_BOUNDARY_PREFIX = '[compact_boundary]';
const SESSION_MEMORY_PREFIX = '[session_memory]';
const IM_VISIBLE_TRANSCRIPT_PREFIX = '[im_visible_transcript]';
const LAST_TURN_ANCHOR_PREFIX = '[last_turn_anchor]';
const LEGACY_SUMMARY_PREFIX = '[以下是之前 ';
const RECENT_TURNS_TO_KEEP = 3;
const MAX_EXISTING_MEMORY_CHARS = 4000;
const MAX_OLDER_CONVERSATION_CHARS = 12000;
const MAX_TOOL_RESULT_PREVIEW = 1200;
const MAX_TOOL_RESULT_LINE_CHARS = 240;
const MAX_TOOL_ARGUMENT_CHARS = 1600;
const MAX_SESSION_MEMORY_CHARS = 6000;
const MAX_RECENT_USER_CHARS = 6000;
const MAX_RECENT_ASSISTANT_CHARS = 4000;
const MAX_VISIBLE_TRANSCRIPT_CHARS = 3000;
const MAX_LAST_TURN_ANCHOR_CHARS = 4000;
const LAST_TURN_TAIL_TOKEN_BUDGET = 6000;
const MAX_VISIBLE_EVENTS = 8;
const TOOL_RESULT_HEAD_LINES = 6;
const TOOL_RESULT_TAIL_LINES = 6;
export const DEFAULT_MAX_CONTEXT_TOKENS = 258400;
export const DEFAULT_COMPACTION_THRESHOLD = 0.7;

export function resolveCompactionThreshold(): number {
  const envValue = Number(process.env.XIAOBA_CONTEXT_COMPACTION_THRESHOLD);
  if (Number.isFinite(envValue) && envValue > 0 && envValue < 1) {
    return envValue;
  }
  return DEFAULT_COMPACTION_THRESHOLD;
}

export function contentToString(content: string | ContentBlock[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '[图片]';
  return content.map(block => block.type === 'text' ? block.text : '[图片]').join('');
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = Math.max(0, max - head - 20);
  return `${text.slice(0, head)}\n...[中间省略 ${text.length - head - tail} 字符]...\n${text.slice(text.length - tail)}`;
}

function limitSection(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return truncateMiddle(text, maxChars);
}

function formatLines(lines: string[], maxHead: number = 6, maxTail: number = 6): string {
  const slim = (line: string) => truncateMiddle(line, MAX_TOOL_RESULT_LINE_CHARS);
  if (lines.length <= maxHead + maxTail) {
    return limitSection(lines.map(slim).join('\n'), MAX_TOOL_RESULT_PREVIEW);
  }
  const head = lines.slice(0, maxHead).map(slim);
  const tail = lines.slice(-maxTail).map(slim);
  return limitSection(
    [...head, `...[中间省略 ${lines.length - maxHead - maxTail} 行]...`, ...tail].join('\n'),
    MAX_TOOL_RESULT_PREVIEW,
  );
}

function summarizeToolResult(toolName: string, text: string): string {
  if (text.length <= MAX_TOOL_RESULT_PREVIEW) return text;
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n').map(line => line.trimEnd());
  const nonEmptyLines = lines.filter(Boolean);
  const preview = formatLines(nonEmptyLines, TOOL_RESULT_HEAD_LINES, TOOL_RESULT_TAIL_LINES);
  return [
    `[tool:${toolName}] 输出已压缩`,
    `原始长度: ${text.length} 字符, ${lines.length} 行`,
    preview,
  ].filter(Boolean).join('\n');
}

function cloneWithContent(message: Message, content: string): Message {
  return {
    ...message,
    content,
  };
}

function limitContentForRetention(
  content: Message['content'],
  maxChars: number,
): Message['content'] {
  if (!content) return content;
  if (typeof content === 'string') return limitSection(content, maxChars);
  if (!Array.isArray(content)) return content;

  return content.map(block => {
    if (block.type !== 'text') return block;
    return {
      ...block,
      text: limitSection(block.text, maxChars),
    };
  });
}

function summarizeToolArguments(args: string): string {
  if (!args || args.length <= MAX_TOOL_ARGUMENT_CHARS) return args;

  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return JSON.stringify({
      _truncated: true,
      preview: truncateMiddle(args, MAX_TOOL_ARGUMENT_CHARS),
      originalChars: args.length,
    });
  }

  return JSON.stringify({
    _truncated: true,
    preview: truncateMiddle(JSON.stringify(parsed), MAX_TOOL_ARGUMENT_CHARS),
    originalChars: args.length,
  });
}

function normalizeSummaryText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '(压缩摘要为空)';
  return limitSection(trimmed, MAX_SESSION_MEMORY_CHARS);
}

function parseToolArguments(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

interface OutboundEvent {
  type: 'text' | 'file' | 'assistant';
  toolName?: string;
  text?: string;
  filePath?: string;
  fileName?: string;
  status?: string;
  userText?: string;
}

function extractOutboundFromToolCall(
  toolName: string,
  args: Record<string, unknown>,
  status?: string,
  userText?: string,
): OutboundEvent | null {
  if (toolName === 'send_text') {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    return text ? { type: 'text', toolName, text, status, userText } : null;
  }

  if (toolName === 'send_file') {
    const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : '';
    const fileName = typeof args.file_name === 'string' ? args.file_name.trim() : '';
    if (!filePath && !fileName) return null;
    return { type: 'file', toolName, filePath, fileName, status, userText };
  }

  if (toolName === 'reply') {
    const text = typeof args.message === 'string' ? args.message.trim() : '';
    return text ? { type: 'text', toolName, text, status, userText } : null;
  }

  if (toolName === 'feishu_mention') {
    const message = typeof args.message === 'string' ? args.message.trim() : '';
    const mentions = Array.isArray(args.mentions)
      ? args.mentions
        .map(item => typeof item === 'object' && item && typeof (item as { name?: unknown }).name === 'string'
          ? `@${String((item as { name: string }).name).trim()}`
          : '')
        .filter(Boolean)
      : [];
    const text = [mentions.join(' ').trim(), message].filter(Boolean).join(' ').trim();
    return text ? { type: 'text', toolName, text, status, userText } : null;
  }

  return null;
}

function formatOutboundEvent(event: OutboundEvent): string {
  const user = event.userText
    ? `用户: ${limitSection(event.userText, 180)}\n`
    : '';

  if (event.type === 'file') {
    return [
      user + `文件: ${event.fileName || '(未命名文件)'}`,
      event.filePath ? `path: ${event.filePath}` : '',
      event.status ? `status: ${limitSection(event.status, 240)}` : '',
    ].filter(Boolean).join('\n');
  }

  if (event.type === 'assistant') {
    return `${user}助手可见回复: ${limitSection(event.text || '', 600)}`;
  }

  return [
    user + `文本: ${limitSection(event.text || '', 800)}`,
    event.status ? `status: ${limitSection(event.status, 240)}` : '',
  ].filter(Boolean).join('\n');
}

function isCompactBoundaryMessage(message: Message): boolean {
  return message.role === 'system'
    && typeof message.content === 'string'
    && message.content.startsWith(COMPACT_BOUNDARY_PREFIX);
}

function isSessionMemoryMessage(message: Message): boolean {
  return message.role === 'system'
    && typeof message.content === 'string'
    && message.content.startsWith(SESSION_MEMORY_PREFIX);
}

function isImVisibleTranscriptMessage(message: Message): boolean {
  return message.role === 'system'
    && typeof message.content === 'string'
    && message.content.startsWith(IM_VISIBLE_TRANSCRIPT_PREFIX);
}

function isLastTurnAnchorMessage(message: Message): boolean {
  return message.role === 'system'
    && typeof message.content === 'string'
    && message.content.startsWith(LAST_TURN_ANCHOR_PREFIX);
}

function isLegacySummaryMessage(message: Message): boolean {
  return message.role === 'user'
    && typeof message.content === 'string'
    && message.content.startsWith(LEGACY_SUMMARY_PREFIX);
}

function extractSessionMemoryContent(message: Message): string {
  const text = contentToString(message.content);
  if (text.startsWith(SESSION_MEMORY_PREFIX)) {
    return text.slice(SESSION_MEMORY_PREFIX.length).trim();
  }
  if (text.startsWith(LEGACY_SUMMARY_PREFIX)) {
    return text.trim();
  }
  return text.trim();
}

function extractImRuntimeMemoryContent(message: Message): string {
  const text = contentToString(message.content);
  if (text.startsWith(IM_VISIBLE_TRANSCRIPT_PREFIX)) {
    return `Previous IM Visible Transcript:\n${text.slice(IM_VISIBLE_TRANSCRIPT_PREFIX.length).trim()}`;
  }
  if (text.startsWith(LAST_TURN_ANCHOR_PREFIX)) {
    return `Previous Last Turn Anchor:\n${text.slice(LAST_TURN_ANCHOR_PREFIX.length).trim()}`;
  }
  return '';
}

export function messagesToConversationText(messages: Message[]): string {
  const lines: string[] = [];
  let pendingToolUses: Array<{ name: string; args: string }> = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = contentToString(msg.content);
      lines.push(`[用户] ${text}`);
      pendingToolUses = [];
    } else if (msg.role === 'assistant') {
      const text = contentToString(msg.content);
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const toolCalls = msg.tool_calls.map(tc => {
          let argsObj: Record<string, unknown> = {};
          try {
            argsObj = JSON.parse(tc.function.arguments || '{}');
          } catch {}
          const outbound = extractOutboundFromToolCall(tc.function.name, argsObj);
          if (outbound) {
            return `用户可见输出: ${formatOutboundEvent(outbound).replace(/\n/g, '; ')}`;
          }
          return `工具调用: ${tc.function.name}(${JSON.stringify(argsObj)})`;
        }).join(', ');
        lines.push(`[AI] ${text || '(无文本输出)'}。${toolCalls}`);
        pendingToolUses = msg.tool_calls.map(tc => ({
          name: tc.function.name,
          args: tc.function.arguments,
        }));
      } else if (text) {
        lines.push(`[AI] ${text}`);
        pendingToolUses = [];
      }
    } else if (msg.role === 'tool') {
      const text = summarizeToolResult(msg.name || 'unknown', contentToString(msg.content));
      const name = msg.name || 'unknown';
      lines.push(`[工具 ${name}] ${text}`);
    }
  }

  return lines.join('\n\n');
}

const COMPACT_NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.`;

export function buildCompactSystemPrompt(customInstructions?: string): string {
  let prompt = COMPACT_NO_TOOLS_PREAMBLE + '\n\n' + BASE_COMPACT_PROMPT;

  if (customInstructions && customInstructions.trim()) {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`;
  }

  prompt += `\n\nREMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block.`;
  return prompt;
}

const BASE_COMPACT_PROMPT = `Create a working-memory summary for a coding/chat agent.

This is NOT a general conversation recap. The summary must preserve only the information required to continue the task correctly after older messages are removed.

Focus on:
1. Task: the user's current goals, requested outputs, and any hard constraints.
2. Facts: confirmed facts that must remain true (paths, files, environment facts, user corrections, important dates, attachment references).
3. Work Done: actions already completed and their outcomes.
4. Failures / Warnings: failed attempts, dead ends, and things that should NOT be repeated.
5. User-visible Outputs: text already sent to the user and files already sent to the user.
6. Next State: the most important context the next model turn must remember.

Rules:
- Prefer precise facts over narrative.
- Keep the summary compact and actionable.
- Do NOT include verbose tool output.
- Do NOT copy long logs or file contents.
- Preserve user-visible outbound text/file facts so the assistant does not repeat or contradict sent messages.
- If prior session memory exists, merge it carefully with the new older conversation and remove duplication.

Output format:
<analysis>
Reason about what must be preserved and what can be safely dropped.
</analysis>

<summary>
Task:
- ...

Facts:
- ...

Work Done:
- ...

Failures / Warnings:
- ...

User-visible Outputs:
- ...

Next State:
- ...
</summary>`;

export function parseCompactSummary(raw: string): string {
  const match = raw.match(/<summary>([\s\S]*?)<\/summary>/i);
  return match ? match[1].trim() : raw.trim();
}

export class ContextCompressor {
  private maxContextTokens: number;
  private compactionThreshold: number;
  private aiService: AIService;

  constructor(aiService: AIService, options?: {
    maxContextTokens?: number;
    compactionThreshold?: number;
  }) {
    this.aiService = aiService;
    this.maxContextTokens = options?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
    this.compactionThreshold = options?.compactionThreshold ?? resolveCompactionThreshold();
  }

  needsCompaction(messages: Message[]): boolean {
    const used = estimateMessagesTokens(messages);
    const threshold = this.maxContextTokens * this.compactionThreshold;
    return used > threshold;
  }

  getUsageInfo(messages: Message[]): {
    usedTokens: number;
    maxTokens: number;
    usagePercent: number;
  } {
    const used = estimateMessagesTokens(messages);
    return {
      usedTokens: used,
      maxTokens: this.maxContextTokens,
      usagePercent: Math.round((used / this.maxContextTokens) * 100),
    };
  }

  private splitRecentTurns(messages: Message[]): {
    olderMessages: Message[];
    recentMessages: Message[];
  } {
    const userIndexes: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'user' && !isLegacySummaryMessage(msg)) {
        userIndexes.push(i);
      }
    }

    if (userIndexes.length === 0) {
      return { olderMessages: [], recentMessages: messages };
    }

    if (userIndexes.length <= RECENT_TURNS_TO_KEEP) {
      return { olderMessages: [], recentMessages: messages };
    }

    const recentStart = userIndexes[userIndexes.length - RECENT_TURNS_TO_KEEP];
    return {
      olderMessages: messages.slice(0, recentStart),
      recentMessages: messages.slice(recentStart),
    };
  }

  private splitForImRetention(messages: Message[]): {
    olderMessages: Message[];
    recentMessages: Message[];
    lastTurnMessages: Message[];
  } {
    const userIndexes: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'user' && !isLegacySummaryMessage(msg)) {
        userIndexes.push(i);
      }
    }

    if (userIndexes.length === 0) {
      return { olderMessages: [], recentMessages: messages, lastTurnMessages: messages };
    }

    if (userIndexes.length <= RECENT_TURNS_TO_KEEP) {
      return { olderMessages: [], recentMessages: messages, lastTurnMessages: messages.slice(userIndexes[userIndexes.length - 1]) };
    }

    const lastTurnStart = userIndexes[userIndexes.length - 1];
    const recentStart = userIndexes[Math.max(0, userIndexes.length - RECENT_TURNS_TO_KEEP)];
    return {
      olderMessages: messages.slice(0, lastTurnStart),
      recentMessages: messages.slice(recentStart, lastTurnStart),
      lastTurnMessages: messages.slice(lastTurnStart),
    };
  }

  private extractOutboundEvents(messages: Message[]): OutboundEvent[] {
    const events: OutboundEvent[] = [];
    const toolResults = new Map<string, Message>();
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.tool_call_id) {
        toolResults.set(msg.tool_call_id, msg);
      }
    }

    let currentUser = '';
    for (const msg of messages) {
      if (msg.role === 'user') {
        currentUser = contentToString(msg.content);
        continue;
      }

      if (msg.role !== 'assistant') continue;

      if (msg.tool_calls?.length) {
        for (const toolCall of msg.tool_calls) {
          const result = toolResults.get(toolCall.id);
          const event = extractOutboundFromToolCall(
            toolCall.function.name,
            parseToolArguments(toolCall.function.arguments),
            result ? contentToString(result.content) : undefined,
            currentUser,
          );
          if (event) events.push(event);
        }
        continue;
      }

      const text = contentToString(msg.content).trim();
      if (text) {
        events.push({
          type: 'assistant',
          text,
          userText: currentUser,
        });
      }
    }

    return events;
  }

  private buildVisibleTranscriptMessage(messages: Message[]): Message | null {
    const events = this.extractOutboundEvents(messages).slice(-MAX_VISIBLE_EVENTS);
    if (events.length === 0) return null;

    const content = events
      .map((event, index) => `${index + 1}. ${formatOutboundEvent(event)}`)
      .join('\n\n');

    return {
      role: 'system',
      content: `${IM_VISIBLE_TRANSCRIPT_PREFIX}\n最近用户已经看到的 IM 输出事实：\n${limitSection(content, MAX_VISIBLE_TRANSCRIPT_CHARS)}`,
    };
  }

  private buildLastTurnAnchorMessage(lastTurnMessages: Message[]): Message | null {
    if (lastTurnMessages.length === 0) return null;

    const lastUser = lastTurnMessages.find(msg => msg.role === 'user');
    const outboundEvents = this.extractOutboundEvents(lastTurnMessages);
    const finalAssistant = [...lastTurnMessages]
      .reverse()
      .find(msg => msg.role === 'assistant' && !msg.tool_calls?.length && contentToString(msg.content).trim());
    const lastMessage = lastTurnMessages[lastTurnMessages.length - 1];

    const sections: string[] = [];
    if (lastUser) {
      sections.push(`User Input:\n${contentToString(lastUser.content)}`);
    }
    if (outboundEvents.length > 0) {
      sections.push(
        `User-visible Outputs In This Turn:\n${outboundEvents
          .map((event, index) => `${index + 1}. ${formatOutboundEvent(event)}`)
          .join('\n\n')}`,
      );
    }
    if (finalAssistant) {
      sections.push(`Final Assistant State:\n${contentToString(finalAssistant.content)}`);
    } else if (lastMessage) {
      sections.push(`Tail State:\nlast_message_role=${lastMessage.role}${lastMessage.name ? ` name=${lastMessage.name}` : ''}`);
    }

    if (sections.length === 0) return null;

    return {
      role: 'system',
      content: `${LAST_TURN_ANCHOR_PREFIX}\n${limitSection(sections.join('\n\n---\n\n'), MAX_LAST_TURN_ANCHOR_CHARS)}`,
    };
  }

  private buildLastTurnTail(lastTurnMessages: Message[]): Message[] {
    if (lastTurnMessages.length <= 1) return [];

    const tail = lastTurnMessages.slice(1).map(msg => this.slimMessageForRetention(msg));
    const kept: Message[] = [];

    for (let i = tail.length - 1; i >= 0; i--) {
      const candidate = [tail[i], ...kept];
      if (estimateMessagesTokens(candidate) <= LAST_TURN_TAIL_TOKEN_BUDGET) {
        kept.unshift(tail[i]);
      }
    }

    return kept;
  }

  private slimMessageForRetention(message: Message): Message {
    if (message.role === 'tool') {
      const content = summarizeToolResult(message.name || 'unknown', contentToString(message.content));
      return cloneWithContent(message, content);
    }

    const maxChars = message.role === 'user'
      ? MAX_RECENT_USER_CHARS
      : message.role === 'assistant'
        ? MAX_RECENT_ASSISTANT_CHARS
        : Number.POSITIVE_INFINITY;

    const next: Message = {
      ...message,
      content: Number.isFinite(maxChars)
        ? limitContentForRetention(message.content, maxChars)
        : message.content,
    };

    if (next.tool_calls?.length) {
      next.tool_calls = next.tool_calls.map(toolCall => ({
        ...toolCall,
        function: {
          ...toolCall.function,
          arguments: summarizeToolArguments(toolCall.function.arguments),
        },
      }));
    }

    return next;
  }

  private buildSummaryInput(
    existingMemory: string[],
    olderMessages: Message[],
  ): string {
    const sections: string[] = [];

    if (existingMemory.length > 0) {
      sections.push(
        `Existing Session Memory:\n${limitSection(existingMemory.join('\n\n'), MAX_EXISTING_MEMORY_CHARS)}`,
      );
    }

    if (olderMessages.length > 0) {
      sections.push(
        `Older Conversation Since Last Memory:\n${limitSection(messagesToConversationText(olderMessages), MAX_OLDER_CONVERSATION_CHARS)}`,
      );
    }

    return sections.join('\n\n---\n\n');
  }

  async compact(
    messages: Message[],
    customInstructions?: string,
    options?: ProviderCallOptions,
  ): Promise<Message[]> {
    throwIfCancelled(options?.abortSignal);
    const before = estimateMessagesTokens(messages);

    const preservedSystem = messages.filter(m =>
      m.role === 'system'
      && !isCompactBoundaryMessage(m)
      && !isSessionMemoryMessage(m)
      && !isImVisibleTranscriptMessage(m)
      && !isLastTurnAnchorMessage(m)
    );
    const existingMemory = messages
      .filter(m =>
        isSessionMemoryMessage(m)
        || isLegacySummaryMessage(m)
        || isImVisibleTranscriptMessage(m)
        || isLastTurnAnchorMessage(m)
      )
      .map(m => isImVisibleTranscriptMessage(m) || isLastTurnAnchorMessage(m)
        ? extractImRuntimeMemoryContent(m)
        : extractSessionMemoryContent(m))
      .filter(Boolean);
    const session = messages.filter(m =>
      m.role !== 'system'
      && !isLegacySummaryMessage(m),
    );

    if (session.length === 0) {
      const memoryMessages = existingMemory.length > 0
        ? [{
            role: 'system' as const,
            content: `${SESSION_MEMORY_PREFIX}\n${existingMemory.join('\n\n')}`,
          }]
        : [];
      return [...preservedSystem, ...memoryMessages];
    }

    const { olderMessages, recentMessages, lastTurnMessages } = this.splitForImRetention(session);
    const compactedRecent = recentMessages.map(msg => this.slimMessageForRetention(msg));
    const lastUserMessage = lastTurnMessages.find(msg => msg.role === 'user');
    const lastTurnAnchorMessage = this.buildLastTurnAnchorMessage(lastTurnMessages);
    const visibleTranscriptMessage = this.buildVisibleTranscriptMessage(recentMessages);
    const lastTurnTail = this.buildLastTurnTail(lastTurnMessages);
    const summaryInput = this.buildSummaryInput(existingMemory, olderMessages);

    if (!summaryInput.trim()) {
      return [
        ...preservedSystem,
        ...compactedRecent,
      ];
    }

    try {
      const summaryMessages: Message[] = [
        {
          role: 'system',
          content: buildCompactSystemPrompt(customInstructions),
        },
        {
          role: 'user',
          content: summaryInput,
        },
      ];

      let fullContent = '';
      const resp = await this.aiService.chatStream(
        summaryMessages,
        undefined,
        {
          onText: (text) => { fullContent += text; },
        }, options
      );
      const rawSummary = fullContent;

      if (resp.usage) {
        Metrics.recordAICall('stream', resp.usage);
      }

      const summaryText = parseCompactSummary(rawSummary || resp.content || '');
      const normalizedSummary = normalizeSummaryText(summaryText);

      const boundaryMessage: Message = {
        role: 'system',
        content: `${COMPACT_BOUNDARY_PREFIX} ${olderMessages.length} older messages summarized. Pre-compact tokens: ${before}`,
      };

      const memoryMessage: Message = {
        role: 'system',
        content: `${SESSION_MEMORY_PREFIX}\n${normalizedSummary}`,
      };

      const result: Message[] = [
        ...preservedSystem,
        boundaryMessage,
        memoryMessage,
        ...(visibleTranscriptMessage ? [visibleTranscriptMessage] : []),
        ...(lastTurnAnchorMessage ? [lastTurnAnchorMessage] : []),
        ...(lastUserMessage ? [lastUserMessage] : []),
        ...lastTurnTail,
      ];

      const after = estimateMessagesTokens(result);

      Logger.info(
        `[压缩] ${messages.length} 条 → ${result.length} 条，` +
        `${before} tokens → ${after} tokens（节省 ${Math.round((1 - after / before) * 100)}%）`
      );

      return result;
    } catch (err: any) {
      Logger.error(`[压缩] AI 摘要失败: ${err.message}`);
      throw err;
    }
  }

  compactDeterministic(messages: Message[], reason?: string): Message[] {
    const before = estimateMessagesTokens(messages);
    const preservedSystem = messages.filter(m =>
      m.role === 'system'
      && !isCompactBoundaryMessage(m)
      && !isSessionMemoryMessage(m)
      && !isImVisibleTranscriptMessage(m)
      && !isLastTurnAnchorMessage(m)
    );
    const existingMemory = messages
      .filter(m =>
        isSessionMemoryMessage(m)
        || isLegacySummaryMessage(m)
        || isImVisibleTranscriptMessage(m)
        || isLastTurnAnchorMessage(m)
      )
      .map(m => isImVisibleTranscriptMessage(m) || isLastTurnAnchorMessage(m)
        ? extractImRuntimeMemoryContent(m)
        : extractSessionMemoryContent(m))
      .filter(Boolean);
    const session = messages.filter(m =>
      m.role !== 'system'
      && !isLegacySummaryMessage(m),
    );
    const { olderMessages, recentMessages, lastTurnMessages } = this.splitForImRetention(session);
    const compactedRecent = recentMessages.map(msg => this.slimMessageForRetention(msg));
    const lastUserMessage = lastTurnMessages.find(msg => msg.role === 'user');
    const lastTurnAnchorMessage = this.buildLastTurnAnchorMessage(lastTurnMessages);
    const visibleTranscriptMessage = this.buildVisibleTranscriptMessage(recentMessages);
    const lastTurnTail = this.buildLastTurnTail(lastTurnMessages);

    const memorySections: string[] = [];
    if (reason) {
      memorySections.push(`Fallback Reason:\n- ${reason}`);
    }
    if (existingMemory.length > 0) {
      memorySections.push(
        `Existing Session Memory:\n${limitSection(existingMemory.join('\n\n'), Math.floor(MAX_SESSION_MEMORY_CHARS * 0.45))}`,
      );
    }
    if (olderMessages.length > 0) {
      memorySections.push(
        `Older Conversation Extract:\n${limitSection(messagesToConversationText(olderMessages), Math.floor(MAX_SESSION_MEMORY_CHARS * 0.55))}`,
      );
    }

    const result: Message[] = [...preservedSystem];
    if (memorySections.length > 0) {
      result.push({
        role: 'system',
        content: `${COMPACT_BOUNDARY_PREFIX} ${olderMessages.length} older messages summarized with deterministic fallback. Pre-compact tokens: ${before}`,
      });
      result.push({
        role: 'system',
        content: `${SESSION_MEMORY_PREFIX}\n${normalizeSummaryText(memorySections.join('\n\n---\n\n'))}`,
      });
    }
    if (memorySections.length === 0) {
      result.push(...compactedRecent);
    } else {
      if (visibleTranscriptMessage) result.push(visibleTranscriptMessage);
      if (lastTurnAnchorMessage) result.push(lastTurnAnchorMessage);
      if (lastUserMessage) result.push(lastUserMessage);
      result.push(...lastTurnTail);
    }

    const after = estimateMessagesTokens(result);
    Logger.warning(
      `[压缩] 使用兜底压缩: ${messages.length} 条 → ${result.length} 条，` +
      `${before} tokens → ${after} tokens`
    );

    return result;
  }

  async compactWithFallback(
    messages: Message[],
    customInstructions?: string,
    options?: ProviderCallOptions,
  ): Promise<Message[]> {
    throwIfCancelled(options?.abortSignal);
    try {
      return await this.compact(messages, customInstructions, options);
    } catch (err: any) {
      if (isCancellation(err)) throw err;
      return this.compactDeterministic(messages, err?.message || String(err));
    }
  }
}
