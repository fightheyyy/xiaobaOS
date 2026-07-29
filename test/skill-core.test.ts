import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SkillExecutor } from '../src/skills/skill-executor';
import { SkillParser } from '../src/skills/skill-parser';
import {
  buildSkillActivationSignal,
  buildSkillSystemPrompt,
  parseSkillActivationSignal,
  upsertSkillSystemMessage,
} from '../src/skills/skill-activation-protocol';
import { Message, Skill } from '../src/types';

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

describe('SkillParser and SkillExecutor', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-core-'));
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('parses XiaoBa frontmatter and defaults invocability flags to true', () => {
    const skillPath = path.join(testRoot, 'skills', 'demo', 'SKILL.md');
    writeFile(skillPath, `---
name: demo-skill
description: Demo skill
aliases:
  - demo
argument-hint: <topic>
max-turns: 5
---

Use $ARGUMENTS.
`);

    const skill = SkillParser.parse(skillPath);

    assert.strictEqual(skill.metadata.name, 'demo-skill');
    assert.strictEqual(skill.metadata.description, 'Demo skill');
    assert.deepStrictEqual(skill.metadata.aliases, ['demo']);
    assert.strictEqual(skill.metadata.argumentHint, '<topic>');
    assert.strictEqual(skill.metadata.userInvocable, true);
    assert.strictEqual(skill.metadata.autoInvocable, true);
    assert.strictEqual(skill.metadata.maxTurns, 5);
    assert.strictEqual(skill.content, 'Use $ARGUMENTS.');
  });

  test('ignores obsolete lifecycle frontmatter', () => {
    for (const legacyStatus of ['candidate', 'active', 'blocked', 'custom']) {
      const skillPath = path.join(testRoot, 'skills', legacyStatus, 'SKILL.md');
      writeFile(skillPath, `---
name: ${legacyStatus}-skill
description: Legacy metadata should not control runtime loading
status: ${legacyStatus}
---

Legacy content.
`);
      const skill = SkillParser.parse(skillPath);
      assert.strictEqual(skill.metadata.name, `${legacyStatus}-skill`);
      assert.strictEqual(Object.hasOwn(skill.metadata, 'status'), false);
    }
  });

  test('parses the optional Arena output line contract and rejects malformed declarations', () => {
    const strictPath = path.join(testRoot, 'skills', 'strict-output', 'SKILL.md');
    writeFile(strictPath, `---
name: strict-output
description: Strict Arena output
arena-output-line-prefixes:
  - "MEOW_RESULT::"
  - "MEOW_EVIDENCE::"
---

Return two lines.
`);
    assert.deepStrictEqual(
      SkillParser.parse(strictPath).metadata.arenaOutputLinePrefixes,
      ['MEOW_RESULT::', 'MEOW_EVIDENCE::'],
    );

    const emptyPath = path.join(testRoot, 'skills', 'empty-output', 'SKILL.md');
    writeFile(emptyPath, `---
name: empty-output
description: Invalid empty Arena output contract
arena-output-line-prefixes: []
---

Invalid.
`);
    assert.throws(
      () => SkillParser.parse(emptyPath),
      /expected a non-empty string list/,
    );

    const duplicatePath = path.join(testRoot, 'skills', 'duplicate-output', 'SKILL.md');
    writeFile(duplicatePath, `---
name: duplicate-output
description: Invalid duplicate Arena output contract
arena-output-line-prefixes:
  - "ROW::"
  - "ROW::"
---

Invalid.
`);
    assert.throws(
      () => SkillParser.parse(duplicatePath),
      /prefixes must be unique/,
    );
  });

  test('parses Claude-style invocable metadata', () => {
    const skillPath = path.join(testRoot, 'skills', 'agent-only', 'SKILL.md');
    writeFile(skillPath, `---
name: agent-only
description: Agent-only skill
invocable: user
autoInvocable: false
argument-hint: <query>
---

Agent content.
`);

    const skill = SkillParser.parse(skillPath);

    assert.strictEqual(skill.metadata.userInvocable, true);
    assert.strictEqual(skill.metadata.autoInvocable, false);
    assert.strictEqual(skill.metadata.argumentHint, '<query>');
  });

  test('rejects skill files without required metadata', () => {
    const skillPath = path.join(testRoot, 'skills', 'broken', 'SKILL.md');
    writeFile(skillPath, `---
name: broken
---

Missing description.
`);

    assert.throws(
      () => SkillParser.parse(skillPath),
      /Missing required fields/,
    );
  });

  test('expands skill placeholders from invocation context', () => {
    const skillPath = path.join(testRoot, 'skills', 'demo', 'SKILL.md');
    const skill: Skill = {
      metadata: {
        name: 'demo',
        description: 'Demo',
      },
      content: [
        'dir=<SKILL_DIR>',
        'name=$0',
        'args=$ARGUMENTS',
        'first=$1',
        'second=$2',
        'missing=$3',
      ].join('\n'),
      filePath: skillPath,
    };

    const output = SkillExecutor.execute(skill, {
      skillName: 'demo',
      arguments: ['alpha', 'beta'],
      rawArguments: 'alpha beta',
      userMessage: '/demo alpha beta',
    });

    assert.match(output, new RegExp(`dir=${path.dirname(skillPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(output, /name=demo/);
    assert.match(output, /args=alpha beta/);
    assert.match(output, /first=alpha/);
    assert.match(output, /second=beta/);
    assert.match(output, /missing=/);
  });
});

describe('skill activation protocol', () => {
  const skill: Skill = {
    metadata: {
      name: 'review-helper',
      description: 'Review helper',
      maxTurns: 7,
    },
    content: 'Review $ARGUMENTS for $1.',
    filePath: path.join('/tmp', 'review-helper', 'SKILL.md'),
  };

  test('builds and parses activation signals with maxTurns', () => {
    const signal = buildSkillActivationSignal(skill, {
      skillName: 'review-helper',
      arguments: ['src'],
      rawArguments: 'src',
      userMessage: '/review-helper src',
    });

    assert.strictEqual(signal.__type__, 'skill_activation');
    assert.strictEqual(signal.skillName, 'review-helper');
    assert.strictEqual(signal.maxTurns, 7);
    assert.match(signal.prompt, /Review src for src/);

    const parsed = parseSkillActivationSignal(JSON.stringify(signal));
    assert.deepStrictEqual(parsed, signal);
  });

  test('rejects malformed activation payloads', () => {
    assert.strictEqual(parseSkillActivationSignal('not json'), null);
    assert.strictEqual(parseSkillActivationSignal(JSON.stringify({ __type__: 'other' })), null);
    assert.strictEqual(parseSkillActivationSignal(JSON.stringify({
      __type__: 'skill_activation',
      skillName: '',
      prompt: 'x',
    })), null);
    assert.strictEqual(parseSkillActivationSignal(JSON.stringify({
      __type__: 'skill_activation',
      skillName: 'demo',
      prompt: 123,
    })), null);
  });

  test('upserts one system message per skill name and keeps other skills intact', () => {
    const messages: Message[] = [
      { role: 'system', content: 'base prompt' },
      { role: 'system', content: '[skill:review-helper]\nold prompt' },
      { role: 'system', content: '[skill:other]\nother prompt' },
      { role: 'user', content: 'hello' },
    ];

    const inserted = upsertSkillSystemMessage(messages, {
      __type__: 'skill_activation',
      skillName: 'review-helper',
      prompt: 'new prompt',
    });

    assert.deepStrictEqual(inserted, {
      role: 'system',
      content: '[skill:review-helper]\nnew prompt',
    });
    assert.strictEqual(messages.filter(msg =>
      msg.role === 'system'
      && typeof msg.content === 'string'
      && msg.content.startsWith('[skill:review-helper]'),
    ).length, 1);
    assert.ok(messages.some(msg => msg.content === '[skill:other]\nother prompt'));
    assert.strictEqual(messages[messages.length - 1].content, buildSkillSystemPrompt({
      __type__: 'skill_activation',
      skillName: 'review-helper',
      prompt: 'new prompt',
    }));
  });
});
