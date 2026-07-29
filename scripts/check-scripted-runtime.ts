#!/usr/bin/env tsx

import * as fs from 'fs';
import * as path from 'path';
import {
  assertScriptedRuntimeTestSet,
  loadScriptedRuntimeTestSet,
} from '../src/testing';

interface CliOptions {
  benchmarkPaths: string[];
  rootDir: string;
  maxCases: number;
}

interface CheckFailure {
  benchmarkPath: string;
  message: string;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const benchmarkPaths = options.benchmarkPaths.length > 0
    ? options.benchmarkPaths
    : findBenchmarkFiles(options.rootDir);

  if (benchmarkPaths.length === 0) {
    throw new Error(`no benchmark manifests found under ${options.rootDir}`);
  }

  const failures: CheckFailure[] = [];
  let totalCases = 0;

  for (const benchmarkPath of benchmarkPaths) {
    try {
      const benchmark = loadScriptedRuntimeTestSet(benchmarkPath);
      assertScriptedRuntimeTestSet(benchmark, benchmarkPath);
      totalCases += benchmark.cases.length;

      if (benchmark.cases.length > options.maxCases) {
        failures.push({
          benchmarkPath,
          message: `has ${benchmark.cases.length} cases; max is ${options.maxCases}`,
        });
      }

      const benchmarkDir = path.dirname(path.resolve(benchmarkPath));
      for (const caseSpec of benchmark.cases) {
        const suitePath = path.resolve(benchmarkDir, caseSpec.eval_suite);
        if (!fs.existsSync(suitePath)) {
          failures.push({
            benchmarkPath,
            message: `${caseSpec.case_id} references missing eval_suite: ${caseSpec.eval_suite}`,
          });
        }
      }
    } catch (error) {
      failures.push({
        benchmarkPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failures.length > 0) {
    console.error(`Scripted Runtime Test check failed (${failures.length} issue${failures.length === 1 ? '' : 's'}):`);
    for (const failure of failures) {
      console.error(`- ${path.relative(process.cwd(), failure.benchmarkPath)}: ${failure.message}`);
    }
    process.exit(1);
  }

  console.log(`Scripted Runtime Test check passed: ${benchmarkPaths.length} manifest(s), ${totalCases} case(s), max ${options.maxCases} per manifest.`);
}

function parseArgs(args: string[]): CliOptions {
  const benchmarkPaths: string[] = [];
  let rootDir = path.resolve('test/scripted-runtime');
  let maxCases = 200;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--benchmark') {
      benchmarkPaths.push(path.resolve(readNext(args, ++index, '--benchmark')));
      continue;
    }
    if (arg === '--root') {
      rootDir = path.resolve(readNext(args, ++index, '--root'));
      continue;
    }
    if (arg === '--max-cases') {
      maxCases = parsePositiveInteger(readNext(args, ++index, '--max-cases'), '--max-cases');
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return { benchmarkPaths, rootDir, maxCases };
}

function findBenchmarkFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];

  const results: string[] = [];
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && (entry.name === 'benchmark.json' || entry.name.endsWith('.benchmark.json'))) {
        results.push(fullPath);
      }
    }
  };

  walk(rootDir);
  return results;
}

function readNext(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function printHelp(): void {
  console.log([
    'Usage: npm run test:check-scripted-runtime -- [--root <dir>] [--benchmark <path>] [--max-cases <n>]',
    '',
    'Checks Scripted Runtime Test manifests without running their cases.',
    '',
    'Default root: test/scripted-runtime',
    'Default max cases per manifest: 200',
  ].join('\n'));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
