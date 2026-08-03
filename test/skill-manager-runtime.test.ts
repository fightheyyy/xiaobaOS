import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { DEFAULT_BUNDLED_BASE_SKILLS, SkillManager } from '../src/skills/skill-manager';
import { ToolManager } from '../src/tools/tool-manager';
import { SubAgentManager } from '../src/core/sub-agent-manager';
import { createSubAgentToolExecutor } from '../src/core/sub-agent-session';
import { SpawnSubagentTool } from '../src/tools/spawn-subagent-tool';
import { ChatResponse, Message, Skill } from '../src/types';
import { ToolDefinition, ToolExecutionOutput } from '../src/types/tool';

describe('SkillManager runtime base skills', () => {
  test('base runtime excludes OfficeCLI, sub-agent, and deleted fallback skill wrappers', async () => {
    const manager = new SkillManager();
    await manager.loadSkills();

    const names = manager.getAllSkills().map(skill => skill.metadata.name).sort();

    assert.deepStrictEqual(names, [...DEFAULT_BUNDLED_BASE_SKILLS].sort());
    assert.strictEqual(manager.getSkill('officecli-docx'), undefined);
    assert.strictEqual(manager.getSkill('officecli-pptx'), undefined);
    assert.strictEqual(manager.getSkill('officecli-xlsx'), undefined);
    assert.strictEqual(manager.getSkill('webcli'), undefined);
    assert.strictEqual(manager.getSkill('vision-analysis'), undefined);
    assert.strictEqual(manager.getSkill('sub-agent'), undefined);
    assert.strictEqual(manager.getSkill('background-task-runner'), undefined);
    assert.strictEqual(manager.getSkill('general-background-task'), undefined);
  });

  test('sub-agent capabilities are default runtime tools', () => {
    const manager = new ToolManager();

    for (const toolName of [
      'spawn_subagent',
      'check_subagent',
      'stop_subagent',
      'resume_subagent',
      'ask_parent',
    ]) {
      assert.ok(manager.getTool(toolName), `${toolName} should be registered as a runtime tool`);
    }
  });

  test('spawn_subagent accepts role_name, skill_name, or no preselected skill', async () => {
    const tool = new SpawnSubagentTool();
    const parameters = tool.definition.parameters as any;

    assert.ok(parameters.properties.role_name);
    assert.deepStrictEqual(parameters.required, ['task_description', 'user_message']);
    assert.equal(parameters.type, 'object');
    for (const forbiddenTopLevelKeyword of ['anyOf', 'oneOf', 'allOf', 'not', 'enum']) {
      assert.equal(
        parameters[forbiddenTopLevelKeyword],
        undefined,
        `spawn_subagent parameters should remain OpenAI-compatible without top-level ${forbiddenTopLevelKeyword}`,
      );
    }

    const noSkillSessionId = `subagent-schema-no-skill-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let noSkillFactoryInput: any;
    const noSkillAi = new ImmediateSubAgentAIService();
    SubAgentManager.getInstance().registerPlatformCallbacks(noSkillSessionId, {
      injectMessage: async () => undefined,
    });

    const noSkillResult = await tool.execute(
      {
        task_description: 'no preselected skill smoke',
        user_message: 'run no preselected skill smoke',
      },
      {
        workingDirectory: process.cwd(),
        conversationHistory: [],
        sessionId: noSkillSessionId,
        subAgentServiceFactory: async input => {
          noSkillFactoryInput = input;
          return {
            aiService: noSkillAi,
            skillManager: new EmptySubAgentSkillManager(),
          };
        },
      },
    );
    assert.strictEqual(noSkillResult.status, 'success');
    assert.match(String(noSkillResult.toolContent), /Skill: 无预设 skill/);
    assert.strictEqual(noSkillFactoryInput.skillName, undefined);
    assert.strictEqual(noSkillFactoryInput.roleName, undefined);
    assert.strictEqual(noSkillFactoryInput.allowSkillSelection, false);

    const noSkillInfo = await waitForSubAgentStatus(noSkillSessionId, 'completed');
    assert.strictEqual(noSkillInfo.skillSelectionMode, 'none');
    assert.ok(noSkillAi.requests[0].messages.some(message => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('[subagent-no-skill]')
    )));
    assert.strictEqual(noSkillAi.requests[0].tools.some(tool => tool.name === 'skill'), false);

    const ambiguousDispatchTarget = await tool.execute(
      {
        skill_name: 'remember',
        task_description: 'ambiguous dispatch target smoke',
        user_message: 'run ambiguous dispatch target smoke',
        role_name: 'reviewer-cat',
      },
      {
        workingDirectory: process.cwd(),
        sessionId: 'subagent-schema-test',
      },
    );
    assertStructuredToolFailure(ambiguousDispatchTarget, 'INVALID_TOOL_ARGUMENTS', /role_name 和 skill_name 只能二选一/);

    const invalidRoleResult = await tool.execute(
      {
        task_description: 'invalid explicit role smoke',
        user_message: 'run invalid explicit role smoke',
        role_name: 'not-a-real-role',
      },
      {
        workingDirectory: process.cwd(),
        sessionId: 'subagent-schema-test',
      },
    );

    assertStructuredToolFailure(invalidRoleResult, 'ROLE_NOT_FOUND', /未找到 role_name "not-a-real-role"/);

    const explicitBaseSessionId = `subagent-schema-base-no-skill-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let explicitBaseFactoryInput: any;
    SubAgentManager.getInstance().registerPlatformCallbacks(explicitBaseSessionId, {
      injectMessage: async () => undefined,
    });
    const baseNoSkillResult = await tool.execute(
      {
        task_description: 'base role-only smoke',
        user_message: 'run base role-only smoke',
        role_name: 'none',
      },
      {
        workingDirectory: process.cwd(),
        conversationHistory: [],
        sessionId: explicitBaseSessionId,
        subAgentServiceFactory: async input => {
          explicitBaseFactoryInput = input;
          return {
            aiService: new ImmediateSubAgentAIService(),
            skillManager: new EmptySubAgentSkillManager(),
          };
        },
      },
    );
    assert.strictEqual(baseNoSkillResult.status, 'success');
    assert.strictEqual(explicitBaseFactoryInput.roleName, undefined);
    assert.strictEqual(explicitBaseFactoryInput.skillName, undefined);
    assert.strictEqual(explicitBaseFactoryInput.allowSkillSelection, false);
    await waitForSubAgentStatus(explicitBaseSessionId, 'completed');
  });

  test('spawn_subagent injects trusted parent session identity outside model arguments', async () => {
    const tool = new SpawnSubagentTool();
    const manager = SubAgentManager.getInstance();
    const originalSpawn = manager.spawn;
    let capturedOptions: any;

    (manager as any).spawn = (...args: any[]) => {
      capturedOptions = args[7];
      return {
        id: 'sub-trusted-parent',
        taskDescription: 'trusted parent context smoke',
        status: 'running',
        createdAt: Date.now(),
        progressLog: [],
        outputFiles: [],
      };
    };

    try {
      const result = await tool.execute({
        task_description: 'trusted parent context smoke',
        user_message: 'verify trusted runtime context',
      }, {
        workingDirectory: process.cwd(),
        conversationHistory: [],
        sessionId: 'cli-parent-trusted',
        subAgentServiceFactory: async () => ({
          aiService: new ImmediateSubAgentAIService(),
          skillManager: new EmptySubAgentSkillManager(),
        }),
      });

      assert.strictEqual(result.status, 'success');
      assert.strictEqual(capturedOptions.parentSessionId, 'cli-parent-trusted');
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(tool.definition.parameters.properties, 'parentSessionId'),
        false,
      );
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(tool.definition.parameters.properties, 'parent_session_id'),
        false,
      );
    } finally {
      (manager as any).spawn = originalSpawn;
    }
  });

  test('default runtime tool schemas keep provider-compatible object roots', () => {
    const manager = new ToolManager();

    for (const definition of manager.getToolDefinitions()) {
      const parameters = definition.parameters as any;
      assert.equal(parameters.type, 'object', `${definition.name} parameters should use object root`);
      for (const forbiddenTopLevelKeyword of ['anyOf', 'oneOf', 'allOf', 'not', 'enum']) {
        assert.equal(
          parameters[forbiddenTopLevelKeyword],
          undefined,
          `${definition.name} parameters should not use top-level ${forbiddenTopLevelKeyword}`,
        );
      }
    }
  });

  test('Engineer sub-agents expose coding tools without Base control tools', () => {
    const engineerTools = createSubAgentToolExecutor(process.cwd(), 'test-engineer', 'engineer-cat');
    const engineerToolNames = engineerTools.getToolDefinitions().map(tool => tool.name);
    for (const baseCodingTool of ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'execute_shell']) {
      assert.ok(engineerToolNames.includes(baseCodingTool), `${baseCodingTool} should be visible`);
    }
    assert.strictEqual(engineerToolNames.includes('engineer_task_run'), false);
    assert.strictEqual(engineerToolNames.includes('codex_job_status'), false);
    assert.ok(engineerToolNames.includes('codex_run'));
    assert.ok(engineerToolNames.includes('ask_parent'));
    for (const hiddenTool of [
      'spawn_subagent',
      'check_subagent',
      'stop_subagent',
      'resume_subagent',
      'skill',
      'send_text',
      'send_file',
    ]) {
      assert.strictEqual(engineerToolNames.includes(hiddenTool), false, `${hiddenTool} should be hidden inside sub-agents`);
    }

    const inspectorTools = createSubAgentToolExecutor(process.cwd(), 'test-inspector', 'inspector-cat');
    const inspectorToolNames = inspectorTools.getToolDefinitions().map(tool => tool.name);
    assert.ok(inspectorToolNames.includes('analyze_log'));
    assert.strictEqual(inspectorToolNames.includes('run_pending_log_batch'), false);

    const reviewerTools = createSubAgentToolExecutor(process.cwd(), 'test-reviewer', 'reviewer');
    const reviewerToolNames = reviewerTools.getToolDefinitions().map(tool => tool.name);
    assert.strictEqual(reviewerToolNames.includes('reviewer_trace_replay'), false);
    assert.strictEqual(reviewerToolNames.includes('reviewer_eval_prepare'), false);
    assert.strictEqual(reviewerToolNames.includes('reviewer_xiaoba_cli_e2e'), false);
    assert.strictEqual(reviewerToolNames.includes('reviewer_module_test'), false);
    assert.strictEqual(reviewerToolNames.includes('spawn_subagent'), false);
  });

  test('role-only sub-agents can use skill tool to choose role-local skills', () => {
    const engineerTools = createSubAgentToolExecutor(
      process.cwd(),
      'test-engineer-role-only',
      'engineer-cat',
      { allowSkillTool: true },
    );
    const engineerToolNames = engineerTools.getToolDefinitions().map(tool => tool.name);
    assert.ok(engineerToolNames.includes('skill'));
    assert.ok(engineerToolNames.includes('execute_shell'));
    assert.ok(engineerToolNames.includes('codex_run'));
    assert.ok(engineerToolNames.includes('ask_parent'));
    for (const hiddenTool of ['spawn_subagent', 'check_subagent', 'stop_subagent', 'resume_subagent']) {
      assert.strictEqual(engineerToolNames.includes(hiddenTool), false, `${hiddenTool} should stay Base-only`);
    }

    const reviewerTools = createSubAgentToolExecutor(
      process.cwd(),
      'test-reviewer-role-only',
      'reviewer',
      { allowSkillTool: true },
    );
    const reviewerToolNames = reviewerTools.getToolDefinitions().map(tool => tool.name);

    assert.ok(reviewerToolNames.includes('skill'));
    assert.strictEqual(reviewerToolNames.includes('reviewer_trace_replay'), false);
    for (const hiddenTool of ['spawn_subagent', 'check_subagent', 'send_text', 'send_file']) {
      assert.strictEqual(reviewerToolNames.includes(hiddenTool), false, `${hiddenTool} should stay hidden`);
    }
  });
});

