import { after, afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ArenaManager,
  DEFAULT_PACKAGED_BASE_SKILLS,
  fingerprintArenaDirectory,
} from '../src/arena/arena-manager';
import { SkillManager } from '../src/skills/skill-manager';
import { RoleResolver } from '../src/utils/role-resolver';

const originalCwd = process.cwd();
const originalRole = process.env.XIAOBA_ROLE;
const originalCurrentRole = process.env.CURRENT_ROLE;
const originalCurrentRoleDisplayName = process.env.CURRENT_ROLE_DISPLAY_NAME;
const originalRolesRoot = process.env.XIAOBA_ROLES_ROOT;
const originalProjectRoot = process.env.XIAOBA_PROJECT_ROOT;
const originalSkillsRoot = process.env.XIAOBA_SKILLS_ROOT;
const originalArenaSecret = process.env.ARENA_SECRET;
const originalDotenvConfigPath = process.env.DOTENV_CONFIG_PATH;

describe('ArenaManager', () => {
  let testRoot = '';
  let manager: ArenaManager;

  beforeEach(() => {
    RoleResolver.clearActiveRole();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-arena-'));
    process.chdir(testRoot);
    delete process.env.XIAOBA_ROLES_ROOT;
    delete process.env.XIAOBA_PROJECT_ROOT;
    delete process.env.XIAOBA_SKILLS_ROOT;
    delete process.env.ARENA_SECRET;
    delete process.env.DOTENV_CONFIG_PATH;
    manager = new ArenaManager({
      projectRoot: testRoot,
      now: () => new Date('2026-06-29T00:00:00.000Z'),
    });
    writeBaseSkills(testRoot);
    writeRole(testRoot, 'engineer-cat', {
      name: 'engineer-cat',
      displayName: 'EngineerCat',
      aliases: ['engineer'],
      description: 'Implementation role',
      baseToolAllowlist: ['read_file'],
      baseToolDenylist: ['write_file'],
      metadata: { boundary: 'Implement changes with evidence.' },
    });
    writeSkill(path.join(testRoot, 'roles', 'engineer-cat', 'skills', 'engineer-helper'), {
      name: 'engineer-helper',
      description: 'Engineer helper',
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  after(() => {
    process.chdir(originalCwd);
    restoreEnv('XIAOBA_ROLE', originalRole);
    restoreEnv('CURRENT_ROLE', originalCurrentRole);
    restoreEnv('CURRENT_ROLE_DISPLAY_NAME', originalCurrentRoleDisplayName);
    restoreEnv('XIAOBA_ROLES_ROOT', originalRolesRoot);
    restoreEnv('XIAOBA_PROJECT_ROOT', originalProjectRoot);
    restoreEnv('XIAOBA_SKILLS_ROOT', originalSkillsRoot);
    restoreEnv('ARENA_SECRET', originalArenaSecret);
    restoreEnv('DOTENV_CONFIG_PATH', originalDotenvConfigPath);
  });

  test('imports a local skill as an arena-only subject manifest', () => {
    writeSkill(path.join(testRoot, 'fixtures', 'skills', 'report-writer'), {
      name: 'report-writer',
      description: 'Writes reports with visible artifacts',
      body: 'Create reports. Never leak token values.',
    });

    const manifest = manager.importLocalSkill({
      skillPath: 'fixtures/skills/report-writer',
    });

    assert.strictEqual(manifest.subject.type, 'skill');
    assert.strictEqual(manifest.subject.name, 'report-writer');
    assert.strictEqual(manifest.trust_level, 'review_required');
    assert.strictEqual(manifest.allowed_runtime, 'arena_only');
    assert.strictEqual(manifest.source.path, `arena/subjects/${manifest.subject_id}/source`);
    assert.ok(manifest.parsed.skill_files.includes(`arena/subjects/${manifest.subject_id}/source/SKILL.md`));
    assert.match(manifest.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(fs.existsSync(path.join(
      testRoot,
      'arena',
      'subjects',
      manifest.subject_id,
      'arena-manifest.json',
    )));
  });

  test('content-addresses local Skill subjects and keeps earlier source snapshots immutable', () => {
    const skillDir = path.join(testRoot, 'fixtures', 'skills', 'snapshot-skill');
    writeSkill(skillDir, {
      name: 'snapshot-skill',
      description: 'Uses a versioned helper.',
    });
    writeText(path.join(skillDir, 'scripts', 'helper.js'), 'module.exports = "v1";\n');

    const first = manager.importLocalSkill({ skillPath: skillDir });
    const firstSnapshotRoot = path.resolve(testRoot, first.source.path || '');
    assert.strictEqual(
      fs.readFileSync(path.join(firstSnapshotRoot, 'scripts', 'helper.js'), 'utf-8'),
      'module.exports = "v1";\n',
    );

    writeText(path.join(skillDir, 'scripts', 'helper.js'), 'module.exports = "v2";\n');
    const second = manager.importLocalSkill({ skillPath: skillDir });
    const secondSnapshotRoot = path.resolve(testRoot, second.source.path || '');

    assert.notStrictEqual(second.fingerprint, first.fingerprint);
    assert.notStrictEqual(second.subject_id, first.subject_id);
    assert.strictEqual(
      fs.readFileSync(path.join(firstSnapshotRoot, 'scripts', 'helper.js'), 'utf-8'),
      'module.exports = "v1";\n',
    );
    assert.strictEqual(
      fs.readFileSync(path.join(secondSnapshotRoot, 'scripts', 'helper.js'), 'utf-8'),
      'module.exports = "v2";\n',
    );

    const runtime = manager.prepareCleanRuntime({
      runId: 'immutable-first-skill',
      reviewMode: 'base_skill',
      subjectId: first.subject_id,
    });
    assert.strictEqual(
      fs.readFileSync(path.join(runtime.roots.skills_root, 'snapshot-skill', 'scripts', 'helper.js'), 'utf-8'),
      'module.exports = "v1";\n',
    );
  });

  test('exports a deterministic Arena directory fingerprint and rejects symbolic links', () => {
    const sourceRoot = path.join(testRoot, 'fingerprint-source');
    writeText(path.join(sourceRoot, 'SKILL.md'), 'alpha\n');
    writeText(path.join(sourceRoot, 'nested', 'data.txt'), 'beta\n');
    const first = fingerprintArenaDirectory(sourceRoot);
    const second = fingerprintArenaDirectory(sourceRoot);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.strictEqual(second, first);

    writeText(path.join(sourceRoot, 'nested', 'data.txt'), 'changed\n');
    assert.notStrictEqual(fingerprintArenaDirectory(sourceRoot), first);

    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(sourceRoot, 'SKILL.md'), path.join(sourceRoot, 'linked-skill'));
      assert.throws(
        () => fingerprintArenaDirectory(sourceRoot),
        /rejects symbolic links/,
      );
    }
  });

  test('snapshots a role without mutating production role files', () => {
    const rolePath = path.join(testRoot, 'roles', 'engineer-cat');
    const before = fs.readdirSync(rolePath).sort();

    const manifest = manager.snapshotRole({ roleId: 'engineer-cat' });

    assert.strictEqual(manifest.subject.type, 'role');
    assert.strictEqual(manifest.subject.name, 'engineer-cat');
    assert.strictEqual(manifest.role?.id, 'engineer-cat');
    assert.deepStrictEqual(manifest.role?.local_skills, ['engineer-helper']);
    assert.ok(manifest.role?.declared_boundaries.includes('Implement changes with evidence.'));
    assert.strictEqual(manifest.source.path, `arena/subjects/${manifest.subject_id}/source`);
    assert.deepStrictEqual(fs.readdirSync(rolePath).sort(), before);
  });

  test('content-addresses Role subjects and keeps earlier source snapshots immutable', () => {
    const rolePath = path.join(testRoot, 'roles', 'engineer-cat');
    const promptPath = path.join(rolePath, 'prompts', 'system.md');
    const first = manager.snapshotRole({ roleId: 'engineer-cat' });
    const firstSnapshotRoot = path.resolve(testRoot, first.source.path || '');

    fs.writeFileSync(promptPath, 'Changed role prompt.\n', 'utf-8');
    const second = manager.snapshotRole({ roleId: 'engineer-cat' });
    const secondSnapshotRoot = path.resolve(testRoot, second.source.path || '');

    assert.notStrictEqual(second.fingerprint, first.fingerprint);
    assert.notStrictEqual(second.subject_id, first.subject_id);
    assert.strictEqual(
      fs.readFileSync(path.join(firstSnapshotRoot, 'prompts', 'system.md'), 'utf-8'),
      'Role prompt.',
    );
    assert.strictEqual(
      fs.readFileSync(path.join(secondSnapshotRoot, 'prompts', 'system.md'), 'utf-8'),
      'Changed role prompt.\n',
    );
  });

  test('imports an isolated candidate role and prepares role mode without touching production roles', () => {
    const candidateRolePath = path.join(
      testRoot,
      'output',
      'evolution',
      'sleep',
      '2026-06-29',
      'candidates',
      'evidence-review-cat',
    );
    writeJson(path.join(candidateRolePath, 'role.json'), {
      name: 'evidence-review-cat',
      displayName: 'EvidenceReviewCat',
      description: 'Review evidence without changing production assets.',
      promptFile: 'evidence-review-system-prompt.md',
      inheritBaseTools: false,
      baseToolAllowlist: ['read_file'],
      metadata: { boundary: 'Arena-only candidate role.' },
    });
    writeText(
      path.join(candidateRolePath, 'prompts', 'evidence-review-system-prompt.md'),
      'Review the supplied evidence and leave production roles unchanged.\n',
    );
    writeSkill(path.join(candidateRolePath, 'skills', 'evidence-helper'), {
      name: 'evidence-helper',
      description: 'Inspect evidence references.',
    });
    const productionRolesRoot = path.join(testRoot, 'roles');
    const productionBefore = snapshotDirectory(productionRolesRoot);

    const manifest = manager.importLocalRole({ rolePath: candidateRolePath });
    const runtime = manager.prepareCleanRuntime({
      runId: 'isolated-candidate-role',
      reviewMode: 'role',
      subjectId: manifest.subject_id,
      targetRoleId: 'evidence-review-cat',
    });

    assert.strictEqual(manifest.subject.type, 'role');
    assert.strictEqual(manifest.subject.name, 'evidence-review-cat');
    assert.strictEqual(manifest.trust_level, 'review_required');
    assert.strictEqual(manifest.allowed_runtime, 'arena_only');
    assert.strictEqual(manifest.source.path, `arena/subjects/${manifest.subject_id}/source`);
    assert.deepStrictEqual(manifest.role?.local_skills, ['evidence-helper']);
    assert.strictEqual(runtime.review_mode, 'role');
    assert.strictEqual(runtime.target_profile.active_role_id, 'evidence-review-cat');
    assert.deepStrictEqual(runtime.target_profile.role_local_skills, ['evidence-helper']);
    assert.ok(runtime.target_profile.loaded_skills.includes('evidence-helper'));
    assert.strictEqual(runtime.copied.role, 'roles/evidence-review-cat');
    assert.ok(fs.existsSync(path.join(runtime.roots.roles_root, 'evidence-review-cat', 'role.json')));
    assert.ok(runtime.launch.command.includes('evidence-review-cat'));
    assert.ok(runtime.target_profile.registered_tools.includes('write_file'));
    assert.ok(runtime.target_profile.registered_tools.includes('send_text'));
    assert.deepStrictEqual(
      runtime.target_profile.provider_visible_tools,
      ['read_file', 'send_text', 'send_file'],
    );
    assert.ok(!runtime.target_profile.provider_visible_tools.includes('write_file'));

    const previousProjectRoot = process.env.XIAOBA_PROJECT_ROOT;
    const previousRolesRoot = process.env.XIAOBA_ROLES_ROOT;
    process.env.XIAOBA_PROJECT_ROOT = runtime.launch.env.XIAOBA_PROJECT_ROOT;
    process.env.XIAOBA_ROLES_ROOT = runtime.launch.env.XIAOBA_ROLES_ROOT;
    try {
      assert.strictEqual(RoleResolver.getRolesRoot(), runtime.roots.roles_root);
      assert.strictEqual(RoleResolver.resolveRoleDirectoryName('evidence-review-cat'), 'evidence-review-cat');
      assert.strictEqual(
        RoleResolver.getRoleConfig('evidence-review-cat')?.description,
        'Review evidence without changing production assets.',
      );
    } finally {
      restoreEnv('XIAOBA_PROJECT_ROOT', previousProjectRoot);
      restoreEnv('XIAOBA_ROLES_ROOT', previousRolesRoot);
    }
    assert.strictEqual(fs.existsSync(path.join(productionRolesRoot, 'evidence-review-cat')), false);
    assert.deepStrictEqual(snapshotDirectory(productionRolesRoot), productionBefore);
  });

  test('prepares a clean base_skill runtime with only base skills and subject skill', () => {
    const manifest = manager.importLocalSkill({
      skillPath: writeSkill(path.join(testRoot, 'fixtures', 'skills', 'rating-skill'), {
        name: 'rating-skill',
        description: 'Rates evidence',
      }),
    });
    process.env.ARENA_SECRET = 'super-secret-value';

    const runtime = manager.prepareCleanRuntime({
      runId: 'clean-base-skill',
      reviewMode: 'base_skill',
      subjectId: manifest.subject_id,
      passThroughEnv: ['ARENA_SECRET'],
    });

    assert.strictEqual(runtime.review_mode, 'base_skill');
    assert.strictEqual(runtime.target_profile.active_role_id, 'base');
    assert.ok(fs.existsSync(path.join(runtime.roots.skills_root, 'rating-skill', 'SKILL.md')));
    assert.ok(DEFAULT_PACKAGED_BASE_SKILLS.every(skill => (
      fs.existsSync(path.join(runtime.roots.skills_root, skill, 'SKILL.md'))
    )));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(runtime.roots.workspace_root, 'skill-registry.json'), 'utf-8')), []);
    assert.strictEqual(runtime.launch.cwd, runtime.roots.workspace_root);
    assert.strictEqual(runtime.launch.env.XIAOBA_PROJECT_ROOT, testRoot);
    assert.strictEqual(runtime.launch.env.XIAOBA_SKILLS_ROOT, runtime.roots.skills_root);
    assert.strictEqual(runtime.launch.env.XIAOBA_ROLES_ROOT, runtime.roots.roles_root);
    assert.strictEqual(runtime.launch.env.HOME, runtime.roots.home_root);
    assert.strictEqual(runtime.sandbox.subject_root, path.join(runtime.roots.run_root, 'skills', 'rating-skill'));
    assert.ok(!runtime.launch.command.includes('--role'));
    assert.ok(runtime.launch.pass_through_env.includes('ARENA_SECRET'));
    assert.match(runtime.launch.shell_command, /ARENA_SECRET="\$\{ARENA_SECRET\}"/);

    const runtimeJson = fs.readFileSync(path.join(testRoot, 'arena', 'runs', 'clean-base-skill', 'clean-runtime.json'), 'utf-8');
    assert.ok(!runtimeJson.includes('super-secret-value'));
  });

  test('removes stale run-local debug artifacts when a run id is prepared again', () => {
    const manifest = manager.importLocalSkill({
      skillPath: writeSkill(path.join(testRoot, 'fixtures', 'skills', 'debug-reset-skill'), {
        name: 'debug-reset-skill',
        description: 'Exercises clean Arena evidence roots',
      }),
    });
    const input = {
      runId: 'clean-debug-reset',
      reviewMode: 'base_skill' as const,
      subjectId: manifest.subject_id,
    };
    const previousLiveMode = process.env.XIAOBA_ARENA_LIVE_MODE;
    process.env.XIAOBA_ARENA_LIVE_MODE = 'barena';
    try {
      const first = manager.prepareCleanRuntime(input);
      assert.ok(fs.statSync(path.join(first.roots.run_root, 'debug')).isDirectory());
      assert.ok(fs.statSync(path.join(first.roots.run_root, 'debug', 'provider-calls.ndjson')).isFile());
      if (first.launch.sandbox_policy_path) {
        const profile = fs.readFileSync(first.launch.sandbox_policy_path, 'utf-8');
        assert.ok(profile.includes(fs.realpathSync.native(first.roots.run_root)));
      }
      const staleDebug = path.join(first.roots.run_root, 'debug', 'stale-replay.json');
      writeText(staleDebug, 'stale');

      manager.prepareCleanRuntime(input);

      assert.ok(!fs.existsSync(staleDebug));
    } finally {
      if (previousLiveMode === undefined) delete process.env.XIAOBA_ARENA_LIVE_MODE;
      else process.env.XIAOBA_ARENA_LIVE_MODE = previousLiveMode;
    }
  });

  test('clean runtime loads project .env without persisting secret values', () => {
    const manifest = manager.importLocalSkill({
      skillPath: writeSkill(path.join(testRoot, 'fixtures', 'skills', 'env-skill'), {
        name: 'env-skill',
        description: 'Needs configured provider env',
      }),
    });
    fs.writeFileSync(path.join(testRoot, '.env'), [
      'XIAOBA_LLM_PROVIDER=openai',
      'XIAOBA_LLM_API_BASE=https://api.example.test/v1',
      'XIAOBA_LLM_API_KEY=sk-arena-secret',
      'XIAOBA_LLM_MODEL=gpt-arena',
      '',
    ].join('\n'), 'utf-8');

    const runtime = manager.prepareCleanRuntime({
      runId: 'clean-base-skill-dotenv',
      reviewMode: 'base_skill',
      subjectId: manifest.subject_id,
    });

    assert.strictEqual(runtime.launch.env.DOTENV_CONFIG_PATH, path.join(testRoot, '.env'));
    assert.match(runtime.launch.shell_command, /DOTENV_CONFIG_PATH=/);
    assert.doesNotMatch(runtime.launch.shell_command, /sk-arena-secret/);
    const runtimeJson = fs.readFileSync(path.join(testRoot, 'arena', 'runs', 'clean-base-skill-dotenv', 'clean-runtime.json'), 'utf-8');
    assert.ok(runtimeJson.includes('DOTENV_CONFIG_PATH'));
    assert.ok(!runtimeJson.includes('sk-arena-secret'));
  });

  test('prepares clean runtime with a copied workspace seed', () => {
    const manifest = manager.importLocalSkill({
      skillPath: writeSkill(path.join(testRoot, 'fixtures', 'skills', 'seeded-skill'), {
        name: 'seeded-skill',
        description: 'Needs workspace fixtures',
      }),
    });
    writeJson(path.join(testRoot, 'fixtures', 'workspace-seed', 'employee_data.json'), { name: 'Sarah Chen' });
    writeText(path.join(testRoot, 'fixtures', 'workspace-seed', 'nested', 'template.txt'), 'hello {{NAME}}');

    const runtime = manager.prepareCleanRuntime({
      runId: 'clean-base-skill-seeded',
      reviewMode: 'base_skill',
      subjectId: manifest.subject_id,
      workspaceSeedPath: 'fixtures/workspace-seed',
    });

    assert.ok(fs.existsSync(path.join(runtime.roots.workspace_root, 'employee_data.json')));
    assert.ok(fs.existsSync(path.join(runtime.roots.workspace_root, 'nested', 'template.txt')));
    assert.deepStrictEqual(runtime.copied.workspace_seed, {
      source: 'fixtures/workspace-seed',
      file_count: 2,
    });
    const runtimeJson = JSON.parse(fs.readFileSync(path.join(testRoot, 'arena', 'runs', 'clean-base-skill-seeded', 'clean-runtime.json'), 'utf-8'));
    assert.strictEqual(runtimeJson.copied.workspace_seed.file_count, 2);
  });

  test('prepares a clean role_skill runtime with the immutable subject as the uniquely loaded Skill', async () => {
    const manifest = manager.importLocalSkill({
      skillPath: writeSkill(path.join(testRoot, 'fixtures', 'skills', 'patch-helper'), {
        name: 'patch-helper',
        description: 'Helps patch files',
      }),
    });

    const runtime = manager.prepareCleanRuntime({
      runId: 'clean-role-skill',
      reviewMode: 'role_skill',
      subjectId: manifest.subject_id,
      targetRoleId: 'engineer',
    });

    assert.strictEqual(runtime.target_profile.active_role_id, 'engineer-cat');
    assert.strictEqual(runtime.target_profile.subject_skill_id, 'patch-helper');
    assert.ok(fs.existsSync(path.join(runtime.roots.skills_root, 'patch-helper', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(runtime.roots.roles_root, 'engineer-cat', 'role.json')));
    assert.ok(fs.existsSync(path.join(runtime.roots.roles_root, 'engineer-cat', 'skills', 'engineer-helper', 'SKILL.md')));
    assert.deepStrictEqual(runtime.launch.command.slice(-2), ['--role', 'engineer-cat']);
    assert.strictEqual(runtime.copied.role, 'roles/engineer-cat');
    assert.strictEqual(runtime.copied.subject_skill, 'skills/patch-helper');
    assert.strictEqual(runtime.sandbox.subject_root, path.join(runtime.roots.run_root, 'skills', 'patch-helper'));

    process.env.XIAOBA_PROJECT_ROOT = testRoot;
    process.env.XIAOBA_SKILLS_ROOT = runtime.roots.skills_root;
    process.env.XIAOBA_ROLES_ROOT = runtime.roots.roles_root;
    const skillManager = new SkillManager('engineer-cat');
    await skillManager.loadSkills();
    const loadedSubject = skillManager.getSkill('patch-helper');
    assert.ok(loadedSubject);
    assert.strictEqual(
      path.resolve(loadedSubject.filePath),
      path.join(runtime.roots.skills_root, 'patch-helper', 'SKILL.md'),
    );
    assert.strictEqual(
      fingerprintArenaDirectory(path.dirname(loadedSubject.filePath)),
      manifest.fingerprint,
    );
  });

  test('copies shared assurance roles into every clean lightweight Arena runtime', () => {
    for (const roleName of ['user-cat', 'inspector-cat', 'reviewer-cat']) {
      writeRole(testRoot, roleName, {
        name: roleName,
        displayName: roleName,
        description: `${roleName} support role`,
        promptFile: 'system.md',
      });
    }
    const manifest = manager.importLocalSkill({
      skillPath: writeSkill(path.join(testRoot, 'fixtures', 'skills', 'assurance-subject'), {
        name: 'assurance-subject',
        description: 'Subject for the shared Arena workflow',
      }),
    });

    const runtime = manager.prepareCleanRuntime({
      runId: 'clean-shared-assurance',
      reviewMode: 'base_skill',
      subjectId: manifest.subject_id,
    });

    assert.deepStrictEqual(
      runtime.copied.support_roles,
      ['user-cat', 'inspector-cat', 'reviewer-cat'],
    );
    for (const roleName of runtime.copied.support_roles || []) {
      assert.ok(fs.existsSync(path.join(runtime.roots.roles_root, roleName, 'role.json')));
    }
  });

  test('rejects role_skill when a same-name role-local Skill could impersonate the subject', () => {
    const manifest = manager.importLocalSkill({
      skillPath: writeSkill(path.join(testRoot, 'fixtures', 'skills', 'identity-bound'), {
        name: 'identity-bound',
        description: 'Immutable Arena subject',
        body: 'SUBJECT SNAPSHOT',
      }),
    });
    writeSkill(path.join(testRoot, 'roles', 'engineer-cat', 'skills', 'imposter'), {
      name: 'Identity-Bound',
      description: 'Same-name role-local imposter',
      body: 'ROLE LOCAL IMPOSTER',
    });

    assert.throws(
      () => manager.prepareCleanRuntime({
        runId: 'role-skill-name-collision',
        reviewMode: 'role_skill',
        subjectId: manifest.subject_id,
        targetRoleId: 'engineer-cat',
      }),
      /conflicts with target role-local Skill "Identity-Bound"; Arena cannot prove the mounted subject identity/,
    );
    assert.strictEqual(
      fs.existsSync(path.join(testRoot, 'arena', 'runs', 'role-skill-name-collision', 'clean-runtime.json')),
      false,
    );
  });

  test('prepares a clean role runtime from the role subject snapshot', () => {
    const manifest = manager.snapshotRole({ roleId: 'engineer-cat' });

    const runtime = manager.prepareCleanRuntime({
      runId: 'clean-role',
      reviewMode: 'role',
      subjectId: manifest.subject_id,
      targetRoleId: 'engineer-cat',
    });

    assert.strictEqual(runtime.review_mode, 'role');
    assert.strictEqual(runtime.target_profile.active_role_id, 'engineer-cat');
    assert.strictEqual(runtime.copied.subject_skill, undefined);
    assert.strictEqual(runtime.copied.role, 'roles/engineer-cat');
    assert.strictEqual(runtime.sandbox.subject_root, path.join(runtime.roots.run_root, 'roles', 'engineer-cat'));
    assert.ok(fs.existsSync(path.join(runtime.roots.roles_root, 'engineer-cat', 'role.json')));
    assert.ok(fs.existsSync(path.join(runtime.roots.roles_root, 'engineer-cat', 'skills', 'engineer-helper', 'SKILL.md')));
    assert.ok(!fs.existsSync(path.join(runtime.roots.skills_root, 'engineer-helper', 'SKILL.md')));
  });

});

function writeBaseSkills(root: string): void {
  for (const skill of DEFAULT_PACKAGED_BASE_SKILLS) {
    writeSkill(path.join(root, 'skills', skill), {
      name: skill,
      description: `${skill} base skill`,
    });
  }
}

function writeSkill(
  dirPath: string,
  input: { name: string; description: string; body?: string },
): string {
  fs.mkdirSync(dirPath, { recursive: true });
  const skillPath = path.join(dirPath, 'SKILL.md');
  fs.writeFileSync(skillPath, [
    '---',
    `name: ${input.name}`,
    `description: ${input.description}`,
    '---',
    '',
    input.body || 'Use evidence.',
    '',
  ].join('\n'), 'utf-8');
  return skillPath;
}

function writeRole(root: string, roleName: string, config: Record<string, unknown>): void {
  const roleDir = path.join(root, 'roles', roleName);
  fs.mkdirSync(path.join(roleDir, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(roleDir, 'role.json'), JSON.stringify(config, null, 2), 'utf-8');
  fs.writeFileSync(path.join(roleDir, 'prompts', 'system.md'), 'Role prompt.', 'utf-8');
}

function writeJson(filePath: string, value: unknown): void {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf-8');
}

function snapshotDirectory(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        snapshot[path.relative(root, fullPath).replace(/\\/g, '/')] = fs.readFileSync(fullPath).toString('base64');
      }
    }
  };
  visit(root);
  return snapshot;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (typeof value === 'string') {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}
