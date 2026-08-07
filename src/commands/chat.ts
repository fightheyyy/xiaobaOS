import * as readline from 'readline';
import ora from 'ora';
import { Logger } from '../utils/logger';
import { AIService } from '../utils/ai-service';
import { createRoleAwareToolManager } from '../bootstrap/tool-manager';
import { startCommandSupport, stopCommandSupport } from '../bootstrap/command-support';
import { CommandOptions } from '../types';
import { styles } from '../theme/colors';
import { SkillManager } from '../skills/skill-manager';
import { AgentSession, AgentServices, SessionCallbacks } from '../core/agent-session';
import { RoleResolver } from '../utils/role-resolver';
import { SubAgentManager } from '../core/sub-agent-manager';
import { shutdownObservability } from '../observability';
import {
  ConversationTurnContext,
  recordVisibleAssistant,
  recordVisibleInbound,
  reserveConversationTraceId,
} from '../utils/conversation-surface';

const DEFAULT_CLI_ONE_SHOT_SUBAGENT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CLI_ONE_SHOT_POLL_INTERVAL_MS = 25;

export interface CliSubAgentFeedbackHandle {
  enqueue(text: string): Promise<void>;
  drain(): Promise<void>;
  generation(): number;
  dispose(): void;
}

export interface CliOneShotSubAgentOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export function shouldRestoreCliSession(options: Pick<CommandOptions, 'message' | 'resume'>): boolean {
  return !options.message && options.resume === true;
}

export function shouldRenderCliRuntimeLogs(options: Pick<CommandOptions, 'verbose'>): boolean {
  return options.verbose === true;
}

export async function chatCommand(options: CommandOptions): Promise<void> {
  const previousSilentMode = Logger.isSilentMode();
  if (!shouldRenderCliRuntimeLogs(options)) {
    Logger.setSilentMode(true);
  }

  const restoreLoggerMode = () => {
    Logger.setSilentMode(previousSilentMode);
  };

  const aiService = new AIService();
  await startCommandSupport();
  const roleName = RoleResolver.getActiveRoleName();

  // 初始化 ToolManager
  const toolManager = createRoleAwareToolManager(process.cwd(), {}, roleName);
  Logger.info(`已注册 ${toolManager.getToolCount()} 个基础工具 (message mode)`);
  Logger.info(`运行时可用工具数量将根据 skill toolPolicy 动态过滤`);

  // 初始化 SkillManager
  const skillManager = new SkillManager(roleName);
  try {
    await skillManager.loadSkills();
    const skillCount = skillManager.getAllSkills().length;
    if (skillCount > 0) {
      Logger.info(`已加载 ${skillCount} 个 skills`);
    }
  } catch (error: any) {
    Logger.warning(`Skills 加载失败: ${error.message}`);
  }

  // 组装 AgentServices + 创建 AgentSession
  const services: AgentServices = {
    aiService,
    toolManager,
    skillManager,
    ...(roleName ? { roleName } : {}),
  };
  const session = new AgentSession(options.sessionKey || 'cli', services, options.sessionType || 'cli');
  const subAgentFeedback = registerCliSubAgentCallbacks(session);
  if (shouldRestoreCliSession(options)) {
    session.restoreFromStore();
  }

  // 启动时激活指定 skill
  if (options.skill) {
    const activated = await session.activateSkill(options.skill);
    if (!activated) {
      Logger.error(`Skill "${options.skill}" 未找到，请通过 xiaoba skill list 查看可用 skills`);
      subAgentFeedback.dispose();
      await stopCommandSupport();
      restoreLoggerMode();
      return;
    }
    Logger.info(`已绑定 skill: ${options.skill}`);
  }

  // 单条消息模式
  if (options.message) {
    const existingSubAgentIds = new Set(
      SubAgentManager.getInstance().listByParent(session.key).map(item => item.id),
    );
    try {
      await sendSingleMessage(session, options.message, {
        recordInbound: true,
        roleName,
      });
      await settleCliOneShotSubAgents(session, subAgentFeedback, existingSubAgentIds);
    } finally {
      cleanupCliOneShotSubAgents(session.key, subAgentFeedback, existingSubAgentIds);
      await session.cleanup({
        finalizeMemory: options.finalizeMemory !== false,
        finalizationReason: 'session_close',
      });
      await stopCommandSupport();
      restoreLoggerMode();
    }
    return;
  }

  // 交互式对话模式（默认）
  await interactiveChat(session, restoreLoggerMode, subAgentFeedback, roleName);
}

