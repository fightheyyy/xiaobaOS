import * as fs from 'fs';
import * as path from 'path';
import {
  writeEvalScorecard,
  writeScriptedRuntimeTestResult,
} from './scripted-runtime-result';
import {
  loadEvalSuite,
  runEvalSuite,
} from './scripted-runtime-runner';
import { normalizePetMessageSurfaceEvent } from '../pet/channel';
import type {
  EvalDecision,
  EvalCase,
  EvalFailureRoute,
  EvalLane,
  EvalReplaySurfaceTurn,
  EvalRiskLevel,
  EvalScorecard,
  EvalTargetModule,
} from './scripted-runtime-types';

export interface EvalBenchmarkRunOptions {
  benchmarkPath: string;
  outDir?: string;
  now?: Date;
}

export interface EvalBenchmark {
  benchmark_id: string;
  name: string;
  version: string;
  description?: string;
  source?: string;
  case_jsonl?: string | string[];
  case_files?: string[];
  cases: EvalBenchmarkCase[];
  decision_policy?: EvalBenchmarkDecisionPolicy;
}

export interface EvalBenchmarkDecisionPolicy {
  fail_on_any_case_failure?: boolean;
  block_on_any_case_blocked?: boolean;
  min_pass_rate?: number;
}

export interface EvalBenchmarkCase {
  case_id: string;
  name: string;
  lane: EvalLane;
  target_module: EvalTargetModule;
  risk_level: EvalRiskLevel;
  eval_suite: string;
  eval_case_ids?: string[];
  requirement?: EvalBenchmarkRequirement;
  expected_decision?: EvalDecision;
  failure_route?: EvalFailureRoute;
  benchmark_case_kind?: string;
  raw_user_text_included?: boolean;
  case_category?: string;
  target_role?: string;
  replay_modes?: string[];
  task_prompt?: string;
  verifier_ids?: string[];
  budgets?: Record<string, unknown>;
  notes?: string;
  case_path?: string;
}

export interface EvalBenchmarkRequirement {
  requirement_id: string;
  user_story: string;
  acceptance_criteria: string[];
  evidence: string[];
  owner?: string;
  source?: string;
  non_goals?: string[];
}

export interface EvalBenchmarkCaseResult {
  case_id: string;
  name: string;
  lane: EvalLane;
  target_module: EvalTargetModule;
  risk_level: EvalRiskLevel;
  decision: EvalDecision;
  eval_suite_id: string;
  eval_suite_path: string;
  eval_case_ids: string[];
  expected_decision?: EvalDecision;
  observed_decision: EvalDecision;
  cases_total: number;
  cases_passed: number;
  hard_failures: number;
  required_artifact_failures: number;
  scorecard_path?: string;
  report_path?: string;
  failure_route?: EvalFailureRoute;
  message: string;
}

export interface EvalBenchmarkScorecard {
  scorecard_version: '0.1';
  benchmark_id: string;
  benchmark_name: string;
  generated_at: string;
  summary: {
    decision: EvalDecision;
    benchmark_cases_total: number;
    benchmark_cases_passed: number;
    benchmark_cases_failed: number;
    benchmark_cases_blocked: number;
    eval_cases_total: number;
    eval_cases_passed: number;
    hard_failures: number;
    required_artifact_failures: number;
    pass_rate: number;
  };
  scores: {
    quality: number;
    reliability: number;
    safety: number;
    efficiency: number;
  };
  cases: EvalBenchmarkCaseResult[];
  evidence: {
    benchmark_path: string;
    out_dir: string;
    manifest_path?: string;
    scorecard_path?: string;
    report_path?: string;
  };
}

interface RawEvalBenchmark {
  benchmark_id?: string;
  name?: string;
  version?: string;
  description?: string;
  source?: string;
  case_jsonl?: string | string[];
  case_files?: string[];
  cases?: EvalBenchmarkCase[];
  decision_policy?: EvalBenchmarkDecisionPolicy;
}

