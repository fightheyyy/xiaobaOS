import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ArenaManager } from '../../arena/arena-manager';
import { buildArenaShellCommand } from '../../arena/arena-shell';
import { FindingCase } from '../../arena/arena-workflow';
import { EvaluationResult } from '../../eval/evaluation';
import { createInspectorCat } from '../inspector-cat/finding-case';
import { CaseReplaySetup } from '../../replay/case-replay';
import { SkillManager } from '../../skills/skill-manager';
import { SubAgentSession } from '../../core/sub-agent-session';
import { AIService } from '../../utils/ai-service';
import { runCandidatePackageTest } from '../../testing/candidate-package-test';
import { runSourceCandidateTest } from '../../testing/source-candidate-test';
import {
  buildEvolutionDigest,
  BuildEvolutionDigestResult,
} from './evolution-observer';
import {
  Candidate,
  EvolutionDependencies,
  EvolutionResult,
  runEvolution,
} from './evolution-workflow';
import {
  createCapabilityCandidate,
  validateEvolutionCandidatePackage,
} from './candidate-package';
import {
  activateSourceCandidate,
  createSourceCandidate,
  createSourceCandidateWorkspace,
  SOURCE_CANDIDATE_NAME,
  validateSourceCandidate,
} from './source-candidate';

const CANDIDATE_BUILDER_HIDDEN_TOOLS = [
  'execute_shell',
  'spawn_subagent',
  'check_subagent',
  'stop_subagent',
  'resume_subagent',
  'ask_parent',
  'remember',
];

const ENGINEER_CANDIDATE_HIDDEN_TOOLS = [
  'spawn_subagent',
  'check_subagent',
  'stop_subagent',
  'resume_subagent',
  'ask_parent',
  'remember',
];

export interface EvolutionSleepRunOptions {
  workingDirectory: string;
  targetDate: string;
  minOccurrences: number;
  runsPerCase?: number;
  verbose?: boolean;
  now?: Date;
}

export interface EvolutionSleepExecution {
  result: EvolutionResult<CaseReplaySetup>;
  result_path: string;
  digest_path: string;
}

export interface EvolutionRuntimeDependencies {
  buildDigest?: typeof buildEvolutionDigest;
  inspect?: EvolutionDependencies<CaseReplaySetup>['inspect'];
  change?: EvolutionDependencies<CaseReplaySetup>['change'];
  test?: EvolutionDependencies<CaseReplaySetup>['test'];
  evaluate?: EvolutionDependencies<CaseReplaySetup>['evaluate'];
  activateForNewSessions?: EvolutionDependencies<CaseReplaySetup>['activateForNewSessions'];
}

export async function runEvolutionSleep(
  options: EvolutionSleepRunOptions,
  dependencies: EvolutionRuntimeDependencies = {},
): Promise<EvolutionSleepExecution> {
  const root = path.resolve(options.workingDirectory);
  const digestResult = (dependencies.buildDigest ?? buildEvolutionDigest)({
    workingDirectory: root,
    targetDate: options.targetDate,
    minOccurrences: options.minOccurrences,
    now: options.now,
  });
  const runId = `evolution-${options.targetDate}`;
  const runRoot = path.join(root, 'output', 'evolution', 'runs', safeSegment(runId));
  const candidatesRoot = path.join(runRoot, 'candidates');
  resetOwnedDirectory(runRoot, candidatesRoot);
  const traceRefs = unique(
    digestResult.digest.patterns
      .flatMap(pattern => pattern.sample_trace_refs)
      .map(stripTraceFragment),
  );

  const result = traceRefs.length === 0
    ? { evolution_run_id: runId, attempts: [] }
    : await runEvolution<CaseReplaySetup>({
        evolution_run_id: runId,
        source: {
          type: 'trace',
          trace_refs: traceRefs,
        },
      }, {
        inspect: dependencies.inspect ?? createEvolutionInspector(root, digestResult),
        change: dependencies.change ?? createEvolutionCandidateBuilder({
          working_directory: root,
          run_root: runRoot,
          candidates_root: candidatesRoot,
        }),
        test: dependencies.test ?? (async ({ candidate }) => (
          candidate.candidate_type === 'code'
            ? runSourceCandidateTest({
                working_directory: root,
                candidate,
                out_dir: path.join(runRoot, 'test', safeSegment(candidate.candidate_id)),
              })
            : runCandidatePackageTest({
                working_directory: root,
                candidate,
                out_dir: path.join(runRoot, 'test', safeSegment(candidate.candidate_id)),
              })
        )),
        evaluate: dependencies.evaluate ?? (async input => evaluateEvolutionCandidate({
          working_directory: root,
          run_id: runId,
          runs_per_case: options.runsPerCase ?? 3,
          ...input,
        })),
        activateForNewSessions: dependencies.activateForNewSessions
          ?? (async candidate => activateEvolutionCandidate({
            working_directory: root,
            candidate,
            out_dir: path.join(runRoot, 'activation'),
          })),
      });

  fs.mkdirSync(runRoot, { recursive: true });
  const resultPath = path.join(runRoot, 'evolution-result.json');
  atomicWriteJson(resultPath, result);
  return {
    result,
    result_path: resultPath,
    digest_path: digestResult.digestPath,
  };
}

