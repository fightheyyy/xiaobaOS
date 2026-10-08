import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PathResolver } from './path-resolver';
import { ActiveRoleContext } from './active-role-context';

/**
 * System Prompt 管理器
 */
export class PromptManager {
  private static promptsDir = path.join(__dirname, '../../prompts');

  private static resolveRoleName(roleName?: string): string | undefined {
    return roleName ? ActiveRoleContext.resolveRoleDirectoryName(roleName) : ActiveRoleContext.getActiveRoleName();
  }

  private static getRuntimeEnvironmentInfo(platform: NodeJS.Platform = process.platform): string[] {
    const normalized = platform.toLowerCase() as NodeJS.Platform;

    if (normalized === 'win32') {
      return [
        '当前操作系统：Windows',
        'execute_shell 默认使用系统 shell；在 Windows 下按 cmd.exe 语义优先思考。如需 PowerShell，请显式写 `powershell -Command "..."`。',
        'Windows 下优先使用 `read_file`、`glob`、`grep` 等工具；必须走 shell 时优先考虑 `dir`、`type`、`findstr`、`if exist`。',
        'Windows 下避免默认使用 `ls`、`head`、`tail`、`find -maxdepth` 这类 Unix 风格命令。',
      ];
    }

    if (normalized === 'darwin') {
      return [
        '当前操作系统：macOS',
        'execute_shell 默认按 Unix shell 语义工作，可优先考虑 `ls`、`cat`、`grep`、`find`。',
        'macOS 自带命令多为 BSD 版本，避免默认假设 GNU 专属参数一定可用。',
      ];
    }

    if (normalized === 'linux') {
      return [
        '当前操作系统：Linux',
        'execute_shell 默认按 Unix shell 语义工作，可优先考虑 `ls`、`cat`、`grep`、`find`。',
        'Linux 环境通常兼容常见 POSIX/GNU 命令，但仍应优先使用结构化工具而不是长链式 shell。',
      ];
    }

    const label = os.platform();
    return [
      `当前操作系统：${label}`,
      'execute_shell 使用系统默认 shell。执行命令前先判断平台兼容性，并优先使用结构化工具。',
    ];
  }