export function loadEvalBenchmark(benchmarkPath: string): EvalBenchmark {
  const resolved = path.resolve(benchmarkPath);
  const benchmarkDir = path.dirname(resolved);
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf-8')) as RawEvalBenchmark;
  validateBenchmarkShape(raw, resolved);

  const jsonlCases = readBenchmarkCaseJsonl(raw.case_jsonl, benchmarkDir);
  const inlineCases = raw.cases ?? [];
  const fileCases = (raw.case_files ?? []).map((caseFile) => {
    const casePath = path.resolve(benchmarkDir, caseFile);
    const parsed = JSON.parse(fs.readFileSync(casePath, 'utf-8')) as EvalBenchmarkCase;
    return {
      ...parsed,
      case_path: casePath,
    };
  });
  const cases = [...inlineCases, ...fileCases, ...jsonlCases];
  validateBenchmarkCases(cases, resolved);

  return {
    benchmark_id: raw.benchmark_id!,
    name: raw.name!,
    version: raw.version!,
    description: raw.description,
    source: raw.source,
    case_jsonl: raw.case_jsonl,
    case_files: raw.case_files,
    cases,
    decision_policy: raw.decision_policy,
  };
}

function readBenchmarkCaseJsonl(
  caseJsonl: string | string[] | undefined,
  benchmarkDir: string,
): EvalBenchmarkCase[] {
  const sources = typeof caseJsonl === 'string'
    ? [caseJsonl]
    : caseJsonl ?? [];
  const cases: EvalBenchmarkCase[] = [];

  for (const source of sources) {
    const casePath = path.resolve(benchmarkDir, source);
    const content = fs.readFileSync(casePath, 'utf-8');
    const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
    for (const [index, line] of lines.entries()) {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`invalid benchmark case JSONL line in ${casePath}:${index + 1}`);
      }
      cases.push({
        ...(parsed as EvalBenchmarkCase),
        case_path: `${casePath}:${index + 1}`,
      });
    }
  }

  return cases;
}

export async function runEvalBenchmark(options: EvalBenchmarkRunOptions): Promise<EvalBenchmarkScorecard> {
  return runBenchmark(options, writeEvalScorecard, assertLiveEvalBenchmark);
}

async function runBenchmark(
  options: EvalBenchmarkRunOptions,
  writeNestedResult: typeof writeEvalScorecard,
  validateTestSet: (benchmark: EvalBenchmark, sourcePath: string) => void,
): Promise<EvalBenchmarkScorecard> {
  const benchmarkPath = path.resolve(options.benchmarkPath);
  const benchmark = loadEvalBenchmark(benchmarkPath);
  validateTestSet(benchmark, benchmarkPath);
  const benchmarkDir = path.dirname(benchmarkPath);
  const now = options.now ?? new Date();
  const outDir = options.outDir
    ? path.resolve(options.outDir)
    : defaultBenchmarkOutDir(benchmark, now);
  fs.mkdirSync(outDir, { recursive: true });

  const cases: EvalBenchmarkCaseResult[] = [];
  const nestedScorecards: EvalScorecard[] = [];

  for (const caseSpec of benchmark.cases) {
    const suitePath = resolveBenchmarkRelativePath(benchmarkDir, caseSpec.eval_suite);
    const suite = loadEvalSuite(suitePath);
    const evalCaseIds = caseSpec.eval_case_ids ?? suite.cases.map(item => item.case_id);
    const suiteOutDir = path.join(outDir, 'suites', safePathSegment(caseSpec.case_id));
    const nestedScorecard = writeNestedResult(await runEvalSuite({
      suitePath,
      outDir: suiteOutDir,
      now,
      caseIds: evalCaseIds,
    }), suiteOutDir);
    nestedScorecards.push(nestedScorecard);

    cases.push(buildBenchmarkCaseResult({
      caseSpec,
      suitePath,
      scorecard: nestedScorecard,
      evalCaseIds,
    }));
  }

  return buildBenchmarkScorecard({
    benchmark,
    benchmarkPath,
    outDir,
    now,
    cases,
    nestedScorecards,
  });
}

