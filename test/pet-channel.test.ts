import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { createRoleAwareToolManager } from '../src/bootstrap/tool-manager';
import type { AgentServices } from '../src/core/agent-session';
import { normalizePetMessageSurfaceEvent, PetChannel } from '../src/pet/channel';
import { SkillManager } from '../src/skills/skill-manager';
import type { ChatResponse, Message } from '../src/types';
import type { ToolDefinition } from '../src/types/tool';
import { RoleResolver } from '../src/utils/role-resolver';
import { resetConversationJournalForTests } from '../src/utils/conversation-journal';
import { SessionReminderStore, tickSessionReminders } from '../src/events';

const originalCwd = process.cwd();
const originalPetsDir = process.env.XIAOBA_PETS_DIR;
const originalAppRoot = process.env.XIAOBA_APP_ROOT;
const originalRole = process.env.XIAOBA_ROLE;
const originalCurrentRole = process.env.CURRENT_ROLE;
const originalCurrentRoleDisplayName = process.env.CURRENT_ROLE_DISPLAY_NAME;

function writePet(root: string, id: string, displayName: string): void {
  const petDir = path.join(root, 'desktop', 'dashboard', 'pets', id);
  fs.mkdirSync(petDir, { recursive: true });
  fs.writeFileSync(
    path.join(petDir, 'pet.json'),
    JSON.stringify({
      id,
      displayName,
      description: `${displayName} test pet`,
      renderer: 'grok-cat-v1',
      roleThemes: {
        base: { body: '#17140F', eyes: '#E5B94F', outline: '#C79A3B' },
      },
    }, null, 2),
    'utf-8',
  );
}

function writeLegacySpritePet(root: string, id: string, displayName: string): void {
  const petDir = path.join(root, 'desktop', 'dashboard', 'pets', id);
  fs.mkdirSync(petDir, { recursive: true });
  fs.writeFileSync(
    path.join(petDir, 'pet.json'),
    JSON.stringify({
      id,
      displayName,
      description: `${displayName} legacy test pet`,
      spritesheetPath: 'spritesheet.webp',
    }, null, 2),
    'utf-8',
  );
  fs.writeFileSync(path.join(petDir, 'spritesheet.webp'), Buffer.from([0x52, 0x49, 0x46, 0x46]));
}

function writeRole(root: string, name: string, petId: string): void {
  const roleDir = path.join(root, 'roles', name);
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(
    path.join(roleDir, 'role.json'),
    JSON.stringify({
      name,
      displayName: name,
      metadata: { petId },
    }, null, 2),
    'utf-8',
  );
}

function writeRoleConfig(root: string, name: string, config: Record<string, unknown>): void {
  const roleDir = path.join(root, 'roles', name);
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(
    path.join(roleDir, 'role.json'),
    JSON.stringify({ name, displayName: name, ...config }, null, 2),
    'utf-8',
  );
}

function writeSkill(root: string, name: string, options: { roleName?: string } = {}): void {
  const skillDir = options.roleName
    ? path.join(root, 'roles', options.roleName, 'skills', name)
    : path.join(root, 'skills', name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      'description: Test skill for pet command channel delivery.',
      'invocable: user',
      'autoInvocable: false',
      'max-turns: 4',
      '---',
      '',
      '# Pet command channel delivery test',
      '',
      'Reply through the visible channel.',
      '',
    ].join('\n'),
    'utf-8',
  );
}

class SendTextOnceAIService {
  requests: Array<{ messages: Message[]; toolNames: string[] }> = [];

  async chatStream(messages: Message[], tools: ToolDefinition[] = []): Promise<ChatResponse> {
    this.requests.push({
      messages: messages.map(message => ({ ...message })),
      toolNames: tools.map(tool => tool.name),
    });

    if (this.requests.length === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: 'send-text-1',
            type: 'function',
            function: {
              name: 'send_text',
              arguments: JSON.stringify({ text: 'skill says: trace simulation can replay behavior' }),
            },
          },
        ],
      };
    }

    return { content: 'done' };
  }

  async chat(messages: Message[], tools: ToolDefinition[] = []): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

