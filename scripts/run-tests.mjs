#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const testRoot = path.resolve('test');

function collectTestFiles(dir) {
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectTestFiles(fullPath);
    if (entry.isFile() && entry.name.endsWith('.test.ts')) return [fullPath];
    return [];
  });
}

const nativeSandboxTestNames = new Set([
  'source-candidate.test.ts',
  'sub-agent-security.test.ts',
]);
const runnerArgs = process.argv.slice(2);
const excludeNativeSandboxTests = runnerArgs.includes('--exclude-native-sandbox-tests');
if (excludeNativeSandboxTests) {
  runnerArgs.splice(runnerArgs.indexOf('--exclude-native-sandbox-tests'), 1);
}
const testFiles = collectTestFiles(testRoot).filter(file => (
  !excludeNativeSandboxTests || !nativeSandboxTestNames.has(path.basename(file))
));

if (testFiles.length === 0) {
  console.error('No test files found under test/**/*.test.ts');
  process.exit(1);
}

if (!runnerArgs.some(arg => arg === '--test-concurrency' || arg.startsWith('--test-concurrency='))) {
  runnerArgs.unshift('--test-concurrency=1');
}

const tsxCli = require.resolve('tsx/cli');
const child = spawn(process.execPath, [tsxCli, '--test', ...runnerArgs, ...testFiles], {
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Test process exited with signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