export function createEvolutionCandidateBuilder(options: {
  working_directory: string;
  run_root: string;
  candidates_root: string;
  runSession?: (input: {
    prompt: string;
    working_directory: string;
    allowed_write_root: string;
  }) => Promise<string>;
  runEngineerSession?: (input: {
    prompt: string;
    working_directory: string;
    allowed_write_root: string;
  }) => Promise<string>;
}): EvolutionDependencies<CaseReplaySetup>['change'] {
  const root = path.resolve(options.working_directory);
  const runRoot = path.resolve(options.run_root);
  const candidatesRoot = path.resolve(options.candidates_root);
  return async ({ finding_case }) => {
    fs.mkdirSync(candidatesRoot, { recursive: true });
    const before = new Set(fs.readdirSync(candidatesRoot));
    const prompt = buildCandidatePrompt(finding_case);
    const raw = options.runSession
      ? await options.runSession({
          prompt,
          working_directory: runRoot,
          allowed_write_root: candidatesRoot,
        })
      : await runCandidateBuilderSession({
          prompt,
          workingDirectory: runRoot,
          candidatesRoot,
        });
    const decision = parseCandidateDecision(raw);
    const created = fs.readdirSync(candidatesRoot).filter(name => !before.has(name));
    if (decision.status === 'blocked') {
      removeCreatedCandidates(candidatesRoot, created);
      throw new Error(decision.reason || 'EvolutionCat blocked Candidate creation');
    }
    if (decision.status === 'delegate_code') {
      removeCreatedCandidates(candidatesRoot, created);
      const workspace = createSourceCandidateWorkspace({
        working_directory: root,
        candidates_root: candidatesRoot,
      });
      const engineerPrompt = buildEngineerCandidatePrompt(finding_case);
      const engineerRaw = options.runEngineerSession
        ? await options.runEngineerSession({
            prompt: engineerPrompt,
            working_directory: workspace.artifact_path,
            allowed_write_root: workspace.artifact_path,
          })
        : await runEngineerCandidateSession({
            prompt: engineerPrompt,
            workingDirectory: workspace.artifact_path,
          });
      const engineerDecision = parseEngineerCandidateDecision(engineerRaw);
      if (engineerDecision.status === 'blocked') {
        fs.rmSync(workspace.artifact_path, { recursive: true, force: true });
        throw new Error(engineerDecision.reason);
      }
      return createSourceCandidate({
        working_directory: root,
        candidates_root: candidatesRoot,
        case_id: finding_case.case.case_id,
        artifact_path: workspace.artifact_path,
        base_version: workspace.base_version,
        base_source_fingerprint: workspace.base_source_fingerprint,
      });
    }
    if (created.length !== 1 || created[0] !== decision.candidate_name) {
      removeCreatedCandidates(candidatesRoot, created);
      throw new Error('EvolutionCat must create exactly one declared Candidate package');
    }
    return createCapabilityCandidate({
      working_directory: root,
      candidates_root: candidatesRoot,
      case_id: finding_case.case.case_id,
      candidate_type: decision.candidate_type,
      candidate_name: decision.candidate_name,
      artifact_path: path.resolve(runRoot, decision.artifact_ref),
    });
  };
}