class MultiTurnPetAIService {
  requests: Array<{ messages: Message[]; toolNames: string[] }> = [];

  async chatStream(messages: Message[], tools: ToolDefinition[] = []): Promise<ChatResponse> {
    this.requests.push({
      messages: messages.map(message => ({ ...message })),
      toolNames: tools.map(tool => tool.name),
    });

    if (this.requests.length === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: 'pet-memory-send-1',
            type: 'function',
            function: {
              name: 'send_text',
              arguments: JSON.stringify({ text: '第一轮收到：苹果已记住' }),
            },
          },
        ],
      };
    }

    if (this.requests.length === 2) {
      return { content: '' };
    }

    const sawFirstUser = messages.some(message =>
      message.role === 'user' && message.content === '请记住苹果'
    );
    const sawFirstAssistant = messages.some(message =>
      message.role === 'assistant'
      && message.tool_calls?.some(call =>
        call.function.name === 'send_text'
        && call.function.arguments.includes('第一轮收到')
      )
    );
    if (this.requests.length === 3) {
      return {
        content: null,
        toolCalls: [
          {
            id: 'pet-memory-send-2',
            type: 'function',
            function: {
              name: 'send_text',
              arguments: JSON.stringify({ text: `第二轮看到历史 user=${sawFirstUser} assistant=${sawFirstAssistant}` }),
            },
          },
        ],
      };
    }

    return { content: '' };
  }

  async chat(messages: Message[], tools: ToolDefinition[] = []): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

async function listen(app: express.Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server: http.Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  });
}

async function readSse(response: Response): Promise<any[]> {
  const body = await response.text();
  return body
    .split('\n\n')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const line = part.split('\n').find(item => item.startsWith('data: '));
      assert.ok(line, `missing data line in ${part}`);
      return JSON.parse(line.slice(6));
    });
}

