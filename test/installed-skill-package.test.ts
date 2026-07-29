import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SkillManager } from '../src/skills/skill-manager';

function writeSkill(
  root: string,
  name: string,
  legacyStatus?: string,
  aliases: string[] = [],
): void {
  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: ${name} description`,
    ...(legacyStatus ? [`status: ${legacyStatus}`] : []),
    ...(aliases.length > 0 ? ['aliases:', ...aliases.map(alias => `  - ${alias}`)] : []),
    '---',
    '',
    `${name} instructions.`,
    '',
  ];
  const filePath = path.join(root, 'skills', name, 'SKILL.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, frontmatter.join('\n'), 'utf-8');
}

describe('installed Skill packages', () => {
  let testRoot = '';
  let previousCwd = '';
  let previousProjectRoot: string | undefined;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-installed-skills-'));
    previousCwd = process.cwd();
    previousProjectRoot = process.env.XIAOBA_PROJECT_ROOT;
    process.chdir(testRoot);
    process.env.XIAOBA_PROJECT_ROOT = testRoot;

    writeSkill(testRoot, 'plain-skill', undefined, ['plain']);
    writeSkill(testRoot, 'legacy-candidate', 'candidate', ['candidate-alias']);
    writeSkill(testRoot, 'legacy-blocked', 'blocked', ['blocked-alias']);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousProjectRoot === undefined) {
      delete process.env.XIAOBA_PROJECT_ROOT;
    } else {
      process.env.XIAOBA_PROJECT_ROOT = previousProjectRoot;
    }
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('loads every installed package regardless of obsolete status metadata', async () => {
    const manager = new SkillManager();
    await manager.loadSkills();

    assert.deepStrictEqual(
      manager.getAllSkills().map(skill => skill.metadata.name).sort(),
      ['legacy-blocked', 'legacy-candidate', 'plain-skill'],
    );
    assert.strictEqual(manager.getSkill('candidate-alias')?.metadata.name, 'legacy-candidate');
    assert.strictEqual(manager.getSkill('blocked-alias')?.metadata.name, 'legacy-blocked');
    assert.ok(manager.getAllSkills().every(skill => !Object.hasOwn(skill.metadata, 'status')));
  });

  test('uses the same installed inventory inside and outside Arena', async () => {
    const originalArena = process.env.XIAOBA_ARENA;
    try {
      const normal = new SkillManager();
      delete process.env.XIAOBA_ARENA;
      await normal.loadSkills();

      const arena = new SkillManager();
      process.env.XIAOBA_ARENA = '1';
      await arena.loadSkills();

      assert.deepStrictEqual(
        arena.getAutoInvocableSkills().map(skill => skill.metadata.name).sort(),
        normal.getAutoInvocableSkills().map(skill => skill.metadata.name).sort(),
      );
    } finally {
      if (originalArena === undefined) {
        delete process.env.XIAOBA_ARENA;
      } else {
        process.env.XIAOBA_ARENA = originalArena;
      }
    }
  });
});
