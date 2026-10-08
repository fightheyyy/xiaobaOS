import { SubAgentJournal } from './sub-agent-journal';
import { AIService } from '../utils/ai-service';
import { SkillManager } from '../skills/skill-manager';
import { Logger } from '../utils/logger';
import { SubAgentSession, SubAgentInfo, SubAgentSpawnOptions, SubAgentStatus } from './sub-agent-session';
import { randomUUID } from 'crypto';

// ─── 平台回调注册 ───────────────────────────────────────

export interface PlatformCallbacks {
  /** 向主会话投递消息，触发主 agent 新一轮推理 */
  injectMessage: (text: string) => Promise<void>;
}

export type StopSubAgentResult = 'stopped' | 'not_found' | 'forbidden' | 'not_running';

// ─── SubAgentManager ────────────────────────────────────

/**
 * SubAgentManager - 子智能体管理器（单例）
 *
 * 管理所有后台运行的 SubAgentSession 的生命周期。
 * 按 parentSessionKey 隔离，每个主会话最多同时运行 MAX_CONCURRENT 个子任务。
 */
export class SubAgentManager {
  private static instance: SubAgentManager;

  /** 所有子智能体，key = subagent id */
  private subAgents = new Map<string, SubAgentSession>();
  /** 子智能体 → 父会话 key 的映射 */
  private parentMap = new Map<string, string>();
  /** 持久化的平台回调，key = 父会话 sessionKey */
  private platformCallbacks = new Map<string, PlatformCallbacks>();
  private callbackOwners = new Map<string, object>();

  private static readonly MAX_CONCURRENT_PER_SESSION = 3;
  /** 完成后保留信息的时间（ms） */
  private static readonly RETENTION_MS = 30 * 60 * 1000;

  private static isActiveStatus(status: SubAgentStatus): boolean {
    return status === 'running' || status === 'waiting_for_input';
  }

  private constructor() { }

  static getInstance(): SubAgentManager {
    if (!SubAgentManager.instance) {
      SubAgentManager.instance = new SubAgentManager();
    }
    return SubAgentManager.instance;
  }

  // ─── 平台回调注册（由 FeishuBot 等消息入口调用，持久化） ─

  /**
   * 注册平台回调。消息入口在创建/获取 session 时调用一次，
   * 不随 handleMessage 结束而注销，保证子智能体完成后能通知主 Agent。
   */
  registerPlatformCallbacks(sessionKey: string, callbacks: PlatformCallbacks): void {
    this.platformCallbacks.set(sessionKey, callbacks);
    this.callbackOwners.delete(sessionKey);
  }

  /** New message in the SAME live Surface: keep child ownership, refresh its route. */
  refreshPlatformCallbacks(sessionKey: string, callbacks: PlatformCallbacks, owner?: object): void {
    const current = this.platformCallbacks.get(sessionKey);
    if (current && this.callbackOwners.get(sessionKey) === owner) current.injectMessage = callbacks.injectMessage;
    else {
      this.registerPlatformCallbacks(sessionKey, callbacks);
      if (owner) this.callbackOwners.set(sessionKey, owner);
    }
  }

  unregisterPlatformCallbacksForOwner(sessionKey: string, owner: object): void {
    if (this.callbackOwners.get(sessionKey) === owner) this.unregisterPlatformCallbacks(sessionKey);
  }

  /**
   * 注销平台回调。传入 expectedCallbacks 时只删除同一个注册实例，避免旧会话
   * 的迟到 cleanup 误删已经接管相同 session key 的新会话回调。
   */
  unregisterPlatformCallbacks(
    sessionKey: string,
    expectedCallbacks?: PlatformCallbacks,
  ): boolean {
    const current = this.platformCallbacks.get(sessionKey);
    if (!current || (expectedCallbacks && current !== expectedCallbacks)) {
      return false;
    }
    this.callbackOwners.delete(sessionKey);
    return this.platformCallbacks.delete(sessionKey);
  }

  // ─── 子智能体生命周期 ─────────────────────────────────

