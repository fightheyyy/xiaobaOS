import { createSandboxPolicy } from '../sandbox/policy';
import { buildArenaShellCommand } from './arena-shell';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { RoleManager } from '../roles/role-manager';
import { getRoleSpecificToolsForResolvedRole } from '../roles/runtime-role-registry';
import { DEFAULT_BUNDLED_BASE_SKILLS } from '../skills/skill-manager';
import { SkillParser } from '../skills/skill-parser';
import { RoleConfig } from '../types/role';
import { ToolExecutionContext } from '../types/tool';
import { ToolManager } from '../tools/tool-manager';
import { PathResolver } from '../utils/path-resolver';
import {
  ArenaAllowedRuntime,
  ArenaCleanRuntimeIndex,
  ArenaDefaultSandbox,
  ArenaReviewMode,
  ArenaSandboxPolicy,
  ArenaSubjectManifest,
  ArenaSubjectSource,
  ArenaTargetProfile,
  ArenaTrustLevel,
  PrepareArenaRuntimeInput,
} from './types';

export const ARENA_REVIEW_MODES: ArenaReviewMode[] = ['base_skill', 'role_skill', 'role'];

export const DEFAULT_PACKAGED_BASE_SKILLS = [...DEFAULT_BUNDLED_BASE_SKILLS];

export const BASE_TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'execute_shell',
  'spawn_subagent',
  'check_subagent',
  'stop_subagent',
  'resume_subagent',
  'ask_parent',
  'skill',
];

export const SURFACE_TOOL_NAMES = ['send_text', 'send_file'];

const CHANNEL_BACKED_SURFACES = new Set(['pet', 'dashboard', 'feishu', 'weixin']);
const DEFAULT_SURFACE = 'pet';
const DEFAULT_SANDBOX_TIMEOUT_MS = 120_000;
const ARENA_PROFILE_CHANNEL: NonNullable<ToolExecutionContext['channel']> = {
  chatId: 'arena-target-profile',
  reply: async () => undefined,
  sendFile: async () => undefined,
};

export interface ArenaManagerOptions {
  projectRoot?: string;
  now?: () => Date;
  createId?: (parts: string[]) => string;
}

export interface BuildArenaTargetProfileInput {
  reviewMode: ArenaReviewMode;
  subject: ArenaSubjectManifest;
  targetRoleId?: string;
  surface: string;
  rolePath?: string;
  workingDirectory: string;
}

export function buildArenaTargetProfile(
  input: BuildArenaTargetProfileInput,
): ArenaTargetProfile {
  const subjectSkillId = input.subject.subject.type === 'skill' ? input.subject.subject.name : undefined;
  const roleConfig = input.rolePath ? readRoleConfig(input.rolePath) : undefined;
  const configuredRoleId = stringValue(roleConfig?.name);
  const activeRoleId = input.reviewMode === 'base_skill'
    ? 'base'
    : configuredRoleId || input.targetRoleId;
  const resolvedRoleId = activeRoleId && activeRoleId !== 'base' ? activeRoleId : undefined;
  const roleLocalSkills = input.rolePath ? collectRoleLocalSkillNames(input.rolePath) : [];
  const loadedSkills = Array.from(new Set([
    ...DEFAULT_PACKAGED_BASE_SKILLS,
    ...roleLocalSkills,
    ...(subjectSkillId ? [subjectSkillId] : []),
  ]));
  const visibilityContext: Partial<ToolExecutionContext> = {
    workingDirectory: input.workingDirectory,
    conversationHistory: [],
    surface: input.surface as ToolExecutionContext['surface'],
    ...(resolvedRoleId && { roleName: resolvedRoleId }),
    ...(subjectSkillId && { activeSkillName: subjectSkillId }),
    ...(CHANNEL_BACKED_SURFACES.has(input.surface) && { channel: ARENA_PROFILE_CHANNEL }),
  };
  const toolManager = new ToolManager(
    input.workingDirectory,
    visibilityContext,
    getRoleSpecificToolsForResolvedRole(resolvedRoleId),
    { roleConfig },
  );

  return {
    ...(activeRoleId && { active_role_id: activeRoleId }),
    ...(subjectSkillId && { subject_skill_id: subjectSkillId }),
    loaded_skills: loadedSkills,
    role_local_skills: roleLocalSkills,
    registered_tools: uniqueToolNames(
      toolManager.getAllTools().map(tool => tool.definition.name),
    ),
    provider_visible_tools: uniqueToolNames(
      toolManager.getToolDefinitions(visibilityContext).map(tool => tool.name),
    ),
    surface: input.surface,
  };
}

export interface ImportLocalSkillOptions {
  skillPath: string;
  trustLevel?: ArenaTrustLevel;
  allowedRuntime?: ArenaAllowedRuntime;
}

export interface ImportGithubSkillOptions {
  repo: string;
  ref?: string;
  trustLevel?: ArenaTrustLevel;
  allowedRuntime?: ArenaAllowedRuntime;
}

export interface SnapshotRoleOptions {
  roleId: string;
  trustLevel?: ArenaTrustLevel;
  allowedRuntime?: ArenaAllowedRuntime;
}