async function readSseUntil(response: Response, count: number, timeoutMs = 1200): Promise<any[]> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: any[] = [];
  let buffer = '';

  while (events.length < count) {
    let timer: NodeJS.Timeout | null = null;
    const read = reader.read();
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${count} SSE events`)), timeoutMs);
    });
    const { value, done } = await Promise.race([read, timeout]);
    if (timer) clearTimeout(timer);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      const line = part.split('\n').find(item => item.startsWith('data: '));
      assert.ok(line, `missing data line in ${part}`);
      events.push(JSON.parse(line.slice(6)));
      if (events.length >= count) break;
    }
  }

  await reader.cancel().catch(() => undefined);
  return events;
}

describe('PetChannel', () => {
  let testRoot: string;
  let channel: PetChannel | null = null;
  let server: http.Server | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    RoleResolver.clearActiveRole();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-pet-'));
    writePet(testRoot, 'alpha-puff', 'Alpha Puff');
    delete process.env.XIAOBA_PETS_DIR;
    process.chdir(testRoot);

    channel = new PetChannel();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', channel.router);
    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.baseUrl;
  });

  test('normalizes valid traceparent and drops invalid trace context', () => {
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const event = normalizePetMessageSurfaceEvent({
      petId: 'alpha-puff',
      text: 'hello',
      traceparent: traceparent.toUpperCase(),
    });
    assert.strictEqual(event.traceparent, traceparent);

    const invalid = normalizePetMessageSurfaceEvent({
      petId: 'alpha-puff',
      text: 'hello',
      traceparent: 'raw-secret-not-a-traceparent',
    });
    assert.strictEqual(invalid.traceparent, undefined);
  });

  test('scheduled reminders enter the original Pet visible history without a new user message', async () => {
    const store = new SessionReminderStore(testRoot);
    const record = await store.create({ sessionKey: 'pet:alpha-puff', surface: 'pet', channelId: 'pet:alpha-puff' },
      { dueAt: '2099-10-09T15:00:00+08:00', purpose: '带上护照', source: 'user', mode: 'remind' });
    const tick = await tickSessionReminders(testRoot, new Date('2099-10-09T08:00:00Z'));
    assert.deepStrictEqual(tick.handled, [record.id]);
    const history = await (await fetch(`${baseUrl}/api/pet/history?petId=alpha-puff`)).json() as any;
    assert.ok(history.events.some((event: any) => event.type === 'text' && event.text === '带上护照'));
    assert.ok(!history.events.some((event: any) => event.type === 'user_message'));
    await tickSessionReminders(testRoot, new Date('2099-10-10T08:00:00Z'));
    const again = await (await fetch(`${baseUrl}/api/pet/history?petId=alpha-puff`)).json() as any;
    assert.strictEqual(again.events.filter((event: any) => event.type === 'text' && event.text === '带上护照').length, 1);
  });

  test('allows role-scoped session suffixes but rejects non-role pet sessions', () => {
    const event = normalizePetMessageSurfaceEvent({
      petId: 'alpha-puff',
      sessionKey: 'pet:alpha-puff:role-engineer-cat:run-trace-001',
      text: 'hello',
    });
    assert.strictEqual(event.sessionKey, 'pet:alpha-puff:role-engineer-cat:run-trace-001');

    assert.throws(
      () => normalizePetMessageSurfaceEvent({
        petId: 'alpha-puff',
        sessionKey: 'pet:alpha-puff:thread-trace-001',
        text: 'hello',
      }),
      /invalid pet session key/,
    );
  });

  afterEach(async () => {
    await closeServer(server);
    server = null;
    if (channel) {
      await channel.destroy();
      channel = null;
    }
    resetConversationJournalForTests({ env: { NODE_ENV: 'test' } });
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    if (typeof originalPetsDir === 'string') {
      process.env.XIAOBA_PETS_DIR = originalPetsDir;
    } else {
      delete process.env.XIAOBA_PETS_DIR;
    }
    if (typeof originalAppRoot === 'string') {
      process.env.XIAOBA_APP_ROOT = originalAppRoot;
    } else {
      delete process.env.XIAOBA_APP_ROOT;
    }
    if (typeof originalRole === 'string') {
      process.env.XIAOBA_ROLE = originalRole;
    } else {
      delete process.env.XIAOBA_ROLE;
    }
    if (typeof originalCurrentRole === 'string') {
      process.env.CURRENT_ROLE = originalCurrentRole;
    } else {
      delete process.env.CURRENT_ROLE;
    }
    if (typeof originalCurrentRoleDisplayName === 'string') {
      process.env.CURRENT_ROLE_DISPLAY_NAME = originalCurrentRoleDisplayName;
    } else {
      delete process.env.CURRENT_ROLE_DISPLAY_NAME;
    }
  });

  test('列出程序化 pet manifest', async () => {
    writeRole(testRoot, 'fresh-role', 'alpha-puff');
    const response = await fetch(`${baseUrl}/api/pet/pets`);
    assert.strictEqual(response.status, 200);
    const data = await response.json() as {
      pets: Array<{ id: string; displayName: string; renderer: string; source: string }>;
      roleKeys: string[];
    };

    const pet = data.pets.find(item => item.id === 'alpha-puff');
    assert.ok(pet);
    assert.strictEqual(pet!.displayName, 'Alpha Puff');
    assert.strictEqual(pet!.renderer, 'grok-cat-v1');
    assert.strictEqual(pet!.source, 'bundled');
    assert.deepStrictEqual(data.roleKeys, ['base', 'fresh-role']);
  });

  test('忽略旧 spritesheet manifest 且不暴露资源端点', async () => {
    writeLegacySpritePet(testRoot, 'legacy-cat', 'Legacy Cat');

    const response = await fetch(`${baseUrl}/api/pet/pets`);
    assert.strictEqual(response.status, 200);
    const data = await response.json() as { pets: Array<{ id: string }> };
    assert.strictEqual(data.pets.some(item => item.id === 'legacy-cat'), false);

    const spriteResponse = await fetch(`${baseUrl}/api/pet/pets/alpha-puff/spritesheet`);
    assert.strictEqual(spriteResponse.status, 404);
  });

  test('默认 pet 会跟随 active role 的 petId 配置', async () => {
    writePet(testRoot, 'role-puff', 'Role Puff');
    writeRole(testRoot, 'engineer-cat', 'role-puff');
    RoleResolver.activateRole('engineer-cat');

    const response = await fetch(`${baseUrl}/api/pet/pets`);
    assert.strictEqual(response.status, 200);
    const data = await response.json() as { activeRole: string; rolePetId: string; defaultPetId: string };

    assert.strictEqual(data.activeRole, 'engineer-cat');
    assert.strictEqual(data.rolePetId, 'role-puff');
    assert.strictEqual(data.defaultPetId, 'role-puff');

    const wake = await fetch(`${baseUrl}/api/pet/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(wake.status, 200);
    const wakeData = await wake.json() as { petId: string; sessionKey: string };
    assert.strictEqual(wakeData.petId, 'role-puff');
    assert.strictEqual(wakeData.sessionKey, 'pet:role-puff');
  });

  test('Electron cwd 切到 userData 时仍从 XIAOBA_APP_ROOT 读取内置 pet', async () => {
    await closeServer(server);
    server = null;
    if (channel) {
      await channel.destroy();
      channel = null;
    }

    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-pet-app-root-'));
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-pet-user-data-'));
    writePet(appRoot, 'electron-puff', 'Electron Puff');
    process.env.XIAOBA_APP_ROOT = appRoot;
    process.chdir(userData);

    channel = new PetChannel();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', channel.router);
    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.baseUrl;

    const petsResponse = await fetch(`${baseUrl}/api/pet/pets`);
    assert.strictEqual(petsResponse.status, 200);
    const petsData = await petsResponse.json() as {
      pets: Array<{ id: string; renderer: string; source: string }>;
    };
    assert.ok(petsData.pets.some(pet => pet.id === 'electron-puff'
      && pet.renderer === 'grok-cat-v1'
      && pet.source === 'bundled'));

    process.chdir(testRoot);
    fs.rmSync(appRoot, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  test('wake 为 pet 创建独立 pet session key', async () => {
    const response = await fetch(`${baseUrl}/api/pet/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ petId: 'alpha-puff' }),
    });
    assert.strictEqual(response.status, 200);
    const data = await response.json() as { ok: boolean; sessionKey: string; petId: string; state: string };

    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.sessionKey, 'pet:alpha-puff');
    assert.strictEqual(data.petId, 'alpha-puff');
    assert.strictEqual(data.state, 'waving');
  });

  test('message 支持内置命令并返回 SSE 状态事件', async () => {
    const response = await fetch(`${baseUrl}/api/pet/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ petId: 'alpha-puff', text: '/history' }),
    });
    assert.strictEqual(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);

    const events = await readSse(response);
    assert.deepStrictEqual(events.map(event => event.type), ['user_message', 'state', 'text', 'state', 'done']);
    assert.strictEqual(events[0].text, '/history');
    assert.strictEqual(events[0].source, 'unknown');
    assert.strictEqual(events[0].sessionKey, 'pet:alpha-puff');
    assert.strictEqual(events[1].state, 'waiting');
    assert.match(events[2].text, /对话历史信息/);
    assert.strictEqual(events[3].state, 'waving');
    assert.strictEqual(events[4].visibleToUser, true);

    const runtimeLog = readPetRuntimeLog(testRoot);
    assert.match(runtimeLog, /\[pet session=pet_alpha-puff\].*收到 pet 消息 \(unknown\): \/history/);
  });

  test('Pet Journal records one inbound and one direct visible reply without done duplication', async () => {
    const journal = resetConversationJournalForTests({
      workingDirectory: testRoot,
      env: {
        NODE_ENV: 'test',
        XIAOBA_CONVERSATION_RECORDING_ENABLED: 'true',
      },
    });
    const request = () => fetch(`${baseUrl}/api/pet/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        petId: 'alpha-puff',
        text: '/history',
        source: 'dashboard',
        eventId: 'pet_event_1',
      }),
    });

    const first = await request();
    assert.strictEqual(first.status, 200);
    await readSse(first);

    const filePath = journal.filePathFor('pet', 'pet:alpha-puff');
    const firstRows = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepStrictEqual(firstRows.map(row => row.role), ['user', 'assistant']);
    assert.deepStrictEqual(firstRows.map(row => row.sequence), [1, 2]);
    assert.deepStrictEqual(firstRows[0].content, [{ type: 'text', text: '/history' }]);
    assert.match(firstRows[1].content[0].text, /对话历史信息/);
    assert.strictEqual(firstRows[0].trace_id, firstRows[1].trace_id);

    const retry = await request();
    assert.strictEqual(retry.status, 200);
    await readSse(retry);
    const retryRows = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(retryRows.length, 2);
  });

  test('skill 斜杠命令带参数时保留 pet channel 并可用 send_text 交付', async () => {
    await closeServer(server);
    server = null;
    assert.ok(channel);
    await channel.destroy();
    channel = null;

    writeSkill(testRoot, 'tiny-skill');
    const aiService = new SendTextOnceAIService();
    const skillManager = new SkillManager();
    const services: AgentServices = {
      aiService: aiService as any,
      toolManager: createRoleAwareToolManager(testRoot),
      skillManager,
    };
    channel = new PetChannel({ services });
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', channel.router);
    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.baseUrl;

    const response = await fetch(`${baseUrl}/api/pet/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        petId: 'alpha-puff',
        text: '/tiny-skill 能用来干什么？',
        source: 'dashboard',
      }),
    });
    assert.strictEqual(response.status, 200);

    const events = await readSse(response);
    const texts = events
      .filter(event => event.type === 'text')
      .map(event => String(event.text || ''));

    assert.ok(aiService.requests[0].toolNames.includes('send_text'));
    assert.ok(texts.includes('skill says: trace simulation can replay behavior'));
    assert.ok(!events.some(event => JSON.stringify(event).includes('send_text 需要 channel 上下文')));
    assert.strictEqual(events[events.length - 1]?.visibleToUser, true);
  });

  test('连续两轮普通文本复用同一个 pet runtime session 历史', async () => {
    await closeServer(server);
    server = null;
    assert.ok(channel);
    await channel.destroy();
    channel = null;

    const aiService = new MultiTurnPetAIService();
    const skillManager = new SkillManager();
    const services: AgentServices = {
      aiService: aiService as any,
      toolManager: createRoleAwareToolManager(testRoot),
      skillManager,
    };
    channel = new PetChannel({ services });
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', channel.router);
    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.baseUrl;

    const firstResponse = await fetch(`${baseUrl}/api/pet/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        petId: 'alpha-puff',
        text: '请记住苹果',
        source: 'dashboard',
      }),
    });
    assert.strictEqual(firstResponse.status, 200);
    const firstEvents = await readSse(firstResponse);
    assert.ok(firstEvents.some(event => event.type === 'text' && event.text === '第一轮收到：苹果已记住'));
    assert.strictEqual(firstEvents[firstEvents.length - 1]?.visibleToUser, true);

    const secondResponse = await fetch(`${baseUrl}/api/pet/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        petId: 'alpha-puff',
        text: '上一轮我让你记住什么？',
        source: 'dashboard',
      }),
    });
    assert.strictEqual(secondResponse.status, 200);
    const secondEvents = await readSse(secondResponse);
    assert.ok(secondEvents.some(event =>
      event.type === 'text'
      && event.text === '第二轮看到历史 user=true assistant=true'
    ));

    assert.strictEqual(aiService.requests.length, 4);
    assert.ok(aiService.requests[0].toolNames.includes('send_text'));
    assert.ok(aiService.requests[2].toolNames.includes('send_text'));
    assert.ok(aiService.requests[2].messages.some(message =>
      message.role === 'user' && message.content === '请记住苹果'
    ));
    assert.ok(aiService.requests[2].messages.some(message =>
      message.role === 'assistant'
      && message.tool_calls?.some(call =>
        call.function.name === 'send_text'
        && call.function.arguments.includes('第一轮收到')
      )
    ));

    const historyResponse = await fetch(`${baseUrl}/api/pet/history?petId=alpha-puff&limit=20`);
    assert.strictEqual(historyResponse.status, 200);
    const historyData = await historyResponse.json() as { events: any[]; sessionKey: string };
    assert.strictEqual(historyData.sessionKey, 'pet:alpha-puff');
    assert.deepStrictEqual(
      historyData.events.filter(event => event.type === 'user_message').map(event => event.text),
      ['请记住苹果', '上一轮我让你记住什么？'],
    );
    assert.strictEqual(
      historyData.events.filter(event => event.type === 'text' && event.text === '第一轮收到：苹果已记住').length,
      1,
    );
    assert.strictEqual(
      historyData.events.filter(event => event.type === 'text' && event.text === '第二轮看到历史 user=true assistant=true').length,
      1,
    );
    assert.ok(historyData.events.every(event => event.sessionKey === 'pet:alpha-puff'));
  });

  test('role-scoped Chat/桌宠 session 只暴露对应角色 skills', async () => {
    await closeServer(server);
    server = null;
    assert.ok(channel);
    await channel.destroy();
    channel = null;

    writeSkill(testRoot, 'base-skill');
    writeRoleConfig(testRoot, 'user-cat', {
      inheritBaseSkills: false,
      inheritBaseTools: false,
      baseToolAllowlist: ['read_file', 'grep', 'glob', 'skill'],
    });
    writeSkill(testRoot, 'trace-simulation', { roleName: 'user-cat' });

    channel = new PetChannel();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', channel.router);
    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.baseUrl;

    const sessionKey = 'pet:alpha-puff:role-user-cat';
    const skillsResponse = await fetch(`${baseUrl}/api/pet/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        petId: 'alpha-puff',
        sessionKey,
        text: '/skills',
        source: 'dashboard',
      }),
    });
    assert.strictEqual(skillsResponse.status, 200);
    const skillsEvents = await readSse(skillsResponse);
    const skillsText = skillsEvents
      .filter(event => event.type === 'text')
      .map(event => String(event.text || ''))
      .join('\n');
    assert.match(skillsText, /\/trace-simulation/);
    assert.doesNotMatch(skillsText, /\/base-skill/);

    const activateResponse = await fetch(`${baseUrl}/api/pet/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        petId: 'alpha-puff',
        sessionKey,
        text: '/trace-simulation',
        source: 'widget',
      }),
    });
    assert.strictEqual(activateResponse.status, 200);
    const activateText = (await readSse(activateResponse))
      .filter(event => event.type === 'text')
      .map(event => String(event.text || ''))
      .join('\n');
    assert.match(activateText, /已激活 skill: trace-simulation/);
  });

  test('events endpoint 会把 pet agent 事件广播给桌宠订阅者', async () => {
    const controller = new AbortController();
    const eventsResponse = await fetch(`${baseUrl}/api/pet/events?petId=alpha-puff`, {
      signal: controller.signal,
    });
    assert.strictEqual(eventsResponse.status, 200);
    assert.match(eventsResponse.headers.get('content-type') || '', /text\/event-stream/);

    const eventsPromise = readSseUntil(eventsResponse, 6);
    const message = await fetch(`${baseUrl}/api/pet/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ petId: 'alpha-puff', text: '/history', source: 'widget' }),
    });
    assert.strictEqual(message.status, 200);
    await message.text();

    const events = await eventsPromise;
    controller.abort();

    assert.deepStrictEqual(events.map(event => event.type), ['connected', 'user_message', 'state', 'text', 'state', 'done']);
    assert.strictEqual(events[0].petId, 'alpha-puff');
    assert.strictEqual(events[1].text, '/history');
    assert.strictEqual(events[1].source, 'widget');
    assert.strictEqual(events[1].sessionKey, 'pet:alpha-puff');
    assert.strictEqual(events[2].state, 'waiting');
    assert.match(events[3].text, /对话历史信息/);
    assert.strictEqual(events[4].state, 'waving');
    assert.strictEqual(events[5].visibleToUser, true);
  });

  test('events replay 会补发 pet 对话事件给后打开的 Dashboard', async () => {
    const message = await fetch(`${baseUrl}/api/pet/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ petId: 'alpha-puff', text: '/history', source: 'widget' }),
    });
    assert.strictEqual(message.status, 200);
    await message.text();

    const controller = new AbortController();
    const eventsResponse = await fetch(`${baseUrl}/api/pet/events?petId=alpha-puff&replay=1`, {
      signal: controller.signal,
    });
    assert.strictEqual(eventsResponse.status, 200);

    const events = await readSseUntil(eventsResponse, 6);
    controller.abort();

    assert.deepStrictEqual(events.map(event => event.type), ['connected', 'user_message', 'state', 'text', 'state', 'done']);
    assert.strictEqual(events[1].source, 'widget');
    assert.strictEqual(events[1].text, '/history');
    assert.match(events[3].text, /对话历史信息/);
  });

  test('Dashboard chat history 会持久化为 JSONL 并在重启后 replay', async () => {
    const message = await fetch(`${baseUrl}/api/pet/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ petId: 'alpha-puff', text: '/history', source: 'dashboard' }),
    });
    assert.strictEqual(message.status, 200);
    await message.text();

    const historyFile = path.join(testRoot, 'data', 'chat', 'sessions', 'pet_alpha-puff.jsonl');
    assert.ok(fs.existsSync(historyFile), 'expected Dashboard chat JSONL history');

    const stored = fs.readFileSync(historyFile, 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.deepStrictEqual(stored.map(event => event.type), ['user_message', 'state', 'text', 'state', 'done']);
    assert.ok(stored.every(event => event.petId === 'alpha-puff'));
    assert.ok(stored.every(event => typeof event.id === 'number'));
    assert.ok(stored.every(event => typeof event.timestamp === 'string'));

    const historyResponse = await fetch(`${baseUrl}/api/pet/history?petId=alpha-puff&limit=10`);
    assert.strictEqual(historyResponse.status, 200);
    const historyData = await historyResponse.json() as { petId: string; events: any[] };
    assert.strictEqual(historyData.petId, 'alpha-puff');
    assert.deepStrictEqual(historyData.events.map(event => event.type), ['user_message', 'state', 'text', 'state', 'done']);

    await closeServer(server);
    server = null;
    assert.ok(channel);
    await channel.destroy();
    channel = null;

    channel = new PetChannel();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', channel.router);
    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.baseUrl;

    const controller = new AbortController();
    const eventsResponse = await fetch(`${baseUrl}/api/pet/events?petId=alpha-puff&replay=1`, {
      signal: controller.signal,
    });
    assert.strictEqual(eventsResponse.status, 200);

    const events = await readSseUntil(eventsResponse, 6);
    controller.abort();

    assert.deepStrictEqual(events.map(event => event.type), ['connected', 'user_message', 'state', 'text', 'state', 'done']);
    assert.strictEqual(events[1].source, 'dashboard');
    assert.strictEqual(events[1].text, '/history');
    assert.deepStrictEqual(events.slice(1).map(event => event.id), stored.map(event => event.id));
  });

  test('Dashboard chat 可按角色 sessionKey 隔离历史和 replay', async () => {
    const baseRoleSession = 'pet:alpha-puff';
    const reviewerRoleSession = 'pet:alpha-puff:role-reviewer-cat';

    for (const [sessionKey, text] of [
      [baseRoleSession, '/role-base'],
      [reviewerRoleSession, '/role-reviewer'],
    ]) {
      const response = await fetch(`${baseUrl}/api/pet/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ petId: 'alpha-puff', sessionKey, text, source: 'dashboard' }),
      });
      assert.strictEqual(response.status, 200);
      const events = await readSse(response);
      assert.strictEqual(events[0].sessionKey, sessionKey);
      assert.strictEqual(events[0].text, text);
      assert.ok(events.every(event => event.sessionKey === sessionKey));
    }

    const historyA = await fetch(`${baseUrl}/api/pet/history?petId=alpha-puff&sessionKey=${encodeURIComponent(baseRoleSession)}`);
    assert.strictEqual(historyA.status, 200);
    const historyDataA = await historyA.json() as { events: any[]; sessionKey: string };
    assert.strictEqual(historyDataA.sessionKey, baseRoleSession);
    assert.deepStrictEqual(historyDataA.events.map(event => event.text).filter(Boolean), ['/role-base', '未识别命令：/role-base', '未识别命令：/role-base']);
    assert.ok(historyDataA.events.every(event => event.sessionKey === baseRoleSession));

    const controller = new AbortController();
    const replayA = await fetch(`${baseUrl}/api/pet/events?petId=alpha-puff&sessionKey=${encodeURIComponent(baseRoleSession)}&replay=1`, {
      signal: controller.signal,
    });
    assert.strictEqual(replayA.status, 200);
    const replayEvents = await readSseUntil(replayA, 6);
    controller.abort();

    assert.deepStrictEqual(replayEvents.map(event => event.type), ['connected', 'user_message', 'state', 'text', 'state', 'done']);
    assert.strictEqual(replayEvents[0].sessionKey, baseRoleSession);
    assert.strictEqual(replayEvents[1].text, '/role-base');
    assert.ok(replayEvents.slice(1).every(event => event.sessionKey === baseRoleSession));
  });

  test('role-base sessionKey aliases to the default pet session for Dashboard compatibility', async () => {
    const response = await fetch(`${baseUrl}/api/pet/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        petId: 'alpha-puff',
        sessionKey: 'pet:alpha-puff:role-base',
        text: '/history',
        source: 'widget',
      }),
    });
    assert.strictEqual(response.status, 200);
    const events = await readSse(response);
    assert.strictEqual(events[0].sessionKey, 'pet:alpha-puff');
    assert.ok(events.every(event => event.sessionKey === 'pet:alpha-puff'));

    const history = await fetch(`${baseUrl}/api/pet/history?petId=alpha-puff&sessionKey=${encodeURIComponent('pet:alpha-puff:role-base')}`);
    assert.strictEqual(history.status, 200);
    const data = await history.json() as { sessionKey: string; events: any[] };
    assert.strictEqual(data.sessionKey, 'pet:alpha-puff');
    assert.deepStrictEqual(data.events.map(event => event.type), ['user_message', 'state', 'text', 'state', 'done']);
    assert.strictEqual(data.events[0].source, 'widget');
  });

  test('拒绝空消息和非法 pet id', async () => {
    const emptyMessage = await fetch(`${baseUrl}/api/pet/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ petId: 'alpha-puff', text: '   ' }),
    });
    assert.strictEqual(emptyMessage.status, 400);
    assert.deepStrictEqual(await emptyMessage.json(), { error: 'text required' });

    const invalidPet = await fetch(`${baseUrl}/api/pet/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ petId: '../alpha-puff' }),
    });
    assert.strictEqual(invalidPet.status, 400);
    assert.deepStrictEqual(await invalidPet.json(), { error: 'invalid pet id' });
  });
});

function readPetSessionEntries(root: string): any[] {
  const logRoot = path.join(root, 'logs', 'sessions', 'pet');
  const files = collectFiles(logRoot).filter(file => path.basename(file) === 'traces.jsonl');
  assert.ok(files.length > 0, 'expected pet session jsonl log');
  return files.flatMap(file => fs.readFileSync(file, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line)));
}

function readPetRuntimeLog(root: string): string {
  const logRoot = path.join(root, 'logs', 'sessions', 'pet');
  const files = collectFiles(logRoot).filter(file => file.endsWith('runtime.log'));
  assert.ok(files.length > 0, 'expected pet session runtime log');
  return files.map(file => fs.readFileSync(file, 'utf-8')).join('\n');
}

function collectFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectFiles(fullPath));
    } else {
      result.push(fullPath);
    }
  }
  return result;
}