export function writeEvalBenchmarkScorecard(
  scorecard: EvalBenchmarkScorecard,
  outDir = scorecard.evidence.out_dir,
): EvalBenchmarkScorecard {
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'manifest.json');
  const scorecardPath = path.join(outDir, 'scorecard.json');
  const reportPath = path.join(outDir, 'report.md');

  const withPaths: EvalBenchmarkScorecard = {
    ...scorecard,
    evidence: {
      ...scorecard.evidence,
      out_dir: outDir,
      manifest_path: manifestPath,
      scorecard_path: scorecardPath,
      report_path: reportPath,
    },
  };

  fs.writeFileSync(manifestPath, `${JSON.stringify({
    benchmark_id: withPaths.benchmark_id,
    generated_at: withPaths.generated_at,
    benchmark_path: withPaths.evidence.benchmark_path,
    decision: withPaths.summary.decision,
    benchmark_cases_total: withPaths.summary.benchmark_cases_total,
    eval_cases_total: withPaths.summary.eval_cases_total,
  }, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(scorecardPath, `${JSON.stringify(withPaths, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(reportPath, `${renderEvalBenchmarkReport(withPaths)}\n`, 'utf-8');

  return withPaths;
}

export function renderEvalBenchmarkReport(scorecard: EvalBenchmarkScorecard): string {
  const caseRows = scorecard.cases.map(item => [
    '|',
    item.case_id,
    '|',
    item.decision,
    '|',
    item.observed_decision,
    '|',
    item.eval_suite_id,
    '|',
    `${item.cases_passed}/${item.cases_total}`,
    '|',
    item.hard_failures,
    '|',
  ].join(' '));

  return [
    `# Eval Benchmark Report: ${scorecard.benchmark_name}`,
    '',
    `- benchmark: ${scorecard.benchmark_id}`,
    `- generated at: ${scorecard.generated_at}`,
    `- decision: ${scorecard.summary.decision}`,
    `- benchmark cases: ${scorecard.summary.benchmark_cases_passed}/${scorecard.summary.benchmark_cases_total} passed`,
    `- eval cases: ${scorecard.summary.eval_cases_passed}/${scorecard.summary.eval_cases_total} passed`,
    `- hard failures: ${scorecard.summary.hard_failures}`,
    `- required artifact failures: ${scorecard.summary.required_artifact_failures}`,
    `- quality: ${scorecard.scores.quality}`,
    `- reliability: ${scorecard.scores.reliability}`,
    `- safety: ${scorecard.scores.safety}`,
    `- efficiency: ${scorecard.scores.efficiency}`,
    '',
    '## Cases',
    '',
    '| Case | Decision | Observed Eval Decision | Eval Suite | Eval Cases | Hard Failures |',
    '| --- | --- | --- | --- | --- | --- |',
    ...caseRows,
    '',
    '## Nested Eval Reports',
    '',
    ...scorecard.cases.flatMap(item => [
      `### ${item.case_id}`,
      '',
      `- scorecard: ${item.scorecard_path ?? 'missing'}`,
      `- report: ${item.report_path ?? 'missing'}`,
      `- message: ${item.message}`,
      '',
    ]),
  ].join('\n');
}

function buildBenchmarkCaseResult(input: {
  caseSpec: EvalBenchmarkCase;
  suitePath: string;
  scorecard: EvalScorecard;
  evalCaseIds: string[];
}): EvalBenchmarkCaseResult {
  const expected = input.caseSpec.expected_decision;
  const observed = input.scorecard.summary.decision;
  const matchedExpectation = !expected || expected === observed;
  const decision: EvalDecision = matchedExpectation
    ? 'pass'
    : observed === 'blocked'
      ? 'blocked'
      : 'fail';

  return {
    case_id: input.caseSpec.case_id,
    name: input.caseSpec.name,
    lane: input.caseSpec.lane,
    target_module: input.caseSpec.target_module,
    risk_level: input.caseSpec.risk_level,
    decision,
    eval_suite_id: input.scorecard.suite_id,
    eval_suite_path: input.suitePath,
    eval_case_ids: input.evalCaseIds,
    expected_decision: expected,
    observed_decision: observed,
    cases_total: input.scorecard.summary.cases_total,
    cases_passed: input.scorecard.summary.cases_passed,
    hard_failures: input.scorecard.summary.hard_failures,
    required_artifact_failures: input.scorecard.summary.required_artifact_failures,
    scorecard_path: input.scorecard.evidence.scorecard_path,
    report_path: input.scorecard.evidence.report_path,
    failure_route: findBenchmarkFailureRoute(input.caseSpec, input.scorecard),
    message: matchedExpectation
      ? `observed expected eval decision: ${observed}`
      : `expected eval decision ${expected} but observed ${observed}`,
  };
}

function buildBenchmarkScorecard(input: {
  benchmark: EvalBenchmark;
  benchmarkPath: string;
  outDir: string;
  now: Date;
  cases: EvalBenchmarkCaseResult[];
  nestedScorecards: EvalScorecard[];
}): EvalBenchmarkScorecard {
  const casesPassed = input.cases.filter(item => item.decision === 'pass').length;
  const casesFailed = input.cases.filter(item => item.decision === 'fail').length;
  const casesBlocked = input.cases.filter(item => item.decision === 'blocked').length;
  const evalCasesTotal = input.cases.reduce((sum, item) => sum + item.cases_total, 0);
  const evalCasesPassed = input.cases.reduce((sum, item) => sum + item.cases_passed, 0);
  const hardFailures = input.cases.reduce((sum, item) => sum + item.hard_failures, 0);
  const requiredArtifactFailures = input.cases.reduce((sum, item) => sum + item.required_artifact_failures, 0);
  const passRate = input.cases.length > 0 ? casesPassed / input.cases.length : 0;

  const decision = decideBenchmark(input.benchmark, {
    casesFailed,
    casesBlocked,
    passRate,
  });

  return {
    scorecard_version: '0.1',
    benchmark_id: input.benchmark.benchmark_id,
    benchmark_name: input.benchmark.name,
    generated_at: input.now.toISOString(),
    summary: {
      decision,
      benchmark_cases_total: input.cases.length,
      benchmark_cases_passed: casesPassed,
      benchmark_cases_failed: casesFailed,
      benchmark_cases_blocked: casesBlocked,
      eval_cases_total: evalCasesTotal,
      eval_cases_passed: evalCasesPassed,
      hard_failures: hardFailures,
      required_artifact_failures: requiredArtifactFailures,
      pass_rate: roundScore(passRate),
    },
    scores: {
      quality: averageScore(input.nestedScorecards.map(item => item.scores.quality)),
      reliability: averageScore(input.nestedScorecards.map(item => item.scores.reliability)),
      safety: averageScore(input.nestedScorecards.map(item => item.scores.safety)),
      efficiency: averageScore(input.nestedScorecards.map(item => item.scores.efficiency)),
    },
    cases: input.cases,
    evidence: {
      benchmark_path: input.benchmarkPath,
      out_dir: input.outDir,
    },
  };
}

function decideBenchmark(
  benchmark: EvalBenchmark,
  input: {
    casesFailed: number;
    casesBlocked: number;
    passRate: number;
  },
): EvalDecision {
  const policy = {
    fail_on_any_case_failure: true,
    block_on_any_case_blocked: true,
    min_pass_rate: 1,
    ...(benchmark.decision_policy ?? {}),
  };

  if (policy.fail_on_any_case_failure && input.casesFailed > 0) return 'fail';
  if (policy.block_on_any_case_blocked && input.casesBlocked > 0) return 'blocked';
  if (input.passRate < policy.min_pass_rate) return 'fail';
  return 'pass';
}

function findBenchmarkFailureRoute(
  caseSpec: EvalBenchmarkCase,
  scorecard: EvalScorecard,
): EvalFailureRoute | undefined {
  return scorecard.cases.find(item => item.failure_route)?.failure_route ?? caseSpec.failure_route;
}

function validateBenchmarkShape(raw: RawEvalBenchmark, benchmarkPath: string): void {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`invalid eval benchmark: ${benchmarkPath}`);
  }
  if (!raw.benchmark_id || !raw.name || !raw.version) {
    throw new Error(`eval benchmark requires benchmark_id, name, and version: ${benchmarkPath}`);
  }
  const hasCaseJsonl = typeof raw.case_jsonl === 'string'
    || (Array.isArray(raw.case_jsonl) && raw.case_jsonl.length > 0);
  if ((!raw.case_files || raw.case_files.length === 0) && (!raw.cases || raw.cases.length === 0) && !hasCaseJsonl) {
    throw new Error(`eval benchmark requires case_jsonl, case_files, or cases: ${benchmarkPath}`);
  }
}