export interface ImportLocalRoleOptions {
  rolePath: string;
  trustLevel?: ArenaTrustLevel;
  allowedRuntime?: ArenaAllowedRuntime;
}

interface ResolvedArenaTargetRole {
  name: string;
  sourceDir: string;
}

export class ArenaManager {
  private readonly projectRoot: string;
  private readonly now: () => Date;
  private readonly createId: (parts: string[]) => string;

  constructor(options: ArenaManagerOptions = {}) {
    this.projectRoot = path.resolve(options.projectRoot || PathResolver.getProjectRoot());
    this.now = options.now || (() => new Date());
    this.createId = options.createId || deriveArenaId;
  }

  getArenaRoot(): string {
    return path.join(this.projectRoot, 'arena');
  }

  getSubjectsRoot(): string {
    return path.join(this.getArenaRoot(), 'subjects');
  }

  getRunsRoot(): string {
    return path.join(this.getArenaRoot(), 'runs');
  }

  importLocalSkill(options: ImportLocalSkillOptions): ArenaSubjectManifest {
    const skillFile = resolveSkillFile(this.projectRoot, options.skillPath);
    const skill = SkillParser.parse(skillFile);
    const sourceRoot = path.dirname(skillFile);
    const fingerprint = fingerprintArenaDirectory(sourceRoot);
    const subjectId = this.createId(['skill', skill.metadata.name, fingerprint]);
    const subjectDir = path.join(this.getSubjectsRoot(), subjectId);
    const snapshotRoot = path.join(subjectDir, 'source');
    ensureDir(subjectDir);
    ensureImmutableSnapshot(sourceRoot, snapshotRoot, fingerprint);

    const snapshotSkillFile = path.join(snapshotRoot, path.relative(sourceRoot, skillFile));

    const parsed = {
      docs: relativeExistingFiles(this.projectRoot, [snapshotSkillFile]),
      prompt_files: [] as string[],
      skill_files: relativeExistingFiles(this.projectRoot, [snapshotSkillFile]),
      declared_tools: [...(skill.metadata.toolsets || [])],
    };
    const manifest = this.buildManifest({
      subjectId,
      type: 'skill',
      source: {
        type: 'local_skill',
        path: relativePath(this.projectRoot, snapshotRoot),
      },
      name: skill.metadata.name,
      description: skill.metadata.description,
      capabilities: [skill.metadata.description],
      requiredTools: parsed.declared_tools,
      parsed,
      safety: scanSafety(collectSnapshotFiles(snapshotRoot)),
      trustLevel: options.trustLevel || 'review_required',
      allowedRuntime: options.allowedRuntime || 'arena_only',
      fingerprint,
    });

    return this.writeSubjectManifest(subjectDir, manifest);
  }

