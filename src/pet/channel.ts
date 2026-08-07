import { Request, Response, Router } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AIService } from '../utils/ai-service';
import { createRoleAwareToolManager } from '../bootstrap/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { AgentSession, AgentServices, SessionCallbacks } from '../core/agent-session';
import { MessageSessionManager } from '../core/message-session-manager';
import { SubAgentManager } from '../core/sub-agent-manager';
import { ChannelCallbacks } from '../types/tool';
import {
  extractSurfaceTraceparent,
  normalizeSurfaceTraceparent,
  NormalizedSurfaceEvent,
} from '../types/surface-event';
import { Logger } from '../utils/logger';
import { RoleResolver } from '../utils/role-resolver';
import { PetChatHistoryStore } from './chat-history-store';
import {
  ConversationTurnContext,
  journalVisibleChannel,
  recordVisibleAssistant,
  recordVisibleInbound,
  reserveConversationTraceId,
} from '../utils/conversation-surface';

type PetState =
  | 'idle'
  | 'running-right'
  | 'running-left'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review';

interface PetManifest {
  id: string;
  displayName?: string;
  description?: string;
  spriteVersionNumber?: number;
  spritesheetPath?: string;
}

interface PetEvent {
  type: string;
  id?: number;
  petId?: string;
  sessionKey?: string;
  timestamp?: string;
  [key: string]: unknown;
}

const DEFAULT_SESSION_TTL = 60 * 60 * 1000;
const PET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,80}$/i;
const PET_SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,80}$/i;
const PET_ROLE_SESSION_SEGMENT_PATTERN = /^role-[a-z0-9][a-z0-9_-]{0,80}$/i;

export function normalizePetIdInput(value: unknown, defaultPetId?: string | null): string {
  const petId = typeof value === 'string' && value.trim()
    ? value.trim()
    : defaultPetId;

  if (!petId || !PET_ID_PATTERN.test(petId)) {
    throw new Error('invalid pet id');
  }
  return petId;
}

export function normalizePetSessionKey(petId: string, value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const sessionKey = typeof raw === 'string' && raw.trim()
    ? raw.trim()
    : `pet:${petId}`;

  const baseSessionKey = `pet:${petId}`;
  if (sessionKey === baseSessionKey) return sessionKey;
  if (sessionKey === `${baseSessionKey}:role-base`) return baseSessionKey;
  if (!sessionKey.startsWith(baseSessionKey + ':')) {
    throw new Error('invalid pet session key');
  }

  const sessionSegments = sessionKey.slice(baseSessionKey.length + 1).split(':');
  if (sessionSegments.some(segment => !PET_SESSION_ID_PATTERN.test(segment))) {
    throw new Error('invalid pet session key');
  }
  if (!PET_ROLE_SESSION_SEGMENT_PATTERN.test(sessionSegments[0])) {
    throw new Error('invalid pet session key');
  }
  return sessionKey;
}

export function normalizePetMessageSurfaceEvent(
  body: unknown,
  options: { defaultPetId?: string | null } = {},
): NormalizedSurfaceEvent {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const petId = normalizePetIdInput(input.petId, options.defaultPetId);
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) {
    throw new Error('text required');
  }

  const sessionKey = normalizePetSessionKey(petId, input.sessionKey);
  const source = typeof input.source === 'string' && input.source.trim()
    ? input.source.trim().slice(0, 40)
    : 'unknown';
  const eventId = typeof input.eventId === 'string' && input.eventId.trim()
    ? input.eventId.trim()
    : undefined;
  const traceparent = extractSurfaceTraceparent(input);

  return {
    surface: 'pet',
    adapterId: 'pet_channel_message',
    eventType: 'pet.message',
    eventId,
    traceparent,
    sessionKey,
    channelId: sessionKey,
    userId: sessionKey,
    userMessage: text,
    payloadType: text.startsWith('/') ? 'command' : 'text',
    source,
    metadata: { petId },
  };
}

