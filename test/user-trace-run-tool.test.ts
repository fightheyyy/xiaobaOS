import { after, afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_BUNDLED_ROLES } from '../src/roles/role-manager';
import { getRoleSpecificToolsForRole } from '../src/roles/runtime-role-registry';
import { UserTraceRunTool } from '../src/roles/user-cat/tools/user-trace-run-tool';
import { SkillManager } from '../src/skills/skill-manager';
import { ToolManager } from '../src/tools/tool-manager';
import { Message } from '../src/types';
import { RoleResolver } from '../src/utils/role-resolver';

const originalCwd = process.cwd();
const originalAppRoot = process.env.XIAOBA_APP_ROOT;
const originalRolesRoot = process.env.XIAOBA_ROLES_ROOT;
const originalRole = process.env.XIAOBA_ROLE;
const originalCurrentRole = process.env.CURRENT_ROLE;
const originalCurrentRoleDisplayName = process.env.CURRENT_ROLE_DISPLAY_NAME;

class FakeTargetRoleAIService {
  requests: Message[][] = [];

  async chatStream(messages: Message[], _tools?: unknown, callbacks?: { onText?: (text: string) => void }) {
    this.requests.push(messages.map(message => ({ ...message })));
    const lastUser = [...messages].reverse().find(message => message.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : '[non-text]';
    const content = `TargetRole turn ${this.requests.length}: 我看到了 "${text}"。证据路径 output/demo.log，当前只是候选 trace。`;
    callbacks?.onText?.(content);
    return {
      content,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }

  async chat() {
    return {
      content: 'summary',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}

describe('UserTraceRunTool', () => {
  let testRoot: string;

  beforeEach(() => {
    RoleResolver.clearActiveRole();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-user-trace-'));
    process.chdir(testRoot);
    process.env.XIAOBA_APP_ROOT = originalCwd;
    delete process.env.XIAOBA_ROLES_ROOT;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(testRoot, { recursive: true, force: true });
    RoleResolver.clearActiveRole();
  });

  after(() => {
    process.chdir(originalCwd);
    restoreEnv('XIAOBA_APP_ROOT', originalAppRoot);
    restoreEnv('XIAOBA_ROLES_ROOT', originalRolesRoot);
    restoreEnv('XIAOBA_ROLE', originalRole);
    restoreEnv('CURRENT_ROLE', originalCurrentRole);
    restoreEnv('CURRENT_ROLE_DISPLAY_NAME', originalCurrentRoleDisplayName);
  });

  test('runs Dashboard Chat multi-turn dialogue against target role and writes candidate package', async () => {
    const fakeAI = new FakeTargetRoleAIService();
    const tool = createToolWithFakeAI(fakeAI, () => 'trace-run-001');

    const output = await tool.execute({
      cwd: '.',
      target_role: 'engineer-cat',
      run_id: 'trace-run-001',
      seed: {
        version: 1,
        seed_id: 'seed.engineer.low-info.001',
        source: 'manual_template',
        target_role: 'engineer-cat',
        task_summary: '用户说 CLI 命令坏了，但不知道哪次改坏的。',
        risk_tags: ['ambiguous_bug', 'evidence_pressure'],
        owner_review_required: false,
      },
      role_intent_map: {
        target_role: 'engineer-cat',
        role_exists_to: ['turn vague engineering requests into verified changes'],
      },
      persona: {
        background: '低信息项目 owner',
        does_not_know: ['怎么跑测试', 'role 边界'],
      },
      scenario_plan: {
        opening_message: '这个命令坏了，我不知道哪次改坏的。',
      },
      messages: [
        '这个命令坏了，我不知道哪次改坏的，你自己看一下。',
        '所以现在到底能用了吗？我怎么看结果？',
        '你说修好了的话，证据在哪？路径或者日志给我。',
      ],
    }, {
      workingDirectory: testRoot,
      conversationHistory: [],
      roleName: 'user-cat',
    });

    assert.match(output, /user_trace_run: status=completed/);
    assert.match(output, /target_role=engineer-cat/);
    assert.match(output, /entrypoint=dashboard_chat/);
    assert.match(output, /session_key=pet:xiaoba:role-engineer-cat:usercat-simulation-trace-run-001/);
    assert.match(output, /turn_count=3/);
    assert.equal(fakeAI.requests.length, 3);

    const artifactManifest = tool.getArtifactManifest?.({}, output, {
      workingDirectory: testRoot,
      conversationHistory: [],
      roleName: 'user-cat',
    }) ?? [];
    assert.deepEqual(artifactManifest.map(item => [item.path, item.action, item.metadata?.artifact_role]), [
      ['data/user-cat/traces/trace-run-001/trace.jsonl', 'captured', 'raw_trace'],
      ['data/chat/sessions/pet_xiaoba_role-engineer-cat_usercat-simulation-trace-run-001.jsonl', 'captured', 'native_visible_history'],
      ['output/user-cat/candidates/trace-run-001/seed.json', 'created', 'seed_metadata'],
      ['output/user-cat/candidates/trace-run-001/role-intent-map.json', 'created', 'role_intent_map'],
      ['output/user-cat/candidates/trace-run-001/persona.json', 'created', 'persona_metadata'],
      ['output/user-cat/candidates/trace-run-001/scenario-plan.json', 'created', 'scenario_plan'],
      ['output/user-cat/candidates/trace-run-001/candidate-case.json', 'created', 'candidate_case'],
      ['output/user-cat/candidates/trace-run-001/trace-quality-self-check.json', 'created', 'self_check'],
      ['output/user-cat/candidates/trace-run-001/manifest.json', 'created', 'candidate_manifest'],
      ['output/user-cat/candidates/trace-run-001/dialogue-summary.md', 'created', 'dialogue_summary'],
    ]);
    assert.ok(!artifactManifest.some(item => path.isAbsolute(item.path)));

    const firstSystem = fakeAI.requests[0].find(message => message.role === 'system');
    assert.match(String(firstSystem?.content || ''), /EngineerCat|工程猫|PochiBa/);

    const tracePath = path.join(testRoot, 'data', 'user-cat', 'traces', 'trace-run-001', 'trace.jsonl');
    const candidateDir = path.join(testRoot, 'output', 'user-cat', 'candidates', 'trace-run-001');
    const candidateCasePath = path.join(candidateDir, 'candidate-case.json');
    const selfCheckPath = path.join(candidateDir, 'trace-quality-self-check.json');
    const summaryPath = path.join(candidateDir, 'dialogue-summary.md');

    assert.ok(fs.existsSync(tracePath));
    assert.ok(fs.existsSync(candidateCasePath));
    assert.ok(fs.existsSync(selfCheckPath));
    assert.ok(fs.existsSync(summaryPath));

    const traceLines = fs.readFileSync(tracePath, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(traceLines.filter(event => event.type === 'user_turn').length, 3);
    assert.equal(traceLines.filter(event => event.type === 'assistant_turn').length, 3);
    assert.equal(traceLines[0].entrypoint, 'dashboard_chat');
    assert.ok(traceLines.some(event => event.type === 'surface_event' && event.event?.type === 'user_message'));

    const candidateCase = JSON.parse(fs.readFileSync(candidateCasePath, 'utf-8'));
    assert.equal(candidateCase.target_role, 'engineer-cat');
    assert.equal(candidateCase.entrypoint, 'dashboard_chat');
    assert.equal(candidateCase.native_session_key, 'pet:xiaoba:role-engineer-cat:usercat-simulation-trace-run-001');
    assert.equal(candidateCase.native_visible_history_path, 'data/chat/sessions/pet_xiaoba_role-engineer-cat_usercat-simulation-trace-run-001.jsonl');
    assert.equal(candidateCase.source_seed_id, 'seed.engineer.low-info.001');
    assert.equal(candidateCase.turn_count, 3);
    assert.equal(candidateCase.recommended_next_owner, 'inspector-cat');
    assert.equal(candidateCase.replay_readiness, 'needs_verifier');
    assert.equal(candidateCase.curation_status, 'not_curated');
    assert.equal(candidateCase.benchmark_acceptance, 'forbidden_until_curated');
    assert.equal(candidateCase.owner_review_required, false);
    assert.ok(!path.isAbsolute(candidateCase.trace_path));

    const selfCheck = JSON.parse(fs.readFileSync(selfCheckPath, 'utf-8'));
    assert.equal(selfCheck.multi_turn_pressure, true);
    assert.equal(selfCheck.evidence_pressure, true);
    assert.equal(selfCheck.curation_required, true);
    assert.equal(selfCheck.benchmark_acceptance, 'forbidden_until_curated');
    assert.equal(selfCheck.worth_inspector_intake, true);

    const manifest = JSON.parse(fs.readFileSync(path.join(candidateDir, 'manifest.json'), 'utf-8'));
    assert.equal(manifest.curation_status, 'not_curated');
    assert.equal(manifest.benchmark_acceptance, 'forbidden_until_curated');
    assert.ok(!path.isAbsolute(manifest.trace_path));
    assert.equal(manifest.entrypoint, 'dashboard_chat');
    assert.equal(manifest.session_key, 'pet:xiaoba:role-engineer-cat:usercat-simulation-trace-run-001');
    assert.equal(manifest.visible_history_path, 'data/chat/sessions/pet_xiaoba_role-engineer-cat_usercat-simulation-trace-run-001.jsonl');
    assert.ok(!('cwd' in manifest));
    assert.ok(manifest.artifacts.some((item: { path: string }) => item.path === 'candidate-case.json'));

    const visibleHistoryPath = path.join(testRoot, 'data', 'chat', 'sessions', 'pet_xiaoba_role-engineer-cat_usercat-simulation-trace-run-001.jsonl');
    assert.ok(fs.existsSync(visibleHistoryPath), 'dashboard chat visible history should be written by native surface');
    const visibleEvents = fs.readFileSync(visibleHistoryPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    assert.equal(visibleEvents.filter(event => event.type === 'user_message').length, 3);
    assert.ok(visibleEvents.every(event => event.sessionKey === 'pet:xiaoba:role-engineer-cat:usercat-simulation-trace-run-001'));
    assert.ok(visibleEvents.some(event => event.source === 'dashboard'));

    const petTraceFiles = collectFiles(path.join(testRoot, 'logs', 'sessions', 'pet'))
      .filter(file => file.endsWith('traces.jsonl'));
    assert.ok(petTraceFiles.length > 0, 'native pet session traces should be written');
    const nativeTraceEntries = petTraceFiles.flatMap(file => fs.readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line)));
    assert.equal(nativeTraceEntries.filter(entry => entry.entry_type === 'trace').length, 3);
    assert.ok(nativeTraceEntries.every(entry => entry.session_type === 'pet'));
    assert.ok(nativeTraceEntries.every(entry => entry.session_id === 'pet:xiaoba:role-engineer-cat:usercat-simulation-trace-run-001'));
    assert.ok(!fs.existsSync(path.join(testRoot, 'logs', 'sessions', 'user-cat')), 'target run should not create user-cat native session logs');
  });

  test('sanitizes candidate overrides that would mark benchmark acceptance', async () => {
    const fakeAI = new FakeTargetRoleAIService();
    const tool = createToolWithFakeAI(fakeAI, () => 'trace-run-sanitized');

    await tool.execute({
      cwd: '.',
      target_role: 'engineer-cat',
      run_id: 'trace-run-sanitized',
      messages: [
        '这个命令坏了，你先看看。',
        '所以证据是什么？',
        '我漏说了，别动无关文件。',
      ],
      candidate_case: {
        replay_readiness: 'accepted',
        recommended_next_owner: 'engineer-cat',
        curation_status: 'accepted',
        benchmark_acceptance: 'accepted',
      },
    }, {
      workingDirectory: testRoot,
      conversationHistory: [],
      roleName: 'user-cat',
    });

    const candidateCasePath = path.join(testRoot, 'output', 'user-cat', 'candidates', 'trace-run-sanitized', 'candidate-case.json');
    const candidateCase = JSON.parse(fs.readFileSync(candidateCasePath, 'utf-8'));
    assert.equal(candidateCase.replay_readiness, 'needs_verifier');
    assert.equal(candidateCase.recommended_next_owner, 'inspector-cat');
    assert.equal(candidateCase.curation_status, 'not_curated');
    assert.equal(candidateCase.benchmark_acceptance, 'forbidden_until_curated');
  });

  test('keeps long Arena run ids on distinct Dashboard Chat sessions', async () => {
    const runIds = [
      'evolution-2026-07-15-evo-closeout-v1-base-fix-usercat-1',
      'evolution-2026-07-15-evo-closeout-v1-base-fix-usercat-2',
    ];
    const sessionKeys: string[] = [];

    for (const runId of runIds) {
      const fakeAI = new FakeTargetRoleAIService();
      const tool = createToolWithFakeAI(fakeAI, () => runId);
      const output = await tool.execute({
        cwd: '.',
        target_role: 'engineer-cat',
        run_id: runId,
        messages: ['请检查这个独立 Arena 场景。'],
        max_turns: 1,
      }, {
        workingDirectory: testRoot,
        conversationHistory: [],
        roleName: 'user-cat',
      });
      const sessionKey = output.match(/^session_key=(.+)$/m)?.[1];
      assert.ok(sessionKey);
      sessionKeys.push(sessionKey);
    }

    assert.notEqual(sessionKeys[0], sessionKeys[1]);
    assert.ok(sessionKeys.every(sessionKey => /-[a-f0-9]{16}$/.test(sessionKey)));
  });

  test('Arena-only subject mount injects the same Skill into every Dashboard Chat turn', async () => {
    writeTestSkill(testRoot, 'arena-pinned-skill');
    const fakeAI = new FakeTargetRoleAIService();
    const tool = createToolWithFakeAI(
      fakeAI,
      () => 'trace-run-arena-pinned',
      undefined,
      'arena-pinned-skill',
    );

    await tool.execute({
      cwd: '.',
      target_role: 'base',
      run_id: 'trace-run-arena-pinned',
      messages: ['先按候选方法处理。', '再确认一次证据。'],
      max_turns: 2,
    }, {
      workingDirectory: testRoot,
      conversationHistory: [],
      roleName: 'user-cat',
    });

    assert.equal(fakeAI.requests.length, 2);
    assert.ok(fakeAI.requests.every(messages => messages.some(message => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.startsWith('[skill:arena-pinned-skill]')
    ))));

    const traceFiles = collectFiles(path.join(testRoot, 'logs', 'sessions', 'pet'))
      .filter(file => file.endsWith('traces.jsonl'));
    const traces = traceFiles.flatMap(file => fs.readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line)))
      .filter(entry => entry.entry_type === 'trace');
    assert.equal(traces.length, 2);
    assert.ok(traces.every(entry => {
      const visibility = Array.isArray(entry.tool_visibility) ? entry.tool_visibility : [];
      return visibility[visibility.length - 1]?.activeSkillName === 'arena-pinned-skill';
    }));
  });

  test('Dashboard Chat does not activate a Skill without the internal Arena mount', async () => {
    writeTestSkill(testRoot, 'arena-unmounted-skill');
    const fakeAI = new FakeTargetRoleAIService();
    const tool = createToolWithFakeAI(fakeAI, () => 'trace-run-arena-unmounted');

    await tool.execute({
      cwd: '.',
      target_role: 'base',
      run_id: 'trace-run-arena-unmounted',
      messages: ['普通消息不应自动选择候选。'],
      max_turns: 1,
      arena_subject_skill_id: 'arena-unmounted-skill',
    }, {
      workingDirectory: testRoot,
      conversationHistory: [],
      roleName: 'user-cat',
    });

    assert.equal(fakeAI.requests.length, 1);
    assert.ok(!fakeAI.requests[0].some(message => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.startsWith('[skill:arena-unmounted-skill]')
    )));
  });

  test('Arena-only subject mount fails closed when the configured Skill is missing', async () => {
    const fakeAI = new FakeTargetRoleAIService();
    const tool = createToolWithFakeAI(
      fakeAI,
      () => 'trace-run-arena-missing',
      undefined,
      'missing-arena-skill',
    );

    await assert.rejects(() => tool.execute({
      cwd: '.',
      target_role: 'base',
      run_id: 'trace-run-arena-missing',
      messages: ['不能回退到裸 Base。'],
      max_turns: 1,
    }, {
      workingDirectory: testRoot,
      conversationHistory: [],
      roleName: 'user-cat',
    }), /Arena subject skill unavailable: missing-arena-skill/);
    assert.equal(fakeAI.requests.length, 0);
  });

  test('adaptive mode chooses each next user turn after observing the previous target turn', async () => {
    const fakeAI = new FakeTargetRoleAIService();
    const plannerInputs: any[] = [];
    const tool = createToolWithFakeAI(fakeAI, () => 'trace-run-adaptive', async () => async input => {
      plannerInputs.push({
        nextTurnIndex: input.nextTurnIndex,
        previousTurns: input.turns.map(turn => ({
          user: turn.user,
          assistant: turn.assistant,
          visibleToUser: turn.visibleToUser,
        })),
      });
      if (input.nextTurnIndex === 2) {
        const visibleReply = input.turns[0].assistant.trim();
        return {
          next_message: visibleReply
            ? `你刚才说的是“${visibleReply.slice(0, 18)}”，那我到底看哪个证据？`
            : '你刚才没给我能看到的结果，那我到底看哪个证据？',
          reason: 'ask for evidence after reading target reply',
        };
      }
      if (input.nextTurnIndex === 3) {
        return {
          next_message: '我漏说了，别改无关东西，你确认一下。',
          reason: 'add a missing constraint based on prior reply',
        };
      }
      return {
        stop: true,
        reason: 'target has enough visible evidence for this candidate trace',
      };
    });

    const output = await tool.execute({
      cwd: '.',
      target_role: 'engineer-cat',
      run_id: 'trace-run-adaptive',
      interaction_mode: 'adaptive',
      max_turns: 4,
      scenario: '我拿到一个 gsap skill，但不知道它能干嘛，帮我直接用一下。',
      messages: [
        '这个 gsap skill 我想直接用，但我也不知道该让它干嘛，你帮我试一下。',
      ],
    }, {
      workingDirectory: testRoot,
      conversationHistory: [],
      roleName: 'user-cat',
    });

    assert.match(output, /interaction_mode=adaptive/);
    assert.match(output, /turn_count=3/);
    assert.equal(fakeAI.requests.length, 3);
    assert.equal(plannerInputs.length, 3);
    assert.equal(plannerInputs[0].nextTurnIndex, 2);
    assert.equal(plannerInputs[0].previousTurns[0].assistant, '');
    assert.equal(plannerInputs[0].previousTurns[0].visibleToUser, false);

    const tracePath = path.join(testRoot, 'data', 'user-cat', 'traces', 'trace-run-adaptive', 'trace.jsonl');
    const traceLines = fs.readFileSync(tracePath, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
    const decisions = traceLines.filter(event => event.type === 'usercat_decision');
    assert.equal(decisions.length, 4);
    assert.equal(decisions[0].source, 'adaptive');
    assert.equal(decisions[3].stop, true);
    assert.match(decisions[1].text, /到底看哪个证据/);

    const candidateCase = JSON.parse(fs.readFileSync(
      path.join(testRoot, 'output', 'user-cat', 'candidates', 'trace-run-adaptive', 'candidate-case.json'),
      'utf-8',
    ));
    assert.equal(candidateCase.interaction_mode, 'adaptive');
    assert.equal(candidateCase.turn_count, 3);

    const selfCheck = JSON.parse(fs.readFileSync(
      path.join(testRoot, 'output', 'user-cat', 'candidates', 'trace-run-adaptive', 'trace-quality-self-check.json'),
      'utf-8',
    ));
    assert.equal(selfCheck.adaptive_interaction, true);
  });

  test('adaptive mode keeps at least two turns even when planner wants to stop early', async () => {
    const fakeAI = new FakeTargetRoleAIService();
    const tool = createToolWithFakeAI(fakeAI, () => 'trace-run-adaptive-min-two', async () => async () => ({
      stop: true,
      reason: 'target already gave visible evidence',
    }));

    const output = await tool.execute({
      cwd: '.',
      target_role: 'engineer-cat',
      run_id: 'trace-run-adaptive-min-two',
      interaction_mode: 'adaptive',
      max_turns: 3,
      scenario: '帮我生成一个文件。',
      messages: [
        '帮我生成一个文件。',
        '文件路径在哪里？你确认就是最终版吗？',
      ],
    }, {
      workingDirectory: testRoot,
      conversationHistory: [],
      roleName: 'user-cat',
    });

    assert.match(output, /turn_count=2/);
    assert.equal(fakeAI.requests.length, 2);
    const tracePath = path.join(testRoot, 'data', 'user-cat', 'traces', 'trace-run-adaptive-min-two', 'trace.jsonl');
    const traceLines = fs.readFileSync(tracePath, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
    const decisions = traceLines.filter(event => event.type === 'usercat_decision');
    assert.equal(decisions[1].stop, false);
    assert.match(decisions[1].reason, /minimum two-turn evidence pressure/);
  });

  test('adaptive mode preserves required planned artifact and schema pressure', async () => {
    const fakeAI = new FakeTargetRoleAIService();
    const tool = createToolWithFakeAI(fakeAI, () => 'trace-run-adaptive-pressure', async () => async input => {
      if (input.nextTurnIndex === 2) {
        return {
          next_message: 'Can you show me the JSON contents and confirm it is done?',
          reason: 'ask a natural generic follow-up',
        };
      }
      return {
        stop: true,
        reason: 'target gave visible evidence',
      };
    });

    const output = await tool.execute({
      cwd: '.',
      target_role: 'engineer-cat',
      run_id: 'trace-run-adaptive-pressure',
      interaction_mode: 'adaptive',
      max_turns: 3,
      scenario: '帮我检查引用。',
      messages: [
        '帮我检查引用，给我一个 JSON。',
        '你最后要给我 answer.json，对吧？里面必须有 fake_citations 这个列表，路径在哪里？',
      ],
    }, {
      workingDirectory: testRoot,
      conversationHistory: [],
      roleName: 'user-cat',
    });

    assert.match(output, /turn_count=2/);
    const tracePath = path.join(testRoot, 'data', 'user-cat', 'traces', 'trace-run-adaptive-pressure', 'trace.jsonl');
    const traceLines = fs.readFileSync(tracePath, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
    const decisions = traceLines.filter(event => event.type === 'usercat_decision');
    assert.match(decisions[1].text, /answer\.json/);
    assert.match(decisions[1].text, /fake_citations/);
    assert.match(decisions[1].reason, /required planned artifact\/schema pressure/);
  });

  test('emits tool-owned artifact manifest through ToolManager', async () => {
    const fakeAI = new FakeTargetRoleAIService();
    const tool = createToolWithFakeAI(fakeAI, () => 'trace-run-tool-owned');
    const manager = new ToolManager(
      testRoot,
      { roleName: 'user-cat' },
      [tool],
    );

    const result = await manager.executeTool({
      id: 'user-trace-tool-owned-1',
      type: 'function',
      function: {
        name: 'user_trace_run',
        arguments: JSON.stringify({
          cwd: '.',
          target_role: 'engineer-cat',
          run_id: 'trace-run-tool-owned',
          messages: [
            '这个命令坏了，你先看下。',
            '所以证据是什么？',
            '我漏说了，别动无关文件。',
          ],
          max_chars: 80,
        }),
      },
    });

    assert.equal(result.status, 'success');
    assert.ok(!String(result.content).includes('candidate_case='));
    const manifest = result.artifact_manifest ?? [];
    assert.ok(manifest.some(item => item.path === 'data/user-cat/traces/trace-run-tool-owned/trace.jsonl'));
    assert.ok(manifest.some(item => item.path === 'output/user-cat/candidates/trace-run-tool-owned/candidate-case.json'));
    assert.ok(manifest.some(item => item.metadata?.artifact_role === 'candidate_manifest'));
    assert.ok(manifest.every(item => item.metadata?.source === 'tool_owned'));
    assert.ok(!manifest.some(item => item.metadata?.inferred === true));
  });

  test('rejects recursive UserCat self-target traces', async () => {
    const fakeAI = new FakeTargetRoleAIService();
    const tool = createToolWithFakeAI(fakeAI, () => 'trace-run-self');

    await assert.rejects(
      () => tool.execute({
        cwd: '.',
        target_role: 'user-cat',
        messages: [
          '你自己测自己一下。',
          '证据是什么？',
          '不要越界。',
        ],
      }, {
        workingDirectory: testRoot,
        conversationHistory: [],
        roleName: 'user-cat',
      }),
      /UserCat cannot target itself/,
    );
  });

  test('can drive every default durable target role through the same Dashboard Chat entrypoint', async () => {
    const targetRoles = DEFAULT_BUNDLED_ROLES.filter(role => role !== 'user-cat');

    for (const targetRole of targetRoles) {
      const fakeAI = new FakeTargetRoleAIService();
      const runId = `trace-${targetRole}`;
      const tool = createToolWithFakeAI(fakeAI, () => runId);

      const output = await tool.execute({
        cwd: '.',
        target_role: targetRole,
        run_id: runId,
        role_intent_map: { target_role: targetRole, role_exists_to: ['exercise role boundary'] },
        messages: [
          '这个东西我不会用，你先看下是不是能跑。',
          '所以我现在到底该看哪里，证据是什么？',
        ],
      }, {
        workingDirectory: testRoot,
        conversationHistory: [],
        roleName: 'user-cat',
      });

      assert.match(output, new RegExp(`target_role=${targetRole}`));
      assert.match(output, /turn_count=2/);
      assert.equal(fakeAI.requests.length, 2);

      const candidateCasePath = path.join(testRoot, 'output', 'user-cat', 'candidates', runId, 'candidate-case.json');
      const candidateCase = JSON.parse(fs.readFileSync(candidateCasePath, 'utf-8'));
      assert.equal(candidateCase.target_role, targetRole);
      assert.equal(candidateCase.turn_count, 2);
    }
  });
});

function createToolWithFakeAI(
  fakeAI: FakeTargetRoleAIService,
  createRunId: () => string,
  createUserPlanner?: any,
  arenaSubjectSkillId?: string,
): UserTraceRunTool {
  return new UserTraceRunTool({
    createRunId,
    ...(createUserPlanner && { createUserPlanner }),
    ...(arenaSubjectSkillId && { arenaSubjectSkillId }),
    createServices: ({ cwd, targetRole, runId }) => ({
      aiService: fakeAI as any,
      toolManager: new ToolManager(
        cwd,
        { roleName: targetRole, runId },
        getRoleSpecificToolsForRole(targetRole),
      ),
      skillManager: new SkillManager(targetRole),
      roleName: targetRole,
    }),
  });
}

function writeTestSkill(root: string, name: string): void {
  const skillDir = path.join(root, 'skills', name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name} test skill`,
    '---',
    '',
    `Follow ${name} deterministically.`,
    '',
  ].join('\n'), 'utf-8');
}

function collectFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectFiles(fullPath));
    } else {
      result.push(fullPath);
    }
  }
  return result;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (typeof value === 'string') {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}
