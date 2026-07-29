#!/usr/bin/env tsx

import * as path from 'path';
import {
  runProviderNetworkReadiness,
  writeProviderNetworkReadinessReport,
} from '../src/testing/provider-network-readiness-runner';
import type { ChatConfig } from '../src/types';

interface CliOptions {
  outDir: string;
  enabled?: boolean;
  useDefaultConfig?: boolean;
  provider?: ChatConfig['provider'];
  apiUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  allowBlocked: boolean;
  allowFail: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = writeProviderNetworkReadinessReport(await runProviderNetworkReadiness({
    outDir: options.outDir,
    enabled: options.enabled,
    useDefaultConfig: options.useDefaultConfig,
    provider: options.provider,
    apiUrl: options.apiUrl,
    apiKey: options.apiKey,
    model: options.model,
    timeoutMs: options.timeoutMs,
  }));

  console.log([
    `Provider network readiness complete: ${report.summary.decision}`,
    `replayEnabled=${String(report.summary.replay_enabled)}`,
    `degradationVerified=${String(report.summary.degradation_verified)}`,
    `checks=${report.summary.checks_passed}/${report.summary.checks_total} passed`,
    `blocked=${report.summary.checks_blocked}`,
    `failed=${report.summary.checks_failed}`,
    `scorecard=${report.evidence.scorecard_path}`,
    `report=${report.evidence.report_path}`,
  ].join('\n'));

  if (report.summary.decision === 'fail' && !options.allowFail) {
    process.exit(1);
  }
  if (report.summary.decision === 'blocked' && !options.allowBlocked) {
    process.exit(1);
  }
}

function parseArgs(args: string[]): CliOptions {
  let outDir = path.resolve('output/provider-network-readiness');
  let enabled: boolean | undefined;
  let useDefaultConfig: boolean | undefined;
  let provider: ChatConfig['provider'] | undefined;
  let apiUrl: string | undefined;
  let apiKey: string | undefined;
  let model: string | undefined;
  let timeoutMs: number | undefined;
  let allowBlocked = false;
  let allowFail = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--out') {
      outDir = path.resolve(readNext(args, ++index, '--out'));
      continue;
    }
    if (arg === '--enable') {
      enabled = true;
      continue;
    }
    if (arg === '--use-config') {
      useDefaultConfig = true;
      continue;
    }
    if (arg === '--provider') {
      provider = parseProvider(readNext(args, ++index, '--provider'));
      continue;
    }
    if (arg === '--api-base') {
      apiUrl = readNext(args, ++index, '--api-base');
      continue;
    }
    if (arg === '--api-key') {
      apiKey = readNext(args, ++index, '--api-key');
      continue;
    }
    if (arg === '--model') {
      model = readNext(args, ++index, '--model');
      continue;
    }
    if (arg === '--timeout-ms') {
      timeoutMs = Number(readNext(args, ++index, '--timeout-ms'));
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('--timeout-ms must be a positive number');
      }
      continue;
    }
    if (arg === '--allow-blocked') {
      allowBlocked = true;
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

  return {
    outDir,
    enabled,
    useDefaultConfig,
    provider,
    apiUrl,
    apiKey,
    model,
    timeoutMs,
    allowBlocked,
    allowFail,
  };
}

function parseProvider(value: string): ChatConfig['provider'] {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'anthropic' || normalized === 'ollama') {
    return normalized;
  }
  throw new Error('--provider must be openai, anthropic, or ollama');
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
    'Usage: tsx scripts/check-provider-network-readiness.ts -- [--enable] [--use-config] [--provider <openai|anthropic|ollama>] [--api-base <url>] [--api-key <key>] [--model <name>] [--timeout-ms <ms>] [--allow-blocked] [--allow-fail]',
    '',
    'Runs an opt-in provider-network degradation readiness replay through live AgentSession evidence.',
    '',
    'The default command is safe for ordinary users: without --enable or XIAOBA_PROVIDER_NETWORK_REPLAY=true it writes blocked readiness evidence and exits successfully when --allow-blocked is set.',
    '',
    'Default output: output/provider-network-readiness',
  ].join('\n'));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