export interface PetChannelOptions {
  services?: AgentServices;
  sessionTtlMs?: number;
  /** Internal runtime pin. HTTP callers cannot select or override this Skill. */
  requiredActiveSkillName?: string;
}

interface PetScopedServices {
  services: AgentServices;
  ready: Promise<void>;
}

export function createPetRouter(options: PetChannelOptions = {}): Router {
  const channel = new PetChannel(options);
  return channel.router;
}

export class PetChannel {
  readonly router = Router();
  private readonly services: AgentServices;
  private readonly sessionManager: MessageSessionManager;
  private readonly skillsReady: Promise<void>;
  private readonly scopedServices = new Map<string, PetScopedServices>();
  private readonly useFixedServices: boolean;
  private readonly chatHistory = new PetChatHistoryStore();
  private readonly events = new PetEventHub(this.chatHistory);
  private readonly messageQueues = new Map<string, Promise<void>>();
  private readonly requiredActiveSkillName?: string;

  constructor(options: PetChannelOptions = {}) {
    this.requiredActiveSkillName = options.requiredActiveSkillName?.trim() || undefined;
    this.useFixedServices = Boolean(options.services);
    const skillManager = options.services?.skillManager || new SkillManager();
    this.services = options.services || {
      aiService: new AIService(),
      toolManager: createRoleAwareToolManager(),
      skillManager,
    };
    this.skillsReady = skillManager.loadSkills()
      .catch((err: any) => Logger.warning(`[pet] Skills 加载失败: ${err.message}`));

    this.sessionManager = new MessageSessionManager(
      this.services,
      'pet',
      options.sessionTtlMs ?? DEFAULT_SESSION_TTL,
      key => this.resolveServicesForSessionKey(key),
    );

    this.sessionManager.setWakeupSendFn(async (channelId, text) => {
      Logger.info(`[pet:${channelId}] wakeup: ${text.slice(0, 120)}`);
    });

    this.mountRoutes();
  }

  async destroy(): Promise<void> {
    this.events.close();
    await this.sessionManager.destroy();
  }

  private resolveServicesForSessionKey(sessionKey: string): AgentServices {
    if (this.useFixedServices) {
      return this.services;
    }

    const roleName = this.resolveRoleNameFromSessionKey(sessionKey);
    if (!roleName) {
      return this.services;
    }

    return this.getScopedServices(roleName).services;
  }

  private async ensureSkillsReadyForSessionKey(sessionKey: string): Promise<void> {
    if (this.useFixedServices) {
      await this.skillsReady;
      return;
    }

    const roleName = this.resolveRoleNameFromSessionKey(sessionKey);
    if (!roleName) {
      await this.skillsReady;
      return;
    }

    await this.getScopedServices(roleName).ready;
  }

  private getScopedServices(roleName: string): PetScopedServices {
    const cached = this.scopedServices.get(roleName);
    if (cached) {
      return cached;
    }

    const skillManager = new SkillManager(roleName);
    const scoped: PetScopedServices = {
      services: {
        aiService: new AIService(),
        toolManager: createRoleAwareToolManager(process.cwd(), {}, roleName),
        skillManager,
        roleName,
      },
      ready: skillManager.loadSkills()
        .catch((err: any) => Logger.warning(`[pet:${roleName}] Skills 加载失败: ${err.message}`)),
    };
    this.scopedServices.set(roleName, scoped);
    return scoped;
  }

  private resolveRoleNameFromSessionKey(sessionKey: string): string | undefined {
    const match = sessionKey.match(/^pet:[^:]+:role-([^:]+)(?::|$)/);
    const roleKey = match?.[1]?.trim();
    if (!roleKey || RoleResolver.normalizeRoleName(roleKey) === 'base') {
      return undefined;
    }
    return RoleResolver.resolveRoleDirectoryName(roleKey);
  }