function validateBenchmarkCases(cases: EvalBenchmarkCase[], benchmarkPath: string): void {
  const ids = new Set<string>();
  for (const caseSpec of cases) {
    if (!caseSpec.case_id || !caseSpec.name || !caseSpec.lane || !caseSpec.target_module || !caseSpec.risk_level || !caseSpec.eval_suite) {
      throw new Error(`invalid eval benchmark case in ${benchmarkPath}`);
    }
    if (ids.has(caseSpec.case_id)) {
      throw new Error(`duplicate eval benchmark case id in ${benchmarkPath}: ${caseSpec.case_id}`);
    }
    ids.add(caseSpec.case_id);
  }
}

export function assertLiveEvalBenchmark(benchmark: EvalBenchmark, benchmarkPath: string): void {
  const benchmarkDir = path.dirname(path.resolve(benchmarkPath));
  for (const caseSpec of benchmark.cases) {
    validateLiveBenchmarkCaseMetadata(caseSpec, benchmarkPath);

    const suitePath = resolveBenchmarkRelativePath(benchmarkDir, caseSpec.eval_suite);
    const suite = loadEvalSuite(suitePath);
    const evalCaseIds = caseSpec.eval_case_ids ?? suite.cases.map(item => item.case_id);
    if (!caseSpec.eval_case_ids || caseSpec.eval_case_ids.length === 0) {
      throw new Error(`live eval benchmark case must list eval_case_ids: ${caseSpec.case_id}`);
    }

    const selected = selectSuiteCasesForBenchmark(suite.cases, evalCaseIds, caseSpec, suitePath);
    for (const suiteCase of selected) {
      validateLiveSuiteCase(suiteCase, caseSpec, suitePath);
    }
  }
}