export async function evaluateEvolutionCandidate(input: {
  working_directory: string;
  run_id: string;
  runs_per_case: number;
  candidate: Readonly<Candidate>;
  cases: readonly Readonly<import('../../eval/evaluation').AgentCase<CaseReplaySetup>>[];
}): Promise<EvaluationResult> {
  const root = path.resolve(input.working_directory);
  if (input.candidate.candidate_type === 'code') {
    return evaluateSourceCandidate({
      root,
      run_id: input.run_id,
      runs_per_case: input.runs_per_case,
      candidate: input.candidate,
      cases: input.cases,
    });
  }
  const verified = validateEvolutionCandidatePackage(root, input.candidate);
  const manager = new ArenaManager({ projectRoot: root });
  const subject = input.candidate.candidate_type === 'skill'
    ? manager.importLocalSkill({
        skillPath: verified.artifact_path,
        trustLevel: 'review_required',
        allowedRuntime: 'arena_only',
      })
    : manager.importLocalRole({
        rolePath: verified.artifact_path,
        trustLevel: 'review_required',
        allowedRuntime: 'arena_only',
      });
  const runtime = manager.prepareCleanRuntime({
    runId: `${safeSegment(input.run_id)}-${safeSegment(input.candidate.candidate_id)}`,
    reviewMode: input.candidate.candidate_type === 'skill' ? 'base_skill' : 'role',
    subjectId: subject.subject_id,
    passThroughEnv: evolutionProviderEnvNames(),
    ...(input.candidate.candidate_type === 'role'
      ? { targetRoleId: input.candidate.candidate_name }
      : {}),
    sandbox: {
      mode: 'workspace_write',
      network: 'enabled',
    },
  });
  if (!runtime.launch.sandbox_profile_path || !runtime.launch.sandbox_shell_command) {
    throw new Error('Candidate Evaluation requires an enforced clean-runtime sandbox');
  }
  const caseSet = {
    case_set_id: `evolution:${input.run_id}:${input.candidate.candidate_id}`,
    cases: input.cases.map(evaluationCase => ({
      ...evaluationCase,
      setup: {
        ...(evaluationCase.setup ?? {}),
        cwd: '.',
        ...(input.candidate.candidate_type === 'skill'
          ? { required_active_skill_name: input.candidate.candidate_name }
          : {
              session_key: `pet:xiaoba:role-${input.candidate.candidate_name}`,
            }),
      },
    })),
  };
  const caseSetPath = path.join(runtime.roots.run_root, 'case-set.json');
  const outDir = path.join(runtime.roots.run_root, 'evaluation');
  atomicWriteJson(caseSetPath, caseSet);
  const entrypoint = path.join(root, 'dist', 'index.js');
  if (!fs.existsSync(entrypoint)) {
    throw new Error(`Candidate Evaluation requires built CLI entrypoint: ${entrypoint}`);
  }
  const command = [
    process.execPath,
    entrypoint,
    'eval',
    'run',
    '--case-set',
    caseSetPath,
    '--cwd',
    runtime.roots.workspace_root,
    '--out',
    outDir,
    '--runs',
    String(input.runs_per_case),
  ];
  const shellCommand = buildArenaShellCommand({
    cwd: runtime.roots.workspace_root,
    command,
    env: runtime.launch.env,
    passThroughEnv: runtime.launch.pass_through_env,
    sandboxProfilePath: runtime.launch.sandbox_profile_path,
  });
  const execution = spawnSync('/bin/sh', ['-lc', shellCommand], {
    cwd: runtime.roots.workspace_root,
    env: process.env,
    encoding: 'utf-8',
    timeout: runtime.sandbox.timeout_ms,
  });
  fs.writeFileSync(
    path.join(runtime.roots.run_root, 'evaluation.stdout.log'),
    execution.stdout || '',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(runtime.roots.run_root, 'evaluation.stderr.log'),
    execution.stderr || '',
    'utf-8',
  );
  if (execution.error) throw execution.error;
  if (execution.status !== 0) {
    throw new Error(
      `Candidate Evaluation exited with status ${execution.status}: ${(execution.stderr || '').slice(0, 1000)}`,
    );
  }
  const resultPath = path.join(outDir, 'evaluation-result.json');
  if (!fs.existsSync(resultPath)) {
    throw new Error('Candidate Evaluation produced no evaluation-result.json');
  }
  return JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as EvaluationResult;
}

