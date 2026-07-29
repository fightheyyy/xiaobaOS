#!/usr/bin/env tsx

import * as fs from 'fs';
import * as path from 'path';
import {
  runScriptedRuntimeTestSuite,
  writeScriptedRuntimeTestResult,
  type TestDecision,
  type ScriptedRuntimeTestResult,
} from '../src/testing';

interface CliOptions {
  outDir?: string;
  allowFail: boolean;
}

interface ContractSmokeItem {
  id: string;
  name: string;
  suitePath: string;
  outSubdir: string;
}

interface ContractSmokeResult {
  id: string;
  name: string;
  decision: TestDecision;
  cases_total: number;
  cases_passed: number;
  hard_failures: number;
  scorecard_path?: string;
  report_path?: string;
  message: string;
}

const CONTRACT_SMOKE_ITEMS: ContractSmokeItem[] = [
  {
    id: 'contract-sentinel',
    name: 'Contract Sentinel',
    suitePath: 'test/contract-smoke/suites/contract-sentinel.json',
    outSubdir: 'suites/contract-sentinel',
  },
  {
    id: 'contract-boundary-smoke',
    name: 'Contract Boundary Smoke',
    suitePath: 'test/contract-smoke/suites/contract-boundary-smoke.json',
    outSubdir: 'suites/contract-boundary-smoke',
  },
  {
    id: 'red-team-boundary-smoke',
    name: 'Red Team Boundary Smoke',
    suitePath: 'test/contract-smoke/suites/red-team-boundary-smoke.json',
    outSubdir: 'suites/red-team-boundary-smoke',
  },
  {
    id: 'surface-runtime-smoke',
    name: 'Surface Runtime Smoke',
    suitePath: 'test/contract-smoke/suites/surface-runtime-smoke.json',
    outSubdir: 'suites/surface-runtime-smoke',
  },
  {
    id: 'surface-runtime-file-smoke',
    name: 'Surface Runtime File Smoke',
    suitePath: 'test/contract-smoke/suites/surface-runtime-file-smoke.json',
    outSubdir: 'suites/surface-runtime-file-smoke',
  },
  {
    id: 'resilience-smoke',
    name: 'Resilience Smoke',
    suitePath: 'test/contract-smoke/suites/resilience-smoke.json',
    outSubdir: 'suites/resilience-smoke',
  },
];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const outDir = options.outDir
    ? path.resolve(options.outDir)
    : path.resolve('output/test/contract-smoke');
  fs.mkdirSync(outDir, { recursive: true });

  const results: ContractSmokeResult[] = [];
  for (const item of CONTRACT_SMOKE_ITEMS) {
    try {
      const scorecard = writeScriptedRuntimeTestResult(await runScriptedRuntimeTestSuite({
        suitePath: path.resolve(item.suitePath),
        outDir: path.join(outDir, item.outSubdir),
      }), path.join(outDir, item.outSubdir));
      results.push(resultFromScorecard(item, scorecard));
    } catch (error) {
      results.push({
        id: item.id,
        name: item.name,
        decision: 'blocked',
        cases_total: 0,
        cases_passed: 0,
        hard_failures: 0,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summary = summarize(results);
  const manifestPath = path.join(outDir, 'manifest.json');
  const reportPath = path.join(outDir, 'report.md');
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    generated_at: new Date().toISOString(),
    decision: summary.decision,
    items_total: results.length,
    cases_total: summary.cases_total,
    results,
  }, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(reportPath, `${renderReport(results, summary)}\n`, 'utf-8');

  console.log([
    `Contract smoke complete: ${summary.decision}`,
    `items=${summary.items_passed}/${summary.items_total} passed`,
    `cases=${summary.cases_passed}/${summary.cases_total} passed`,
    `hardFailures=${summary.hard_failures}`,
    `manifest=${manifestPath}`,
    `report=${reportPath}`,
  ].join('\n'));

  if (!options.allowFail && summary.decision !== 'pass') {
    process.exit(1);
  }
}

function parseArgs(args: string[]): CliOptions {
  let outDir: string | undefined;
  let allowFail = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--out') {
      outDir = path.resolve(readNext(args, ++index, '--out'));
      continue;
    }
    if (arg === '--allow-fail') {
      allowFail = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return { outDir, allowFail };
}

function resultFromScorecard(
  item: ContractSmokeItem,
  scorecard: ScriptedRuntimeTestResult,
): ContractSmokeResult {
  return {
    id: item.id,
    name: item.name,
    decision: scorecard.summary.decision,
    cases_total: scorecard.summary.cases_total,
    cases_passed: scorecard.summary.cases_passed,
    hard_failures: scorecard.summary.hard_failures,
    scorecard_path: scorecard.evidence.scorecard_path,
    report_path: scorecard.evidence.report_path,
    message: `${scorecard.summary.cases_passed}/${scorecard.summary.cases_total} test cases passed`,
  };
}

function summarize(results: ContractSmokeResult[]): {
  decision: TestDecision;
  items_total: number;
  items_passed: number;
  cases_total: number;
  cases_passed: number;
  hard_failures: number;
} {
  const itemsPassed = results.filter(item => item.decision === 'pass').length;
  const blocked = results.some(item => item.decision === 'blocked');
  const failed = results.some(item => item.decision === 'fail');
  return {
    decision: failed ? 'fail' : blocked ? 'blocked' : 'pass',
    items_total: results.length,
    items_passed: itemsPassed,
    cases_total: results.reduce((sum, item) => sum + item.cases_total, 0),
    cases_passed: results.reduce((sum, item) => sum + item.cases_passed, 0),
    hard_failures: results.reduce((sum, item) => sum + item.hard_failures, 0),
  };
}

function renderReport(
  results: ContractSmokeResult[],
  summary: ReturnType<typeof summarize>,
): string {
  return [
    '# Contract Smoke Report',
    '',
    `- decision: ${summary.decision}`,
    `- items: ${summary.items_passed}/${summary.items_total} passed`,
    `- cases: ${summary.cases_passed}/${summary.cases_total} passed`,
    `- hard failures: ${summary.hard_failures}`,
    '',
    '| Item | Decision | Cases | Hard Failures | Scorecard |',
    '| --- | --- | --- | --- | --- |',
    ...results.map(item => [
      '|',
      item.id,
      '|',
      item.decision,
      '|',
      `${item.cases_passed}/${item.cases_total}`,
      '|',
      item.hard_failures,
      '|',
      item.scorecard_path ?? 'missing',
      '|',
    ].join(' ')),
  ].join('\n');
}

function readNext(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp(): void {
  console.log([
    'Usage: tsx scripts/run-contract-smoke.ts -- [--out <dir>] [--allow-fail]',
    '',
    'Runs deterministic runtime contract smoke suites under test/contract-smoke.',
    '',
    'Default output: output/test/contract-smoke',
  ].join('\n'));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
