import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SkillManager } from '../src/skills/skill-manager';
import { createBrowserCatTools } from '../src/roles/browser-cat';
import {
  AgentBrowserDriverStatus,
  AgentBrowserResponse,
  AgentBrowserRunOptions,
  AgentBrowserRunner,
} from '../src/roles/browser-cat/agent-browser-runner';
import { ToolManager } from '../src/tools/tool-manager';

class RoleFakeRunner implements AgentBrowserRunner {
  async getStatus(): Promise<AgentBrowserDriverStatus> {
    return {
      installed: true,
      ready: true,
      version: '0.31.1',
      expectedVersion: '0.31.1',
      binaryPath: '/fake/agent-browser',
      doctor: { success: true, summary: { pass: 5, fail: 0, warn: 0 } },
    };
  }

  async run(_command: string[], _options: AgentBrowserRunOptions): Promise<AgentBrowserResponse> {
    return { success: true, data: {} };
  }
}

describe('BrowserCat role contract', () => {
  test('role config and official core skill keep BrowserCat on narrow typed tools', async () => {
    const roleDir = path.join(process.cwd(), 'roles', 'browser-cat');
    const config = JSON.parse(fs.readFileSync(path.join(roleDir, 'role.json'), 'utf-8'));

    assert.strictEqual(config.name, 'browser-cat');
    assert.strictEqual(config.inheritBaseSkills, false);
    assert.strictEqual(config.inheritBaseTools, false);
    assert.deepStrictEqual(config.baseToolAllowlist, ['ask_parent', 'read_file', 'glob', 'grep', 'skill']);
    assert.deepStrictEqual(config.confirmedToolGate.tools, ['browser_click_confirmed']);
    assert.strictEqual(config.metadata.driver, 'agent-browser');
    assert.strictEqual(config.metadata.driverVersion, '0.31.1');
    assert.strictEqual(config.metadata.petId, 'xiaoba');

    const skillManager = new SkillManager('browser-cat');
    await skillManager.loadSkills();
    const coreSkill = skillManager.getSkill('core');
    assert.ok(coreSkill, 'BrowserCat must package the official agent-browser core skill');
    assert.match(coreSkill.content, /agent-browser snapshot -i/);
    assert.match(coreSkill.content, /agent-browser mcp/);

    const vendoredSkill = fs.readFileSync(path.join(roleDir, 'skills', 'core', 'SKILL.md'));
    assert.strictEqual(
      createHash('sha256').update(vendoredSkill).digest('hex'),
      'cc5ec94697530e750bcb9776479d71ef7966e7cf874b9a60b091a986b1ae5b9d',
      'BrowserCat core SKILL.md must remain an exact copy of upstream commit ed2e1059',
    );
    assert.match(
      fs.readFileSync(path.join(roleDir, 'skills', 'core', 'LICENSE'), 'utf8'),
      /Apache License[\s\S]*Copyright 2025 Vercel Inc\./,
    );
  });

  test('prompt defines untrusted web, sensitive-input, verification, and subagent confirmation boundaries', () => {
    const promptPath = path.join(
      process.cwd(),
      'roles',
      'browser-cat',
      'prompts',
      'browser-system-prompt.md',
    );
    const prompt = fs.readFileSync(promptPath, 'utf-8');

    assert.match(prompt, /untrusted_web_content/);
    assert.match(prompt, /密码、OTP、PIN、验证码/);
    assert.match(prompt, /重新 snapshot/);
    assert.match(prompt, /BROWSER_TRUSTED_CONFIRMATION_UNAVAILABLE/);
    assert.match(prompt, /不使用 `execute_shell`/);
  });

  test('role tool composition exposes browser tools and hides broad base execution tools', () => {
    const manager = new ToolManager(
      process.cwd(),
      { roleName: 'browser-cat' },
      createBrowserCatTools({ runner: new RoleFakeRunner() }),
    );
    const names = manager.getToolDefinitions().map(tool => tool.name);

    for (const expected of [
      'browser_driver_status',
      'browser_open',
      'browser_snapshot',
      'browser_action_sequence',
      'browser_click',
      'browser_fill',
      'browser_select',
      'browser_scroll',
      'browser_wait',
      'browser_tab',
      'browser_screenshot',
      'browser_close',
      'ask_parent',
      'read_file',
      'glob',
      'grep',
      'skill',
    ]) {
      assert.ok(names.includes(expected), `${expected} should be visible to BrowserCat`);
    }
    assert.strictEqual(names.includes('browser_click_confirmed'), false, 'confirmed click stays hidden without confirmation');
    assert.strictEqual(names.includes('browser_task_run'), false, 'upstream agent loop must stay hidden');
    for (const forbidden of [
      'execute_shell',
      'write_file',
      'edit_file',
      'spawn_subagent',
      'check_subagent',
      'stop_subagent',
      'resume_subagent',
    ]) {
      assert.strictEqual(names.includes(forbidden), false, `${forbidden} must be hidden from BrowserCat`);
    }
  });
});