  private static readPromptFile(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return undefined;
    }
  }

  private static expandPromptIncludes(content: string, sourceDir?: string, includeStack: Set<string> = new Set()): string {
    return content.replace(/^\s*\{\{\s*include:([^}]+)\s*\}\}\s*$/gm, (_match, rawName: string) => {
      const includeName = rawName.trim();
      if (!includeName || path.isAbsolute(includeName) || includeName.split(/[\\/]+/).includes('..')) {
        return '';
      }

      const candidates = [
        sourceDir ? path.join(sourceDir, includeName) : undefined,
        this.getBasePromptPath(includeName),
      ].filter((item): item is string => Boolean(item));

      const includePath = candidates.find(candidate => fs.existsSync(candidate));
      if (!includePath) {
        return '';
      }

      const resolvedPath = path.resolve(includePath);
      if (includeStack.has(resolvedPath)) {
        return '';
      }

      includeStack.add(resolvedPath);
      try {
        const included = this.readPromptFile(resolvedPath) || '';
        return this.expandPromptIncludes(included, path.dirname(resolvedPath), includeStack).trim();
      } finally {
        includeStack.delete(resolvedPath);
      }
    });
  }

  private static resolvePromptFile(fileName: string, roleName?: string): string | undefined {
    const rolePromptPath = roleName
      ? PathResolver.getRoleSubPathForRole(roleName, path.join('prompts', fileName))
      : PathResolver.getRoleSubPath(path.join('prompts', fileName));
    if (rolePromptPath && fs.existsSync(rolePromptPath)) {
      return rolePromptPath;
    }

    const basePromptPath = path.join(this.promptsDir, fileName);
    return fs.existsSync(basePromptPath) ? basePromptPath : undefined;
  }

  private static getBasePromptPath(fileName: string): string | undefined {
    const candidates = [
      path.join(PathResolver.getPromptsPath(), fileName),
      path.join(this.promptsDir, fileName),
    ];

    return candidates.find(candidate => fs.existsSync(candidate));
  }

  private static normalizeBehaviorPrompt(content: string | undefined): string {
    const trimmed = (content || '').trim();
    if (!trimmed || trimmed.includes('（在下方添加你的个性化设置）')) {
      return '';
    }
    return trimmed;
  }

  /**
   * 获取基础 system prompt
   */
  static getBaseSystemPrompt(roleName?: string): string {
    try {
      const resolvedRoleName = this.resolveRoleName(roleName);
      const roleConfig = resolvedRoleName
        ? ActiveRoleContext.getRoleConfig(resolvedRoleName)
        : undefined;
      const promptFile = roleConfig?.promptFile || 'system-prompt.md';
      const resolvedPath = this.resolvePromptFile(promptFile, resolvedRoleName);
      if (resolvedPath) {
        return this.expandPromptIncludes(fs.readFileSync(resolvedPath, 'utf-8'), path.dirname(resolvedPath));
      }
      if (promptFile !== 'system-prompt.md') {
        const fallbackPath = this.resolvePromptFile('system-prompt.md', resolvedRoleName);
        if (fallbackPath) {
          return this.expandPromptIncludes(fs.readFileSync(fallbackPath, 'utf-8'), path.dirname(fallbackPath));
        }
      }
      return this.getDefaultSystemPrompt();
    } catch (error) {
      return this.getDefaultSystemPrompt();
    }
  }

  /**
   * 获取 channel surface 交付规则 prompt。
   */
  static getSurfacePrompt(): string {
    try {
      const surfacePromptPath = this.getBasePromptPath('surface.md');
      if (surfacePromptPath) {
        const content = this.expandPromptIncludes(
          fs.readFileSync(surfacePromptPath, 'utf-8'),
          path.dirname(surfacePromptPath),
        ).trim();
        if (content) {
          return content;
        }
      }
    } catch {
      // Fall through to the embedded fallback so channel delivery stays explicit.
    }

    return this.getDefaultSurfacePrompt();
  }

  /**
   * 获取 behavior prompt（用户偏好）
   */
  static getBehaviorPrompt(roleName?: string): string {
    try {
      const resolvedRoleName = this.resolveRoleName(roleName);
      const paths = [
        this.getBasePromptPath('behavior.md'),
        resolvedRoleName
          ? PathResolver.getRoleSubPathForRole(resolvedRoleName, path.join('prompts', 'behavior.md'))
          : PathResolver.getRoleSubPath(path.join('prompts', 'behavior.md')),
      ].filter((item): item is string => Boolean(item));

      const seen = new Set<string>();
      const parts: string[] = [];
      for (const promptPath of paths) {
        const resolved = path.resolve(promptPath);
        if (seen.has(resolved) || !fs.existsSync(resolved)) {
          continue;
        }
        seen.add(resolved);
        const content = this.normalizeBehaviorPrompt(this.readPromptFile(resolved));
        if (content) {
          parts.push(content);
        }
      }

      return parts.join('\n\n');
    } catch {
      return '';
    }
  }

  /**
   * 构建完整 system prompt（包含运行时信息）
   */
  static async buildSystemPrompt(options: { roleName?: string } = {}): Promise<string> {
    const resolvedRoleName = this.resolveRoleName(options.roleName);
    const basePrompt = this.getBaseSystemPrompt(resolvedRoleName).trim();
    const behaviorPrompt = this.getBehaviorPrompt(resolvedRoleName).trim();
    const displayName = (
      process.env.CURRENT_AGENT_DISPLAY_NAME
      || process.env.BOT_BRIDGE_NAME
      || ''
    ).trim();
    const roleName = resolvedRoleName || '';
    const roleDisplayName = roleName
      ? (ActiveRoleContext.getRoleConfig(roleName)?.displayName || roleName)
      : '';
    const platform = process.env.CURRENT_PLATFORM || '';
    const runtimeEnvironmentInfo = this.getRuntimeEnvironmentInfo();

    // 动态生成工作空间路径
    const workspaceName = displayName || 'default';
    const workspacePath = `~/xiaoba-workspace/${workspaceName}`;

    const runtimeInfo = [
      displayName ? `你在这个平台上的名字是：${displayName}` : '',
      roleName ? `当前角色：${roleDisplayName}` : '',
      platform ? `当前平台：${platform}` : '',
      this.getCurrentTimeInfo(),
      `你的默认工作目录是：\`${workspacePath}\``,
      ...runtimeEnvironmentInfo,
    ].filter(Boolean).join('\n');

    return [basePrompt, behaviorPrompt, runtimeInfo].filter(Boolean).join('\n\n');
  }

  /** Refresh on every request; durable sessions can live across local midnight. */
  static getCurrentTimeInfo(now = new Date()): string {
    const localTime = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now);
    return `当前日期：${localTime.slice(0, 10)}\n当前时间：${localTime}（Asia/Shanghai，UTC+08:00）；UTC 时间：${now.toISOString()}。定时工具需要带时区的绝对时间。`;
  }

  /**
   * 默认 system prompt（当文件不存在时使用）
   */
  private static getDefaultSystemPrompt(): string {
    return `你是小八。

你和用户交流时，保持自然、直接、可信。

工作原则：
1. 只根据当前对话、真实上下文和当前运行时提供的能力行动。
2. 不编造自己拥有的工具、技能、历史记忆或已完成的工作。
3. 先理解问题，再决定是否需要行动或回复。
4. 当前这一轮没有新信息时，不要为了显得热情而额外寒暄。`;
  }

  private static getDefaultSurfacePrompt(): string {
    return '【消息交付规则（强制）】当前是 channel-delivered 消息会话。只有 send_text 和 send_file 会产生用户可见输出；最终直接文本回复默认不会发送给用户。';
  }
}