function validateLiveBenchmarkCaseMetadata(caseSpec: EvalBenchmarkCase, benchmarkPath: string): void {
  if (!caseSpec.benchmark_case_kind || !caseSpec.benchmark_case_kind.includes('live')) {
    throw new Error(`live eval benchmark case must set benchmark_case_kind containing "live" in ${benchmarkPath}: ${caseSpec.case_id}`);
  }
  if (caseSpec.raw_user_text_included === true) {
    throw new Error(`live eval benchmark case must not include raw private user text: ${caseSpec.case_id}`);
  }
  if (!caseSpec.task_prompt || caseSpec.task_prompt.trim().length === 0) {
    throw new Error(`live eval benchmark case must describe the input request in task_prompt: ${caseSpec.case_id}`);
  }
  if (!Array.isArray(caseSpec.verifier_ids) || caseSpec.verifier_ids.length === 0) {
    throw new Error(`live eval benchmark case must list verifier_ids: ${caseSpec.case_id}`);
  }
}

function selectSuiteCasesForBenchmark(
  suiteCases: EvalCase[],
  evalCaseIds: string[],
  caseSpec: EvalBenchmarkCase,
  suitePath: string,
): EvalCase[] {
  const requested = new Set(evalCaseIds);
  const selected = suiteCases.filter(item => requested.has(item.case_id));
  const selectedIds = new Set(selected.map(item => item.case_id));
  const missing = evalCaseIds.filter(id => !selectedIds.has(id));
  if (missing.length > 0) {
    throw new Error(`live eval benchmark case ${caseSpec.case_id} references missing eval case(s) in ${suitePath}: ${missing.join(', ')}`);
  }
  return selected;
}

