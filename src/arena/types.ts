export type ArenaReviewMode = 'base_skill' | 'role_skill' | 'role';

export type ArenaSubjectType = 'skill' | 'role';

export type ArenaTrustLevel = 'untrusted' | 'review_required' | 'reviewed' | 'promoted';

export type ArenaAllowedRuntime = 'arena_only' | 'production_candidate' | 'production';

export type ArenaSandboxEngine =
  | 'macos_seatbelt'
  | 'linux_bubblewrap'
  | 'windows_native'
  | 'local_spawn'
  | 'none';

export type ArenaSandboxMode = 'metadata_only' | 'read_only' | 'workspace_write';

export type ArenaNetworkMode = 'disabled' | 'enabled';

export interface ArenaSubjectSource {
  type: 'github' | 'local_skill' | 'local_role';
  owner?: string;
  repo?: string;
  ref?: string;
  commit?: string;
  path?: string;
  url?: string;
}

export interface ArenaSubjectInfo {
  name: string;
  description: string;
  capabilities: string[];
  required_tools: string[];
}

export interface ArenaParsedSubject {
  docs: string[];
  prompt_files: string[];
  skill_files: string[];
  declared_tools: string[];
}

export interface ArenaSafetyScan {
  risk_level: 'low' | 'medium' | 'high';
  warnings: string[];
}

export interface ArenaDefaultSandbox {
  engine?: ArenaSandboxEngine;
  mode: ArenaSandboxMode;
  network: ArenaNetworkMode;
  env_allowlist: string[];
  timeout_ms: number;
}

export interface ArenaRoleSnapshot {
  id: string;
  docs: string[];
  local_skills: string[];
  declared_boundaries: string[];
  fingerprint: string;
}

export interface ArenaSubjectManifest {
  version: 1;
  subject_id: string;
  subject: ArenaSubjectInfo & { type: ArenaSubjectType };
  source: ArenaSubjectSource;
  parsed: ArenaParsedSubject;
  safety: ArenaSafetyScan;
  trust_level: ArenaTrustLevel;
  allowed_runtime: ArenaAllowedRuntime;
  default_sandbox: ArenaDefaultSandbox;
  fingerprint: string;
  created_at: string;
  role?: ArenaRoleSnapshot;
}

export interface ArenaSandboxPolicy {
  engine: ArenaSandboxEngine;
  mode: ArenaSandboxMode;
  workspace_root: string;
  subject_root: string;
  writable_roots: string[];
  network: ArenaNetworkMode;
  env_allowlist: string[];
  timeout_ms: number;
}

export interface ArenaCleanRuntimeRoots {
  run_root: string;
  home_root: string;
  skills_root: string;
  roles_root: string;
  workspace_root: string;
  tmp_root: string;
}

export interface ArenaCleanRuntimeLaunch {
  cwd: string;
  command: string[];
  env: Record<string, string>;
  pass_through_env: string[];
  shell_command: string;
  sandbox_profile_path?: string;
  sandbox_shell_command?: string;
}

export interface ArenaCleanRuntimeIndex {
  version: 1;
  run_id: string;
  review_mode: ArenaReviewMode;
  subject_id: string;
  subject_manifest_path: string;
  target_profile: ArenaTargetProfile;
  roots: ArenaCleanRuntimeRoots;
  copied: {
    base_skills: string[];
    missing_base_skills: string[];
    support_roles?: string[];
    subject_skill?: string;
    role?: string;
    workspace_seed?: {
      source: string;
      file_count: number;
    };
  };
  isolation: {
    production_skills_root: string;
    production_roles_root: string;
    production_home_root?: string;
    registry_files: string[];
  };
  sandbox: ArenaSandboxPolicy;
  launch: ArenaCleanRuntimeLaunch;
  created_at: string;
}

export interface ArenaTargetProfile {
  active_role_id?: string;
  subject_skill_id?: string;
  loaded_skills: string[];
  role_local_skills: string[];
  registered_tools: string[];
  provider_visible_tools: string[];
  surface: string;
}

export interface PrepareArenaRuntimeInput {
  runId?: string;
  reviewMode: ArenaReviewMode;
  subjectId: string;
  targetRoleId?: string;
  surface?: string;
  passThroughEnv?: string[];
  workspaceSeedPath?: string;
  sandbox?: Partial<ArenaSandboxPolicy>;
}