async function evaluateSourceCandidate(input: {
  root: string;
  run_id: string;
  runs_per_case: number;
  candidate: Readonly<Candidate>;
  cases: readonly Readonly<import('../../eval/evaluation').AgentCase<CaseReplaySetup>>[];
}): Promise<EvaluationResult> {
  const verified = validateSourceCandidate(input.root, input.candidate);
  if (verified.base_version !== input.candidate.base_version) {
    throw new Error('Production source changed before Source Candidate Evaluation');
  }
  const entrypoint = path.join(verified.artifact_path, 'dist', 'index.js');
  if (!fs.existsSync(entrypoint)) {
    throw new Error('Source Candidate Evaluation requires a successful Candidate Test build');
  }
  const targetRole = singleCaseTargetRole(input.cases);
  const subjectRole = targetRole ?? 'reviewer-cat';
  const rolePath = path.join(verified.artifact_path, 'roles', subjectRole);
  if (!fs.existsSync(path.join(rolePath, 'role.json'))) {
    throw new Error(`Source Candidate is missing target Role package: ${subjectRole}`);
  }

  const manager = new ArenaManager({ projectRoot: verified.artifact_path });
  const subject = manager.importLocalRole({
    rolePath,
    trustLevel: 'review_required',
    allowedRuntime: 'arena_only',
  });
  const runtime = manager.prepareCleanRuntime({
    runId: `${safeSegment(input.run_id)}-${safeSegment(input.candidate.candidate_id)}`,
    reviewMode: 'role',
    subjectId: subject.subject_id,
    targetRoleId: subjectRole,
    passThroughEnv: evolutionProviderEnvNames(),
    sandbox: {
      mode: 'workspace_write',
      network: 'enabled',
    },
  });
  if (!runtime.launch.sandbox_profile_path || !runtime.launch.sandbox_shell_command) {
    throw new Error('Source Candidate Evaluation requires an enforced clean-runtime sandbox');
  }

  const caseSet = {
    case_set_id: `evolution:${input.run_id}:${input.candidate.candidate_id}`,
    cases: input.cases.map(evaluationCase => ({
      ...evaluationCase,
      setup: {
        ...(evaluationCase.setup ?? {}),
        cwd: '.',
        sandbox: evaluationCase.setup?.sandbox ?? 'read_only',
      },
    })),
  };
  const caseSetPath = path.join(runtime.roots.run_root, 'case-set.json');
  const outDir = path.join(runtime.roots.run_root, 'evaluation');
  atomicWriteJson(caseSetPath, caseSet);
  const command = [
    process.execPath,
    entrypoint,
    'eval',
    'run',
    '--case-set',
    caseSetPath,
    '--cwd',
    runtime.roots.workspace_root,
    '--out',
    outDir,
    '--runs',
    String(input.runs_per_case),
  ];
  const shellCommand = buildArenaShellCommand({
    cwd: runtime.roots.workspace_root,
    command,
    env: runtime.launch.env,
    passThroughEnv: runtime.launch.pass_through_env,
    sandboxProfilePath: runtime.launch.sandbox_profile_path,
  });
  const execution = spawnSync('/bin/sh', ['-lc', shellCommand], {
    cwd: runtime.roots.workspace_root,
    env: process.env,
    encoding: 'utf-8',
    timeout: runtime.sandbox.timeout_ms,
  });
  fs.writeFileSync(
    path.join(runtime.roots.run_root, 'evaluation.stdout.log'),
    execution.stdout || '',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(runtime.roots.run_root, 'evaluation.stderr.log'),
    execution.stderr || '',
    'utf-8',
  );
  if (execution.error) throw execution.error;
  if (execution.status !== 0) {
    throw new Error(
      `Source Candidate Evaluation exited with status ${execution.status}: ${(execution.stderr || '').slice(0, 1000)}`,
    );
  }
  const resultPath = path.join(outDir, 'evaluation-result.json');
  if (!fs.existsSync(resultPath)) {
    throw new Error('Source Candidate Evaluation produced no evaluation-result.json');
  }
  return JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as EvaluationResult;
}