  /**
   * 派遣子智能体执行任务
   */
  spawn(
    parentSessionKey: string,
    skillName: string | undefined,
    taskDescription: string,
    userMessage: string,
    workingDirectory: string,
    aiService: AIService,
    skillManager: SkillManager,
    spawnOptions: Pick<SubAgentSpawnOptions, 'roleName' | 'allowSkillSelection' | 'observabilityContext' | 'parentSessionId'> = {},
  ): SubAgentInfo | { error: string } {
    // 并发限制
    const active = this.listByParent(parentSessionKey,workingDirectory).filter(s => SubAgentManager.isActiveStatus(s.status));
    if (active.length >= SubAgentManager.MAX_CONCURRENT_PER_SESSION) {
      return { error: `最多同时运行 ${SubAgentManager.MAX_CONCURRENT_PER_SESSION} 个子任务，当前已有 ${active.length} 个在运行或等待输入` };
    }

    // 检查显式 skill 是否存在；没有预选 skill 时允许 role-only 或 no-skill 运行。
    const skill = skillName ? skillManager.getSkill(skillName) : undefined;
    if (skillName && !skill) {
      return { error: `Skill "${skillName}" 不存在` };
    }

    const id = `sub-${randomUUID()}`;

    // 获取平台回调（子智能体需要 injectMessage 向主 Agent 报告）
    const platform = this.platformCallbacks.get(parentSessionKey);
    if (!platform) {
      return { error: '平台回调未注册，无法派遣子智能体' };
    }

    const journal = new SubAgentJournal(workingDirectory);
    const options: SubAgentSpawnOptions = {
      onStateChange: info => journal.record(parentSessionKey,info),
      skillName,
      taskDescription,
      userMessage,
      workingDirectory,
      roleName: spawnOptions.roleName,
      allowSkillSelection: spawnOptions.allowSkillSelection ?? Boolean(spawnOptions.roleName && !skillName),
      observabilityContext: spawnOptions.observabilityContext,
      parentSessionId: spawnOptions.parentSessionId ?? parentSessionKey,
      notifyParent: async (subAgentId, taskDesc, question) => {
        const msg = `[子智能体 ${subAgentId} 反馈]\n任务：${taskDesc}\n需要你的指示：${question}`;
        if(this.platformCallbacks.get(parentSessionKey)!==platform) throw new Error('Parent callback is no longer registered.');
        await platform.injectMessage(msg);
      },
    };

    const session = new SubAgentSession(id, aiService, skillManager, options);
    journal.record(parentSessionKey,session.getInfo());
    this.subAgents.set(id, session);
    this.parentMap.set(id, parentSessionKey);

    // fire-and-forget
    session.run().finally(() => {
      journal.record(parentSessionKey,session.getInfo());
      // 通知主 agent 子智能体已完成（stopped 不通知）
      if (session.status !== 'stopped' && this.platformCallbacks.get(parentSessionKey)===platform) {
        const info = session.getInfo();
        const statusLabel = info.status === 'completed' ? '已完成' : '失败';
        const fileList = info.outputFiles.length > 0
          ? `\n产出文件：\n${info.outputFiles.map(f => `- ${f}`).join('\n')}`
          : '';
        const msg = `[子智能体 ${id} ${statusLabel}]\n任务：${taskDescription}\n结果：${info.resultSummary || '（无结果）'}${fileList}`;
        platform.injectMessage(msg).catch(err => {
          Logger.warning(`[SubAgentManager] 通知主 agent 失败: ${err.message}`);
        });
      }

      // 完成后保留一段时间供查询，然后清理
      const retentionTimer = setTimeout(() => {
        this.subAgents.delete(id);
        this.parentMap.delete(id);
        journal.remove(id);
      }, SubAgentManager.RETENTION_MS);
      retentionTimer.unref?.();
    }).catch(error => Logger.warning(`[SubAgentManager] 子任务结束记录失败: ${error.message}`));

    const skillLabel = skillName || (options.allowSkillSelection ? 'role-selected skill' : 'no skill');
    Logger.info(`[SubAgentManager] 派遣 ${id} 执行 "${skillLabel}"${options.roleName ? ` as ${options.roleName}` : ''} (父会话: ${parentSessionKey})`);
    return session.getInfo();
  }

  /**
   * 停止子智能体
   */
  stop(subAgentId: string): boolean {
    const session = this.subAgents.get(subAgentId);
    if (!session || !SubAgentManager.isActiveStatus(session.status)) {
      return false;
    }
    session.stop();
    Logger.info(`[SubAgentManager] 已停止 ${subAgentId}`);
    return true;
  }

  /**
   * 按父会话停止子智能体（防止跨会话越权）
   */
  stopForParent(parentSessionKey: string, subAgentId: string): StopSubAgentResult {
    const owner = this.parentMap.get(subAgentId);
    if (!owner) {
      return 'not_found';
    }
    if (owner !== parentSessionKey) {
      return 'forbidden';
    }

    const session = this.subAgents.get(subAgentId);
    if (!session) {
      return 'not_found';
    }
    if (!SubAgentManager.isActiveStatus(session.status)) {
      return 'not_running';
    }

    session.stop();
    Logger.info(`[SubAgentManager] 已停止 ${subAgentId} (父会话: ${parentSessionKey})`);
    return 'stopped';
  }

  /**
   * 恢复挂起的子智能体（主 agent 提供答案）
   */
  resumeForParent(parentSessionKey: string, subAgentId: string, answer: string): 'resumed' | 'not_found' | 'forbidden' | 'not_waiting' {
    const owner = this.parentMap.get(subAgentId);
    if (!owner) return 'not_found';
    if (owner !== parentSessionKey) return 'forbidden';

    const session = this.subAgents.get(subAgentId);
    if (!session) return 'not_found';
    if (!session.resume(answer)) return 'not_waiting';

    Logger.info(`[SubAgentManager] 已恢复 ${subAgentId} (父会话: ${parentSessionKey})`);
    return 'resumed';
  }

  /**
   * 子智能体请求父会话输入。
   */
  async requestParentInput(subAgentId: string, question: string): Promise<string> {
    const session = this.subAgents.get(subAgentId);
    if (!session) {
      throw new Error(`未找到子智能体 ${subAgentId}`);
    }
    return session.waitForParentInput(question);
  }

  /**
   * 查询单个子智能体状态
   */
  getInfo(subAgentId: string): SubAgentInfo | undefined {
    return this.subAgents.get(subAgentId)?.getInfo();
  }

  /**
   * 按父会话查询子智能体（防止跨会话越权）
   */
  getInfoForParent(parentSessionKey: string, subAgentId: string, root = process.cwd()): SubAgentInfo | undefined {
    const owner = this.parentMap.get(subAgentId);
    if (!owner) return new SubAgentJournal(root).list(parentSessionKey).find(info=>info.id===subAgentId);
    if (owner !== parentSessionKey) return undefined;
    return this.subAgents.get(subAgentId)?.getInfo();
  }

  /**
   * 列出某个父会话下的所有子智能体
   */
  listByParent(parentSessionKey: string, root = process.cwd()): SubAgentInfo[] {
    const result: SubAgentInfo[] = [];
    for (const [id, session] of this.subAgents) {
      if (this.parentMap.get(id) === parentSessionKey) {
        result.push(session.getInfo());
      }
    }
    const known=new Set(result.map(info=>info.id));
    result.push(...new SubAgentJournal(root).list(parentSessionKey).filter(info=>!known.has(info.id)));
    return result;
  }
}
