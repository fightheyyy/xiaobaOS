#!/usr/bin/env tsx

import * as path from 'path';
import {
  runScriptedRuntimeTestBenchmark,
  writeScriptedRuntimeTestBenchmarkResult,
} from '../src/testing';

interface CliOptions {
  outDir?: string;
  allowFail: boolean;
}

const BASE_RUNTIME_TEST_PATH = path.resolve('test/scripted-runtime/base-runtime/benchmark.json');

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = writeScriptedRuntimeTestBenchmarkResult(
    await runScriptedRuntimeTestBenchmark({
      benchmarkPath: BASE_RUNTIME_TEST_PATH,
      outDir: options.outDir,
    }),
  );

  console.log([
    `Scripted Runtime Test complete: ${result.summary.decision}`,
    `testSet=${result.benchmark_id}`,
    `groups=${result.summary.benchmark_cases_passed}/${result.summary.benchmark_cases_total} passed`,
    `cases=${result.summary.eval_cases_passed}/${result.summary.eval_cases_total} passed`,
    `hardFailures=${result.summary.hard_failures}`,
    `result=${result.evidence.scorecard_path}`,
    `report=${result.evidence.report_path}`,
  ].join('\n'));

  if (!options.allowFail && result.summary.decision !== 'pass') {
    process.exit(1);
  }
}

function parseArgs(args: string[]): CliOptions {
  let outDir: string | undefined;
  let allowFail = false;

  for (let index = 0; index < args.length; index += 1) {
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

function readNext(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp(): void {
  console.log([
    'Usage: npm run test:base-runtime -- [--out <dir>] [--allow-fail]',
    '',
    'Runs prewritten model actions against the real BaseRuntime.',
    'This verifies implementation behavior; it is not Agent behavioral Eval.',
  ].join('\n'));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
