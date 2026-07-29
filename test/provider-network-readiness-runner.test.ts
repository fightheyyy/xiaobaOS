import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ChatResponse, Message } from '../src/types';
import type { ToolDefinition } from '../src/types/tool';
import {
  runProviderNetworkReadiness,
  writeProviderNetworkReadinessReport,
} from '../src/testing/provider-network-readiness-runner';

class FailingProviderService {
  async chatStream(_messages: Message[], _tools?: ToolDefinition[]): Promise<ChatResponse> {
    const error = new Error('API错误 (429): provider rate limit api_key=sk-test-provider-network-readiness-secret') as Error & {
      provider?: string;
      model?: string;
      endpoint?: string;
      status?: number;
      error_code?: string;
      retryable?: boolean;
    };
    error.provider = 'openai-compatible';
    error.model = 'provider-network-test-model';
    error.endpoint = 'primary';
    error.status = 429;
    error.error_code = 'MODEL_RATE_LIMIT';
    error.retryable = true;
    throw error;
  }

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

describe('provider network readiness runner', () => {
  test('writes blocked readiness evidence until explicitly enabled', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-provider-network-blocked-'));
    const report = writeProviderNetworkReadinessReport(await runProviderNetworkReadiness({
      outDir,
      enabled: false,
      now: new Date('2026-06-05T00:00:00.000Z'),
    }));

    assert.equal(report.summary.decision, 'blocked');
    assert.equal(report.summary.replay_enabled, false);
    assert.equal(report.summary.degradation_verified, false);
    assert.ok(report.checks.some(item => item.id === 'provider_network.opt_in' && item.status === 'blocked'));
    assert.ok(fs.existsSync(path.join(outDir, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(outDir, 'scorecard.json')));
    assert.ok(fs.existsSync(path.join(outDir, 'report.md')));
  });

  test('verifies live AgentSession degraded provider transcript evidence with injected provider failure', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-provider-network-pass-'));
    const report = writeProviderNetworkReadinessReport(await runProviderNetworkReadiness({
      outDir,
      enabled: true,
      provider: 'openai',
      apiUrl: 'https://provider-network.invalid/v1',
      apiKey: 'sk-test-provider-network-readiness-secret',
      model: 'provider-network-test-model',
      aiServiceFactory: () => new FailingProviderService(),
      now: new Date('2026-06-05T00:00:00.000Z'),
    }));

    assert.equal(report.summary.decision, 'pass');
    assert.equal(report.summary.replay_enabled, true);
    assert.equal(report.summary.degradation_verified, true);
    assert.ok(report.evidence.session_log_path);
    assert.ok(fs.existsSync(report.evidence.session_log_path));
    assert.ok(report.checks.some(item => item.id === 'provider_network.provider_error' && item.status === 'pass'));
    assert.ok(report.checks.some(item => item.id === 'provider_network.degraded_provider_transcript' && item.status === 'pass'));

    const persisted = fs.readFileSync(path.join(outDir, 'scorecard.json'), 'utf-8');
    assert.ok(!persisted.includes('sk-test-provider-network-readiness-secret'));
    const entries = fs.readFileSync(report.evidence.session_log_path, 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const turn = entries.find(entry => entry.entry_type === 'trace' || entry.entry_type === 'turn');
    assert.match(turn.state_boundary.provider_transcript.ref, /^provider-transcripts\/sha256:[a-f0-9]{64}$/);
    assert.equal(turn.state_boundary.provider_transcript.status, 'degraded');
  });

  test('CLI allows blocked provider-network readiness evidence by default package behavior', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-provider-network-cli-'));
    const output = execFileSync('npx', [
      'tsx',
      'scripts/check-provider-network-readiness.ts',
      '--out',
      outDir,
      '--allow-blocked',
    ], {
      encoding: 'utf-8',
    });

    assert.ok(output.includes('Provider network readiness complete: blocked'));
    assert.ok(output.includes('replayEnabled=false'));
    assert.ok(fs.existsSync(path.join(outDir, 'scorecard.json')));
  });
});