export async function activateEvolutionCandidate(input: {
  working_directory: string;
  candidate: Readonly<Candidate>;
  out_dir: string;
}): Promise<void> {
  const root = path.resolve(input.working_directory);
  if (input.candidate.candidate_type === 'code') {
    activateSourceCandidate({
      working_directory: root,
      candidate: input.candidate,
      out_dir: input.out_dir,
    });
    return;
  }
  const verified = validateEvolutionCandidatePackage(root, input.candidate);
  if (verified.base_version !== input.candidate.base_version) {
    throw new Error(
      `Production ${input.candidate.candidate_type} changed after Candidate creation`,
    );
  }

  const target = verified.production_path;
  const parent = path.dirname(target);
  const nonce = crypto.randomUUID();
  const temporary = path.join(parent, `.${input.candidate.candidate_name}.activate-${nonce}`);
  const backup = path.join(parent, `.${input.candidate.candidate_name}.backup-${nonce}`);
  fs.mkdirSync(parent, { recursive: true });
  fs.cpSync(verified.artifact_path, temporary, {
    recursive: true,
    errorOnExist: true,
  });

  let backedUp = false;
  try {
    const temporaryCandidate: Candidate = {
      ...input.candidate,
      artifact_ref: temporary,
    };
    validateEvolutionCandidatePackage(root, temporaryCandidate);
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup);
      backedUp = true;
    }
    fs.renameSync(temporary, target);
    const activatedCandidate: Candidate = {
      ...input.candidate,
      artifact_ref: target,
    };
    validateEvolutionCandidatePackage(root, activatedCandidate);
    if (backedUp) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
    if (backedUp) {
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(backup, target);
    }
    throw error;
  }

  const outDir = path.resolve(input.out_dir);
  fs.mkdirSync(outDir, { recursive: true });
  atomicWriteJson(path.join(outDir, `${safeSegment(input.candidate.candidate_id)}.json`), {
    activation_version: 1,
    candidate_id: input.candidate.candidate_id,
    candidate_type: input.candidate.candidate_type,
    candidate_name: input.candidate.candidate_name,
    artifact_fingerprint: input.candidate.artifact_fingerprint,
    production_ref: displayPath(target, root),
    scope: 'new_sessions',
    activated_at: new Date().toISOString(),
  });
}

function singleCaseTargetRole(
  cases: readonly Readonly<import('../../eval/evaluation').AgentCase<CaseReplaySetup>>[],
): string | undefined {
  const roles = unique(cases.map(item => {
    const match = item.setup?.session_key
      ?.match(/(?:^|:)role-([a-z0-9][a-z0-9-]{0,63})(?:$|:)/i);
    const role = match?.[1]?.toLowerCase();
    return role && role !== 'base' ? role : '';
  }));
  if (roles.length > 1) {
    throw new Error('Source Candidate Evaluation requires one target Role per Candidate');
  }
  return roles[0] || undefined;
}

