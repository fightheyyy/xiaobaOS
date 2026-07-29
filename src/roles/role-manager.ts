import * as fs from 'fs';
import * as path from 'path';
import { RoleConfig } from '../types/role';
import { RoleResolver } from '../utils/role-resolver';

export const DEFAULT_BUNDLED_ROLES = [
  'user-cat',
  'inspector-cat',
  'engineer-cat',
  'reviewer-cat',
  'browser-cat',
  'gui-cat',
  'secretary-cat',
  'evolution-cat',
] as const;

const BASE_ROLE_NAMES = new Set(['', 'base', 'default', 'none']);

export interface RoleSummary {
  name: string;
  displayName: string;
  description: string;
  aliases: string[];
  promptFile: string | null;
  path: string;
  active: boolean;
  config?: RoleConfig;
}

export interface RoleRemovalResult {
  name: string;
  displayName: string;
  path: string;
  wasActive: boolean;
}

export class RoleManager {
  static listRoles(): RoleSummary[] {
    return RoleResolver.listAvailableRoles()
      .map(roleName => this.getRole(roleName))
      .filter((role): role is RoleSummary => Boolean(role));
  }

  static getRole(roleName: string): RoleSummary | undefined {
    const resolved = RoleResolver.resolveRoleDirectoryName(roleName);
    if (!resolved) {
      return undefined;
    }

    const rolesRoot = RoleResolver.getRolesRoot();
    const rolePath = path.join(rolesRoot, resolved);
    const config = RoleResolver.getRoleConfig(resolved);
    const activeRole = RoleResolver.getActiveRoleName();

    return {
      name: resolved,
      displayName: config?.displayName || resolved,
      description: config?.description || '',
      aliases: config?.aliases || [],
      promptFile: config?.promptFile || null,
      path: rolePath,
      active: Boolean(activeRole && RoleResolver.normalizeRoleName(activeRole) === RoleResolver.normalizeRoleName(resolved)),
      config,
    };
  }

  static removeRole(roleName: string): RoleRemovalResult {
    const requested = roleName.trim();
    const normalized = RoleResolver.normalizeRoleName(requested);
    if (BASE_ROLE_NAMES.has(normalized)) {
      throw new Error('Base role cannot be removed');
    }

    const role = this.getRole(requested);
    if (!role) {
      throw new Error(`Role not found: ${roleName}`);
    }

    const rolesRoot = RoleResolver.getRolesRoot();
    assertPathInside(role.path, rolesRoot);

    const wasActive = role.active;
    fs.rmSync(role.path, { recursive: true, force: true });

    if (wasActive) {
      RoleResolver.clearActiveRole();
    }

    return {
      name: role.name,
      displayName: role.displayName,
      path: role.path,
      wasActive,
    };
  }
}

function assertPathInside(targetPath: string, parentPath: string): void {
  const parentRealPath = fs.realpathSync(parentPath);
  const targetRealPath = fs.realpathSync(targetPath);
  const relative = path.relative(parentRealPath, targetRealPath);

  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return;
  }

  throw new Error(`Refusing to remove path outside roles root: ${targetPath}`);
}