export function registerCliSubAgentCallbacks(
  session: AgentSession,
  renderFeedback: (session: AgentSession, text: string) => Promise<void> = sendSingleMessage,
): CliSubAgentFeedbackHandle {
  let feedbackQueue: Promise<void> = Promise.resolve();
  let feedbackGeneration = 0;
  let disposed = false;
  const enqueue = (text: string): Promise<void> => {
    if (disposed) return Promise.resolve();
    feedbackGeneration += 1;
    const current = feedbackQueue.then(async () => {
      while (!disposed && session.isBusy()) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (disposed) return;
      await renderFeedback(session, text);
    });
    feedbackQueue = current.catch(error => {
      Logger.warning(`CLI 处理子智能体反馈失败: ${error?.message || error}`);
    });
    return feedbackQueue;
  };

  const platformCallbacks = {
    injectMessage: enqueue,
  };
  SubAgentManager.getInstance().registerPlatformCallbacks(session.key, platformCallbacks);

  return {
    enqueue,
    generation: () => feedbackGeneration,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      SubAgentManager.getInstance().unregisterPlatformCallbacks(session.key, platformCallbacks);
    },
    drain: async () => {
      while (true) {
        const current = feedbackQueue;
        await current;
        if (current === feedbackQueue) return;
      }
    },
  };
}

