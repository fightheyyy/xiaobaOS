import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_BUNDLED_ROLES } from '../src/roles/role-manager';
import { DEFAULT_BUNDLED_BASE_SKILLS } from '../src/skills/skill-manager';

function getBuildFiles(): string[] {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
  return packageJson.build.files as string[];
}

describe('default packaged policy assets', () => {
  test('electron package bundles zero default base skills', () => {
    const files = getBuildFiles();
    const bundledSkills = files
      .map(file => {
        const match = file.match(/^skills\/([^/]+)\/\*\*\/\*$/);
        return match?.[1];
      })
      .filter((skill): skill is string => Boolean(skill))
      .sort();

    assert.deepStrictEqual(bundledSkills, [...DEFAULT_BUNDLED_BASE_SKILLS].sort());
    assert.ok(files.includes('skills/README.md'));
    assert.strictEqual(bundledSkills.includes('OfficeCLI'), false);
    assert.strictEqual(bundledSkills.includes('WebCLI'), false);
    assert.strictEqual(bundledSkills.includes('vision-analysis'), false);
    assert.strictEqual(bundledSkills.includes('agent-browser'), false);
  });

  test('electron package bundles the eight default roles', () => {
    const files = getBuildFiles();
    const bundledRoles = files
      .map(file => {
        const match = file.match(/^roles\/([^/]+)\/\*\*\/\*$/);
        return match?.[1];
      })
      .filter((role): role is string => Boolean(role))
      .sort();

    assert.deepStrictEqual(bundledRoles, [...DEFAULT_BUNDLED_ROLES].sort());
    assert.ok(files.includes('roles/README.md'));
    assert.strictEqual(bundledRoles.includes('researcher-cat'), false);
    assert.strictEqual(bundledRoles.includes('router-cat'), false);
    assert.strictEqual(bundledRoles.includes('secretary-cat'), true);
    assert.strictEqual(bundledRoles.includes('guide'), false);
    assert.ok(bundledRoles.includes('browser-cat'));
    assert.ok(bundledRoles.includes('gui-cat'));
    assert.ok(bundledRoles.includes('secretary-cat'));
    assert.ok(bundledRoles.includes('evolution-cat'));

    for (const roleName of DEFAULT_BUNDLED_ROLES) {
      const config = JSON.parse(fs.readFileSync(
        path.join(process.cwd(), 'roles', roleName, 'role.json'),
        'utf-8',
      ));
      assert.strictEqual(config.metadata?.petId, 'xiaoba', `${roleName} must share the XiaoBa renderer`);
    }
  });

  test('electron startup sync includes takeover roles and narrowly migrates exact bundled assets', () => {
    const mainSource = fs.readFileSync(
      path.join(process.cwd(), 'desktop', 'electron', 'main.js'),
      'utf-8',
    );

    assert.match(mainSource, /DEFAULT_BUNDLED_ROLES[^\n]+browser-cat[^\n]+gui-cat[^\n]+secretary-cat[^\n]+evolution-cat/);
    assert.match(mainSource, /RETIRED_AGENT_BROWSER_SKILL_SHA256S/);
    assert.match(mainSource, /26f30428a5cff69f396e821cb51060db1f13c7ec66473268b3731001ea63cd93/);
    assert.match(mainSource, /fs\.rmSync\(retiredBrowserSkillDir/);
    assert.match(mainSource, /RETIRED_BASE_SKILL_FILES/);
    assert.match(mainSource, /1d75e06fa8d340ae8600e1a352923ddc6c1bf009820a4bfd1f9527b2b822661d/);
    assert.match(mainSource, /df7eb5741a9bbc5f5ed89ac90f5aec041920985a3772f9d5c24cbc4e1ddaec4a/);
    assert.match(mainSource, /retireExactLegacyBaseSkills/);
    assert.match(mainSource, /migration-backups', 'base-skills'/);
    assert.match(mainSource, /LEGACY_ROLE_CONFIG_SHA256S/);
    assert.match(mainSource, /petId: bundledRoleConfig\.metadata\.petId/);
    assert.match(mainSource, /createHash\('sha256'\)/);
    assert.match(mainSource, /migration-backups/);
    assert.doesNotMatch(mainSource, /includes\('npx agent-browser'\)/);
    assert.doesNotMatch(mainSource, /shouldMigrateLegacyBrowserSkill/);

    const gitignore = fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf-8');
    assert.match(gitignore, /!\/roles\/evolution-cat\/\*\*/);
    assert.doesNotMatch(gitignore, /!\/skills\/(remember|self-evolution|skill-publish|role-publish)/);
  });
});