function createEvolutionInspector(
  workingDirectory: string,
  digest: BuildEvolutionDigestResult,
): EvolutionDependencies<CaseReplaySetup>['inspect'] {
  const inspector = createInspectorCat<CaseReplaySetup>({
    working_directory: workingDirectory,
  });
  return traceRefs => inspector({
    trace_refs: traceRefs,
    evidence_refs: [displayPath(digest.digestPath, workingDirectory)],
    context: {
      source: 'nightly_evolution',
      target_date: digest.digest.window.target_date,
      recurring_patterns: digest.digest.patterns,
    },
  });
}

function buildCandidatePrompt(findingCase: Readonly<FindingCase<CaseReplaySetup>>): string {
  return [
    'This is a bounded EvolutionCat Candidate builder call.',
    'Create one directly loadable Skill or Role Candidate under candidates/<name>/.',
    'If the Finding requires runtime, Tool, protocol, test, or source-code changes, do not modify code. Delegate it to EngineerCat.',
    'Do not add candidate/blocked lifecycle status. The package is isolated by its directory until Test + Eval pass.',
    'Use write_file/edit_file only inside candidates/. Do not run shell commands or modify production skills/roles.',
    'Return exactly one JSON object:',
    '{"version":1,"status":"candidate","candidate_type":"skill|role","candidate_name":"lowercase-kebab-name","artifact_ref":"candidates/<name>"}',
    'or {"version":1,"status":"delegate_code","reason":"why source code is required"}',
    'or {"version":1,"status":"blocked","reason":"..."}',
    '',
    JSON.stringify(findingCase, null, 2),
  ].join('\n');
}

function buildEngineerCandidatePrompt(
  findingCase: Readonly<FindingCase<CaseReplaySetup>>,
): string {
  return [
    'This is a bounded EngineerCat Source Candidate call.',
    `The working directory is an isolated copy named ${SOURCE_CANDIDATE_NAME}.`,
    'Implement the smallest source-code repair that satisfies the Finding and executable Case.',
    'Do not access or modify the production repository. Do not add a second runtime, workflow, lifecycle, or report system.',
    'You may read, edit, and test only inside the supplied working directory.',
    'Return exactly one JSON object after the source change:',
    `{"version":1,"status":"candidate","candidate_name":"${SOURCE_CANDIDATE_NAME}"}`,
    'or {"version":1,"status":"blocked","reason":"..."}',
    '',
    JSON.stringify(findingCase, null, 2),
  ].join('\n');
}

async function runCandidateBuilderSession(input: {
  prompt: string;
  workingDirectory: string;
  candidatesRoot: string;
}): Promise<string> {
  const skills = new SkillManager('evolution-cat');
  await skills.loadSkills();
  const session = new SubAgentSession(
    `evolution-candidate-${crypto.randomUUID()}`,
    new AIService(),
    skills,
    {
      roleName: 'evolution-cat',
      skillName: 'self-evolution',
      taskDescription: 'build one isolated capability Candidate',
      userMessage: input.prompt,
      workingDirectory: input.workingDirectory,
      parentSessionId: `evolution:${crypto.randomUUID()}`,
      allowSkillSelection: false,
      hiddenTools: CANDIDATE_BUILDER_HIDDEN_TOOLS,
      allowedWriteRoot: input.candidatesRoot,
    },
  );
  await session.run();
  const info = session.getInfo();
  if (info.status !== 'completed' || !info.resultSummary?.trim()) {
    throw new Error(`EvolutionCat Candidate builder failed: ${info.resultSummary || info.status}`);
  }
  return info.resultSummary;
}

