import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type {
  EvalCaseResult,
  EvalDecision,
  EvalFailureRoute,
  EvalScorecard,
  EvalSuite,
} from './scripted-runtime-types';

const FAILURE_ROUTES: EvalFailureRoute[] = [
  'runtime',
  'surface',
  'role',
  'skill',
  'tool',
  'provider',
  'state_evidence',
  'external',
];

export function defaultEvalOutDir(suite: EvalSuite, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.resolve(process.cwd(), 'output', 'test', suite.suite_id, stamp);
}

export function buildEvalScorecard(input: {
  suite: EvalSuite;
  suitePath: string;
  outDir: string;
  now: Date;
  cases: EvalCaseResult[];
}): EvalScorecard {
  const casesPassed = input.cases.filter(item => item.decision === 'pass').length;
  const casesFailed = input.cases.filter(item => item.decision === 'fail').length;
  const casesBlocked = input.cases.filter(item => item.decision === 'blocked').length;
  const casesQuarantined = input.cases.filter(item => item.decision === 'quarantine').length;
  const hardFailures = input.cases.reduce((sum, item) => sum + item.verifier_results.filter(resultItem => resultItem.status === 'fail').length, 0);
  const judgeFailures = input.cases.reduce((sum, item) => sum + item.judge_results.filter(resultItem => resultItem.status === 'fail').length, 0);
  const judgeBlocks = input.cases.reduce((sum, item) => sum + item.judge_results.filter(resultItem => resultItem.status === 'blocked').length, 0);
  const requiredArtifactFailures = input.cases.reduce((sum, item) => sum + item.verifier_results.filter(resultItem => resultItem.id === 'artifact_evidence' && resultItem.status === 'fail').length, 0);
  const passRate = input.cases.length > 0 ? casesPassed / input.cases.length : 0;
  const decision = decideSuite(input.suite, {
    casesFailed,
    casesBlocked,
    hardFailures,
    requiredArtifactFailures,
    passRate,
  });

  const failureRoutes = Object.fromEntries(FAILURE_ROUTES.map(route => [route, 0])) as Record<EvalFailureRoute, number>;
  for (const caseResult of input.cases) {
    if (caseResult.failure_route) {
      failureRoutes[caseResult.failure_route] += 1;
    }
  }

  const safety = hardFailures === 0 ? 100 : Math.max(0, 100 - hardFailures * 20);
  const reliability = roundScore(passRate * 100);
  const judgeQuality = computeJudgeQualityScore(input.cases);
  const quality = hardFailures === 0
    ? (judgeQuality === undefined ? reliability : roundScore((reliability + judgeQuality) / 2))
    : Math.max(0, reliability - 40);
  const efficiency = computeEfficiencyScore(input.cases);
  const generatedAt = input.now.toISOString();

  return {
    scorecard_version: '0.1',
    run_id: `${input.suite.suite_id}.${generatedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}`,
    suite_id: input.suite.suite_id,
    suite_name: input.suite.name,
    generated_at: generatedAt,
    candidate: {
      git_sha: getGitValue(['rev-parse', '--short', 'HEAD']) || 'unknown',
      branch: getGitValue(['rev-parse', '--abbrev-ref', 'HEAD']) || 'working-tree',
      entrypoint: 'scripted-runtime-test',
    },
    summary: {
      decision,
      cases_total: input.cases.length,
      cases_passed: casesPassed,
      cases_failed: casesFailed,
      cases_blocked: casesBlocked,
      cases_quarantined: casesQuarantined,
      hard_failures: hardFailures,
      judge_failures: judgeFailures,
      judge_blocks: judgeBlocks,
      required_artifact_failures: requiredArtifactFailures,
      pass_rate: roundScore(passRate),
    },
    scores: {
      quality,
      reliability,
      safety,
      efficiency,
    },
    failure_routes: failureRoutes,
    cases: input.cases,
    evidence: {
      suite_path: input.suitePath,
      out_dir: input.outDir,
    },
  };
}

