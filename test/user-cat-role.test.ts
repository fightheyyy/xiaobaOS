import { after, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { createRoleAwareToolManager } from '../src/bootstrap/tool-manager';
import { getRoleSpecificToolsForRole, startRoleRuntimeServices } from '../src/roles/runtime-role-registry';
import { SkillManager } from '../src/skills/skill-manager';
import { PromptManager } from '../src/utils/prompt-manager';
import { RoleResolver } from '../src/utils/role-resolver';

const originalRole = process.env.XIAOBA_ROLE;
const originalCurrentRole = process.env.CURRENT_ROLE;
const originalCurrentRoleDisplayName = process.env.CURRENT_ROLE_DISPLAY_NAME;

function restoreEnv(): void {
  if (originalRole) {
    process.env.XIAOBA_ROLE = originalRole;
  } else {
    delete process.env.XIAOBA_ROLE;
  }
  if (originalCurrentRole) {
    process.env.CURRENT_ROLE = originalCurrentRole;
  } else {
    delete process.env.CURRENT_ROLE;
  }
  if (originalCurrentRoleDisplayName) {
    process.env.CURRENT_ROLE_DISPLAY_NAME = originalCurrentRoleDisplayName;
  } else {
    delete process.env.CURRENT_ROLE_DISPLAY_NAME;
  }
}

describe('UserCat role', () => {
  beforeEach(() => {
    RoleResolver.clearActiveRole();
  });

  after(() => {
    restoreEnv();
  });

  test('role assets exist and alias activation resolves to user-cat', () => {
    const rolePath = path.join(process.cwd(), 'roles', 'user-cat', 'role.json');
    assert.ok(fs.existsSync(rolePath));

    const config = JSON.parse(fs.readFileSync(rolePath, 'utf-8'));
    assert.equal(config.name, 'user-cat');
    assert.equal(config.promptFile, 'user-system-prompt.md');
    assert.equal(config.inheritBaseSkills, false);
    assert.equal(config.inheritBaseTools, false);
    assert.deepEqual(config.baseToolAllowlist, []);
    assert.equal(config.metadata.toolPolicy, 'one-natural-user-turn-or-explicit-live-trace');
    assert.match(config.metadata.promptProvenance, /langwatch\/scenario.*Apache-2\.0/);

    RoleResolver.activateRole('low info user');
    assert.equal(RoleResolver.getActiveRoleName(), 'user-cat');
    assert.equal(process.env.CURRENT_ROLE_DISPLAY_NAME, 'UserCat');
  });

  test('prompt keeps UserCat in narrow Scenario-style end-user role-play', async () => {
    const prompt = await PromptManager.buildSystemPrompt({ roleName: 'user-cat' });

    assert.match(prompt, /pretending to be an ordinary end user/);
    assert.match(prompt, /keep each message short and conversational/);
    assert.match(prompt, /do not reveal every detail up front/);
    assert.match(prompt, /Send one user message and stop/);
    assert.match(prompt, /It never means that\s+evaluation evidence is sufficient/);
    assert.match(prompt, /Never:[\s\S]*judge whether the Agent passed or failed/);
    assert.doesNotMatch(prompt, /role_intent_map|scenario_plan|trace_quality_self_check/);
    assert.match(prompt, /当前角色：UserCat/);
  });

  test('UserCat has no role-local planning Skills', async () => {
    const manager = new SkillManager('user-cat');
    await manager.loadSkills();

    assert.deepEqual(manager.getAllSkills(), []);
  });

  test('role exposes only the explicit UserCat live-trace compatibility tool', async () => {
    const userTools = getRoleSpecificToolsForRole('user-cat');
    assert.deepEqual(userTools.map(tool => tool.definition.name), ['user_trace_run']);
    assert.equal(await startRoleRuntimeServices({ workingDirectory: process.cwd() }), null);

    const manager = createRoleAwareToolManager(process.cwd(), {}, 'user-cat');
    const toolNames = manager.getToolDefinitions().map(tool => tool.name).sort();

    assert.ok(toolNames.includes('user_trace_run'));
    assert.ok(!toolNames.includes('read_file'));
    assert.ok(!toolNames.includes('grep'));
    assert.ok(!toolNames.includes('glob'));
    assert.ok(!toolNames.includes('skill'));
    assert.ok(!toolNames.includes('write_file'));
    assert.ok(!toolNames.includes('edit_file'));
    assert.ok(!toolNames.includes('execute_shell'));
    assert.ok(!toolNames.includes('spawn_subagent'));
    assert.ok(!toolNames.includes('check_subagent'));
    assert.ok(!toolNames.includes('reviewer_eval_prepare'));
    assert.ok(!toolNames.includes('reviewer_xiaoba_cli_e2e'));
    assert.ok(!toolNames.includes('reviewer_module_test'));
    assert.ok(!toolNames.includes('engineer_task_run'));
    assert.ok(!toolNames.includes('codex_job_start'));
    assert.ok(!toolNames.includes('feishu_message_send_confirmed'));
  });
});