function validateLiveSuiteCase(suiteCase: EvalCase, caseSpec: EvalBenchmarkCase, suitePath: string): void {
  const replay = suiteCase.replay;
  if (!replay) {
    throw new Error(`live eval suite case must have replay: ${suiteCase.case_id} (${suitePath})`);
  }
  if (replay.mode !== 'surface_runtime') {
    throw new Error(`live eval suite case must use surface_runtime replay: ${suiteCase.case_id} (${suitePath})`);
  }
  if (!replay.user_message && (!replay.surface_turns || replay.surface_turns.length === 0)) {
    throw new Error(`live eval suite case must define a user_message or surface_turns: ${suiteCase.case_id}`);
  }
  if (!Array.isArray(replay.model_responses) || replay.model_responses.length === 0) {
    throw new Error(`live eval suite case must replay fresh model/runtime behavior: ${suiteCase.case_id}`);
  }
  if (!hasBehaviorVerifier(suiteCase)) {
    throw new Error(`live eval suite case must verify tool use, delivery, artifact, result, or safety behavior: ${suiteCase.case_id}`);
  }
  validateLiveSurfaceRuntimePayloads(suiteCase, suitePath);
  if (caseSpec.replay_modes && caseSpec.replay_modes.length > 0) {
    const replayModeText = `${replay.mode}${replay.surface ? `_${replay.surface}` : ''}`;
    const matchesDeclaredMode = caseSpec.replay_modes.some(mode => (
      mode === replay.mode
      || mode === replayModeText
      || mode.startsWith(`${replay.mode}_`)
    ));
    if (!matchesDeclaredMode) {
      throw new Error(`live eval benchmark case ${caseSpec.case_id} declares replay_modes that do not match ${suiteCase.case_id}: ${caseSpec.replay_modes.join(', ')}`);
    }
  }
}

function validateLiveSurfaceRuntimePayloads(suiteCase: EvalCase, suitePath: string): void {
  const replay = suiteCase.replay;
  if (!replay || replay.mode !== 'surface_runtime') return;
  if (replay.surface !== 'pet') return;

  const turns = replay.surface_turns?.length
    ? replay.surface_turns
    : [{ user_message: replay.user_message, surface_event: replay.surface_event }];

  for (let index = 0; index < turns.length; index += 1) {
    const body = buildPetSurfaceRuntimePreflightBody(suiteCase, replay.user_message, turns[index], index);
    try {
      normalizePetMessageSurfaceEvent(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`live eval suite case has invalid pet surface payload: ${suiteCase.case_id} turn ${index + 1} (${suitePath}): ${message}`);
    }
  }
}

function buildPetSurfaceRuntimePreflightBody(
  suiteCase: EvalCase,
  fallbackUserMessage: string,
  turn: EvalReplaySurfaceTurn,
  index: number,
): Record<string, unknown> {
  return {
    petId: 'alpha-puff',
    text: turn.user_message || fallbackUserMessage,
    source: 'eval-runtime',
    eventId: turn.surface_event?.event_id ?? `${safePathSegment(suiteCase.case_id)}.message.${index + 1}`,
    ...(turn.surface_event?.raw ?? {}),
  };
}