  importGithubSkill(options: ImportGithubSkillOptions): ArenaSubjectManifest {
    const { owner, repo } = parseGithubRepo(options.repo);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-arena-skill-'));
    const repoUrl = `https://github.com/${owner}/${repo}.git`;
    try {
      execFileSync('git', ['clone', repoUrl, tmpDir], { stdio: 'ignore' });
      if (options.ref) {
        execFileSync('git', ['checkout', options.ref], { cwd: tmpDir, stdio: 'ignore' });
      }
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf-8' }).trim();
      const skillFiles = PathResolver.findSkillFiles(tmpDir);
      if (skillFiles.length === 0) {
        throw new Error(`No SKILL.md found in ${options.repo}`);
      }
      const skillFile = skillFiles[0];
      const skill = SkillParser.parse(skillFile);
      const fingerprint = fingerprintArenaDirectory(tmpDir);
      const subjectId = this.createId(['skill', owner, repo, commit, skill.metadata.name, fingerprint]);
      const subjectDir = path.join(this.getSubjectsRoot(), subjectId);
      const sourceDir = path.join(subjectDir, 'source');
      ensureDir(subjectDir);
      ensureImmutableSnapshot(tmpDir, sourceDir, fingerprint);

      const persistedSkillFile = path.join(sourceDir, path.relative(tmpDir, skillFile));
      const parsed = {
        docs: relativeExistingFiles(this.projectRoot, [persistedSkillFile]),
        prompt_files: [] as string[],
        skill_files: relativeExistingFiles(this.projectRoot, [persistedSkillFile]),
        declared_tools: [...(skill.metadata.toolsets || [])],
      };
      const manifest = this.buildManifest({
        subjectId,
        type: 'skill',
        source: {
          type: 'github',
          owner,
          repo,
          ref: options.ref,
          commit,
          url: repoUrl,
          path: relativePath(this.projectRoot, sourceDir),
        },
        name: skill.metadata.name,
        description: skill.metadata.description,
        capabilities: [skill.metadata.description],
        requiredTools: parsed.declared_tools,
        parsed,
        safety: scanSafety([persistedSkillFile]),
        trustLevel: options.trustLevel || 'untrusted',
        allowedRuntime: options.allowedRuntime || 'arena_only',
        fingerprint,
      });

      return this.writeSubjectManifest(subjectDir, manifest);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  snapshotRole(options: SnapshotRoleOptions): ArenaSubjectManifest {
    const role = RoleManager.getRole(options.roleId);
    if (!role) {
      throw new Error(`Role not found: ${options.roleId}`);
    }

    return this.importRolePath({
      rolePath: role.path,
      roleName: role.name,
      displayName: role.displayName,
      description: role.description,
      config: role.config || {},
      trustLevel: options.trustLevel,
      allowedRuntime: options.allowedRuntime,
    });
  }

  importLocalRole(options: ImportLocalRoleOptions): ArenaSubjectManifest {
    const rolePath = resolveRoleDirectory(this.projectRoot, options.rolePath);
    const config = readRoleConfig(rolePath);
    const roleName = stringValue(config.name) || path.basename(rolePath);
    const displayName = stringValue(config.displayName) || roleName;
    const description = stringValue(config.description) || displayName;

    return this.importRolePath({
      rolePath,
      roleName,
      displayName,
      description,
      config,
      trustLevel: options.trustLevel,
      allowedRuntime: options.allowedRuntime,
    });
  }

  private importRolePath(input: {
    rolePath: string;
    roleName: string;
    displayName: string;
    description: string;
    config: RoleConfig;
    trustLevel?: ArenaTrustLevel;
    allowedRuntime?: ArenaAllowedRuntime;
  }): ArenaSubjectManifest {
    const fingerprint = fingerprintArenaDirectory(input.rolePath);
    const subjectId = this.createId(['role', input.roleName, fingerprint]);
    const subjectDir = path.join(this.getSubjectsRoot(), subjectId);
    const snapshotRoot = path.join(subjectDir, 'source');
    ensureDir(subjectDir);
    ensureImmutableSnapshot(input.rolePath, snapshotRoot, fingerprint);

    const roleFiles = collectRoleFiles(snapshotRoot);
    const localSkillFiles = PathResolver.findSkillFiles(path.join(snapshotRoot, 'skills'));
    const localSkills = localSkillFiles.map(file => SkillParser.parse(file).metadata.name).sort();
    const docs = roleFiles
      .filter(file => isDocFile(file))
      .map(file => relativePath(this.projectRoot, file));
    const promptFiles = roleFiles
      .filter(file => file.includes(`${path.sep}prompts${path.sep}`))
      .map(file => relativePath(this.projectRoot, file));
    const declaredBoundaries = [
      input.description,
      input.config.metadata?.boundary,
      input.config.metadata?.responsibility,
    ]
      .map(value => typeof value === 'string' ? value.trim() : '')
      .filter(Boolean);
    const declaredTools = [
      ...(input.config.baseToolAllowlist || []),
      ...(input.config.toolVisibility?.defaultTools || []),
    ].map(String).filter(Boolean);
    const manifest = this.buildManifest({
      subjectId,
      type: 'role',
      source: {
        type: 'local_role',
        path: relativePath(this.projectRoot, snapshotRoot),
      },
      name: input.roleName,
      description: input.description || input.displayName,
      capabilities: [input.description || input.displayName],
      requiredTools: declaredTools,
      parsed: {
        docs,
        prompt_files: promptFiles,
        skill_files: localSkillFiles.map(file => relativePath(this.projectRoot, file)),
        declared_tools: declaredTools,
      },
      safety: scanSafety(roleFiles),
      trustLevel: input.trustLevel || 'review_required',
      allowedRuntime: input.allowedRuntime || 'arena_only',
      fingerprint,
      role: {
        id: input.roleName,
        docs,
        local_skills: localSkills,
        declared_boundaries: declaredBoundaries,
        fingerprint,
      },
    });

    return this.writeSubjectManifest(subjectDir, manifest);
  }

  readSubjectManifest(subjectIdOrPath: string): ArenaSubjectManifest {
    const manifestPath = this.resolveSubjectManifestPath(subjectIdOrPath);
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ArenaSubjectManifest;
  }

  prepareCleanRuntime(input: PrepareArenaRuntimeInput): ArenaCleanRuntimeIndex {
    const subject = this.readSubjectManifest(input.subjectId);
    this.validateModeAndSubject(input.reviewMode, subject, input.targetRoleId);
    const runId = safeSegment(input.runId || this.createId([
      'clean-runtime',
      input.reviewMode,
      subject.subject_id,
      this.now().toISOString(),
    ]));
    const runRoot = path.join(this.getRunsRoot(), runId);
    const roots = {
      run_root: runRoot,
      home_root: path.join(runRoot, 'home'),
      skills_root: path.join(runRoot, 'skills'),
      roles_root: path.join(runRoot, 'roles'),
      workspace_root: path.join(runRoot, 'workspace'),
      tmp_root: path.join(runRoot, 'tmp'),
    };
    resetRuntimeRoots([
      roots.home_root,
      roots.skills_root,
      roots.roles_root,
      roots.workspace_root,
      roots.tmp_root,
      path.join(runRoot, 'sandbox'),
      path.join(runRoot, 'debug'),
    ]);
    Object.values(roots).forEach(ensureDir);
    // The sandboxed worker writes evaluator and provider-call evidence here.
    // Create the directory before Seatbelt starts so the worker never needs
    // permission to create a direct child of the run root.
    const debugRoot = path.join(runRoot, 'debug');
    ensureDir(debugRoot);
    if (process.env.XIAOBA_ARENA_LIVE_MODE === 'barena') {
      fs.writeFileSync(path.join(debugRoot, 'provider-calls.ndjson'), '', 'utf-8');
    }

    const registryFiles = [
      path.join(roots.home_root, 'skill-registry.json'),
      path.join(roots.workspace_root, 'skill-registry.json'),
    ];
    for (const registryFile of registryFiles) {
      writeJson(registryFile, []);
    }
    const copiedWorkspaceSeed = input.workspaceSeedPath
      ? copyWorkspaceSeed(this.projectRoot, input.workspaceSeedPath, roots.workspace_root)
      : undefined;

    const copiedBaseSkills = copyBaseSkills(this.projectRoot, roots.skills_root);
    const copiedSubjectSkill = subject.subject.type === 'skill'
      ? this.copySubjectSkill(subject, roots.skills_root)
      : undefined;
    const targetRole = this.resolveTargetRole(subject, input.reviewMode, input.targetRoleId);
    const copiedSupportRoles = copyArenaSupportRoles(
      this.projectRoot,
      roots.roles_root,
      targetRole?.name,
    );
    const copiedRole = targetRole ? this.copyTargetRole(targetRole, roots.roles_root) : undefined;
    const surface = input.surface || DEFAULT_SURFACE;
    const targetProfile = buildArenaTargetProfile({
      reviewMode: input.reviewMode,
      subject,
      targetRoleId: targetRole?.name,
      surface,
      rolePath: copiedRole ? path.join(runRoot, copiedRole) : undefined,
      workingDirectory: roots.workspace_root,
    });
    const sandboxSubjectRoot = copiedSubjectSkill
      ? path.join(runRoot, copiedSubjectSkill)
      : copiedRole
        ? path.join(runRoot, copiedRole)
        : roots.workspace_root;
    const passThroughEnv = normalizeEnvNames([
      ...subject.default_sandbox.env_allowlist,
      ...(input.sandbox?.env_allowlist || []),
      ...(input.passThroughEnv || []),
    ]);
    const sandbox = this.buildSandboxPolicy(subject, {
      ...input.sandbox,
      workspace_root: input.sandbox?.workspace_root || roots.workspace_root,
      subject_root: input.sandbox?.subject_root || sandboxSubjectRoot,
      writable_roots: input.sandbox?.writable_roots || [
        roots.home_root,
        roots.workspace_root,
        roots.tmp_root,
      ],
      env_allowlist: passThroughEnv,
    });
    const launchEnv = buildCleanRuntimeEnv({
      projectRoot: this.projectRoot,
      homeRoot: roots.home_root,
      skillsRoot: roots.skills_root,
      rolesRoot: roots.roles_root,
      tmpRoot: roots.tmp_root,
    });
    const command = buildLaunchCommand(this.projectRoot, targetProfile.active_role_id);
    const sandboxPolicyPath = writeSdkSandboxPolicy({
        runRoot,
        projectRoot: this.projectRoot,
        roots,
        sandbox,
      });
    const launch = {
      cwd: roots.workspace_root,
      command,
      env: launchEnv,
      pass_through_env: passThroughEnv,
      shell_command: buildArenaShellCommand({
        cwd: roots.workspace_root,
        command,
        env: launchEnv,
        passThroughEnv,
      }),
      ...(sandboxPolicyPath && {
        sandbox_policy_path: sandboxPolicyPath,
        sandbox_shell_command: buildArenaShellCommand({
          cwd: roots.workspace_root,
          command,
          env: launchEnv,
          passThroughEnv,
          sandboxPolicyPath,
        }),
      }),
    };
    const runtimeIndex: ArenaCleanRuntimeIndex = {
      version: 1,
      run_id: runId,
      review_mode: input.reviewMode,
      subject_id: subject.subject_id,
      subject_manifest_path: relativePath(this.projectRoot, this.resolveSubjectManifestPath(subject.subject_id)),
      target_profile: targetProfile,
      roots,
      copied: {
        base_skills: copiedBaseSkills.copied,
        missing_base_skills: copiedBaseSkills.missing,
        support_roles: copiedSupportRoles,
        ...(copiedSubjectSkill && { subject_skill: copiedSubjectSkill }),
        ...(copiedRole && { role: copiedRole }),
        ...(copiedWorkspaceSeed && { workspace_seed: copiedWorkspaceSeed }),
      },
      isolation: {
        production_skills_root: path.join(this.projectRoot, 'skills'),
        production_roles_root: path.join(this.projectRoot, 'roles'),
        production_home_root: process.env.XIAOBA_HOME || process.env.HOME,
        registry_files: registryFiles,
      },
      sandbox,
      launch,
      created_at: this.now().toISOString(),
    };

    writeJson(path.join(runRoot, 'clean-runtime.json'), runtimeIndex);
    return runtimeIndex;
  }

  private buildManifest(input: {
    subjectId: string;
    type: 'skill' | 'role';
    source: ArenaSubjectSource;
    name: string;
    description: string;
    capabilities: string[];
    requiredTools: string[];
    parsed: ArenaSubjectManifest['parsed'];
    safety: ArenaSubjectManifest['safety'];
    trustLevel: ArenaTrustLevel;
    allowedRuntime: ArenaAllowedRuntime;
    fingerprint: string;
    role?: ArenaSubjectManifest['role'];
  }): ArenaSubjectManifest {
    return {
      version: 1,
      subject_id: input.subjectId,
      subject: {
        type: input.type,
        name: input.name,
        description: input.description,
        capabilities: input.capabilities,
        required_tools: input.requiredTools,
      },
      source: input.source,
      parsed: input.parsed,
      safety: input.safety,
      trust_level: input.trustLevel,
      allowed_runtime: input.allowedRuntime,
      default_sandbox: defaultSandboxForTrust(input.trustLevel),
      fingerprint: input.fingerprint,
      created_at: this.now().toISOString(),
      ...(input.role && { role: input.role }),
    };
  }

  private writeSubjectManifest(subjectDir: string, manifest: ArenaSubjectManifest): ArenaSubjectManifest {
    writeJson(path.join(subjectDir, 'arena-manifest.json'), manifest);
    return manifest;
  }

  private copySubjectSkill(subject: ArenaSubjectManifest, skillsRoot: string): string {
    const subjectSkillName = safeSegment(subject.subject.name);
    const destination = path.join(skillsRoot, subjectSkillName);
    const sourceDir = resolveSubjectSkillSourceDir(this.projectRoot, subject);
    copyDirectory(sourceDir, destination);
    return relativePath(path.dirname(skillsRoot), destination);
  }

  private copyTargetRole(
    targetRole: ResolvedArenaTargetRole,
    rolesRoot: string,
  ): string {
    const destinationName = safeSegment(targetRole.name);
    const destination = path.join(rolesRoot, destinationName);
    copyDirectory(targetRole.sourceDir, destination);
    return relativePath(path.dirname(rolesRoot), destination);
  }

  private resolveTargetRole(
    subject: ArenaSubjectManifest,
    reviewMode: ArenaReviewMode,
    targetRoleId: string | undefined,
  ): ResolvedArenaTargetRole | undefined {
    if (reviewMode === 'base_skill') {
      return undefined;
    }
    const requestedRoleId = targetRoleId?.trim();
    if (!requestedRoleId) {
      throw new Error(`${reviewMode} requires targetRoleId`);
    }
    const role = reviewMode === 'role' ? undefined : RoleManager.getRole(requestedRoleId);
    const sourceDir = reviewMode === 'role'
      ? resolveSubjectRoleSourceDir(this.projectRoot, subject)
      : role?.path;
    if (!sourceDir || !fs.existsSync(sourceDir)) {
      throw new Error(`Role not found: ${requestedRoleId}`);
    }
    return {
      name: reviewMode === 'role'
        ? safeSegment(subject.role?.id || subject.subject.name)
        : role!.name,
      sourceDir,
    };
  }

  private resolveSubjectManifestPath(subjectIdOrPath: string): string {
    const value = subjectIdOrPath.trim();
    if (!value) {
      throw new Error('subject id is required');
    }
    if (value.endsWith('arena-manifest.json')) {
      return path.resolve(this.projectRoot, value);
    }
    return path.join(this.getSubjectsRoot(), safeSegment(value), 'arena-manifest.json');
  }

  private validateModeAndSubject(
    reviewMode: ArenaReviewMode,
    subject: ArenaSubjectManifest,
    targetRoleId?: string,
  ): void {
    if (!ARENA_REVIEW_MODES.includes(reviewMode)) {
      throw new Error(`Unsupported review mode: ${reviewMode}`);
    }
    if ((reviewMode === 'base_skill' || reviewMode === 'role_skill') && subject.subject.type !== 'skill') {
      throw new Error(`${reviewMode} requires subject.type=skill`);
    }
    if (reviewMode === 'role' && subject.subject.type !== 'role') {
      throw new Error('role review mode requires subject.type=role');
    }
    if ((reviewMode === 'role_skill' || reviewMode === 'role') && !targetRoleId?.trim()) {
      throw new Error(`${reviewMode} requires targetRoleId`);
    }
    if (reviewMode === 'role_skill') {
      const subjectSkillName = normalizeSkillIdentity(subject.subject.name);
      const targetRolePath = RoleManager.getRole(targetRoleId!.trim())?.path;
      const conflictingRoleSkill = (targetRolePath ? collectRoleLocalSkillNames(targetRolePath) : [])
        .find(skillName => normalizeSkillIdentity(skillName) === subjectSkillName);
      if (conflictingRoleSkill) {
        throw new Error(
          `role_skill subject Skill "${subject.subject.name}" conflicts with target role-local Skill "${conflictingRoleSkill}"; Arena cannot prove the mounted subject identity`,
        );
      }
    }
  }

  private buildSandboxPolicy(
    subject: ArenaSubjectManifest,
    override: Partial<ArenaSandboxPolicy> | undefined,
  ): ArenaSandboxPolicy {
    const subjectRoot = subject.source.path || path.dirname(this.resolveSubjectManifestPath(subject.subject_id));
    const workspaceRoot = override?.workspace_root || path.join(this.getRunsRoot(), '.workspaces', subject.subject_id);
    return {
      engine: 'anthropic_sdk',
      mode: override?.mode || subject.default_sandbox.mode,
      workspace_root: workspaceRoot,
      subject_root: override?.subject_root || subjectRoot,
      writable_roots: override?.writable_roots || [workspaceRoot],
      network: override?.network || subject.default_sandbox.network,
      env_allowlist: override?.env_allowlist || [...subject.default_sandbox.env_allowlist],
      timeout_ms: override?.timeout_ms || subject.default_sandbox.timeout_ms,
    };
  }

}

function resetRuntimeRoots(paths: string[]): void {
  for (const rootPath of paths) {
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
}

function copyBaseSkills(projectRoot: string, skillsRoot: string): { copied: string[]; missing: string[] } {
  const copied: string[] = [];
  const missing: string[] = [];
  for (const skillName of DEFAULT_PACKAGED_BASE_SKILLS) {
    const sourceDir = path.join(projectRoot, 'skills', skillName);
    if (!fs.existsSync(sourceDir)) {
      missing.push(skillName);
      continue;
    }
    copyDirectory(sourceDir, path.join(skillsRoot, skillName));
    copied.push(skillName);
  }
  return { copied, missing };
}

function copyArenaSupportRoles(
  projectRoot: string,
  rolesRoot: string,
  targetRoleName?: string,
): string[] {
  const target = normalizeSkillIdentity(targetRoleName || '');
  const copied: string[] = [];
  for (const roleName of ['user-cat', 'inspector-cat', 'reviewer-cat']) {
    if (normalizeSkillIdentity(roleName) === target) continue;
    const sourceDir = path.join(projectRoot, 'roles', roleName);
    if (!fs.existsSync(path.join(sourceDir, 'role.json'))) continue;
    copyDirectory(sourceDir, path.join(rolesRoot, roleName));
    copied.push(roleName);
  }
  return copied;
}

function copyWorkspaceSeed(projectRoot: string, seedPath: string, workspaceRoot: string): { source: string; file_count: number } {
  const source = path.resolve(projectRoot, seedPath);
  if (!fs.existsSync(source)) {
    throw new Error(`Workspace seed path does not exist: ${seedPath}`);
  }
  if (!fs.statSync(source).isDirectory()) {
    throw new Error(`Workspace seed path must be a directory: ${seedPath}`);
  }
  copyDirectory(source, workspaceRoot);
  return {
    source: relativePath(projectRoot, source),
    file_count: countFiles(source),
  };
}

function resolveSubjectSkillSourceDir(projectRoot: string, subject: ArenaSubjectManifest): string {
  const sourcePath = resolveSubjectSourcePath(projectRoot, subject);
  if (subject.source.type === 'github' && sourcePath && fs.existsSync(sourcePath) && fs.statSync(sourcePath).isDirectory()) {
    return sourcePath;
  }
  const skillFile = firstExistingPath(projectRoot, [
    ...subject.parsed.skill_files,
    ...(sourcePath ? [sourcePath] : []),
  ]);
  if (!skillFile) {
    throw new Error(`Skill source not found for subject: ${subject.subject_id}`);
  }
  return fs.statSync(skillFile).isDirectory() ? skillFile : path.dirname(skillFile);
}

function resolveSubjectRoleSourceDir(projectRoot: string, subject: ArenaSubjectManifest): string {
  const sourcePath = resolveSubjectSourcePath(projectRoot, subject);
  if (sourcePath && fs.existsSync(sourcePath) && fs.statSync(sourcePath).isDirectory()) {
    return sourcePath;
  }
  throw new Error(`Role source not found for subject: ${subject.subject_id}`);
}

function resolveSubjectSourcePath(projectRoot: string, subject: ArenaSubjectManifest): string | undefined {
  if (!subject.source.path) {
    return undefined;
  }
  return path.resolve(projectRoot, subject.source.path);
}

function firstExistingPath(projectRoot: string, refs: string[]): string | undefined {
  for (const ref of refs) {
    const value = String(ref || '').trim();
    if (!value) {
      continue;
    }
    const absolutePath = path.resolve(projectRoot, value);
    if (fs.existsSync(absolutePath)) {
      return absolutePath;
    }
  }
  return undefined;
}

function buildCleanRuntimeEnv(input: {
  projectRoot: string;
  homeRoot: string;
  skillsRoot: string;
  rolesRoot: string;
  tmpRoot: string;
}): Record<string, string> {
  const dotenvPath = resolveArenaDotenvPath(input.projectRoot);
  return {
    XIAOBA_ARENA: '1',
    XIAOBA_HOME: input.homeRoot,
    XIAOBA_PROJECT_ROOT: input.projectRoot,
    XIAOBA_SKILLS_ROOT: input.skillsRoot,
    XIAOBA_ROLES_ROOT: input.rolesRoot,
    HOME: input.homeRoot,
    TMPDIR: input.tmpRoot,
    NO_COLOR: '1',
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    ...(dotenvPath && { DOTENV_CONFIG_PATH: dotenvPath }),
  };
}

function resolveArenaDotenvPath(projectRoot: string): string | undefined {
  const explicitPath = String(process.env.DOTENV_CONFIG_PATH || '').trim();
  const candidates = [
    explicitPath
      ? path.resolve(projectRoot, explicitPath)
      : '',
    path.join(projectRoot, '.env'),
  ];
  return candidates.find(candidate => Boolean(candidate) && fs.existsSync(candidate));
}

function buildLaunchCommand(projectRoot: string, activeRoleId?: string): string[] {
  const command = [
    process.execPath,
    path.join(projectRoot, 'dist', 'index.js'),
    'chat',
    '--interactive',
  ];
  if (activeRoleId && activeRoleId !== 'base') {
    command.push('--role', activeRoleId);
  }
  return command;
}

function writeSdkSandboxPolicy(input: {
  runRoot: string; projectRoot: string; roots: ArenaCleanRuntimeIndex['roots']; sandbox: ArenaSandboxPolicy;
}): string {
  const policyPath = path.join(input.runRoot, 'sandbox', 'anthropic-policy.json');
  const envPath = resolveArenaDotenvPath(input.projectRoot);
  const environment = { ...(envPath ? dotenv.parse(fs.readFileSync(envPath)) : {}), ...process.env };
  const domains = Object.entries(environment).filter(([key]) => /^XIAOBA_LLM_.*API_BASE$/.test(key)).flatMap(([, value]) => {
    try { return value ? [new URL(value).hostname] : []; } catch { return []; }
  });
  const policy = createSandboxPolicy({
    cwd: input.roots.workspace_root, scratchRoot: path.join(input.runRoot, 'sandbox'),
    readRoots: [input.runRoot, ...['dist', 'src', 'node_modules', 'prompts', 'roles', 'skills', 'package.json', 'skill-registry.json'].map(name => path.join(input.projectRoot, name))], writeRoots: [input.runRoot, ...input.sandbox.writable_roots],
    denyRead: [path.join(input.projectRoot, 'data'), path.join(input.projectRoot, 'memory'), path.join(input.projectRoot, 'logs')],
    denyWrite: [input.projectRoot + '/src', input.projectRoot + '/dist', input.projectRoot + '/roles', input.projectRoot + '/skills', input.projectRoot + '/data', input.projectRoot + '/memory'],
    allowedDomains: [...domains, 'api.openai.com', 'api.anthropic.com'], allowLocalBinding: true,
  });
  policy.config.filesystem.denyWrite.push({ path: policyPath, literal: true });
  writeJson(policyPath, policy);
  return policyPath;
}

function normalizeEnvNames(values: string[]): string[] {
  const names = values
    .map(value => value.trim())
    .filter(value => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value));
  return Array.from(new Set(names)).sort();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function resolveSkillFile(projectRoot: string, value: string): string {
  const resolved = path.resolve(projectRoot, value);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    const skillFile = path.join(resolved, 'SKILL.md');
    if (fs.existsSync(skillFile)) {
      return skillFile;
    }
  }
  if (fs.existsSync(resolved) && path.basename(resolved) === 'SKILL.md') {
    return resolved;
  }
  throw new Error(`Skill path must point to SKILL.md or a skill directory: ${value}`);
}

function resolveRoleDirectory(projectRoot: string, value: string): string {
  const resolved = path.resolve(projectRoot, value);
  const rolePath = fs.existsSync(resolved) && fs.statSync(resolved).isFile()
    && path.basename(resolved) === 'role.json'
    ? path.dirname(resolved)
    : resolved;
  const configPath = path.join(rolePath, 'role.json');
  if (fs.existsSync(rolePath) && fs.statSync(rolePath).isDirectory() && fs.existsSync(configPath)) {
    return rolePath;
  }
  throw new Error(`Role path must point to role.json or a role directory: ${value}`);
}

function readRoleConfig(rolePath: string): RoleConfig {
  const configPath = path.join(rolePath, 'role.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed as RoleConfig;
  } catch (error: any) {
    throw new Error(`Role config parse failed (${configPath}): ${error?.message || error}`);
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseGithubRepo(repo: string): { owner: string; repo: string } {
  const match = repo.trim().match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    throw new Error('GitHub repo must use owner/repo format');
  }
  return { owner: match[1], repo: match[2] };
}

function defaultSandboxForTrust(trustLevel: ArenaTrustLevel): ArenaDefaultSandbox {
  return {
    engine: defaultSandboxEngine(),
    mode: trustLevel === 'untrusted' ? 'metadata_only' : 'read_only',
    network: 'disabled',
    env_allowlist: [],
    timeout_ms: DEFAULT_SANDBOX_TIMEOUT_MS,
  };
}

function defaultSandboxEngine(): ArenaSandboxPolicy['engine'] { return 'anthropic_sdk'; }

function collectRoleLocalSkillNames(rolePath: string): string[] {
  return PathResolver.findSkillFiles(path.join(rolePath, 'skills'))
    .map(file => SkillParser.parse(file).metadata.name)
    .sort();
}

function uniqueToolNames(toolNames: string[]): string[] {
  return Array.from(new Set(toolNames));
}

function normalizeSkillIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function collectRoleFiles(rolePath: string): string[] {
  const files: string[] = [];
  walk(rolePath, files);
  return files.sort();
}

function collectSnapshotFiles(rootPath: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  };
  visit(rootPath);
  return files.sort();
}

function walk(dirPath: string, files: string[]): void {
  if (!fs.existsSync(dirPath)) return;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
}

function isDocFile(filePath: string): boolean {
  const baseName = path.basename(filePath).toLowerCase();
  return baseName === 'readme.md'
    || baseName === 'spec.md'
    || baseName === 'plan.md'
    || baseName.endsWith('.md');
}

function scanSafety(filePaths: string[]): ArenaSubjectManifest['safety'] {
  const warnings: string[] = [];
  const patterns = [
    { re: /\brm\s+-rf\b/i, label: 'destructive rm -rf instruction' },
    { re: /\bcurl\b.+\|\s*(?:sh|bash)\b/i, label: 'curl pipe shell instruction' },
    { re: /\b(api[_-]?key|token|secret|password)\b/i, label: 'mentions credentials or secrets' },
    { re: /\b(send email|send mail|发邮件|发送邮件|付款|支付|delete remote|删除远端)\b/i, label: 'mentions external side effects' },
  ];

  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size > 256_000) {
      continue;
    }
    const text = fs.readFileSync(filePath, 'utf-8');
    for (const pattern of patterns) {
      if (pattern.re.test(text)) {
        warnings.push(`${pattern.label}: ${relativePath(process.cwd(), filePath)}`);
      }
    }
  }

