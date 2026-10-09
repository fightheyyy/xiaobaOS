import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionOutput } from '../types/tool';
import { SubAgentManager } from '../core/sub-agent-manager';
import { AIService } from '../utils/ai-service';
import { SkillManager } from '../skills/skill-manager';
import { Logger } from '../utils/logger';
import { RoleResolver } from '../utils/role-resolver';
import { styles } from '../theme/colors';
import { toolFailure, toolSuccess } from './tool-result';

/**
 * spawn_subagent - 派遣子智能体后台执行 skill、role-scoped task 或 no-skill task
 *
 * 主 agent 像"甩活给小弟"一样使用这个工具：
 * 调用后立即返回，子智能体在后台独立运行，
 * 主会话不阻塞，可以继续和用户对话。
 */
export class SpawnSubagentTool implements Tool {
  definition: ToolDefinition = {
    name: 'spawn_subagent',
    description: `派遣一个子智能体在后台独立执行某个 skill 任务、指定 role 后让子智能体自行选择 role-local skill，或不预设 skill 直接执行后台任务。

调用后立即返回，不会阻塞当前对话。子智能体完成后会通知你（主 agent），并附上产出文件列表。
由你决定是否将结果和文件转发给用户。

使用场景：
- 用户要求执行耗时较长的 skill（如论文精读、文献综述等）
- 你判断任务需要大量工具调用轮次（>10轮），不适合在当前对话中同步执行
- 用户可能还有其他事情要聊，你不想让他等
- 当前 role 有明确后台 skill 时，传 skill_name
- 需要切到另一个 role 时，只传 role_name，让子智能体自己用 skill 工具选择该 role 的 skill
- 没有合适 skill 且不需要切 role 时，不传 role_name / skill_name，子智能体会无预设 skill 直接执行
- role_name 和 skill_name 互斥，可以都不传，但不要同时传

注意：
- 每个会话最多同时运行 3 个子任务
- 子智能体不会直接给用户发消息或文件
- 任务完成后你会收到包含结果摘要和产出文件路径的通知
- 你可以用 check_subagent 查看进度，用 stop_subagent 停止任务
- 收到完成通知后，请用 reply 告知用户结果，用 send_file 发送相关文件`,
    parameters: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: '可选：要预激活的当前 role 可见 skill。只填 skill_name 时会继承父会话 role；指定 role_name 时不要同时填 skill_name。',
        },
        role_name: {
          type: 'string',
          description: '可选：子智能体使用的角色名或别名。只填 role_name 时，子智能体会在该 role 内自行选择 skill；传 base/default/none 表示明确不使用角色。',
        },
        task_description: {
          type: 'string',
          description: '任务的简短描述，用于进度通知（如"精读 attention is all you need"）',
        },
        user_message: {
          type: 'string',
          description: '传递给子智能体的完整用户指令（包含文件路径等必要信息）',
        },
      },
      required: ['task_description', 'user_message'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const { skill_name, role_name, task_description, user_message } = args;
    const requestedSkillName = typeof skill_name === 'string' ? skill_name.trim() : '';
    const requestedRoleName = typeof role_name === 'string' ? role_name.trim() : '';

    if (!task_description || !user_message) {
      return toolFailure('错误：task_description、user_message 均为必填参数', 'INVALID_TOOL_ARGUMENTS');
    }
    if (requestedSkillName && requestedRoleName) {
      return toolFailure('错误：role_name 和 skill_name 只能二选一。跨 role 派遣时只传 role_name，让子智能体在目标 role 内自行选择 skill；当前 role 的明确后台任务才只传 skill_name。', 'INVALID_TOOL_ARGUMENTS');
    }

    const manager = SubAgentManager.getInstance();
    const sessionKey = context.sessionId || 'unknown';
    const roleResolution = resolveSubAgentRoleName(
      requestedRoleName || undefined,
      requestedSkillName ? context.roleName : undefined,
    );
    if (roleResolution.error) {
      return toolFailure(roleResolution.error, 'ROLE_NOT_FOUND');
    }
    const roleName = roleResolution.roleName;
    const allowSkillSelection = Boolean(!requestedSkillName && requestedRoleName && roleName);

    // Production uses default services; deterministic eval can inject scripted sub-agent services.
    const injectedServices = context.subAgentServiceFactory
      ? await context.subAgentServiceFactory({
        roleName,
        skillName: requestedSkillName || undefined,
        allowSkillSelection,
        workingDirectory: context.workingDirectory,
        parentSessionId: sessionKey,
      })
      : undefined;
    const aiService = (injectedServices?.aiService as AIService | undefined) || new AIService();
    const skillManager = (injectedServices?.skillManager as SkillManager | undefined) || new SkillManager(roleName);
    await skillManager.loadSkills();

    const result = manager.spawn(
      sessionKey,
      requestedSkillName || undefined,
      task_description,
      user_message,
      context.workingDirectory,
      aiService,
      skillManager,
      {
        roleName,
        allowSkillSelection,
        observabilityContext: context.observabilityContext,
        parentSessionId: sessionKey,
        toolManager: injectedServices?.toolManager,
        maxTurns: injectedServices?.maxTurns,
      },
    );

    if ('error' in result) {
      return toolFailure(`派遣失败：${result.error}`, 'SUBAGENT_SPAWN_FAILED');
    }

    if (!Logger.isSilentMode()) {
      console.log('\n' + styles.highlight(`🚀 派遣子智能体: ${task_description}`));
      console.log(styles.text(`   ID: ${result.id}`));
      if (roleName) {
        console.log(styles.text(`   Role: ${roleName}`));
      }
      console.log(styles.text(`   Skill: ${formatSubAgentSkillLabel(requestedSkillName, allowSkillSelection)}\n`));
    }

    return toolSuccess([
      `子智能体 ${result.id} 已派遣，正在后台执行「${task_description}」。`,
      ...(roleName ? [`Role: ${roleName}`] : []),
      `Skill: ${formatSubAgentSkillLabel(requestedSkillName, allowSkillSelection)}`,
      `状态: running`,
      ``,
      `子智能体完成后会通知你结果和产出文件列表。届时判断是否值得告知；channel 会话用 send_text/send_file 交付，CLI 正常回复。不要向用户照搬子任务 ID 和 Role 日志。`,
      `派工后释放当前对话，不轮询等待。用户询问进度时用 check_subagent；要求停止时用 stop_subagent。`,
    ].join('\n'));
  }
}

function formatSubAgentSkillLabel(skillName: string, allowSkillSelection: boolean): string {
  if (skillName) {
    return skillName;
  }
  return allowSkillSelection ? '由子智能体自行选择' : '无预设 skill';
}

function resolveSubAgentRoleName(requestedRole: unknown, inheritedRole: unknown): { roleName?: string; error?: string } {
  const requested = typeof requestedRole === 'string' ? requestedRole.trim() : '';
  const inherited = typeof inheritedRole === 'string' ? inheritedRole.trim() : '';
  const rawRole = requested || inherited;
  if (!rawRole) {
    return {};
  }

  const normalized = RoleResolver.normalizeRoleName(rawRole);
  if (normalized === '' || normalized === 'base' || normalized === 'default' || normalized === 'none') {
    return {};
  }

  const resolved = RoleResolver.resolveRoleDirectoryName(rawRole);
  if (resolved) {
    return { roleName: resolved };
  }

  const available = RoleResolver.listAvailableRoles();
  const detail = available.length > 0
    ? `可用角色：${available.join(', ')}`
    : '当前项目还没有 roles 目录或角色定义。';
  return { error: `错误：未找到 role_name "${rawRole}"。${detail}` };
}