async function runEngineerCandidateSession(input: {
  prompt: string;
  workingDirectory: string;
}): Promise<string> {
  const skills = new SkillManager('engineer-cat');
  await skills.loadSkills();
  const session = new SubAgentSession(
    `engineer-candidate-${crypto.randomUUID()}`,
    new AIService(),
    skills,
    {
      roleName: 'engineer-cat',
      taskDescription: 'build one isolated Source Candidate',
      userMessage: input.prompt,
      workingDirectory: input.workingDirectory,
      parentSessionId: `evolution:${crypto.randomUUID()}`,
      allowSkillSelection: false,
      hiddenTools: ENGINEER_CANDIDATE_HIDDEN_TOOLS,
      allowedWriteRoot: input.workingDirectory,
    },
  );
  await session.run();
  const info = session.getInfo();
  if (info.status !== 'completed' || !info.resultSummary?.trim()) {
    throw new Error(`EngineerCat Candidate builder failed: ${info.resultSummary || info.status}`);
  }
  return info.resultSummary;
}

function parseCandidateDecision(raw: string): {
  status: 'candidate' | 'delegate_code' | 'blocked';
  candidate_type: 'skill' | 'role';
  candidate_name: string;
  artifact_ref: string;
  reason?: string;
} {
  const value = parseJsonObject(raw);
  if (value.version !== 1) throw new Error('Candidate builder requires version 1');
  if (value.status === 'blocked') {
    return {
      status: 'blocked',
      candidate_type: 'skill',
      candidate_name: '',
      artifact_ref: '',
      reason: requiredString(value.reason, 'blocked reason'),
    };
  }
  if (value.status === 'delegate_code') {
    return {
      status: 'delegate_code',
      candidate_type: 'skill',
      candidate_name: '',
      artifact_ref: '',
      reason: requiredString(value.reason, 'delegate_code reason'),
    };
  }
  if (value.status !== 'candidate') {
    throw new Error('Candidate builder status must be candidate, delegate_code, or blocked');
  }
  const candidateType = requiredString(value.candidate_type, 'candidate_type');
  if (candidateType !== 'skill' && candidateType !== 'role') {
    throw new Error('candidate_type must be skill or role');
  }
  return {
    status: 'candidate',
    candidate_type: candidateType,
    candidate_name: requiredString(value.candidate_name, 'candidate_name'),
    artifact_ref: requiredString(value.artifact_ref, 'artifact_ref'),
  };
}

function parseEngineerCandidateDecision(raw: string): {
  status: 'candidate' | 'blocked';
  reason: string;
} {
  const value = parseJsonObject(raw);
  if (value.version !== 1) throw new Error('EngineerCat Candidate builder requires version 1');
  if (value.status === 'blocked') {
    return {
      status: 'blocked',
      reason: requiredString(value.reason, 'blocked reason'),
    };
  }
  if (
    value.status !== 'candidate'
    || requiredString(value.candidate_name, 'candidate_name') !== SOURCE_CANDIDATE_NAME
  ) {
    throw new Error(`EngineerCat must return candidate_name=${SOURCE_CANDIDATE_NAME} or blocked`);
  }
  return {
    status: 'candidate',
    reason: '',
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  const value = JSON.parse(fenced || trimmed) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Candidate builder must return one JSON object');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Candidate builder requires ${label}`);
  }
  return value.trim();
}

function resetOwnedDirectory(runRoot: string, target: string): void {
  const relative = path.relative(path.resolve(runRoot), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to reset Candidate directory outside the Evolution run');
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
}

function removeCreatedCandidates(root: string, entries: readonly string[]): void {
  for (const entry of entries) {
    const target = path.join(root, entry);
    const relative = path.relative(root, target);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
}

function stripTraceFragment(value: string): string {
  return value.split('#', 1)[0];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function evolutionProviderEnvNames(): string[] {
  return Object.keys(process.env)
    .filter(name => /^XIAOBA_LLM_(?:BACKUP(?:_[1-5])?_)?(?:PROVIDER|API_BASE|API_KEY|MODEL)$/.test(name))
    .sort();
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  fs.renameSync(temporary, filePath);
}

function displayPath(filePath: string, root: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.replace(/\\/g, '/')
    : filePath.replace(/\\/g, '/');
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'evolution';
}