function assertStructuredToolFailure(
  output: ToolExecutionOutput,
  errorCode: string,
  contentPattern: RegExp,
): void {
  assert.strictEqual(output.status, 'failure');
  assert.strictEqual(output.error_code, errorCode);
  assert.strictEqual(output.retryable, false);
  assert.match(String(output.toolContent), contentPattern);
}

class ImmediateSubAgentAIService {
  readonly requests: Array<{ messages: Message[]; tools: ToolDefinition[] }> = [];

  async chatStream(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    this.requests.push({ messages, tools });
    return { content: 'no-skill subagent completed' };
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

class EmptySubAgentSkillManager {
  async loadSkills(): Promise<void> {}
  getAllSkills(): Skill[] { return []; }
  getUserInvocableSkills(): Skill[] { return []; }
  getAutoInvocableSkills(): Skill[] { return []; }
  getSkill(): Skill | undefined { return undefined; }
}

async function waitForSubAgentStatus(sessionId: string, status: string): Promise<any> {
  const manager = SubAgentManager.getInstance();
  for (let attempt = 0; attempt < 50; attempt++) {
    const info = manager.listByParent(sessionId)[0];
    if (info?.status === status) {
      return info;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const latest = manager.listByParent(sessionId)[0];
  throw new Error(`Timed out waiting for subagent ${sessionId} to reach ${status}; latest=${latest?.status || 'missing'}`);
}
