import { RoleConfig } from '../types/role';
import { ActiveRoleContext } from './active-role-context';

const ROLE_ENV_KEYS = ['XIAOBA_ROLE', 'CURRENT_ROLE'] as const;
const DEFAULT_ROLE_NAMES = new Set(['', 'base', 'default', 'none']);

export class RoleResolver {
  static getProjectRoot(): string {
    return ActiveRoleContext.getProjectRoot();
  }

  static getRolesRoot(): string {
    return ActiveRoleContext.getRolesRoot();
  }

  static normalizeRoleName(roleName: string): string {
    return ActiveRoleContext.normalizeRoleName(roleName);
  }

  static getRequestedRoleName(
    roleName?: string,
    environment: NodeJS.ProcessEnv = process.env,
  ): string {
    return roleName?.trim()
      || environment.XIAOBA_ROLE?.trim()
      || environment.CURRENT_ROLE?.trim()
      || '';
  }

  static isBaseRoleName(roleName: string): boolean {
    return DEFAULT_ROLE_NAMES.has(this.normalizeRoleName(roleName));
  }

  static activateRole(roleName?: string): void {
    const requested = this.getRequestedRoleName(roleName);

    if (this.isBaseRoleName(requested)) {
      this.clearActiveRole();
      return;
    }

    const resolvedRoleDir = ActiveRoleContext.resolveRoleDirectoryName(requested);
    if (!resolvedRoleDir) {
      const available = ActiveRoleContext.listAvailableRoles();
      const detail = available.length > 0
        ? `可用角色：${available.join(', ')}`
        : '当前项目还没有 roles 目录或角色定义。';
      throw new Error(`未找到角色 "${requested}"。${detail}`);
    }

    process.env.XIAOBA_ROLE = resolvedRoleDir;
    process.env.CURRENT_ROLE = resolvedRoleDir;

    const config = this.getRoleConfig(resolvedRoleDir);
    if (config?.displayName) {
      process.env.CURRENT_ROLE_DISPLAY_NAME = config.displayName;
    } else {
      delete process.env.CURRENT_ROLE_DISPLAY_NAME;
    }
  }

  static clearActiveRole(): void {
    for (const key of ROLE_ENV_KEYS) {
      delete process.env[key];
    }
    delete process.env.CURRENT_ROLE_DISPLAY_NAME;
  }

  static getActiveRoleName(): string | undefined {
    return ActiveRoleContext.getActiveRoleName();
  }

  static getActiveRolePath(): string | undefined {
    return ActiveRoleContext.getActiveRolePath();
  }

  static getActiveRoleConfig(): RoleConfig | undefined {
    return ActiveRoleContext.getActiveRoleConfig();
  }

  static getRoleConfig(roleDirName: string): RoleConfig | undefined {
    return ActiveRoleContext.getRoleConfig(roleDirName);
  }

  static listAvailableRoles(): string[] {
    return ActiveRoleContext.listAvailableRoles();
  }

  static resolveRoleDirectoryName(roleName: string): string | undefined {
    return ActiveRoleContext.resolveRoleDirectoryName(roleName);
  }

}
