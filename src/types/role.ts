export type ToolVisibilityMode = 'all' | 'skill_scoped';

export interface RoleToolVisibilityConfig {
  mode?: ToolVisibilityMode;
  defaultTools?: string[];
  skillToolsets?: Record<string, string[]>;
}

export interface ConfirmedToolGateConfig {
  requireImmediateUserConfirmation?: boolean;
  tools?: string[];
}

export interface RoleConfig {
  name?: string;
  displayName?: string;
  description?: string;
  promptFile?: string;
  aliases?: string[];
  inheritBaseSkills?: boolean;
  excludeBaseSkills?: string[];
  inheritBaseTools?: boolean;
  baseToolAllowlist?: string[];
  baseToolDenylist?: string[];
  toolVisibility?: RoleToolVisibilityConfig;
  skillToolsetAliases?: Record<string, string | string[]>;
  confirmedToolGate?: ConfirmedToolGateConfig;
  metadata?: Record<string, unknown>;
}
