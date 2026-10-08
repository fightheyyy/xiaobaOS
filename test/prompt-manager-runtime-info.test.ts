import { after, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import { PromptManager } from '../src/utils/prompt-manager';
import { RoleResolver } from '../src/utils/role-resolver';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const originalPlatformEnv = process.env.CURRENT_PLATFORM;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

describe('PromptManager runtime environment injection', () => {
  beforeEach(() => {
    RoleResolver.clearActiveRole();
    delete process.env.CURRENT_PLATFORM;
  });

  test('Windows 下应注入操作系统和 cmd/PowerShell 提示', async () => {
    setPlatform('win32');

    const prompt = await PromptManager.buildSystemPrompt();

    assert.ok(prompt.includes('当前操作系统：Windows'));
    assert.ok(prompt.includes('cmd.exe 语义'));
    assert.ok(prompt.includes('powershell -Command'));
    assert.ok(prompt.includes('避免默认使用 `ls`、`head`、`tail`、`find -maxdepth`'));
  });

  test('Linux 下应注入 Unix shell 提示', async () => {
    setPlatform('linux');

    const prompt = await PromptManager.buildSystemPrompt();

    assert.ok(prompt.includes('当前操作系统：Linux'));
    assert.ok(prompt.includes('Unix shell 语义'));
    assert.ok(prompt.includes('`ls`、`cat`、`grep`、`find`'));
  });

  test('macOS 下应注入 BSD 命令提示', async () => {
    setPlatform('darwin');

    const prompt = await PromptManager.buildSystemPrompt();

    assert.ok(prompt.includes('当前操作系统：macOS'));
    assert.ok(prompt.includes('Unix shell 语义'));
    assert.ok(prompt.includes('BSD 版本'));
  });

  test('surface prompt exposes the channel delivery contract', () => {
    const prompt = PromptManager.getSurfacePrompt();

    assert.ok(prompt.includes('消息交付规则（强制）'));
    assert.ok(prompt.includes('只有 send_text 和 send_file 会产生用户可见输出'));
    assert.ok(prompt.includes('普通最终回复、thinking、tool result、subagent 状态注入和日志'));
  });

  test('request clock resolves local midnight independently of a persistent session prompt', () => {
    assert.ok(PromptManager.getCurrentTimeInfo(new Date('2026-10-08T15:59:59Z')).includes('当前日期：2026-10-08'));
    const next = PromptManager.getCurrentTimeInfo(new Date('2026-10-08T16:00:00Z'));
    assert.ok(next.includes('当前日期：2026-10-09'));
    assert.ok(next.includes('2026-10-09 00:00:00'));
    assert.ok(next.includes('2026-10-08T16:00:00.000Z'));
  });
});

after(() => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }

  if (originalPlatformEnv) {
    process.env.CURRENT_PLATFORM = originalPlatformEnv;
  } else {
    delete process.env.CURRENT_PLATFORM;
  }

  RoleResolver.clearActiveRole();
});
