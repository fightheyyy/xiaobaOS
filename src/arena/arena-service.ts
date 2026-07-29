import * as fs from 'fs';
import * as path from 'path';
import {
  CaseReplaySetup,
  createCaseReplayAdapter,
} from '../replay/case-replay';
import { runEvaluation } from '../eval/evaluation';
import { writeEvaluationResult } from '../eval/evaluation-files';
import { createReviewerCatJudge } from '../eval/reviewer-cat-judge';
import { verifyReplayTrace } from '../eval/verifier-registry';
import { createInspectorCat } from '../roles/inspector-cat/finding-case';
import { createUserCatScenarioProposer } from '../roles/user-cat/scenario';
import {
  ArenaDependencies,
  FindingCase,
  ArenaResult,
  ArenaSubject,
  Scenario,
  runArena,
} from './arena-workflow';
import { createSubjectInteraction } from './subject-interaction';
import { ArenaCleanRuntimeIndex } from './types';
import { configureArenaLiveAudit } from './live-audit';

export interface RunArenaServiceOptions {
  working_directory: string;
  arena_run_id: string;
  subject: ArenaSubject;
  scenario?: Scenario;
  scenario_goal?: string;
  turn_budget?: number;
  runs_per_case?: number;
  out_dir?: string;
  audit_project_root?: string;
}

export interface RunPreparedArenaOptions {
  project_root: string;
  run_id: string;
  scenario?: string;
  max_turns?: number;
  replay_attempts?: number;
}

export interface ArenaServiceResult {
  result: ArenaResult<CaseReplaySetup>;
  result_path: string;
}

export async function runArenaService(
  options: RunArenaServiceOptions,
  dependencies: Partial<ArenaDependencies<CaseReplaySetup>> = {},
): Promise<ArenaServiceResult> {
  const workingDirectory = path.resolve(options.working_directory);
  configureArenaLiveAudit({
    projectRoot: path.resolve(options.audit_project_root ?? workingDirectory),
    runId: options.arena_run_id,
  });
  const outDir = path.resolve(
    options.out_dir
      ?? path.join(workingDirectory, 'output', 'arena', safeSegment(options.arena_run_id)),
  );
  const scenario = options.scenario ?? (
    options.scenario_goal
      ? {
          scenario_id: `${options.arena_run_id}-scenario`,
          user_context: '',
          goal: options.scenario_goal,
          constraints: [],
          turn_budget: options.turn_budget ?? 4,
        }
      : undefined
  );
  const proposer = createUserCatScenarioProposer({
    working_directory: workingDirectory,
  });
  const inspect = dependencies.inspect ?? (async input => createInspectorCat<CaseReplaySetup>({
    working_directory: workingDirectory,
  })({
    trace_refs: input.trace_refs,
    context: {
      subject: input.subject,
      scenario: input.scenario,
    },
  }));
  const result = await runArena<CaseReplaySetup>({
    arena_run_id: options.arena_run_id,
    subject: options.subject,
    ...(scenario ? { scenario } : {}),
  }, {
    proposeScenario: dependencies.proposeScenario ?? (async subject => {
      const proposed = await proposer(subject);
      return options.turn_budget
        ? { ...proposed, turn_budget: options.turn_budget }
        : proposed;
    }),
    interact: dependencies.interact ?? createSubjectInteraction({
      working_directory: workingDirectory,
      trace_root: path.join(workingDirectory, 'logs', 'sessions'),
    }),
    inspect: async input => mountArenaSubject(
      await inspect(input),
      input.subject,
    ),
    evaluate: dependencies.evaluate ?? (async caseSet => {
      const evaluationOutDir = path.join(outDir, 'evaluation');
      const evaluation = await runEvaluation({
        case_set: caseSet,
        runs_per_case: options.runs_per_case ?? 3,
      }, {
        replay: createCaseReplayAdapter({
          working_directory: workingDirectory,
          out_root: path.join(evaluationOutDir, 'replay'),
        }),
        verify: async input => verifyReplayTrace(input),
        review: createReviewerCatJudge({
          working_directory: workingDirectory,
        }),
      });
      writeEvaluationResult(evaluation, evaluationOutDir);
      return evaluation;
    }),
  });

  fs.mkdirSync(outDir, { recursive: true });
  const resultPath = path.join(outDir, 'arena-result.json');
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
  return {
    result,
    result_path: resultPath,
  };
}

export async function runPreparedArena(
  options: RunPreparedArenaOptions,
  dependencies: Partial<ArenaDependencies<CaseReplaySetup>> = {},
): Promise<ArenaServiceResult> {
  const projectRoot = path.resolve(options.project_root);
  const runRoot = path.join(projectRoot, 'arena', 'runs', safeSegment(options.run_id));
  const runtimePath = path.join(runRoot, 'clean-runtime.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf-8')) as ArenaCleanRuntimeIndex;
  const activeRole = runtime.target_profile.active_role_id;
  return runArenaService({
    working_directory: runtime.roots.workspace_root,
    arena_run_id: runtime.run_id,
    subject: {
      subject_id: runtime.subject_id,
      ...(activeRole && activeRole !== 'base' ? { role_id: activeRole } : {}),
      ...(runtime.target_profile.subject_skill_id
        ? { skill_id: runtime.target_profile.subject_skill_id }
        : {}),
    },
    ...(options.scenario ? { scenario_goal: options.scenario } : {}),
    turn_budget: options.max_turns ?? 4,
    runs_per_case: options.replay_attempts ?? 3,
    out_dir: runRoot,
    audit_project_root: projectRoot,
  }, dependencies);
}

function mountArenaSubject(
  findingCases: readonly FindingCase<CaseReplaySetup>[],
  subject: Readonly<ArenaSubject>,
): FindingCase<CaseReplaySetup>[] {
  return findingCases.map(item => ({
    ...item,
    case: {
      ...item.case,
      setup: {
        ...(item.case.setup ?? {}),
        cwd: item.case.setup?.cwd ?? '.',
        ...(subject.role_id
          ? {
              session_key: item.case.setup?.session_key
                ?? `pet:xiaoba:role-${safeSegment(subject.role_id)}`,
            }
          : {}),
        ...(subject.skill_id
          ? { required_active_skill_name: subject.skill_id }
          : {}),
      },
    },
  }));
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'arena';
}
