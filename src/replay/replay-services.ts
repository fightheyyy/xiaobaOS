import { AgentServices } from '../core/agent-session';
import { SkillManager } from '../skills/skill-manager';
import { buildCanonicalToolResult } from '../tools/tool-result';
import { ToolManager } from '../tools/tool-manager';
import {
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../types/tool';
import { AIService } from '../utils/ai-service';

export type ReplaySandboxMode = 'read_only' | 'workspace_write';

const READ_ONLY_TOOLS = new Set([
  'read_file',
  'glob',
  'grep',
]);

const WORKSPACE_WRITE_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  'write_file',
  'edit_file',
  'execute_shell',
]);

export async function createReplayServices(input: {
  working_directory: string;
  parent_session_id: string;
  sandbox_mode: ReplaySandboxMode;
  role_name?: string;
}): Promise<AgentServices> {
  assertReplaySandboxAvailable(input.sandbox_mode);
  const allowedTools = input.sandbox_mode === 'workspace_write'
    ? WORKSPACE_WRITE_TOOLS
    : READ_ONLY_TOOLS;

  class ReplayToolManager extends ToolManager {
    constructor() {
      super(
        input.working_directory,
        {
          surface: 'agent',
          permissionProfile: 'strict',
          parentSessionId: input.parent_session_id,
          ...(input.role_name ? { roleName: input.role_name } : {}),
        },
        [],
        {
          inheritBaseTools: false,
          baseToolAllowlist: [...allowedTools],
        },
      );
    }

    override getToolDefinitions(contextOverrides = {}): ToolDefinition[] {
      return super.getToolDefinitions(contextOverrides)
        .filter(definition => allowedTools.has(definition.name));
    }

    override async executeTool(
      toolCall: ToolCall,
      conversationHistory?: any[],
      contextOverrides = {},
    ): Promise<ToolResult> {
      const toolName = canonicalToolName(toolCall.function.name);
      if (!allowedTools.has(toolName)) {
        const reason = `${toolName} is forbidden by Case Replay ${input.sandbox_mode} policy`;
        return buildCanonicalToolResult({
          tool_call_id: toolCall.id,
          name: toolName,
          content: `执行被阻止: ${reason}`,
          status: 'blocked',
          errorCode: 'CASE_REPLAY_TOOL_FORBIDDEN',
          blockedReason: reason,
          retryable: false,
        });
      }
      return super.executeTool(toolCall, conversationHistory, contextOverrides);
    }
  }

  const skillManager = new SkillManager(input.role_name);
  await skillManager.loadSkills();
  return {
    aiService: new AIService(undefined, { arenaComponent: 'replay' }),
    toolManager: new ReplayToolManager(),
    skillManager,
    ...(input.role_name ? { roleName: input.role_name } : {}),
  };
}

export function assertReplaySandboxAvailable(mode: ReplaySandboxMode): void {
  if (mode === 'workspace_write' && process.env.XIAOBA_ARENA_SANDBOXED !== '1') {
    throw new Error(
      'Case Replay workspace_write requires an enforced clean-runtime sandbox',
    );
  }
}

function canonicalToolName(value: string): string {
  if (['Bash', 'bash', 'Shell', 'execute_bash'].includes(value)) return 'execute_shell';
  if (value === 'Read') return 'read_file';
  if (value === 'Write') return 'write_file';
  if (value === 'Edit') return 'edit_file';
  return value;
}