export async function settleCliOneShotSubAgents(
  session: Pick<AgentSession, 'key' | 'isBusy'>,
  feedback: CliSubAgentFeedbackHandle,
  existingSubAgentIds: ReadonlySet<string> = new Set(),
  options: CliOneShotSubAgentOptions = {},
): Promise<'none' | 'completed' | 'waiting_stopped' | 'timed_out'> {
  const manager = SubAgentManager.getInstance();
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_CLI_ONE_SHOT_SUBAGENT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_CLI_ONE_SHOT_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  const trackedIds = new Set<string>();
  const handledWaitingIds = new Set<string>();
  let sawWaiting = false;

  const tracked = () => manager
    .listByParent(session.key)
    .filter(item => !existingSubAgentIds.has(item.id));

  while (true) {
    const current = tracked();
    for (const item of current) trackedIds.add(item.id);

    for (const item of current) {
      if (item.status !== 'waiting_for_input' || handledWaitingIds.has(item.id)) continue;
      handledWaitingIds.add(item.id);
      sawWaiting = true;
      manager.stopForParent(session.key, item.id);
      await feedback.enqueue([
        `[子智能体 ${item.id} 已停止]`,
        `任务：${item.taskDescription}`,
        `原因：CLI 单条消息模式无法继续交互式恢复 waiting_for_input 任务。`,
        ...(item.pendingQuestion ? [`待回复问题：${item.pendingQuestion}`] : []),
        `请明确告知用户改用 \`xiaoba chat -i\` 重试；不要在本次单条消息中重新派发同一任务。`,
      ].join('\n'));
    }

    const active = tracked().filter(item => (
      item.status === 'running' || item.status === 'waiting_for_input'
    ));

    if (active.length === 0) {
      if (trackedIds.size === 0) return 'none';
      await feedback.drain();
      const stableGeneration = feedback.generation();
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      await feedback.drain();
      const activeAfterDrain = tracked().filter(item => (
        item.status === 'running' || item.status === 'waiting_for_input'
      ));
      if (activeAfterDrain.length === 0 && stableGeneration === feedback.generation()) {
        return sawWaiting ? 'waiting_stopped' : 'completed';
      }
      continue;
    }

    if (Date.now() >= deadline) {
      for (const item of active) {
        manager.stopForParent(session.key, item.id);
      }
      await feedback.enqueue([
        `[CLI 单条消息后台任务已超时并停止]`,
        `等待超过 ${timeoutMs}ms，已停止 ${active.length} 个仍在运行或等待输入的子智能体。`,
        `请明确告知用户改用 \`xiaoba chat -i\` 重试或缩小任务范围；不要在本次单条消息中继续派发后台任务。`,
      ].join('\n'));
      await feedback.drain();
      for (const item of tracked().filter(candidate => (
        candidate.status === 'running' || candidate.status === 'waiting_for_input'
      ))) {
        manager.stopForParent(session.key, item.id);
      }
      return 'timed_out';
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * one-shot 命令的兜底清理。即使首轮模型调用或反馈处理异常，也只停止本次命令
 * 新建的活跃子任务，并释放 CLI 自己注册的 callback。
 */
export function cleanupCliOneShotSubAgents(
  sessionKey: string,
  feedback: CliSubAgentFeedbackHandle,
  existingSubAgentIds: ReadonlySet<string> = new Set(),
): number {
  const manager = SubAgentManager.getInstance();
  let stoppedCount = 0;
  for (const item of manager.listByParent(sessionKey)) {
    if (
      !existingSubAgentIds.has(item.id)
      && (item.status === 'running' || item.status === 'waiting_for_input')
      && manager.stopForParent(sessionKey, item.id) === 'stopped'
    ) {
      stoppedCount += 1;
    }
  }
  feedback.dispose();
  return stoppedCount;
}

/**
 * 创建支持流式输出的 ConversationRunner 回调
 * spinner 在首个文本片段到达时自动停止，文本直接写入 stdout
 */
function createStreamingCallbacks(spinner: ora.Ora): { callbacks: SessionCallbacks; didStream: () => boolean } {
  let streaming = false;
  let streamed = false;

  const callbacks: SessionCallbacks = {
    onText: (text: string) => {
      if (!streaming) {
        spinner.stop();
        process.stdout.write('\n');
        streaming = true;
        streamed = true;
      }
      process.stdout.write(text);
    },
    onToolStart: (name: string, toolUseId: string, input: any) => {
      // 如果上一轮有流式输出，先换行
      if (streaming) {
        process.stdout.write('\n');
        streaming = false;
      }
      spinner.stop();
      Logger.info(`执行工具: ${name}`);
      spinner.start();
      spinner.text = styles.text('执行工具...');
    },
    onToolEnd: () => {
      spinner.text = styles.text('思考中...');
    },
    onToolDisplay: (_name: string, content: string) => {
      spinner.stop();
      console.log(content);
      spinner.start();
    }
  };

  return { callbacks, didStream: () => streamed };
}

export async function sendSingleMessage(
  session: AgentSession,
  message: string,
  options: { recordInbound?: boolean; roleName?: string; traceId?: string } = {},
): Promise<void> {
  const turn = options.recordInbound === true
    ? await recordVisibleInbound({
      surface: 'cli',
      sessionKey: session.key,
      content: [{ type: 'text', text: message }],
      traceId: options.traceId,
    })
    : {
      surface: 'cli' as const,
      sessionKey: session.key,
      traceId: options.traceId || reserveConversationTraceId('cli', session.key),
    };
  const spinner = ora(styles.text('思考中...')).start();

  const { callbacks, didStream } = createStreamingCallbacks(spinner);
  const result = await session.handleMessage(message, {
    callbacks,
    surface: 'cli',
    traceId: turn.traceId,
  });

  spinner.stop();
  if (didStream()) {
    process.stdout.write('\n\n');
  } else {
    // 没有流式输出（如错误信息），直接打印返回值
    console.log('\n' + result.text + '\n');
  }
  await recordCliReply(turn, result.text, options.roleName, 'cli:direct');
}

async function interactiveChat(
  session: AgentSession,
  restoreLoggerMode: () => void,
  subAgentFeedback: CliSubAgentFeedbackHandle,
  roleName?: string,
): Promise<void> {
  // 保存原始的 process.exit 函数
  const originalExit = process.exit.bind(process);
  let isExiting = false;
  // A pending Promise does not keep Node alive; this timer is the interactive session handle.
  const interactiveKeepAliveTimer = setInterval(() => {}, 1000);

  const stopInteractiveKeepAlive = () => {
    clearInterval(interactiveKeepAliveTimer);
  };

  /** 统一的退出清理逻辑 */
  const gracefulExit = (code: number) => {
    if (isExiting) {
      originalExit(code);
      return;
    }
    isExiting = true;
    console.log('\n');

    const keepAliveTimer = setInterval(() => {}, 100);
    const cleanup = async () => {
      try {
        subAgentFeedback.dispose();
        await session.cleanup({ finalizeMemory: true, finalizationReason: 'session_close' });
        await stopCommandSupport();
        await shutdownObservability();
        Logger.info('已保存对话历史');
        console.log(styles.text('再见！期待下次与你对话。\n'));
      } finally {
        clearInterval(keepAliveTimer);
        stopInteractiveKeepAlive();
        restoreLoggerMode();
        originalExit(code);
      }
    };
    cleanup();
  };

  // 覆盖 process.exit，确保在任何退出情况下都能保存记忆
  (process.exit as any) = (code?: number) => gracefulExit(code ?? 0);

  // 使用 prependListener 确保我们的处理器优先执行
  process.prependListener('SIGINT', () => gracefulExit(0));

  console.log(
    styles.text('开始对话吧！输入消息后按回车发送。\n输入 ') +
    styles.highlight('/exit') + styles.text(' 退出对话，输入 ') +
    styles.highlight('/stop') + styles.text(' 暂停会话，输入 ') +
    styles.highlight('/clear') + styles.text(' 清空历史，输入 ') +
    styles.highlight('/clear --all') + styles.text(' 清空历史并删除文件，输入 ') +
    styles.highlight('/skills') + styles.text(' 查看可用技能。\n输入 ') +
    styles.highlight('/history') + styles.text(' 查看历史信息。需要恢复上次 CLI 上下文时用 ') +
    styles.highlight('--resume') + styles.text(' 启动。\n'),
  );

  // 创建 readline 接口
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: styles.highlight('> '),
  });
  process.stdin.resume();

  const promptForNextInput = () => {
    rl.resume();
    rl.prompt();
  };

  // 处理每一行输入
  rl.on('line', async (message: string) => {
    if (!message.trim()) {
      promptForNextInput();
      return;
    }

    const turn = await recordVisibleInbound({
      surface: 'cli',
      sessionKey: session.key,
      content: [{ type: 'text', text: message }],
    });

    // 处理斜杠命令
    if (message.startsWith('/')) {
      const parts = message.slice(1).split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1);
      const cmdName = command.toLowerCase();

      // /exit：直接退出，不走 gracefulExit 避免双重告别
      if (cmdName === 'exit') {
        const result = await session.handleCommand(command, args, {
          surface: 'cli',
          traceId: turn.traceId,
        });
        if (result.reply) {
          console.log('\n' + styles.text(result.reply) + '\n');
          await recordCliReply(turn, result.reply, roleName, 'cli:command');
        }
        isExiting = true;
        rl.close();
        subAgentFeedback.dispose();
        await stopCommandSupport();
        stopInteractiveKeepAlive();
        restoreLoggerMode();
        originalExit(0);
        return;
      }

      // 简单内置命令：不需要 spinner
      if (['clear', 'skills', 'history'].includes(cmdName)) {
        const result = await session.handleCommand(command, args, {
          surface: 'cli',
          traceId: turn.traceId,
        });
        if (result.handled && result.reply) {
          console.log('\n' + result.reply);
          await recordCliReply(turn, result.reply, roleName, 'cli:command');
        }
        promptForNextInput();
        return;
      }

      // 可能涉及 AI 的命令（skill 等）
      const spinner = ora({ text: styles.text('思考中...'), color: 'yellow', discardStdin: false }).start();
      const { callbacks, didStream } = createStreamingCallbacks(spinner);

      const result = await session.handleCommand(command, args, {
        callbacks,
        surface: 'cli',
        traceId: turn.traceId,
      });
      spinner.stop();

      if (result.handled) {
        if (didStream()) {
          process.stdout.write('\n\n');
        } else if (result.reply) {
          console.log('\n' + result.reply);
        }
        if (result.reply) {
          await recordCliReply(turn, result.reply, roleName, 'cli:command');
        }
        promptForNextInput();
        return;
      }
    }

    // 处理退出命令（向后兼容）
    if (message.toLowerCase() === 'exit' || message.toLowerCase() === 'quit') {
      await session.summarizeAndDestroy();
      subAgentFeedback.dispose();
      await stopCommandSupport();
      console.log('\n' + styles.text('再见！期待下次与你对话。') + '\n');
      await recordCliReply(turn, '再见！期待下次与你对话。', roleName, 'cli:exit');
      isExiting = true;
      rl.close();
      Logger.info('再见！期待下次与你对话。');
      stopInteractiveKeepAlive();
      restoreLoggerMode();
      originalExit(0);
      return;
    }

    // 普通消息
    const spinner = ora({ text: styles.text('思考中...'), color: 'yellow', discardStdin: false }).start();
    const { callbacks, didStream } = createStreamingCallbacks(spinner);

    const result = await session.handleMessage(message, {
      callbacks,
      surface: 'cli',
      traceId: turn.traceId,
    });

    spinner.stop();
    if (didStream()) {
      process.stdout.write('\n\n');
    } else {
      console.log('\n' + result.text + '\n');
    }
    await recordCliReply(turn, result.text, roleName, 'cli:direct');

    promptForNextInput();
  });

  // 处理 Ctrl+C
  rl.on('SIGINT', () => {
    rl.pause();
    gracefulExit(0);
  });

  // 处理 readline 关闭
  rl.on('close', () => {
    if (!isExiting) {
      process.exit(0);
    }
  });

  // 显示第一个提示符
  promptForNextInput();
  await new Promise<void>(() => undefined);
}

async function recordCliReply(
  turn: ConversationTurnContext,
  text: string | undefined,
  roleName: string | undefined,
  deliveryKey: string,
): Promise<void> {
  if (!text) return;
  await recordVisibleAssistant({
    ...turn,
    roleName,
    content: [{ type: 'text', text }],
    deliveryKey,
  });
}
