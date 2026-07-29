import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { ArenaManager } from '../arena/arena-manager';
import { executeArenaRun } from '../arena/arena-runner';
import {
  ArenaAllowedRuntime,
  ArenaNetworkMode,
  ArenaReviewMode,
  ArenaSandboxEngine,
  ArenaSandboxMode,
  ArenaTrustLevel,
  PrepareArenaRuntimeInput,
} from '../arena/types';
import { SkillParser } from '../skills/skill-parser';
import { PathResolver } from '../utils/path-resolver';
import { arenaLiveRuntimeContract } from '../arena/live-audit';
import {
  runArenaService,
  runPreparedArena,
} from '../arena/arena-service';

export function registerArenaCommand(program: Command): void {
  const arenaCmd = program
    .command('arena')
    .description('Arena: trace-grounded agentic eval for XiaoBa skills and roles');

  arenaCmd
    .command('live-contract')
    .description('Print the credential-free Barena live execution contract')
    .requiredOption('--json', 'emit the machine-readable contract')
    .action(() => {
      printJson(arenaLiveRuntimeContract());
    });

  arenaCmd
    .command('evaluate')
    .description('Run lightweight Scenario -> Trace -> Finding+Case -> shared Eval')
    .option('--role <id>', 'installed Role under test; defaults to Base for a Skill')
    .option('--skill <id>', 'installed Skill under test')
    .option('--scenario <text>', 'user Scenario goal; UserCat proposes one when omitted')
    .option('--run-id <id>', 'Arena run id')
    .option('--turns <n>', 'Scenario turn budget; default 4')
    .option('--runs <n>', 'Replay runs per generated Case; default 3')
    .option('--cwd <dir>', 'Runtime working directory')
    .option('--out <dir>', 'ArenaResult output directory')
    .action(async (options: LightweightArenaOptions) => {
      if (!options.role && !options.skill) {
        throw new Error('arena evaluate requires --role, --skill, or both');
      }
      const workingDirectory = path.resolve(
        options.cwd ?? PathResolver.getProjectRoot(),
      );
      const runId = options.runId || `arena-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const turnBudget = parseOptionalPositiveInt(options.turns, '--turns') ?? 4;
      const runsPerCase = parseOptionalPositiveInt(options.runs, '--runs') ?? 3;
      const subject = {
        subject_id: [options.role || 'base', options.skill].filter(Boolean).join('+'),
        ...(options.role ? { role_id: options.role } : {}),
        ...(options.skill ? { skill_id: options.skill } : {}),
      };
      const execution = await runArenaService({
        working_directory: workingDirectory,
        arena_run_id: runId,
        subject,
        ...(options.scenario ? { scenario_goal: options.scenario } : {}),
        turn_budget: turnBudget,
        runs_per_case: runsPerCase,
        ...(options.out ? { out_dir: path.resolve(options.out) } : {}),
      });
      printJson({
        arena_run_id: execution.result.arena_run_id,
        decision: execution.result.decision,
        result_path: execution.result_path,
      });
    });

  arenaCmd
    .command('skill <name>')
    .description('Evaluate an installed XiaoBa skill by name through Arena')
    .option('--role <id>', 'evaluate the skill inside a target role; default is clean base runtime')
    .option('--run-id <id>', 'run id')
    .option('--surface <name>', 'surface used by UserCat, default pet')
    .option('--pass-env <name>', 'environment variable name to pass through; repeatable', collectOption, [])
    .option('--workspace-seed <path>', 'directory copied into the clean Arena workspace before execution')
    .option('--scenario <text>', 'Scenario goal; UserCat proposes one when omitted')
    .option('--max-turns <n>', 'Scenario turn budget, default 4')
    .option('--replay-attempts <n>', 'shared Eval runs per generated Case, default 3')
    .option('--dry-run', 'write the sandboxed runner command without executing it')
    .option('--allow-unsandboxed', 'debug only: allow execution when no sandbox_shell_command is available')
    .option('--sandbox-engine <engine>', 'macos_seatbelt|linux_bubblewrap|windows_native|local_spawn|none')
    .option('--sandbox-mode <mode>', 'metadata_only|read_only|workspace_write')
    .option('--sandbox-workspace <path>', 'sandbox workspace root')
    .option('--sandbox-subject-root <path>', 'sandbox subject root')
    .option('--sandbox-writable <path>', 'sandbox writable root; repeatable', collectOption, [])
    .option('--network <mode>', 'disabled|enabled')
    .option('--timeout-ms <n>', 'sandbox command timeout')
    .action(async (name: string, options: ArenaSkillEvaluateOptions) => {
      const projectRoot = PathResolver.getProjectRoot();
      const skillPath = resolveInstalledSkillPath(projectRoot, name);
      const manager = new ArenaManager({ projectRoot });
      const manifest = manager.importLocalSkill({ skillPath });
      const reviewMode: ArenaReviewMode = options.role ? 'role_skill' : 'base_skill';
      const result = await executeArenaRun({
        projectRoot,
        reviewMode,
        subjectId: manifest.subject_id,
        runId: options.runId,
        targetRoleId: options.role,
        surface: options.surface,
        passThroughEnv: options.passEnv || [],
        workspaceSeedPath: options.workspaceSeed,
        scenario: options.scenario,
        maxTurns: parseOptionalPositiveInt(options.maxTurns, '--max-turns'),
        replayAttempts: parseOptionalPositiveInt(options.replayAttempts, '--replay-attempts'),
        dryRun: options.dryRun === true,
        allowUnsandboxed: options.allowUnsandboxed === true,
        sandbox: parseSandboxOptions(options),
      });
      printJson({
        status: result.status,
        command: 'arena skill',
        skill: {
          name: manifest.subject.name,
          subject_id: manifest.subject_id,
          source_path: manifest.source.path,
        },
        review_mode: reviewMode,
        ...(options.role && { target_role_id: options.role }),
        run_id: result.run_id,
        sandbox_enforced: result.sandbox_enforced,
        command_kind: result.command_kind,
        clean_runtime_path: result.clean_runtime_path,
        runner_path: result.runner_path,
        ...(result.result_path && { result_path: result.result_path }),
        ...(result.stdout_path && { stdout_path: result.stdout_path }),
        ...(result.stderr_path && { stderr_path: result.stderr_path }),
        ...(result.result && { result: result.result }),
      });
    });

  const importCmd = arenaCmd
    .command('import')
    .description('Import arena-only subjects without promoting them to production');

  importCmd
    .command('skill <path>')
    .description('Import a local skill into arena/subjects')
    .option('--trust <level>', 'trust level: untrusted|review_required|reviewed|promoted')
    .option('--allowed-runtime <level>', 'allowed runtime: arena_only|production_candidate|production')
    .action((skillPath: string, options: ImportSubjectOptions) => {
      const manifest = new ArenaManager().importLocalSkill({
        skillPath,
        trustLevel: parseTrustLevel(options.trust),
        allowedRuntime: parseAllowedRuntime(options.allowedRuntime),
      });
      printJson(manifest);
    });

  importCmd
    .command('github <repo>')
    .description('Clone, pin and scan a GitHub skill into arena/subjects')
    .option('--ref <ref>', 'git ref to checkout before pinning commit')
    .option('--trust <level>', 'trust level: untrusted|review_required|reviewed|promoted')
    .option('--allowed-runtime <level>', 'allowed runtime: arena_only|production_candidate|production')
    .action((repo: string, options: ImportGithubOptions) => {
      const manifest = new ArenaManager().importGithubSkill({
        repo,
        ref: options.ref,
        trustLevel: parseTrustLevel(options.trust) || 'untrusted',
        allowedRuntime: parseAllowedRuntime(options.allowedRuntime),
      });
      printJson(manifest);
    });

  const snapshotCmd = arenaCmd
    .command('snapshot')
    .description('Snapshot local subjects for Arena review');

  snapshotCmd
    .command('role <role-id>')
    .description('Snapshot a local role into arena/subjects')
    .option('--trust <level>', 'trust level: untrusted|review_required|reviewed|promoted')
    .option('--allowed-runtime <level>', 'allowed runtime: arena_only|production_candidate|production')
    .action((roleId: string, options: ImportSubjectOptions) => {
      const manifest = new ArenaManager().snapshotRole({
        roleId,
        trustLevel: parseTrustLevel(options.trust),
        allowedRuntime: parseAllowedRuntime(options.allowedRuntime),
      });
      printJson(manifest);
    });

  const runCmd = arenaCmd
    .command('run')
    .description('Execute the lightweight Arena workflow in a clean runtime');

  runCmd
    .command('execute')
    .description('Run Scenario -> Trace -> Finding+Case -> shared Eval in a clean runtime')
    .requiredOption('--mode <mode>', 'base_skill|role_skill|role')
    .requiredOption('--subject <id>', 'Arena subject id or path to arena-manifest.json')
    .option('--run-id <id>', 'run id')
    .option('--target-role <id>', 'required for role_skill and role modes')
    .option('--surface <name>', 'surface used by UserCat, default pet')
    .option('--pass-env <name>', 'environment variable name to pass through; repeatable', collectOption, [])
    .option('--workspace-seed <path>', 'directory copied into the clean Arena workspace before execution')
    .option('--scenario <text>', 'Scenario goal; UserCat proposes one when omitted')
    .option('--max-turns <n>', 'Scenario turn budget, default 4')
    .option('--replay-attempts <n>', 'shared Eval runs per generated Case, default 3')
    .option('--dry-run', 'write the sandboxed runner command without executing it')
    .option('--allow-unsandboxed', 'debug only: allow execution when no sandbox_shell_command is available')
    .option('--sandbox-engine <engine>', 'macos_seatbelt|linux_bubblewrap|windows_native|local_spawn|none')
    .option('--sandbox-mode <mode>', 'metadata_only|read_only|workspace_write')
    .option('--sandbox-workspace <path>', 'sandbox workspace root')
    .option('--sandbox-subject-root <path>', 'sandbox subject root')
    .option('--sandbox-writable <path>', 'sandbox writable root; repeatable', collectOption, [])
    .option('--network <mode>', 'disabled|enabled')
    .option('--timeout-ms <n>', 'sandbox command timeout')
    .action(async (options: ArenaRunExecuteOptions) => {
      const result = await executeArenaRun({
        reviewMode: parseReviewMode(options.mode),
        subjectId: options.subject,
        runId: options.runId,
        targetRoleId: options.targetRole,
        surface: options.surface,
        passThroughEnv: options.passEnv || [],
        workspaceSeedPath: options.workspaceSeed,
        scenario: options.scenario,
        maxTurns: parseOptionalPositiveInt(options.maxTurns, '--max-turns'),
        replayAttempts: parseOptionalPositiveInt(options.replayAttempts, '--replay-attempts'),
        dryRun: options.dryRun === true,
        allowUnsandboxed: options.allowUnsandboxed === true,
        sandbox: parseSandboxOptions(options),
      });
      printJson(result.result || result);
    });

  runCmd
    .command('worker')
    .description('Internal Arena worker for the lightweight shared-core workflow')
    .requiredOption('--run-id <id>', 'run id prepared by arena run execute')
    .option('--scenario <text>', 'Scenario goal')
    .option('--max-turns <n>', 'Scenario turn budget')
    .option('--replay-attempts <n>', 'shared Eval runs per generated Case')
    .action(async (options: ArenaRunWorkerOptions) => {
      const execution = await runPreparedArena({
        project_root: PathResolver.getProjectRoot(),
        run_id: options.runId,
        scenario: options.scenario,
        max_turns: parseOptionalPositiveInt(options.maxTurns, '--max-turns'),
        replay_attempts: parseOptionalPositiveInt(options.replayAttempts, '--replay-attempts'),
      });
      printJson(execution.result);
      if (process.env.XIAOBA_ARENA_SANDBOXED === '1') {
        // The internal worker has persisted every result at this point. Exit
        // after stdout flush so provider/client keep-alive handles cannot hold
        // the outer Arena command open until its coarse process timeout.
        await flushStdout();
        process.exit(0);
      }
    });

  const runtimeCmd = arenaCmd
    .command('runtime')
    .description('Prepare clean Arena runtime overlays');

  runtimeCmd
    .command('prepare')
    .description('Prepare a clean base or role runtime for evaluating a skill or role')
    .requiredOption('--mode <mode>', 'base_skill|role_skill|role')
    .requiredOption('--subject <id>', 'Arena subject id or path to arena-manifest.json')
    .option('--run-id <id>', 'run id')
    .option('--target-role <id>', 'required for role_skill and role modes')
    .option('--surface <name>', 'surface used by UserCat, default pet')
    .option('--pass-env <name>', 'environment variable name to pass through; repeatable', collectOption, [])
    .option('--workspace-seed <path>', 'directory copied into the clean Arena workspace')
    .option('--sandbox-engine <engine>', 'macos_seatbelt|linux_bubblewrap|windows_native|local_spawn|none')
    .option('--sandbox-mode <mode>', 'metadata_only|read_only|workspace_write')
    .option('--sandbox-workspace <path>', 'sandbox workspace root')
    .option('--sandbox-subject-root <path>', 'sandbox subject root')
    .option('--sandbox-writable <path>', 'sandbox writable root; repeatable', collectOption, [])
    .option('--network <mode>', 'disabled|enabled')
    .option('--timeout-ms <n>', 'sandbox command timeout')
    .action((options: ArenaRuntimePrepareOptions) => {
      const manager = new ArenaManager();
      const runtimeIndex = manager.prepareCleanRuntime({
        runId: options.runId,
        reviewMode: parseReviewMode(options.mode),
        subjectId: options.subject,
        targetRoleId: options.targetRole,
        surface: options.surface,
        passThroughEnv: options.passEnv || [],
        workspaceSeedPath: options.workspaceSeed,
        sandbox: parseSandboxOptions(options),
      });
      printJson(runtimeIndex);
    });
}

function flushStdout(): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write('', error => error ? reject(error) : resolve());
  });
}

interface ImportSubjectOptions {
  trust?: string;
  allowedRuntime?: string;
}

interface ImportGithubOptions extends ImportSubjectOptions {
  ref?: string;
}

interface ArenaSandboxOptionSet {
  sandboxEngine?: string;
  sandboxMode?: string;
  sandboxWorkspace?: string;
  sandboxSubjectRoot?: string;
  sandboxWritable?: string[];
  network?: string;
  timeoutMs?: string;
}

interface LightweightArenaOptions {
  role?: string;
  skill?: string;
  scenario?: string;
  runId?: string;
  turns?: string;
  runs?: string;
  cwd?: string;
  out?: string;
}

interface ArenaRuntimePrepareOptions extends ArenaSandboxOptionSet {
  mode: string;
  subject: string;
  runId?: string;
  targetRole?: string;
  surface?: string;
  passEnv?: string[];
  workspaceSeed?: string;
}

interface ArenaRunExecuteOptions extends ArenaSandboxOptionSet {
  mode: string;
  subject: string;
  runId?: string;
  targetRole?: string;
  surface?: string;
  passEnv?: string[];
  workspaceSeed?: string;
  scenario?: string;
  maxTurns?: string;
  replayAttempts?: string;
  dryRun?: boolean;
  allowUnsandboxed?: boolean;
}

interface ArenaSkillEvaluateOptions extends ArenaSandboxOptionSet {
  role?: string;
  runId?: string;
  surface?: string;
  passEnv?: string[];
  workspaceSeed?: string;
  scenario?: string;
  maxTurns?: string;
  replayAttempts?: string;
  dryRun?: boolean;
  allowUnsandboxed?: boolean;
}

interface ArenaRunWorkerOptions {
  runId: string;
  scenario?: string;
  maxTurns?: string;
  replayAttempts?: string;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'arena';
}

function resolveInstalledSkillPath(projectRoot: string, value: string): string {
  const direct = resolveSkillFileCandidate(projectRoot, value);
  if (direct) return direct;

  const baseSkillsRoot = PathResolver.getBaseSkillsPath();
  const baseDirect = resolveSkillFileCandidate(projectRoot, path.join(baseSkillsRoot, value));
  if (baseDirect) return baseDirect;

  const matches = PathResolver.findSkillFiles(baseSkillsRoot)
    .map(filePath => readSkillIdentity(filePath))
    .filter((identity): identity is SkillIdentity => Boolean(identity));
  const exactMatches = findSkillIdentityMatches(matches, value, false);
  if (exactMatches.length === 1) return exactMatches[0].filePath;
  if (exactMatches.length > 1) {
    throw new Error(`ambiguous skill name: ${value}. Matches: ${exactMatches.map(match => match.filePath).join(', ')}`);
  }

  const looseMatches = findSkillIdentityMatches(matches, value, true);
  if (looseMatches.length === 1) return looseMatches[0].filePath;
  if (looseMatches.length > 1) {
    throw new Error(`ambiguous skill name: ${value}. Matches: ${looseMatches.map(match => match.filePath).join(', ')}`);
  }

  const arenaSubjectSkill = resolveArenaSubjectSkillPath(projectRoot, value);
  if (arenaSubjectSkill) return arenaSubjectSkill;

  throw new Error(`Skill not found in XiaoBa skills system or Arena subjects: ${value}. Searched ${baseSkillsRoot} and arena/subjects.`);
}

function resolveSkillFileCandidate(projectRoot: string, value: string): string | undefined {
  const absolutePath = path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
  if (!fs.existsSync(absolutePath)) return undefined;
  const stat = fs.statSync(absolutePath);
  if (stat.isDirectory()) {
    const skillFile = path.join(absolutePath, 'SKILL.md');
    return fs.existsSync(skillFile) ? skillFile : undefined;
  }
  if (stat.isFile() && path.basename(absolutePath) === 'SKILL.md') {
    return absolutePath;
  }
  return undefined;
}

interface SkillIdentity {
  filePath: string;
  keys: string[];
  rankMs?: number;
}

function readSkillIdentity(filePath: string): SkillIdentity | undefined {
  try {
    const skill = SkillParser.parse(filePath);
    return {
      filePath,
      keys: [
        skill.metadata.name,
        ...(skill.metadata.aliases || []),
        path.basename(path.dirname(filePath)),
      ].filter(Boolean),
    };
  } catch {
    return undefined;
  }
}

function findSkillIdentityMatches(skills: SkillIdentity[], value: string, caseInsensitive: boolean): SkillIdentity[] {
  const target = caseInsensitive ? value.toLowerCase() : value;
  return skills.filter(skill => skill.keys.some(key => (caseInsensitive ? key.toLowerCase() : key) === target));
}

function resolveArenaSubjectSkillPath(projectRoot: string, value: string): string | undefined {
  const subjectsRoot = path.join(projectRoot, 'arena', 'subjects');
  if (!fs.existsSync(subjectsRoot)) return undefined;

  const matches = fs.readdirSync(subjectsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(subjectsRoot, entry.name, 'arena-manifest.json'))
    .filter(manifestPath => fs.existsSync(manifestPath))
    .map(manifestPath => readArenaSubjectSkillIdentity(projectRoot, manifestPath))
    .filter((identity): identity is SkillIdentity => Boolean(identity));

  const exactMatches = findSkillIdentityMatches(matches, value, false);
  if (exactMatches.length > 0) return pickLatestSkillIdentity(exactMatches).filePath;

  const looseMatches = findSkillIdentityMatches(matches, value, true);
  if (looseMatches.length > 0) return pickLatestSkillIdentity(looseMatches).filePath;

  return undefined;
}

function readArenaSubjectSkillIdentity(projectRoot: string, manifestPath: string): SkillIdentity | undefined {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      subject_id?: string;
      created_at?: string;
      subject?: { type?: string; name?: string };
      source?: { path?: string };
      parsed?: { skill_files?: string[] };
    };
    if (manifest.subject?.type !== 'skill' || !manifest.subject.name) return undefined;
    const skillFile = [
      manifest.source?.path,
      ...(manifest.parsed?.skill_files || []),
    ]
      .map(candidate => typeof candidate === 'string' ? resolveSkillFileCandidate(projectRoot, candidate) : undefined)
      .find(Boolean);
    if (!skillFile) return undefined;
    const createdAtMs = manifest.created_at ? Date.parse(manifest.created_at) : Number.NaN;
    const manifestMtimeMs = fs.statSync(manifestPath).mtimeMs;
    return {
      filePath: skillFile,
      keys: [
        manifest.subject.name,
        manifest.subject_id || '',
        path.basename(path.dirname(skillFile)),
      ].filter(Boolean),
      rankMs: Number.isFinite(createdAtMs) ? createdAtMs : manifestMtimeMs,
    };
  } catch {
    return undefined;
  }
}

function pickLatestSkillIdentity(matches: SkillIdentity[]): SkillIdentity {
  return [...matches].sort((left, right) => {
    const timeDelta = (right.rankMs || 0) - (left.rankMs || 0);
    if (timeDelta !== 0) return timeDelta;
    return right.filePath.localeCompare(left.filePath);
  })[0];
}

function parseTrustLevel(value: string | undefined): ArenaTrustLevel | undefined {
  if (!value) return undefined;
  const allowed: ArenaTrustLevel[] = ['untrusted', 'review_required', 'reviewed', 'promoted'];
  if (allowed.includes(value as ArenaTrustLevel)) return value as ArenaTrustLevel;
  throw new Error(`invalid trust level: ${value}`);
}

function parseAllowedRuntime(value: string | undefined): ArenaAllowedRuntime | undefined {
  if (!value) return undefined;
  const allowed: ArenaAllowedRuntime[] = ['arena_only', 'production_candidate', 'production'];
  if (allowed.includes(value as ArenaAllowedRuntime)) return value as ArenaAllowedRuntime;
  throw new Error(`invalid allowed runtime: ${value}`);
}

function parseReviewMode(value: string): ArenaReviewMode {
  const allowed: ArenaReviewMode[] = ['base_skill', 'role_skill', 'role'];
  if (allowed.includes(value as ArenaReviewMode)) return value as ArenaReviewMode;
  throw new Error(`invalid review mode: ${value}`);
}

function parseSandboxOptions(options: ArenaSandboxOptionSet): PrepareArenaRuntimeInput['sandbox'] {
  const sandbox: PrepareArenaRuntimeInput['sandbox'] = {};
  if (options.sandboxEngine) sandbox.engine = parseSandboxEngine(options.sandboxEngine);
  if (options.sandboxMode) sandbox.mode = parseSandboxMode(options.sandboxMode);
  if (options.sandboxWorkspace) sandbox.workspace_root = options.sandboxWorkspace;
  if (options.sandboxSubjectRoot) sandbox.subject_root = options.sandboxSubjectRoot;
  if (options.sandboxWritable?.length) sandbox.writable_roots = options.sandboxWritable;
  if (options.network) sandbox.network = parseNetworkMode(options.network);
  const timeoutMs = parseOptionalNonNegativeInt(options.timeoutMs, '--timeout-ms');
  if (timeoutMs !== undefined) sandbox.timeout_ms = timeoutMs;
  return sandbox;
}

function parseSandboxEngine(value: string): ArenaSandboxEngine {
  const allowed: ArenaSandboxEngine[] = ['macos_seatbelt', 'linux_bubblewrap', 'windows_native', 'local_spawn', 'none'];
  if (allowed.includes(value as ArenaSandboxEngine)) return value as ArenaSandboxEngine;
  throw new Error(`invalid sandbox engine: ${value}`);
}

function parseSandboxMode(value: string): ArenaSandboxMode {
  const allowed: ArenaSandboxMode[] = ['metadata_only', 'read_only', 'workspace_write'];
  if (allowed.includes(value as ArenaSandboxMode)) return value as ArenaSandboxMode;
  throw new Error(`invalid sandbox mode: ${value}`);
}

function parseNetworkMode(value: string): ArenaNetworkMode {
  const allowed: ArenaNetworkMode[] = ['disabled', 'enabled'];
  if (allowed.includes(value as ArenaNetworkMode)) return value as ArenaNetworkMode;
  throw new Error(`invalid network mode: ${value}`);
}

function parseOptionalNonNegativeInt(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseOptionalPositiveInt(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
