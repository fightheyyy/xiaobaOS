import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { createApiRouter } from '../src/dashboard/routes/api';
import { ServiceManager } from '../src/dashboard/service-manager';
import { MessageSessionManager } from '../src/core/message-session-manager';
import { RoleResolver } from '../src/utils/role-resolver';

const originalCwd = process.cwd();
const originalRole = process.env.XIAOBA_ROLE;
const originalCurrentRole = process.env.CURRENT_ROLE;
const originalCurrentRoleDisplayName = process.env.CURRENT_ROLE_DISPLAY_NAME;

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
    server.close(error => error ? reject(error) : resolve());
  });
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function writeSkill(root: string, name: string, legacyStatus?: string): string {
  const skillPath = path.join(root, 'skills', name, 'SKILL.md');
  writeFile(skillPath, `---
name: ${name}
description: ${name} description
${legacyStatus ? `status: ${legacyStatus}\n` : ''}aliases:
  - ${name}-alias
---

${name} instructions.
`);
  return skillPath;
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (typeof value === 'string') {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}

describe('Dashboard installed capability API', () => {
  let testRoot = '';
  let server: http.Server | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    RoleResolver.clearActiveRole();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dashboard-skills-'));
    process.chdir(testRoot);

    writeFile(path.join(testRoot, 'roles', 'engineer-cat', 'role.json'), JSON.stringify({
      name: 'engineer-cat',
      displayName: 'EngineerCat',
      inheritBaseSkills: true,
    }, null, 2));
    RoleResolver.activateRole('engineer-cat');

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', createApiRouter(new ServiceManager(testRoot)));
    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.baseUrl;
  });

  afterEach(async () => {
    await closeServer(server);
    server = null;
    await MessageSessionManager.getManager('pet')?.destroy();
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    restoreEnvValue('XIAOBA_ROLE', originalRole);
    restoreEnvValue('CURRENT_ROLE', originalCurrentRole);
    restoreEnvValue('CURRENT_ROLE_DISPLAY_NAME', originalCurrentRoleDisplayName);
  });

  test('lists every installed Skill without lifecycle fields', async () => {
    writeSkill(testRoot, 'legacy-candidate', 'candidate');
    writeSkill(testRoot, 'legacy-blocked', 'blocked');

    const response = await fetch(`${baseUrl}/api/skills-all`);
    assert.strictEqual(response.status, 200);
    const skills = await response.json() as Array<Record<string, unknown>>;
    const installed = skills
      .filter(skill => ['legacy-candidate', 'legacy-blocked'].includes(String(skill.name)))
      .sort((left, right) => String(left.name).localeCompare(String(right.name)));

    assert.deepStrictEqual(installed.map(skill => skill.name), ['legacy-blocked', 'legacy-candidate']);
    assert.ok(installed.every(skill => !Object.hasOwn(skill, 'status')));
    assert.ok(installed.every(skill => !Object.hasOwn(skill, 'enabled')));
  });

  test('does not expose Skill lifecycle mutation routes', async () => {
    const skillPath = writeSkill(testRoot, 'plain-skill', 'candidate');
    const before = fs.readFileSync(skillPath, 'utf-8');

    for (const action of ['enable', 'disable', 'unblock', 'promote']) {
      const response = await fetch(`${baseUrl}/api/skills/plain-skill/${action}`, { method: 'POST' });
      assert.strictEqual(response.status, 404, action);
    }
    assert.strictEqual(fs.readFileSync(skillPath, 'utf-8'), before);
  });

  test('treats every installed Role as runnable and exposes no lifecycle routes', async () => {
    const rolePath = path.join(testRoot, 'roles', 'legacy-blocked', 'role.json');
    writeFile(rolePath, JSON.stringify({
      name: 'legacy-blocked',
      displayName: 'LegacyBlocked',
      aliases: ['legacy-role'],
      status: 'blocked',
    }, null, 2));

    const listResponse = await fetch(`${baseUrl}/api/roles`);
    assert.strictEqual(listResponse.status, 200);
    const roles = await listResponse.json() as { roles: Array<Record<string, unknown>> };
    const installed = roles.roles.find(role => role.name === 'legacy-blocked');
    assert.ok(installed);
    assert.strictEqual(Object.hasOwn(installed, 'status'), false);

    const activate = await fetch(`${baseUrl}/api/roles/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'legacy-role' }),
    });
    assert.strictEqual(activate.status, 200);
    assert.strictEqual(RoleResolver.getActiveRoleName(), 'legacy-blocked');

    for (const action of ['block', 'unblock', 'promote']) {
      const response = await fetch(`${baseUrl}/api/roles/legacy-blocked/${action}`, { method: 'POST' });
      assert.strictEqual(response.status, 404, action);
    }
    assert.strictEqual(JSON.parse(fs.readFileSync(rolePath, 'utf-8')).status, 'blocked');
  });

  test('deletes an installed Skill package', async () => {
    const skillPath = writeSkill(testRoot, 'delete-me');
    const response = await fetch(`${baseUrl}/api/skills/delete-me`, { method: 'DELETE' });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(fs.existsSync(path.dirname(skillPath)), false);
  });

  test('deletes an installed Role and clears the selected role', async () => {
    const rolePath = path.join(testRoot, 'roles', 'engineer-cat');
    const response = await fetch(`${baseUrl}/api/roles/engineer-cat`, { method: 'DELETE' });
    assert.strictEqual(response.status, 200);
    const result = await response.json() as { ok: boolean; active: string | null };
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.active, null);
    assert.strictEqual(fs.existsSync(rolePath), false);
    assert.strictEqual(RoleResolver.getActiveRoleName(), undefined);
  });
});
