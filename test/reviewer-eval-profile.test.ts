import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('ReviewerCat shared Judge role', () => {
  const root = process.cwd();

  test('runtime prompt includes the lightweight Judge lenses', () => {
    const prompt = fs.readFileSync(
      path.join(root, 'roles', 'reviewer-cat', 'prompts', 'reviewer-system-prompt.md'),
      'utf-8',
    );

    for (const lens of [
      'task-fit',
      'evidence',
      'safety',
      'runtime',
      'recovery',
      'Durable Session',
      'Working Trace',
      'Provider Transcript',
    ]) {
      assert.match(prompt, new RegExp(lens));
    }
  });

  test('prompt and case-review Skill enforce the shared read-only Judge boundary', () => {
    const prompt = fs.readFileSync(
      path.join(root, 'roles', 'reviewer-cat', 'prompts', 'reviewer-system-prompt.md'),
      'utf-8',
    );
    const skill = fs.readFileSync(
      path.join(root, 'roles', 'reviewer-cat', 'skills', 'case-review', 'SKILL.md'),
      'utf-8',
    );
    const role = JSON.parse(fs.readFileSync(
      path.join(root, 'roles', 'reviewer-cat', 'role.json'),
      'utf-8',
    ));

    for (const content of [prompt, skill]) {
      assert.match(content, /独立 Session/);
      assert.match(content, /只读/);
      assert.match(content, /Oracle/);
      assert.match(content, /全部.*Trace/);
      assert.match(content, /pass\s*\|\s*fail\s*\|\s*blocked/);
      assert.match(content, /"version":\s*1/);
      assert.match(content, /"decisions"/);
      assert.match(content, /"run_id"/);
      assert.match(content, /"status"/);
      assert.match(content, /"evidence_refs"/);
      assert.match(content, /不.*Finding|不生成 Finding/);
      assert.match(content, /不.*激活|不激活/);
      assert.doesNotMatch(content, /codex_job_/);
      assert.doesNotMatch(content, /"nextState"\s*:/);
      assert.doesNotMatch(content, /"recommendedNextOwner"\s*:/);
    }

    assert.match(skill, /^version: 2\.0\.0$/m);
    assert.match(skill, /不负责执行 Case/);
    assert.match(role.description, /共享 Agentic Judge/);
    assert.match(role.description, /pass\/fail\/blocked/);
  });
});
