import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRoleAwareToolManager } from '../src/bootstrap/tool-manager';
import { DEFAULT_BUNDLED_ROLES } from '../src/roles/role-manager';
import { SkillManager } from '../src/skills/skill-manager';
import { MemoryFinalizer } from '../src/utils/memory-finalizer';

describe('EvolutionCat role', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-evolution-cat-'));
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('is the eighth bundled role and exclusively owns the evolution skills', async () => {
    assert.equal(DEFAULT_BUNDLED_ROLES.length, 8);
    assert.ok(DEFAULT_BUNDLED_ROLES.includes('evolution-cat'));

    const baseSkills = new SkillManager();
    await baseSkills.loadSkills();
    assert.deepEqual(baseSkills.getAllSkills().map(skill => skill.metadata.name), []);

    const evolutionSkills = new SkillManager('evolution-cat');
    await evolutionSkills.loadSkills();
    assert.deepEqual(
      evolutionSkills.getAllSkills().map(skill => skill.metadata.name).sort(),
      ['role-publish', 'self-evolution', 'skill-publish'],
    );
    assert.equal(evolutionSkills.getSkill('remember'), undefined);

    const engineerSkills = new SkillManager('engineer-cat');
    await engineerSkills.loadSkills();
    const engineerSkillNames = engineerSkills.getAllSkills().map(skill => skill.metadata.name);
    assert.equal(engineerSkillNames.includes('self-evolution'), false);
    assert.equal(engineerSkillNames.includes('skill-publish'), false);
    assert.equal(engineerSkillNames.includes('role-publish'), false);
  });

  test('registers deterministic memory only for EvolutionCat; harvest belongs to the runtime DAG', () => {
    assert.equal(createRoleAwareToolManager(testRoot).getTool('remember'), undefined);
    assert.equal(createRoleAwareToolManager(testRoot, {}, 'engineer-cat').getTool('remember'), undefined);
    assert.ok(createRoleAwareToolManager(testRoot, {}, 'evolution-cat').getTool('remember'));
    assert.equal(createRoleAwareToolManager(testRoot).getTool('evolution_observe'), undefined);
    assert.equal(createRoleAwareToolManager(testRoot, {}, 'engineer-cat').getTool('evolution_observe'), undefined);
    assert.equal(createRoleAwareToolManager(testRoot, {}, 'evolution-cat').getTool('evolution_observe'), undefined);
  });

  test('remember writes and updates one deterministic session-person record', async () => {
    const manager = createRoleAwareToolManager(
      testRoot,
      {
        roleName: 'evolution-cat',
        sessionId: 'subagent:temporary-evolution-worker',
        parentSessionId: 'pet:xiaoba:user-42',
      },
      'evolution-cat',
    );

    const first = await manager.executeTool({
      id: 'remember-1',
      type: 'function',
      function: {
        name: 'remember',
        arguments: JSON.stringify({ content: '默认用中文回复', kind: 'preference' }),
      },
    });
    assert.equal(first.status, 'success');
    assert.match(String(first.content), /"action": "created"/);
    assert.deepEqual(first.artifact_manifest?.map(item => item.path), [
      `memory/sessions/${MemoryFinalizer.hashSessionKey('pet:xiaoba:user-42')}/MEMORY.md`,
    ]);
    assert.equal(first.artifact_manifest?.[0]?.metadata?.source, 'tool_owned');

    const second = await manager.executeTool({
      id: 'remember-2',
      type: 'function',
      function: {
        name: 'remember',
        arguments: JSON.stringify({ content: '默认用中文回复', kind: 'preference' }),
      },
    });
    assert.equal(second.status, 'success');
    assert.match(String(second.content), /"action": "updated"/);

    const memory = MemoryFinalizer.loadSessionMemory('pet:xiaoba:user-42', testRoot);
    assert.ok(memory);
    assert.equal(memory?.records.length, 1);
    assert.equal(memory?.records[0].kind, 'preference');
    assert.equal(memory?.records[0].text, '用户希望默认用中文回复。');
    assert.equal(
      MemoryFinalizer.loadSessionMemory('subagent:temporary-evolution-worker', testRoot),
      null,
    );
  });

  test('remember returns structured failures for invalid runtime input', async () => {
    const manager = createRoleAwareToolManager(testRoot, { roleName: 'evolution-cat' }, 'evolution-cat');
    const missingSession = await manager.executeTool({
      id: 'remember-invalid-1',
      type: 'function',
      function: {
        name: 'remember',
        arguments: JSON.stringify({ content: '记住这个' }),
      },
    });
    assert.equal(missingSession.status, 'failure');
    assert.equal(missingSession.error_code, 'SESSION_ID_REQUIRED');

    const invalidKind = await manager.executeTool({
      id: 'remember-invalid-2',
      type: 'function',
      function: {
        name: 'remember',
        arguments: JSON.stringify({ content: '记住这个', kind: 'temporary' }),
      },
    }, undefined, { sessionId: 'session-valid' });
    assert.equal(invalidKind.status, 'failure');
    assert.equal(invalidKind.error_code, 'INVALID_TOOL_ARGUMENTS');
  });

  test('remember corrects and forgets only records belonging to the trusted parent session', async () => {
    const saved = MemoryFinalizer.remember('owner', '喜欢咖啡', { rootDir: testRoot });
    MemoryFinalizer.remember('other', '喜欢果汁', { rootDir: testRoot });
    const manager = createRoleAwareToolManager(testRoot, {
      roleName: 'evolution-cat', sessionId: 'worker', parentSessionId: 'owner',
    }, 'evolution-cat');
    const correction = await manager.executeTool({
      id: 'correct', type: 'function', function: {
        name: 'remember', arguments: JSON.stringify({ content: '喜欢茶', replaces: saved.record.id }),
      },
    });
    assert.equal(correction.status, 'success');
    const payload = JSON.parse(String(correction.content));
    assert.equal(payload.action, 'updated');
    assert.deepEqual(MemoryFinalizer.loadSessionMemory('owner', testRoot)?.records.map(record => record.text), ['用户记忆：喜欢茶。']);
    const forgotten = await manager.executeTool({
      id: 'forget', type: 'function', function: {
        name: 'remember', arguments: JSON.stringify({ action: 'forget', record_id: payload.record_id }),
      },
    });
    assert.equal(forgotten.status, 'success');
    assert.equal(JSON.parse(String(forgotten.content)).action, 'forgotten');
    assert.equal(forgotten.artifact_manifest?.[0]?.action, 'updated');
    assert.deepEqual(MemoryFinalizer.loadSessionMemory('owner', testRoot)?.records, []);
    assert.equal(MemoryFinalizer.loadSessionMemory('other', testRoot)?.records.length, 1);
    assert.equal(MemoryFinalizer.loadSessionMemory('worker', testRoot), null);
  });
});
