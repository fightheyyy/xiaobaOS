#!/usr/bin/env tsx

import * as path from 'path';
import {
  runScriptedRuntimeTestSuite,
  writeScriptedRuntimeTestResult,
} from '../src/testing';

interface CliOptions {
  suitePath: string;
  outDir?: string;
  allowFail: boolean;
  caseIds: string[];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const scorecard = writeScriptedRuntimeTestResult(await runScriptedRuntimeTestSuite({
    suitePath: options.suitePath,
    outDir: options.outDir,
    caseIds: options.caseIds,
  }));

  console.log([
    `Scripted Runtime Test complete: ${scorecard.summary.decision}`,
    `suite=${scorecard.suite_id}`,
    `cases=${scorecard.summary.cases_passed}/${scorecard.summary.cases_total} passed`,
    `hardFailures=${scorecard.summary.hard_failures}`,
    `scorecard=${scorecard.evidence.scorecard_path}`,
    `report=${scorecard.evidence.report_path}`,
  ].join('\n'));

  if (!options.allowFail && scorecard.summary.decision !== 'pass') {
    process.exit(1);
  }
}

function parseArgs(args: string[]): CliOptions {
  let suitePath = path.resolve('test/contract-smoke/suites/contract-sentinel.json');
  let outDir: string | undefined;
  let allowFail = false;
  const caseIds: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--suite') {
      suitePath = path.resolve(readNext(args, ++index, '--suite'));
      continue;
    }
    if (arg === '--out') {
      outDir = path.resolve(readNext(args, ++index, '--out'));
      continue;
    }
    if (arg === '--allow-fail') {
      allowFail = true;
      continue;
    }
    if (arg === '--case') {
      caseIds.push(readNext(args, ++index, '--case'));
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return { suitePath, outDir, allowFail, caseIds };
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
    'Usage: tsx scripts/run-test-suite.ts -- [--suite <path>] [--case <id>] [--out <dir>] [--allow-fail]',
    '',
    'Runs prewritten model actions against the real XiaoBa Runtime.',
    'This is implementation correctness evidence, not Agent behavioral Eval.',
    '',
    'Default suite: test/contract-smoke/suites/contract-sentinel.json',
  ].join('\n'));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
