import { after, afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRoleAwareToolManager } from '../src/bootstrap/tool-manager';
import { startRoleRuntimeServices } from '../src/roles/runtime-role-registry';
import { ToolManager } from '../src/tools/tool-manager';
import { RoleResolver } from '../src/utils/role-resolver';

const originalCwd = process.cwd();
const originalRole = process.env.XIAOBA_ROLE;
const originalCurrentRole = process.env.CURRENT_ROLE;
const originalCurrentRoleDisplayName = process.env.CURRENT_ROLE_DISPLAY_NAME;

describe('ToolManager role-specific tools', () => {
  let testRoot: string;

  beforeEach(() => {
    RoleResolver.clearActiveRole();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-tool-role-'));
    fs.mkdirSync(path.join(testRoot, 'roles', 'InspectorCat'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'roles', 'reviewer-cat'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'roles', 'engineer-cat'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'roles', 'researcher-cat'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'roles', 'secretary-cat'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'roles', 'guide'), { recursive: true });
    fs.writeFileSync(
      path.join(testRoot, 'roles', 'InspectorCat', 'role.json'),
      JSON.stringify({ name: 'inspector-cat', displayName: 'InspectorCat' }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(testRoot, 'roles', 'reviewer-cat', 'role.json'),
      JSON.stringify({ name: 'reviewer-cat', displayName: 'ReviewerCat' }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(testRoot, 'roles', 'engineer-cat', 'role.json'),
      JSON.stringify({
        name: 'engineer-cat',
        displayName: 'EngineerCat',
        inheritBaseTools: false,
        baseToolAllowlist: ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'execute_shell', 'skill', 'ask_parent'],
      }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(testRoot, 'roles', 'researcher-cat', 'role.json'),
      JSON.stringify({ name: 'researcher-cat', displayName: 'ResearcherCat', aliases: ['researcher'] }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(testRoot, 'roles', 'secretary-cat', 'role.json'),
      JSON.stringify({
        name: 'secretary-cat',
        displayName: 'SecretaryCat',
        aliases: ['secretary'],
        inheritBaseTools: false,
        baseToolAllowlist: ['skill'],
      }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(testRoot, 'roles', 'guide', 'role.json'),
      JSON.stringify({ name: 'guide', displayName: 'Guide', aliases: ['tpc-guide'] }, null, 2),
      'utf-8',
    );
    process.chdir(testRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  after(() => {
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
  });

  test('默认角色不注册 Inspector 专属工具', () => {
    const manager = new ToolManager();
    assert.strictEqual(manager.getTool('analyze_log'), undefined);
  });

  test('Base aliases use the Base tool set without requiring a role package', () => {
    for (const roleName of ['base', 'default', 'none']) {
      const manager = createRoleAwareToolManager(testRoot, {}, roleName);
      assert.ok(manager.getTool('read_file'));
      assert.strictEqual(manager.getTool('analyze_log'), undefined);
    }
  });

  test('激活角色后基础 ToolManager 仍保持纯 runtime 工具集', () => {
    RoleResolver.activateRole('inspector-cat');
    const manager = new ToolManager();
    assert.strictEqual(manager.getTool('analyze_log'), undefined);
  });

  test('inspector-cat 角色通过组合层注册 analyze_log', () => {
    RoleResolver.activateRole('inspector-cat');
    const manager = createRoleAwareToolManager();
    assert.ok(manager.getTool('analyze_log'));
  });

  test('inspector-cat 不再自动启动独立 hook runtime', async () => {
    RoleResolver.activateRole('inspector-cat');
    assert.strictEqual(await startRoleRuntimeServices({ workingDirectory: testRoot }), null);
  });

  test('inspector-cat analyze_log 显式声明 source log 证据', async () => {
    RoleResolver.activateRole('inspector-cat');
    const logDir = path.join(testRoot, 'logs', 'sessions');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'inspector-source.jsonl'),
      `${JSON.stringify({
        schema_version: 2,
        entry_type: 'turn',
        turn: 1,
        timestamp: '2026-06-04T00:00:00.000Z',
        session_id: 'inspector-source',
        session_type: 'eval',
        user: { text: 'inspect runtime evidence' },
        assistant: { text: 'I found a concrete failure.', tool_calls: [] },
        tokens: { prompt: 10, completion: 5 },
      })}\n`,
      'utf-8',
    );

    const manager = createRoleAwareToolManager(testRoot);
    const result = await manager.executeTool({
      id: 'inspector-analyze-log-manifest-1',
      type: 'function',
      function: {
        name: 'analyze_log',
        arguments: JSON.stringify({
          log_source: 'logs/sessions/inspector-source.jsonl',
          analysis_depth: 'quick',
        }),
      },
    });

    assert.strictEqual(result.status, 'success');
    assert.deepEqual((result.artifact_manifest ?? []).map(item => item.path), [
      'logs/sessions/inspector-source.jsonl',
    ]);
    assert.ok(result.artifact_manifest?.every(item => item.action === 'captured'));
    assert.ok(result.artifact_manifest?.every(item => item.metadata?.source === 'tool_owned'));
    assert.ok(result.artifact_manifest?.every(item => item.metadata?.artifact_role === 'source_log'));
    assert.ok(!result.artifact_manifest?.some(item => item.metadata?.inferred === true));
  });

  test('reviewer-cat has no private evaluator or replay tools', () => {
    RoleResolver.activateRole('reviewer-cat');
    const manager = createRoleAwareToolManager();
    assert.strictEqual(manager.getTool('reviewer_trace_replay'), undefined);
    assert.strictEqual(manager.getTool('reviewer_eval_prepare'), undefined);
    assert.strictEqual(manager.getTool('reviewer_xiaoba_cli_e2e'), undefined);
    assert.strictEqual(manager.getTool('reviewer_module_test'), undefined);
    assert.strictEqual(manager.getTool('engineer_task_run'), undefined);
    assert.strictEqual(manager.getTool('codex_job_start'), undefined);
  });

  test('Reviewer command runners are absent instead of policy-blocked', () => {
    RoleResolver.activateRole('reviewer-cat');
    const manager = createRoleAwareToolManager(testRoot, {
      roleName: 'reviewer-cat',
      parentSessionId: 'evolution:dag:2026-07-14',
    });
    assert.strictEqual(manager.getTool('reviewer_xiaoba_cli_e2e'), undefined);
    assert.strictEqual(manager.getTool('reviewer_module_test'), undefined);
  });

  test('engineer-cat 只开放 coding 和 skill 工具且没有调度控制面', () => {
    RoleResolver.activateRole('engineer-cat');
    const manager = createRoleAwareToolManager();
    const visibleToolNames = manager.getToolDefinitions().map(tool => tool.name);
    for (const toolName of ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'execute_shell', 'codex_run']) {
      assert.ok(visibleToolNames.includes(toolName), `${toolName} should be visible to EngineerCat`);
    }
    assert.ok(visibleToolNames.includes('skill'));
    assert.ok(visibleToolNames.includes('ask_parent'));
    for (const removedToolName of [
      'spawn_subagent',
      'check_subagent',
      'stop_subagent',
      'resume_subagent',
      'engineer_task_run',
      'engineer_codex_supervisor_start',
      'codex_job_start',
    ]) {
      assert.strictEqual(visibleToolNames.includes(removedToolName), false);
    }
  });

  test('researcher alias 通过组合层注册 auto research 和 Research Board 工具', () => {
    RoleResolver.activateRole('researcher');
    const manager = createRoleAwareToolManager();
    assert.ok(manager.getTool('auto_research_run'));
    assert.ok(manager.getTool('research_board_update'));
    assert.ok(manager.getTool('research_board_read'));
  });

  test('guide alias 通过组合层注册 TPC baseline、eval analysis 和 env baseline 工具', () => {
    RoleResolver.activateRole('tpc-guide');
    const manager = createRoleAwareToolManager();
    assert.ok(manager.getTool('guide_tpc_baseline'));
    assert.ok(manager.getTool('guide_tpc_eval_analysis'));
    assert.ok(manager.getTool('guide_tpc_env_baseline'));
  });

  test('researcher role tools emit explicit tool-owned artifact manifests', async () => {
    RoleResolver.activateRole('researcher');
    const manager = createRoleAwareToolManager(testRoot);

    const boardResult = await manager.executeTool({
      id: 'research-board-explicit-1',
      type: 'function',
      function: {
        name: 'research_board_update',
        arguments: JSON.stringify({
          project: 'Manifest Demo',
          goal: 'prove explicit board artifact evidence',
          claim_board: [{ claim: 'Manifest evidence is explicit.', status: 'weakly_supported' }],
        }),
      },
    });

    assert.strictEqual(boardResult.status, 'success');
    assert.deepEqual((boardResult.artifact_manifest ?? []).map(item => item.path), [
      'data/researcher-cat/boards/manifest-demo/board.json',
      'output/researcher-cat/boards/manifest-demo/research-board.md',
      'data/researcher-cat/boards/manifest-demo/events.jsonl',
    ]);
    assert.ok(boardResult.artifact_manifest?.every(item => item.metadata?.source === 'tool_owned'));
    assert.ok(!boardResult.artifact_manifest?.some(item => item.metadata?.inferred === true));

    const autoResult = await manager.executeTool({
      id: 'auto-research-explicit-1',
      type: 'function',
      function: {
        name: 'auto_research_run',
        arguments: JSON.stringify({
          project: 'Manifest Auto',
          goal: 'prove explicit auto research artifact evidence',
          workspace_path: '.',
          max_files: 5,
        }),
      },
    });

    assert.strictEqual(autoResult.status, 'success');
    const autoPaths = (autoResult.artifact_manifest ?? []).map(item => item.path);
    assert.ok(autoPaths.includes('data/researcher-cat/auto-research/manifest-auto/intake-manifest.json'));
    assert.ok(autoPaths.includes('output/researcher-cat/auto-research/manifest-auto/auto-research-report.md'));
    assert.ok(autoPaths.includes('data/researcher-cat/auto-research/manifest-auto/phase-plan.json'));
    assert.ok(autoPaths.includes('data/researcher-cat/auto-research/manifest-auto/reviewer-handoff.json'));
    assert.ok(autoPaths.includes('data/researcher-cat/boards/manifest-auto/board.json'));
    assert.ok(autoResult.artifact_manifest?.some(item => item.path.endsWith('intake-manifest.json') && item.action === 'generated'));
    assert.ok(autoResult.artifact_manifest?.some(item => item.path.endsWith('board.json') && item.action === 'updated'));
    assert.ok(autoResult.artifact_manifest?.every(item => item.metadata?.source === 'tool_owned'));
    assert.ok(!autoResult.artifact_manifest?.some(item => item.metadata?.inferred === true));
  });

  test('role alias resolves base tool inheritance policy', () => {
    const manager = createRoleAwareToolManager(testRoot, {}, 'secretary');
    assert.ok(manager.getTool('skill'));
    assert.strictEqual(manager.getTool('execute_shell'), undefined);
    assert.strictEqual(manager.getTool('read_file'), undefined);
  });

  test('组合层把激活角色写入工具执行上下文', async () => {
    RoleResolver.activateRole('engineer-cat');
    const manager = createRoleAwareToolManager();
    manager.registerTool({
      definition: {
        name: 'context_probe',
        description: 'probe tool context',
        parameters: { type: 'object', properties: {} },
      },
      async execute(_args, context) {
        return context.roleName || '';
      },
    });

    const result = await manager.executeTool({
      id: 'context-probe-1',
      type: 'function',
      function: {
        name: 'context_probe',
        arguments: '{}',
      },
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.content, 'engineer-cat');
  });

  test('role text tool outputs produce inferred artifact manifests', async () => {
    const manager = new ToolManager(testRoot);
    manager.registerTool({
      definition: {
        name: 'engineer_case_result',
        description: 'fake EngineerCat case result',
        parameters: { type: 'object', properties: {} },
      },
      async execute() {
        return [
          'engineer_case: status=reviewing',
          `cwd=${path.join(testRoot, 'project')}`,
          'implementation_file=output/evolution/sleep/demo/implementation.md',
          'output_file=output/evolution/sleep/demo/engineer-output.json',
          'patch_file=output/evolution/sleep/demo/implementation.patch',
        ].join('\n');
      },
    });

    const result = await manager.executeTool({
      id: 'engineer-task-status-1',
      type: 'function',
      function: {
        name: 'engineer_case_result',
        arguments: '{}',
      },
    });

    assert.strictEqual(result.status, 'success');
    assert.deepEqual((result.artifact_manifest ?? []).map(item => item.path), [
      'output/evolution/sleep/demo/implementation.md',
      'output/evolution/sleep/demo/engineer-output.json',
      'output/evolution/sleep/demo/implementation.patch',
    ]);
    assert.ok(result.artifact_manifest?.every(item => item.action === 'captured'));
    assert.ok(result.artifact_manifest?.every(item => item.metadata?.inferred === true));
    assert.ok(!result.artifact_manifest?.some(item => item.path === path.join(testRoot, 'project')));
  });

  test('role JSON tool outputs produce inferred artifact manifests', async () => {
    const boardJson = path.join(testRoot, 'data', 'researcher-cat', 'boards', 'demo', 'board.json');
    const boardMarkdown = path.join(testRoot, 'output', 'researcher-cat', 'boards', 'demo', 'research-board.md');
    const eventsJsonl = path.join(testRoot, 'data', 'researcher-cat', 'boards', 'demo', 'events.jsonl');
    const manager = new ToolManager(testRoot);
    manager.registerTool({
      definition: {
        name: 'research_board_update',
        description: 'fake ResearcherCat board update',
        parameters: { type: 'object', properties: {} },
      },
      async execute() {
        return `${JSON.stringify({
          ok: true,
          board_json_path: boardJson,
          board_markdown_path: boardMarkdown,
          events_jsonl_path: eventsJsonl,
          status: 'completed',
        }, null, 2)}\n`;
      },
    });

    const result = await manager.executeTool({
      id: 'research-board-update-1',
      type: 'function',
      function: {
        name: 'research_board_update',
        arguments: '{}',
      },
    });

    assert.strictEqual(result.status, 'success');
    assert.deepEqual((result.artifact_manifest ?? []).map(item => item.path), [
      boardJson,
      boardMarkdown,
      eventsJsonl,
    ]);
    assert.deepEqual((result.artifact_manifest ?? []).map(item => item.type), [
      'json',
      'md',
      'jsonl',
    ]);
  });
});