function hasBehaviorVerifier(suiteCase: EvalCase): boolean {
  const evidenceOnlyVerifiers = new Set([
    'jsonl_parse',
    'budget_check',
    'tool_result_contract',
    'tool_transcript_completeness',
    'runtime_observability',
  ]);
  return suiteCase.hard_verifiers.some(spec => !evidenceOnlyVerifiers.has(spec.id));
}

function resolveBenchmarkRelativePath(benchmarkDir: string, relativeOrAbsolute: string): string {
  return path.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : path.resolve(benchmarkDir, relativeOrAbsolute);
}

function defaultBenchmarkOutDir(benchmark: EvalBenchmark, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.resolve(process.cwd(), 'output', 'benchmarks', benchmark.benchmark_id, stamp);
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_');
}

function averageScore(values: number[]): number {
  if (values.length === 0) return 0;
  return roundScore(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

export function runScriptedRuntimeTestBenchmark(
  options: EvalBenchmarkRunOptions,
): Promise<EvalBenchmarkScorecard> {
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const testSetName = path.basename(path.dirname(path.resolve(options.benchmarkPath)));
  return runBenchmark({
    ...options,
    outDir: options.outDir
      ? path.resolve(options.outDir)
      : path.resolve(process.cwd(), 'output', 'test', testSetName, stamp),
  }, writeScriptedRuntimeTestResult, assertScriptedRuntimeTestSet);
}

export function assertScriptedRuntimeTestSet(
  testSet: EvalBenchmark,
  sourcePath: string,
): void {
  const sourceDir = path.dirname(path.resolve(sourcePath));
  for (const group of testSet.cases) {
    const suitePath = resolveBenchmarkRelativePath(sourceDir, group.eval_suite);
    const suite = loadEvalSuite(suitePath);
    const caseIds = group.eval_case_ids ?? suite.cases.map(item => item.case_id);
    if (!group.eval_case_ids || group.eval_case_ids.length === 0) {
      throw new Error(`scripted runtime test group must list case ids: ${group.case_id}`);
    }
    const selected = selectSuiteCasesForBenchmark(suite.cases, caseIds, group, suitePath);
    for (const testCase of selected) {
      const replay = testCase.replay;
      if (!replay || replay.mode !== 'surface_runtime') {
        throw new Error(`scripted runtime test must drive surface_runtime: ${testCase.case_id}`);
      }
      if (!Array.isArray(replay.model_responses) || replay.model_responses.length === 0) {
        throw new Error(`scripted runtime test requires prewritten model_responses: ${testCase.case_id}`);
      }
      validateLiveSurfaceRuntimePayloads(testCase, suitePath);
    }
  }
}

export function writeScriptedRuntimeTestBenchmarkResult(
  result: EvalBenchmarkScorecard,
  outDir = result.evidence.out_dir,
): EvalBenchmarkScorecard {
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'manifest.json');
  const resultPath = path.join(outDir, 'test-result.json');
  const reportPath = path.join(outDir, 'report.md');
  const withPaths: EvalBenchmarkScorecard = {
    ...result,
    evidence: {
      ...result.evidence,
      out_dir: outDir,
      manifest_path: manifestPath,
      scorecard_path: resultPath,
      report_path: reportPath,
    },
  };

  fs.writeFileSync(manifestPath, `${JSON.stringify({
    test_set_id: withPaths.benchmark_id,
    generated_at: withPaths.generated_at,
    source_path: withPaths.evidence.benchmark_path,
    decision: withPaths.summary.decision,
    groups_total: withPaths.summary.benchmark_cases_total,
    cases_total: withPaths.summary.eval_cases_total,
  }, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(resultPath, `${JSON.stringify(withPaths, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(
    reportPath,
    `${renderEvalBenchmarkReport(withPaths)
      .replace(/^# Eval Benchmark Report:/, '# Scripted Runtime Test Report:')
      .replace(/^- benchmark:/m, '- test set:')
      .replace('## Nested Eval Reports', '## Test Group Reports')}\n`,
    'utf-8',
  );
  return withPaths;
}