  return {
    risk_level: warnings.some(warning => warning.includes('destructive') || warning.includes('curl pipe'))
      ? 'high'
      : warnings.length > 0 ? 'medium' : 'low',
    warnings,
  };
}

export function fingerprintArenaDirectory(rootPath: string): string {
  const absoluteRoot = path.resolve(rootPath);
  if (!fs.existsSync(absoluteRoot)) {
    throw new Error(`Arena fingerprint directory does not exist: ${absoluteRoot}`);
  }
  const rootStat = fs.lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Arena fingerprint path must be a real directory: ${absoluteRoot}`);
  }

  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const entryPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Arena fingerprint rejects symbolic links: ${entryPath}`);
      }
      if (stat.isDirectory()) {
        visit(entryPath);
      } else if (stat.isFile()) {
        files.push(entryPath);
      } else {
        throw new Error(`Arena fingerprint rejects unsupported filesystem entry: ${entryPath}`);
      }
    }
  };
  visit(absoluteRoot);

  const hash = crypto.createHash('sha256');
  for (const filePath of files.sort()) {
    hash.update(path.relative(absoluteRoot, filePath).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function ensureImmutableSnapshot(from: string, to: string, expectedFingerprint: string): void {
  if (fs.existsSync(to)) {
    if (!fs.statSync(to).isDirectory() || fingerprintArenaDirectory(to) !== expectedFingerprint) {
      throw new Error(`Arena subject snapshot collision: ${to}`);
    }
    return;
  }

  try {
    copyDirectory(from, to);
    const copiedFingerprint = fingerprintArenaDirectory(to);
    if (copiedFingerprint === expectedFingerprint) return;
    throw new Error(`Arena subject snapshot verification failed: ${to}`);
  } catch (error) {
    fs.rmSync(to, { recursive: true, force: true });
    throw error;
  }
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'arena-item';
}

export function deriveArenaSubjectId(
  type: 'skill' | 'role',
  name: string,
  fingerprint: string,
): string {
  return deriveArenaId([type, name, fingerprint]);
}

function deriveArenaId(parts: string[]): string {
  const readable = safeSegment(parts.find(part => part && !part.includes('/')) || 'arena');
  const hash = crypto
    .createHash('sha256')
    .update(parts.join('\0'))
    .digest('hex')
    .slice(0, 10);
  return `${readable}-${hash}`;
}

function relativeExistingFiles(root: string, filePaths: string[]): string[] {
  return filePaths
    .filter(filePath => fs.existsSync(filePath))
    .map(filePath => relativePath(root, filePath));
}

function relativePath(root: string, filePath: string): string {
  const absolute = path.resolve(root, filePath);
  return path.relative(root, absolute) || '.';
}

function copyDirectory(from: string, to: string): void {
  ensureDir(to);
  fs.cpSync(from, to, {
    recursive: true,
    filter: source => !source.includes(`${path.sep}.git${path.sep}`) && !source.endsWith(`${path.sep}.git`),
  });
}

function countFiles(rootPath: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      count += countFiles(entryPath);
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}
