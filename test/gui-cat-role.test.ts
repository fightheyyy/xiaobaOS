import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createGuiCatTools } from '../src/roles/gui-cat/tools/gui-tools';
import { DesktopLease } from '../src/roles/gui-cat/utils/desktop-lease';
import {
  PeekabooCommandResult,
  PeekabooDriverStatus,
  PeekabooRunner,
} from '../src/roles/gui-cat/utils/peekaboo-runner';
import { ToolManager } from '../src/tools/tool-manager';
import { SkillManager } from '../src/skills/skill-manager';
import { PromptManager } from '../src/utils/prompt-manager';
import { RoleResolver } from '../src/utils/role-resolver';

const temporaryRoots: string[] = [];

class DefinitionOnlyRunner implements PeekabooRunner {
  async status(): Promise<PeekabooDriverStatus> {
    return readyStatus();
  }

  async run(): Promise<PeekabooCommandResult> {
    return { data: {}, stdout: '{"success":true,"data":{}}', stderr: '' };
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('GuiCat role contract', () => {
  test('role assets and aliases match the narrow macOS driver boundary', async () => {
    const roleDir = path.join(process.cwd(), 'roles', 'gui-cat');
    const config = JSON.parse(fs.readFileSync(path.join(roleDir, 'role.json'), 'utf8'));
    const prompt = fs.readFileSync(path.join(roleDir, 'prompts', 'gui-system-prompt.md'), 'utf8');
    const spec = fs.readFileSync(path.join(process.cwd(), 'docs', 'roles-skills', 'SPEC.md'), 'utf8');
    const plan = fs.readFileSync(path.join(process.cwd(), 'docs', 'roles-skills', 'PLAN.md'), 'utf8');

    assert.equal(config.name, 'gui-cat');
    assert.equal(config.promptFile, 'gui-system-prompt.md');
    assert.equal(config.inheritBaseSkills, false);
    assert.equal(config.inheritBaseTools, false);
    assert.deepEqual(config.baseToolAllowlist, ['ask_parent', 'read_file', 'glob', 'grep', 'skill']);
    assert.deepEqual(config.confirmedToolGate.tools, ['gui_confirmed_action']);
    assert.equal(config.metadata.driver, 'peekaboo');
    assert.equal(config.metadata.driverVersion, '3.8.x');
    assert.equal(config.metadata.petId, 'xiaoba');
    assert.equal(RoleResolver.resolveRoleDirectoryName('gui'), 'gui-cat');
    assert.equal(RoleResolver.resolveRoleDirectoryName('computer-use'), 'gui-cat');

    assert.match(prompt, /untrusted_desktop_content/);
    assert.match(prompt, /Terminal/);
    assert.match(prompt, /GUI_ACTION_OUTCOME_UNKNOWN/);
    assert.match(prompt, /subagent.*blocked/i);
    assert.match(prompt, /ask_parent/);
    assert.match(spec, /GuiCat.*桌面 GUI 接管/);
    assert.match(plan, /GuiCat typed desktop adapter/);

    const skillManager = new SkillManager('gui-cat');
    await skillManager.loadSkills();
    const peekabooSkill = skillManager.getSkill('peekaboo');
    assert.ok(peekabooSkill, 'GuiCat must package the official Peekaboo skill');
    assert.match(peekabooSkill.content, /peekaboo permissions status --json/);
    assert.match(peekabooSkill.content, /perform-action AXPress/);
    const vendoredSkill = fs.readFileSync(path.join(roleDir, 'skills', 'peekaboo', 'SKILL.md'));
    assert.equal(
      createHash('sha256').update(vendoredSkill).digest('hex'),
      '0bfe8b25ef9ac2ffc99c7135ddc3b7258abb0a41da0bbeeb9c27d1faa52f2d28',
      'GuiCat Peekaboo SKILL.md must remain an exact copy of upstream commit ed1a7218',
    );
    assert.match(
      fs.readFileSync(path.join(roleDir, 'skills', 'peekaboo', 'LICENSE'), 'utf8'),
      /MIT License[\s\S]*Copyright \(c\) 2025 Peter Steinberger/,
    );

    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    assert.equal(packageJson.optionalDependencies['@steipete/peekaboo'], '3.8.0');
    assert.deepEqual(packageJson.build.mac.extraResources, [{
      from: 'node_modules/@steipete/peekaboo/peekaboo',
      to: 'drivers/peekaboo/peekaboo',
    }]);

    const builtPrompt = await PromptManager.buildSystemPrompt({ roleName: 'gui-cat' });
    assert.match(builtPrompt, /你是 GuiCat/);
    assert.match(builtPrompt, /Peekaboo 只是被类型化工具约束/);
  });

  test('role-aware ToolManager exposes only GuiCat role tools and confirmation-gates the consequential tool', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-gui-role-'));
    temporaryRoots.push(root);
    const tools = createGuiCatTools({
      runner: new DefinitionOnlyRunner(),
      lease: new DesktopLease({ rootDir: path.join(root, 'lease') }),
    });
    const manager = new ToolManager(process.cwd(), { roleName: 'gui-cat' }, tools);

    const ordinary = manager.getToolDefinitions({
      roleName: 'gui-cat',
      conversationHistory: [{ role: 'user', content: '看看 TextEdit 当前界面' }],
    }).map(tool => tool.name).sort();

    assert.deepEqual(ordinary, [
      'ask_parent',
      'glob',
      'grep',
      'gui_capture',
      'gui_click',
      'gui_click_sequence',
      'gui_driver_status',
      'gui_input',
      'gui_manage',
      'gui_observe',
      'gui_release_control',
      'read_file',
      'skill',
    ]);
    assert.equal(ordinary.includes('gui_task_run'), false, 'upstream agent loop must stay hidden');
    assert.equal(ordinary.includes('execute_shell'), false);
    assert.equal(ordinary.includes('write_file'), false);
    assert.equal(ordinary.includes('spawn_subagent'), false);

    const confirmed = manager.getToolDefinitions({
      roleName: 'gui-cat',
      conversationHistory: [
        { role: 'assistant', content: '准备关闭 TextEdit 窗口。' },
        { role: 'user', content: '确认关闭 TextEdit' },
      ],
    }).map(tool => tool.name);
    assert.ok(confirmed.includes('gui_confirmed_action'));
  });
});

function readyStatus(): PeekabooDriverStatus {
  return {
    platform: 'darwin',
    macosVersion: '17',
    supportedPlatform: true,
    binaryPath: '/fake/peekaboo',
    version: '3.8.0',
    versionCompatible: true,
    permissions: {
      screenRecording: true,
      accessibility: true,
      eventSynthesizing: true,
    },
    ready: true,
  };
}