  private mountRoutes(): void {
    this.router.get('/pet/pets', (_req, res) => {
      const pets = this.listPets();
      const activeRole = RoleResolver.getActiveRoleName() || null;
      const rolePetId = this.resolveRolePetId(activeRole, pets);
      res.json({
        pets,
        defaultPetId: this.resolveDefaultPetId(pets, rolePetId),
        rolePetId,
        activeRole,
      });
    });

    this.router.get('/pet/pets/:petId/spritesheet', (req, res) => {
      try {
        const pet = this.resolvePet(req.params.petId);
        res.sendFile(pet.spritesheetPath, err => {
          if (!err || res.headersSent) return;
          res.status(404).json({ error: err.message });
        });
      } catch (err: any) {
        res.status(404).json({ error: err.message });
      }
    });

    this.router.post('/pet/wake', async (req, res) => {
      try {
        const petId = this.normalizePetId(req.body?.petId);
        const sessionKey = this.normalizeSessionKey(petId, req.body?.sessionKey);
        await this.ensureSkillsReadyForSessionKey(sessionKey);
        this.sessionManager.getOrCreate(sessionKey, sessionKey);
        this.events.publish(petId, sessionKey, { type: 'state', state: 'waving', reason: 'wake' });
        res.json({
          ok: true,
          sessionKey,
          petId,
          state: 'waving',
        });
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    });

    this.router.post('/pet/message', async (req, res) => {
      await this.handleMessage(this.withRequestTraceparent(req.body, req), res);
    });

    this.router.get('/pet/events', (req, res) => {
      this.handleEvents(req, res);
    });

    this.router.get('/pet/history', (req, res) => {
      try {
        const petId = this.normalizePetId(req.query.petId);
        const sessionKey = this.normalizeSessionKey(petId, req.query.sessionKey);
        const limit = this.normalizeHistoryLimit(req.query.limit);
        res.json({
          petId,
          sessionKey,
          events: this.chatHistory.read(sessionKey, limit),
        });
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    });

    this.router.delete('/pet/history', (req, res) => {
      try {
        const petId = this.normalizePetId(req.query.petId || req.body?.petId);
        const sessionKey = this.normalizeSessionKey(petId, req.query.sessionKey || req.body?.sessionKey);
        this.chatHistory.delete(sessionKey);
        this.events.clear(sessionKey);
        res.json({ ok: true, petId, sessionKey });
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    });
  }

  private async handleMessage(body: any, res: Response): Promise<void> {
    const stream = new PetEventStream(res);
    let session: AgentSession | undefined;
    let journalTurn: ConversationTurnContext | undefined;
    let streamedVisibleText = '';

    try {
      const normalized = normalizePetMessageSurfaceEvent(body, { defaultPetId: this.resolveDefaultPetId() });
      const petId = String(normalized.metadata?.petId || '');
      const text = normalized.userMessage;
      const source = normalized.source || 'unknown';
      const sessionKey = normalized.sessionKey;
      const traceparent = normalized.traceparent;
      journalTurn = this.withConversationRole(await recordVisibleInbound({
        surface: 'pet',
        sessionKey,
        content: [{ type: 'text', text }],
        sourceEventId: normalized.eventId,
      }));
      await this.ensureSkillsReadyForSessionKey(sessionKey);
      this.assertRequiredSkillAvailable(sessionKey);
      const activeSession = this.sessionManager.getOrCreate(sessionKey, sessionKey);
      session = activeSession;
      this.registerSubAgentCallbacks(sessionKey, petId);
      stream.setFanout(event => this.events.publish(petId, sessionKey, event));
      const channel = journalVisibleChannel(journalTurn, this.buildChannel(sessionKey, stream));
      const callbacks = this.buildCallbacks(stream, chunk => {
        streamedVisibleText += chunk;
      });

      stream.open();
      activeSession.runWithLogContext(() => Logger.info(`[${sessionKey}] 收到 pet 消息 (${source}): ${text.slice(0, 120)}`));
      stream.event({ type: 'user_message', text, source, sessionKey });

      const result = await this.enqueueMessage(sessionKey, async () => {
        stream.state('waiting', 'processing');
        await this.activateRequiredSkill(activeSession);

        let resultText = '';
        let visibleToUser = true;
        if (text.startsWith('/')) {
          const parts = text.slice(1).split(/\s+/).filter(Boolean);
          const command = parts[0] || '';
          const args = parts.slice(1);
          const commandResult = await activeSession.handleCommand(command, args, {
            callbacks,
            channel,
            surface: 'pet',
            traceparent,
            traceId: journalTurn?.traceId,
          });
          if (command.toLowerCase() === 'clear' && args.includes('--all')) {
            this.chatHistory.delete(sessionKey);
            this.events.clear(sessionKey);
          }
          resultText = commandResult.reply || '';
          visibleToUser = commandResult.handled;
          if (!commandResult.handled) {
            resultText = `未识别命令：/${command}`;
          }
        } else {
          const messageResult = await activeSession.handleMessage(text, {
            callbacks,
            channel,
            surface: 'pet',
            traceparent,
            traceId: journalTurn?.traceId,
          });
          resultText = messageResult.text;
          visibleToUser = messageResult.visibleToUser;
        }

        return { resultText, visibleToUser };
      });

      if (streamedVisibleText && journalTurn) {
        await recordVisibleAssistant({
          ...journalTurn,
          content: [{ type: 'text', text: streamedVisibleText }],
          deliveryKey: 'pet:visible-stream',
        });
      }
      if (!stream.hasText && result.resultText) {
        stream.text(result.resultText);
        if (journalTurn) {
          await recordVisibleAssistant({
            ...journalTurn,
            content: [{ type: 'text', text: result.resultText }],
            deliveryKey: 'pet:direct',
          });
        }
      }
      stream.state('waving', 'done');
      stream.done(result.resultText, result.visibleToUser);
    } catch (err: any) {
      if (streamedVisibleText && journalTurn) {
        await recordVisibleAssistant({
          ...journalTurn,
          content: [{ type: 'text', text: streamedVisibleText }],
          deliveryKey: 'pet:visible-stream',
        });
      }
      const logError = () => Logger.error(`[pet] 消息处理失败: ${err.message}`);
      if (session) {
        session.runWithLogContext(logError);
      } else {
        logError();
      }
      if (!stream.isOpen) {
        const clientErrors = new Set(['text required', 'invalid pet id', 'invalid pet session key']);
        res.status(clientErrors.has(err.message) ? 400 : 500).json({ error: err.message });
        return;
      }
      stream.state('failed', 'error');
      stream.event({ type: 'error', message: err.message || String(err) });
      stream.done('', false);
    }
  }

  private enqueueMessage<T>(sessionKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.messageQueues.get(sessionKey) || Promise.resolve();
    const queued = previous.catch(() => undefined).then(task);
    const stored = queued
      .then(() => undefined, () => undefined)
      .finally(() => {
        if (this.messageQueues.get(sessionKey) === stored) {
          this.messageQueues.delete(sessionKey);
        }
      });
    this.messageQueues.set(sessionKey, stored);
    return queued;
  }

  private assertRequiredSkillAvailable(sessionKey: string): void {
    const skillName = this.requiredActiveSkillName;
    if (!skillName) return;
    const skillManager = this.resolveServicesForSessionKey(sessionKey).skillManager;
    if (!skillManager.getSkill(skillName)) {
      throw new Error(`required active skill unavailable: ${skillName}`);
    }
  }

  private async activateRequiredSkill(session: AgentSession): Promise<void> {
    const skillName = this.requiredActiveSkillName;
    if (!skillName) return;
    if (!await session.activateSkill(skillName)) {
      throw new Error(`required active skill unavailable: ${skillName}`);
    }
  }

  private registerSubAgentCallbacks(sessionKey: string, petId: string): void {
    SubAgentManager.getInstance().registerPlatformCallbacks(sessionKey, {
      injectMessage: async (text: string) => {
        await this.handleSubAgentFeedback(sessionKey, petId, text);
      },
    });
  }

  private async handleSubAgentFeedback(sessionKey: string, petId: string, text: string): Promise<void> {
    await this.enqueueMessage(sessionKey, async () => {
      const session = this.sessionManager.getOrCreate(sessionKey, sessionKey);
      const turn = this.createConversationTurn(sessionKey);
      let streamedVisibleText = '';
      const callbacks = this.buildBackgroundCallbacks(sessionKey, petId, chunk => {
        streamedVisibleText += chunk;
      });
      const channel = journalVisibleChannel(turn, this.buildBackgroundChannel(sessionKey, petId));
      session.runWithLogContext(() => Logger.info(`[${sessionKey}] 收到子智能体反馈: ${text.slice(0, 120)}`));
      try {
        await session.handleMessage(text, {
          callbacks,
          channel,
          surface: 'pet',
          traceId: turn.traceId,
        });
      } finally {
        if (streamedVisibleText) {
          await recordVisibleAssistant({
            ...turn,
            content: [{ type: 'text', text: streamedVisibleText }],
            deliveryKey: 'pet:visible-stream',
          });
        }
      }
    });
  }

  private handleEvents(req: Request, res: Response): void {
    try {
      const petId = this.normalizePetId(req.query.petId);
      const sessionKey = this.normalizeSessionKey(petId, req.query.sessionKey);
      const replay = req.query.replay === '1';
      this.events.subscribe(petId, sessionKey, res, { replay });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  private buildCallbacks(stream: PetEventStream, onVisibleText?: (text: string) => void): SessionCallbacks {
    return {
      onText: (text: string) => {
        stream.state('review', 'text_stream');
        stream.text(text);
        onVisibleText?.(text);
      },
      onThinking: (thinking: string) => {
        stream.state('review', 'thinking');
        stream.event({ type: 'thinking', text: thinking });
      },
      onToolStart: (name: string, toolUseId: string, input: any) => {
        stream.state('running', 'tool_start');
        stream.event({ type: 'tool_start', name, toolUseId, input });
      },
      onToolEnd: (name: string, toolUseId: string, result: string) => {
        stream.state('waiting', 'tool_end');
        stream.event({ type: 'tool_end', name, toolUseId, result: result.slice(0, 4000) });
      },
      onToolDisplay: (name: string, content: string) => {
        stream.event({ type: 'tool_display', name, content });
      },
      onRetry: (attempt: number, maxRetries: number) => {
        stream.state('waiting', 'retry');
        stream.event({ type: 'retry', attempt, maxRetries });
      },
    };
  }

  private buildBackgroundCallbacks(
    sessionKey: string,
    petId: string,
    onVisibleText?: (text: string) => void,
  ): SessionCallbacks {
    return {
      onText: (text: string) => {
        this.events.publish(petId, sessionKey, { type: 'state', state: 'review', reason: 'subagent_text_stream' });
        this.events.publish(petId, sessionKey, { type: 'text', text });
        onVisibleText?.(text);
      },
      onThinking: (thinking: string) => {
        this.events.publish(petId, sessionKey, { type: 'state', state: 'review', reason: 'subagent_thinking' });
        this.events.publish(petId, sessionKey, { type: 'thinking', text: thinking });
      },
      onToolStart: (name: string, toolUseId: string, input: any) => {
        this.events.publish(petId, sessionKey, { type: 'state', state: 'running', reason: 'subagent_tool_start' });
        this.events.publish(petId, sessionKey, { type: 'tool_start', name, toolUseId, input });
      },
      onToolEnd: (name: string, toolUseId: string, result: string) => {
        this.events.publish(petId, sessionKey, { type: 'state', state: 'waiting', reason: 'subagent_tool_end' });
        this.events.publish(petId, sessionKey, { type: 'tool_end', name, toolUseId, result: result.slice(0, 4000) });
      },
      onToolDisplay: (name: string, content: string) => {
        this.events.publish(petId, sessionKey, { type: 'tool_display', name, content });
      },
      onRetry: (attempt: number, maxRetries: number) => {
        this.events.publish(petId, sessionKey, { type: 'state', state: 'waiting', reason: 'subagent_retry' });
        this.events.publish(petId, sessionKey, { type: 'retry', attempt, maxRetries });
      },
    };
  }

  private buildChannel(sessionKey: string, stream: PetEventStream): ChannelCallbacks {
    return {
      chatId: sessionKey,
      reply: async (_chatId: string, text: string) => {
        stream.state('review', 'channel_reply');
        stream.text(text);
      },
      sendFile: async (_chatId: string, filePath: string, fileName: string) => {
        stream.event({ type: 'file', filePath, fileName });
      },
    };
  }

  private buildBackgroundChannel(sessionKey: string, petId: string): ChannelCallbacks {
    return {
      chatId: sessionKey,
      reply: async (_chatId: string, text: string) => {
        const timestamp = new Date().toISOString();
        this.events.publish(petId, sessionKey, { type: 'state', state: 'review', reason: 'subagent_channel_reply' });
        this.events.publish(petId, sessionKey, { type: 'text', text });
        return {
          receipt_id: `pet.subagent.message.${Date.now()}`,
          receipt_type: 'message' as const,
          surface: 'pet' as const,
          status: 'delivered' as const,
          platform_message_id: `pet_subagent_message_${Date.now()}`,
          delivery_id: 'pet.subagent.reply',
          timestamp,
        };
      },
      sendFile: async (_chatId: string, filePath: string, fileName: string) => {
        const timestamp = new Date().toISOString();
        const deliveryId = 'pet.subagent.file';
        this.events.publish(petId, sessionKey, { type: 'file', filePath, fileName });
        return [
          {
            receipt_id: `pet.subagent.upload.${Date.now()}`,
            receipt_type: 'upload' as const,
            surface: 'pet' as const,
            status: 'accepted' as const,
            platform_file_key: `pet_subagent_file_${Date.now()}`,
            file_name: fileName,
            artifact_path: filePath,
            timestamp,
          },
          {
            receipt_id: `pet.subagent.file.${Date.now()}`,
            receipt_type: 'file' as const,
            surface: 'pet' as const,
            status: 'delivered' as const,
            platform_message_id: `pet_subagent_file_message_${Date.now()}`,
            platform_file_key: `pet_subagent_file_${Date.now()}`,
            delivery_id: deliveryId,
            file_name: fileName,
            artifact_path: filePath,
            timestamp,
          },
        ];
      },
    };
  }

  private createConversationTurn(sessionKey: string, traceId?: string): ConversationTurnContext {
    return this.withConversationRole({
      surface: 'pet',
      sessionKey,
      traceId: traceId || reserveConversationTraceId('pet', sessionKey),
    });
  }

  private withConversationRole(turn: ConversationTurnContext): ConversationTurnContext {
    const roleName = this.resolveServicesForSessionKey(turn.sessionKey).roleName;
    return {
      ...turn,
      ...(roleName ? { roleName } : {}),
    };
  }

  private listPets(): Array<PetManifest & { spriteUrl: string; source: string }> {
    const pets = new Map<string, PetManifest & { spriteUrl: string; source: string }>();

    for (const root of this.petRoots()) {
      if (!fs.existsSync(root.dir)) continue;
      for (const entry of fs.readdirSync(root.dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !PET_ID_PATTERN.test(entry.name)) continue;
        try {
          const resolved = this.readPet(path.join(root.dir, entry.name));
          if (!pets.has(resolved.manifest.id)) {
            pets.set(resolved.manifest.id, {
              ...resolved.manifest,
              spriteUrl: `/api/pet/pets/${encodeURIComponent(resolved.manifest.id)}/spritesheet`,
              source: root.label,
            });
          }
        } catch {
          // Ignore incomplete pet folders.
        }
      }
    }

    return Array.from(pets.values());
  }

  private resolveDefaultPetId(
    pets: Array<PetManifest & { spriteUrl: string; source: string }> = this.listPets(),
    rolePetId: string | null = this.resolveRolePetId(RoleResolver.getActiveRoleName() || null, pets),
  ): string | null {
    return rolePetId || pets.find(pet => pet.id === 'xiaoba')?.id || pets[0]?.id || null;
  }

  private resolveRolePetId(
    activeRole: string | null,
    pets: Array<PetManifest & { spriteUrl: string; source: string }>,
  ): string | null {
    if (!activeRole) return null;

    const config = RoleResolver.getRoleConfig(activeRole);
    const configured = typeof config?.metadata?.petId === 'string'
      ? config.metadata.petId.trim()
      : '';

    if (!configured || !PET_ID_PATTERN.test(configured)) {
      return null;
    }

    return pets.some(pet => pet.id === configured) ? configured : null;
  }

  private resolvePet(petId: string): { manifest: PetManifest; spritesheetPath: string } {
    const normalized = this.normalizePetId(petId);
    for (const root of this.petRoots()) {
      const petDir = path.join(root.dir, normalized);
      if (!fs.existsSync(petDir)) continue;
      return this.readPet(petDir);
    }
    throw new Error(`pet not found: ${normalized}`);
  }

  private readPet(petDir: string): { manifest: PetManifest; spritesheetPath: string } {
    const manifestPath = path.join(petDir, 'pet.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`pet.json not found: ${manifestPath}`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PetManifest;
    const petId = normalizePetIdInput(manifest.id || path.basename(petDir), path.basename(petDir));
    const spritesheetName = manifest.spritesheetPath || 'spritesheet.webp';
    const spritesheetPath = path.resolve(petDir, spritesheetName);
    if (!spritesheetPath.startsWith(path.resolve(petDir) + path.sep) || !fs.existsSync(spritesheetPath)) {
      throw new Error(`spritesheet not found: ${spritesheetName}`);
    }

    return {
      manifest: {
        ...manifest,
        id: petId,
        spritesheetPath: path.basename(spritesheetPath),
      },
      spritesheetPath,
    };
  }

  private normalizePetId(value: unknown): string {
    return normalizePetIdInput(value, this.resolveDefaultPetId());
  }

  private normalizeSessionKey(petId: string, value: unknown): string {
    return normalizePetSessionKey(petId, value);
  }

  private normalizeHistoryLimit(value: unknown): number {
    const raw = Array.isArray(value) ? value[0] : value;
    const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw);
    if (!Number.isFinite(parsed)) return 500;
    return Math.max(1, Math.min(2000, Math.trunc(parsed)));
  }

  private withRequestTraceparent(body: unknown, req: Request): unknown {
    const headerTraceparent = normalizeSurfaceTraceparent(req.get('traceparent'))
      || normalizeSurfaceTraceparent(req.get('x-traceparent'));
    if (!headerTraceparent || extractSurfaceTraceparent(body)) {
      return body;
    }
    return {
      ...(body && typeof body === 'object' ? body as Record<string, unknown> : {}),
      traceparent: headerTraceparent,
    };
  }

  private sessionKey(petId: string): string {
    return `pet:${petId}`;
  }

  private petRoots(): Array<{ dir: string; label: string }> {
    const roots = [
      { dir: path.resolve(process.cwd(), 'desktop', 'dashboard', 'pets'), label: 'bundled' },
      { dir: path.resolve(process.env.XIAOBA_APP_ROOT || '', 'desktop', 'dashboard', 'pets'), label: 'bundled' },
      { dir: path.resolve(process.env.XIAOBA_PETS_DIR || ''), label: 'custom' },
      ...(process.env.XIAOBA_INCLUDE_CODEX_PETS === 'true'
        ? [{ dir: path.join(os.homedir(), '.codex', 'pets'), label: 'codex' }]
        : []),
    ];

    const seen = new Set<string>();
    return roots
      .filter(root => root.dir && root.dir !== path.resolve(process.cwd()))
      .filter(root => {
        if (seen.has(root.dir)) return false;
        seen.add(root.dir);
        return true;
      });
  }
}

class PetEventStream {
  isOpen = false;
  hasText = false;
  private fanout?: (event: PetEvent) => PetEvent | void;

  constructor(private res: Response) {}

  setFanout(fanout: (event: PetEvent) => PetEvent | void): void {
    this.fanout = fanout;
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    this.res.setHeader('Cache-Control', 'no-cache, no-transform');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.flushHeaders?.();
  }

  state(state: PetState, reason: string): void {
    this.event({ type: 'state', state, reason });
  }

  text(text: string): void {
    this.hasText = true;
    this.event({ type: 'text', text });
  }

  done(text: string, visibleToUser: boolean): void {
    this.event({ type: 'done', text, visibleToUser });
    this.res.end();
  }

  event(event: PetEvent): void {
    const outbound = this.fanout?.(event) || event;
    if (!this.isOpen) return;
    this.res.write(`data: ${JSON.stringify(outbound)}\n\n`);
  }
}

class PetEventHub {
  private readonly subscribers = new Map<string, Set<Response>>();
  private readonly history = new Map<string, PetEvent[]>();
  private nextId: number;
  private readonly historyLimit = 80;

  constructor(private readonly historyStore?: PetChatHistoryStore) {
    this.nextId = Math.max(1, (this.historyStore?.getMaxEventId() || 0) + 1);
  }

  subscribe(petId: string, sessionKey: string, res: Response, options: { replay?: boolean } = {}): void {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    this.write(res, {
      type: 'connected',
      petId,
      sessionKey,
      timestamp: new Date().toISOString(),
    });

    if (options.replay) {
      for (const event of this.replayEvents(sessionKey)) {
        this.write(res, event);
      }
    }

    const set = this.subscribers.get(sessionKey) || new Set<Response>();
    set.add(res);
    this.subscribers.set(sessionKey, set);

    res.on('close', () => {
      set.delete(res);
      if (set.size === 0) {
        this.subscribers.delete(sessionKey);
      }
    });
  }

  publish(petId: string, sessionKey: string, event: PetEvent): PetEvent {
    const decorated = {
      ...event,
      id: this.nextId++,
      petId,
      sessionKey,
      timestamp: new Date().toISOString(),
    };

    this.historyStore?.append(sessionKey, decorated);
    const events = this.history.get(sessionKey) || [];
    events.push(decorated);
    if (events.length > this.historyLimit) {
      events.splice(0, events.length - this.historyLimit);
    }
    this.history.set(sessionKey, events);

    for (const res of this.subscribers.get(sessionKey) || []) {
      this.write(res, decorated);
    }

    return decorated;
  }

  close(): void {
    for (const responses of this.subscribers.values()) {
      for (const res of responses) {
        res.end();
      }
    }
    this.subscribers.clear();
  }

  clear(sessionKey: string): void {
    this.history.delete(sessionKey);
  }

  private replayEvents(sessionKey: string): PetEvent[] {
    const byId = new Map<string, PetEvent>();
    for (const event of this.historyStore?.read(sessionKey) || []) {
      byId.set(this.eventKey(event), event);
    }
    for (const event of this.history.get(sessionKey) || []) {
      byId.set(this.eventKey(event), event);
    }

    return Array.from(byId.values()).sort((a, b) => {
      const aId = typeof a.id === 'number' ? a.id : Number.MAX_SAFE_INTEGER;
      const bId = typeof b.id === 'number' ? b.id : Number.MAX_SAFE_INTEGER;
      if (aId !== bId) return aId - bId;
      return String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
    });
  }

  private eventKey(event: PetEvent): string {
    if (typeof event.id === 'number') return String(event.id);
    return `${event.timestamp || ''}:${event.type}:${JSON.stringify(event)}`;
  }

  private write(res: Response, event: PetEvent): void {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}
