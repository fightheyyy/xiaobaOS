import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AgentSession } from '../src/core/agent-session';
import { ToolManager } from '../src/tools/tool-manager';
import { SkillManager } from '../src/skills/skill-manager';
import { MemoryFinalizer } from '../src/utils/memory-finalizer';
import { buildFileMemoryContext, FILE_MEMORY_PREFIX } from '../src/utils/file-memory-context';
import { SessionStore } from '../src/utils/session-store';
import type { Message } from '../src/types';

describe('File-system memory', () => {
  let root: string;
  const keys: string[] = [];
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-file-memory-')); });
  afterEach(() => {
    for (const key of keys.splice(0)) SessionStore.getInstance().deleteSession(key, 'cli');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('loads shared project and current-session indexes without reading other sessions or linked details', () => {
    const own = MemoryFinalizer.remember('owner', '喜欢简洁回答', { rootDir: root });
    MemoryFinalizer.remember('other', '喜欢秘密火星计划', { rootDir: root });
    const project = path.join(root, 'memory', 'MEMORY.md');
    fs.writeFileSync(project, '# Project\n- 使用 pnpm\n- [发布流程](release.md)\n');
    fs.writeFileSync(path.join(root, 'memory', 'release.md'), 'DETAIL_NOT_AUTO_LOADED');
    const context = buildFileMemoryContext('owner', root)!;
    assert.equal(context.__injected, true);
    const content = String(context.content);
    assert.ok(content.startsWith(FILE_MEMORY_PREFIX));
    assert.match(content, /使用 pnpm/);
    assert.match(content, /喜欢简洁回答/);
    assert.match(content, /release.md/);
    assert.ok(!content.includes('DETAIL_NOT_AUTO_LOADED'));
    assert.ok(!content.includes('秘密火星计划'));
    assert.ok(!content.includes(own.record.id));
  });

  test('bounds loaded index size and observes manual edits on the next request', () => {
    fs.mkdirSync(path.join(root, 'memory'));
    const file = path.join(root, 'memory', 'MEMORY.md');
    fs.writeFileSync(file, 'a'.repeat(100_000));
    const first = String(buildFileMemoryContext('owner', root)!.content);
    assert.ok(first.length < 5000);
    assert.match(first, /truncated/);
    fs.writeFileSync(file, '# 项目记忆\n改用 npm\n');
    const second = String(buildFileMemoryContext('owner', root)!.content);
    assert.match(second, /改用 npm/);
    assert.ok(!second.includes('aaaa'));
    assert.equal(buildFileMemoryContext('owner', path.join(root, 'absent')), undefined);
  });

  test('a new Session consumes saved memory and refreshes it without saving injected memory to transcript', async () => {
    const key = `test-file-memory-${randomUUID()}`;
    keys.push(key);
    const saved = MemoryFinalizer.remember(key, '偏好先给结论', { rootDir: root });
    const requests: Message[][] = [];
    const aiService = { async chatStream(messages: Message[]) {
      requests.push(JSON.parse(JSON.stringify(messages)));
      return { content: '好的' };
    } };
    const services = { aiService: aiService as any, toolManager: new ToolManager(root), skillManager: new SkillManager() };
    const session = new AgentSession(key, services, 'cli');
    await session.handleMessage('你好', { surface: 'cli' });
    assert.match(requests[0].map(message => String(message.content)).join('\n'), /偏好先给结论/);
    MemoryFinalizer.remember(key, '偏好先给例子', { rootDir: root, replaces: saved.record.id });
    await session.handleMessage('再聊一下', { surface: 'cli' });
    const recalled = requests[1].filter(message => String(message.content).startsWith(FILE_MEMORY_PREFIX));
    assert.equal(recalled.length, 1);
    assert.match(String(recalled[0].content), /偏好先给例子/);
    assert.ok(!String(recalled[0].content).includes('偏好先给结论'));
    const restarted = new AgentSession(key, services, 'cli');
    await restarted.handleMessage('新会话也能记得吗', { surface: 'cli' });
    assert.match(requests[2].map(message => String(message.content)).join('\n'), /偏好先给例子/);
    const transcript = SessionStore.getInstance().loadContext(key, 'cli');
    assert.ok(!transcript.some(message => String(message.content).includes(FILE_MEMORY_PREFIX)));
    assert.ok(!transcript.some(message => String(message.content).includes('偏好先给例子')));
  });

  test('preserves custom Markdown while upgrading legacy sections and writing new records', () => {
    const file = MemoryFinalizer.getMemoryPath('owner', root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const custom = '## My notes\n- [项目详情](project.md)\n这段内容由用户维护。';
    fs.writeFileSync(file, '# Long-Term Memory\n\n## Stable Preferences\n- 用户喜欢简洁回答。\n\n' + custom + '\n');
    MemoryFinalizer.remember('owner', '习惯使用 pnpm', { rootDir: root });
    assert.ok(fs.readFileSync(file, 'utf8').includes(custom));
    assert.equal(MemoryFinalizer.loadSessionMemory('owner', root)?.records.length, 2);
    MemoryFinalizer.remember('owner', '默认中文', { rootDir: root });
    const updated = fs.readFileSync(file, 'utf8');
    assert.ok(updated.includes(custom));
    assert.equal((updated.match(/xiaoba:records:start/g) || []).length, 1);
  });

  test('replacement and forgetting survive later finalization of old transcripts', () => {
    const old = MemoryFinalizer.remember('owner', '我喜欢咖啡', { rootDir: root });
    const replacement = MemoryFinalizer.remember('owner', '我喜欢茶', { rootDir: root, replaces: old.record.id });
    assert.equal(replacement.action, 'updated');
    MemoryFinalizer.finalizeSession('owner', [{ role: 'user', content: '我喜欢咖啡' }], { rootDir: root });
    assert.deepEqual(MemoryFinalizer.loadSessionMemory('owner', root)?.records.map(record => record.text), ['用户喜欢茶。']);
    MemoryFinalizer.forget('owner', replacement.record.id, root);
    MemoryFinalizer.finalizeSession('owner', [{ role: 'user', content: '我喜欢咖啡。我喜欢茶。' }], { rootDir: root });
    assert.deepEqual(MemoryFinalizer.loadSessionMemory('owner', root)?.records, []);
    // A fresh explicit request can intentionally remember the same fact again.
    MemoryFinalizer.remember('owner', '我喜欢茶', { rootDir: root });
    assert.equal(MemoryFinalizer.loadSessionMemory('owner', root)?.records.length, 1);
  });

  test('rejects unknown correction IDs and concurrent or interrupted writers without changing the file', () => {
    const saved = MemoryFinalizer.remember('owner', '喜欢简洁', { rootDir: root });
    const original = fs.readFileSync(saved.memoryPath, 'utf8');
    assert.throws(() => MemoryFinalizer.remember('owner', '喜欢详细', { rootDir: root, replaces: 'missing' }), /MEMORY_RECORD_NOT_FOUND/);
    assert.throws(() => MemoryFinalizer.forget('owner', 'missing', root), /MEMORY_RECORD_NOT_FOUND/);
    fs.mkdirSync(`${saved.memoryPath}.lock`);
    assert.throws(() => MemoryFinalizer.remember('owner', '喜欢详细', { rootDir: root }), /MEMORY_BUSY_OR_INTERRUPTED/);
    assert.equal(fs.readFileSync(saved.memoryPath, 'utf8'), original);
  });

  test('preserves literal comment text and refuses to overwrite a broken managed block', () => {
    const saved = MemoryFinalizer.remember('owner', '我喜欢 <!-- xiaoba:records:end --> 这个示例', { rootDir: root });
    MemoryFinalizer.remember('owner', '默认中文', { rootDir: root });
    assert.equal(MemoryFinalizer.loadSessionMemory('owner', root)?.records.length, 2);
    const raw = fs.readFileSync(saved.memoryPath, 'utf8').replace('<!-- xiaoba:records:start -->', '');
    fs.writeFileSync(saved.memoryPath, raw);
    assert.throws(() => MemoryFinalizer.remember('owner', '默认英文', { rootDir: root }), /MEMORY_BLOCK_INVALID/);
    assert.equal(fs.readFileSync(saved.memoryPath, 'utf8'), raw);
    assert.ok(!fs.existsSync(`${saved.memoryPath}.lock`));
  });
});