export function writeEvalScorecard(scorecard: EvalScorecard, outDir = scorecard.evidence.out_dir): EvalScorecard {
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'manifest.json');
  const scorecardPath = path.join(outDir, 'scorecard.json');
  const reportPath = path.join(outDir, 'report.md');

  const withPaths: EvalScorecard = {
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
    run_id: withPaths.run_id,
    suite_id: withPaths.suite_id,
    generated_at: withPaths.generated_at,
    suite_path: withPaths.evidence.suite_path,
    decision: withPaths.summary.decision,
  }, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(scorecardPath, `${JSON.stringify(withPaths, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(reportPath, `${renderEvalReport(withPaths)}\n`, 'utf-8');

  return withPaths;
}

export function renderEvalReport(scorecard: EvalScorecard): string {
  const caseRows = scorecard.cases.map((item) => [
    '|',
    item.case_id,
    '|',
    item.decision,
    '|',
    item.target_module,
    '|',
    item.verifier_results.map(result => `${result.id}:${result.status}`).join(', '),
    '|',
    item.judge_results.map(result => `${result.id}:${result.status}:${result.score}/${result.max_score}`).join(', '),
    '|',
  ].join(' '));

  const routeRows = FAILURE_ROUTES
    .filter(route => scorecard.failure_routes[route] > 0)
    .map(route => `- ${route}: ${scorecard.failure_routes[route]}`);

  return [
    `# Eval Report: ${scorecard.suite_name}`,
    '',
    `- run id: ${scorecard.run_id}`,
    `- suite: ${scorecard.suite_id}`,
    `- decision: ${scorecard.summary.decision}`,
    `- cases: ${scorecard.summary.cases_passed}/${scorecard.summary.cases_total} passed, ${scorecard.summary.cases_failed} failed, ${scorecard.summary.cases_blocked} blocked, ${scorecard.summary.cases_quarantined} quarantined`,
    `- hard failures: ${scorecard.summary.hard_failures}`,
    `- judge failures: ${scorecard.summary.judge_failures}`,
    `- judge blocks: ${scorecard.summary.judge_blocks}`,
    `- required artifact failures: ${scorecard.summary.required_artifact_failures}`,
    `- quality: ${scorecard.scores.quality}`,
    `- reliability: ${scorecard.scores.reliability}`,
    `- safety: ${scorecard.scores.safety}`,
    `- efficiency: ${scorecard.scores.efficiency}`,
    '',
    '## Cases',
    '',
    '| Case | Decision | Target | Verifiers | Judges |',
    '| --- | --- | --- | --- | --- |',
    ...caseRows,
    '',
    '## Failure Routes',
    '',
    ...(routeRows.length > 0 ? routeRows : ['- none']),
  ].join('\n');
}

function decideSuite(
  suite: EvalSuite,
  input: {
    casesFailed: number;
    casesBlocked: number;
    hardFailures: number;
    requiredArtifactFailures: number;
    passRate: number;
  },
): EvalDecision {
  const policy = {
    fail_on_any_hard_failure: true,
    fail_on_required_artifact_failure: true,
    block_on_missing_evidence: true,
    min_pass_rate: 1,
    ...(suite.decision_policy ?? {}),
  };

  if (policy.fail_on_required_artifact_failure && input.requiredArtifactFailures > 0) return 'fail';
  if (policy.fail_on_any_hard_failure && input.hardFailures > 0) return 'fail';
  if (input.casesFailed > 0) return 'fail';
  if (policy.block_on_missing_evidence && input.casesBlocked > 0) return 'blocked';
  if (input.passRate < policy.min_pass_rate) return 'fail';
  return 'pass';
}

function computeEfficiencyScore(cases: EvalCaseResult[]): number {
  if (cases.length === 0) return 0;
  const budgetChecks = cases.flatMap(item => item.verifier_results.filter(resultItem => resultItem.id === 'budget_check'));
  if (budgetChecks.length === 0) return 100;
  const passed = budgetChecks.filter(item => item.status === 'pass').length;
  return roundScore((passed / budgetChecks.length) * 100);
}

function computeJudgeQualityScore(cases: EvalCaseResult[]): number | undefined {
  const judgeScores = cases.flatMap(item => item.judge_results.map((resultItem) => {
    if (resultItem.max_score <= 0) return 0;
    return (resultItem.score / resultItem.max_score) * 100;
  }));
  if (judgeScores.length === 0) return undefined;
  return roundScore(judgeScores.reduce((sum, item) => sum + item, 0) / judgeScores.length);
}

export function writeScriptedRuntimeTestResult(
  result: EvalScorecard,
  outDir = result.evidence.out_dir,
): EvalScorecard {
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'manifest.json');
  const resultPath = path.join(outDir, 'test-result.json');
  const reportPath = path.join(outDir, 'report.md');
  const withPaths: EvalScorecard = {
    ...result,
    candidate: {
      ...result.candidate,
      entrypoint: 'scripted-runtime-test',
    },
    evidence: {
      ...result.evidence,
      out_dir: outDir,
      manifest_path: manifestPath,
      scorecard_path: resultPath,
      report_path: reportPath,
    },
  };

  fs.writeFileSync(manifestPath, `${JSON.stringify({
    run_id: withPaths.run_id,
    test_set_id: withPaths.suite_id,
    generated_at: withPaths.generated_at,
    source_path: withPaths.evidence.suite_path,
    decision: withPaths.summary.decision,
  }, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(resultPath, `${JSON.stringify(withPaths, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(reportPath, `${renderScriptedRuntimeTestReport(withPaths)}\n`, 'utf-8');
  return withPaths;
}

export function renderScriptedRuntimeTestReport(result: EvalScorecard): string {
  return renderEvalReport(result)
    .replace(/^# Eval Report:/, '# Scripted Runtime Test Report:')
    .replace('- suite:', '- test set:');
}

function getGitValue(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}
