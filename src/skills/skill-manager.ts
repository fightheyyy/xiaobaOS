import { Skill } from '../types/skill';
import { PathResolver } from '../utils/path-resolver';
import { ActiveRoleContext } from '../utils/active-role-context';
import { SkillParser } from './skill-parser';
import { Logger } from '../utils/logger';

const DEFAULT_EXCLUDED_BASE_SKILLS = new Set([
  'WebCLI',
  'webcli',
  'OfficeCLI',
  'officecli-docx',
  'officecli-pptx',
  'officecli-xlsx',
  'vision-analysis',
  'sub-agent',
  'background-task-runner',
]);

export const DEFAULT_BUNDLED_BASE_SKILLS = [] as const;

/**
 * Skills 管理器
 */
export class SkillManager {
  private skills: Map<string, Skill>;
  private skillAliases: Map<string, string>;
  private skillsPath: string;

  constructor(private readonly roleName?: string) {
    this.skills = new Map();
    this.skillAliases = new Map();
    this.skillsPath = roleName
      ? (PathResolver.getRoleSubPathForRole(roleName, 'skills') || PathResolver.getBaseSkillsPath())
      : PathResolver.getSkillsPath();
  }

  /**
   * 加载所有 skills（只从统一目录加载）
   */
  async loadSkills(): Promise<void> {
    this.skills.clear();
    this.skillAliases.clear();

    const resolvedRoleName = this.roleName
      ? ActiveRoleContext.resolveRoleDirectoryName(this.roleName)
      : undefined;
    const roleConfig = resolvedRoleName
      ? ActiveRoleContext.getRoleConfig(resolvedRoleName)
      : ActiveRoleContext.getActiveRoleConfig();
    const inheritBaseSkills = roleConfig?.inheritBaseSkills !== false;
    const excludedBaseSkills = new Set([
      ...DEFAULT_EXCLUDED_BASE_SKILLS,
      ...(roleConfig?.excludeBaseSkills || []).map(name => name.trim()).filter(Boolean),
    ]);

    if (inheritBaseSkills) {
      await this.loadSkillsFromPath(PathResolver.getBaseSkillsPath(), excludedBaseSkills);
    }

    const roleSkillsPath = this.roleName
      ? PathResolver.getRoleSubPathForRole(this.roleName, 'skills')
      : PathResolver.getRoleSubPath('skills');
    if (roleSkillsPath) {
      await this.loadSkillsFromPath(roleSkillsPath);
    }

    if (!inheritBaseSkills && !roleSkillsPath) {
      await this.loadSkillsFromPath(PathResolver.getBaseSkillsPath());
    }
  }

  /**
   * 从指定路径加载 skills
   */
  private async loadSkillsFromPath(basePath: string, excludedSkillNames: Set<string> = new Set()): Promise<void> {
    try {
      const skillFiles = PathResolver.findSkillFiles(basePath);

      for (const filePath of skillFiles) {
        try {
          const skill = SkillParser.parse(filePath);
          if (this.isSkillExcluded(skill.metadata.name, filePath, excludedSkillNames)) {
            continue;
          }
          this.skills.set(skill.metadata.name, skill);
          for (const alias of skill.metadata.aliases || []) {
            const normalizedAlias = this.normalizeSkillName(alias);
            if (normalizedAlias && !this.skills.has(normalizedAlias)) {
              this.skillAliases.set(normalizedAlias, skill.metadata.name);
            }
          }
        } catch (error: any) {
          Logger.warning(`Failed to load skill from ${filePath}: ${error.message}`);
        }
      }
    } catch (error: any) {
      // 目录不存在或无法访问，静默处理
    }
  }

  /** 根据名称或别名获取已安装的 Skill。 */
  getSkill(name: string): Skill | undefined {
    const normalizedName = this.normalizeSkillName(name);
    const direct = Array.from(this.skills.values())
      .find(skill => this.normalizeSkillName(skill.metadata.name) === normalizedName);
    if (direct) {
      return direct;
    }
    const canonicalName = this.skillAliases.get(normalizedName);
    return canonicalName ? this.skills.get(canonicalName) : undefined;
  }

  /** 获取全部已安装的 Skills。 */
  getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * 获取用户可调用的 skills
   */
  getUserInvocableSkills(): Skill[] {
    return this.getAllSkills().filter(skill => skill.metadata.userInvocable !== false);
  }

  /**
   * 获取自动可调用的 skills
   */
  getAutoInvocableSkills(): Skill[] {
    return this.getAllSkills().filter(skill => skill.metadata.autoInvocable !== false);
  }

  /**
   * 根据用户文本匹配可自动触发的 skill
   *
   * 触发策略（保守）：
   * - 必须出现 skill 名称（支持原名、空格变体、下划线变体）
   * - 只匹配 autoInvocable skill
   * - 若多个命中，优先选择名称更长（更具体）的 skill
   */
  findAutoInvocableSkillByText(text: string): Skill | undefined {
    const normalizedText = this.normalizeText(text);
    if (!normalizedText) return undefined;

    const candidates = this.getAutoInvocableSkills()
      .filter(skill => [
        skill.metadata.name,
        ...(skill.metadata.aliases || []),
      ].some(name => this.isSkillMentioned(normalizedText, name)));

    if (candidates.length === 0) {
      return undefined;
    }

    candidates.sort((a, b) => b.metadata.name.length - a.metadata.name.length);
    return candidates[0];
  }

  /**
   * 重新加载 skills
   */
  async reload(): Promise<void> {
    await this.loadSkills();
  }

  private normalizeText(text: string): string {
    return text.trim().toLowerCase();
  }

  private normalizeSkillName(name: string): string {
    return name.trim().toLowerCase();
  }

  private isSkillExcluded(skillName: string, filePath: string, excludedSkillNames: Set<string>): boolean {
    if (excludedSkillNames.size === 0) {
      return false;
    }

    const normalizedExclusions = new Set(
      Array.from(excludedSkillNames)
        .map(name => this.normalizeSkillName(name))
        .filter(Boolean),
    );

    if (normalizedExclusions.has(this.normalizeSkillName(skillName))) {
      return true;
    }

    return filePath
      .split(/[\\/]+/)
      .some(segment => normalizedExclusions.has(this.normalizeSkillName(segment)));
  }

  private isSkillMentioned(text: string, skillName: string): boolean {
    const lowerName = skillName.toLowerCase();
    const variants = Array.from(new Set([
      lowerName,
      lowerName.replace(/-/g, ' '),
      lowerName.replace(/-/g, '_'),
    ])).filter(Boolean);

    return variants.some(variant => this.containsToken(text, variant));
  }

  private containsToken(text: string, token: string): boolean {
    if (!token) return false;

    // 包含空格的短语直接做子串匹配
    if (token.includes(' ')) {
      return text.includes(token);
    }

    // 英文/数字 token 使用边界匹配，避免误匹配子串
    if (/^[a-z0-9_-]+$/.test(token)) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(^|[^a-z0-9_-])${escaped}([^a-z0-9_-]|$)`, 'i');
      return regex.test(text);
    }

    // 其他字符集合（如中文）退化为 includes
    return text.includes(token);
  }
}
