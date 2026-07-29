import { afterEach, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ARENA_LIVE_CALL_BOUNDS,
  arenaLiveAuditEvidencePath,
  arenaLiveProviderConfig,
  arenaLiveRuntimeContract,
  configureArenaLiveAudit,
  resetArenaLiveAuditForTests,
  runArenaAuditedProviderCall,
} from '../src/arena/live-audit';

afterEach(() => resetArenaLiveAuditForTests());

test('Arena live contract is credential-free and declares enforced composite call bounds', () => {
  const contract = arenaLiveRuntimeContract();
  assert.strictEqual(contract.schema, 'barena.xiaoba_live_runtime_contract.v1');
  assert.deepStrictEqual(contract.bounds, ARENA_LIVE_CALL_BOUNDS);
  assert.strictEqual(contract.enforcement.sdk_max_retries, 0);
  assert.strictEqual(contract.enforcement.authoritative_per_call_telemetry, true);
  assert.strictEqual(JSON.stringify(contract).includes('secret-value'), false);
});

test('Arena live audit scrubs provider secrets, records physical calls, and blocks a fifth target call in one scope', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-live-audit-'));
  const environment: NodeJS.ProcessEnv = {
    XIAOBA_ARENA_LIVE_MODE: 'barena',
    XIAOBA_LLM_PROVIDER: 'openai',
    XIAOBA_LLM_MODEL: 'fixture-model',
    XIAOBA_LLM_MAX_TOKENS: '1000',
    XIAOBA_ARENA_MAX_INPUT_TOKENS: '10000',
    XIAOBA_ARENA_MAX_PROVIDER_CALLS: '5',
    XIAOBA_ARENA_CREDENTIAL_ENV: 'FIXTURE_PROVIDER_KEY',
    XIAOBA_ARENA_API_BASE_ENV: 'FIXTURE_PROVIDER_BASE',
    FIXTURE_PROVIDER_KEY: 'secret-value',
    FIXTURE_PROVIDER_BASE: 'https://provider.invalid/v1',
    XIAOBA_LLM_BACKUP_API_KEY: 'backup-secret',
  };

  try {
    configureArenaLiveAudit({
      projectRoot: root,
      runId: 'barena-eval-candidate-case-one-1-audit',
      environment,
    });
    assert.strictEqual(environment.FIXTURE_PROVIDER_KEY, undefined);
    assert.strictEqual(environment.FIXTURE_PROVIDER_BASE, undefined);
    assert.strictEqual(environment.XIAOBA_LLM_BACKUP_API_KEY, undefined);
    assert.strictEqual(arenaLiveProviderConfig()?.apiKey, 'secret-value');

    let physicalCalls = 0;
    for (let index = 0; index < ARENA_LIVE_CALL_BOUNDS.target_calls_per_turn; index += 1) {
      await runArenaAuditedProviderCall({
        component: 'target',
        scopeId: 'target-turn-1',
        provider: 'openai',
        model: 'fixture-model',
        requestedOutputLimit: 500,
        messages: [{ role: 'user', content: 'hello' }],
        invoke: async () => {
          physicalCalls += 1;
          return {
            content: 'ok',
            usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
          };
        },
      });
    }

    await assert.rejects(
      () => runArenaAuditedProviderCall({
        component: 'target',
        scopeId: 'target-turn-1',
        provider: 'openai',
        model: 'fixture-model',
        requestedOutputLimit: 500,
        messages: [{ role: 'user', content: 'one call too many' }],
        invoke: async () => {
          physicalCalls += 1;
          return { content: 'should not run' };
        },
      }),
      /target call limit exceeded/i,
    );
    assert.strictEqual(physicalCalls, 4);

    const evidencePath = arenaLiveAuditEvidencePath();
    assert.ok(evidencePath);
    const records = fs.readFileSync(evidencePath!, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
    assert.strictEqual(records.length, 4);
    assert.strictEqual(records.every(record => record.component === 'target'), true);
    assert.strictEqual(records.every(record => record.configured_max_retries === 0), true);
    assert.strictEqual(records.every(record => record.provider === 'openai' && record.model === 'fixture-model'), true);
    assert.strictEqual(fs.readFileSync(evidencePath!, 'utf-8').includes('secret-value'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Arena live audit rejects provider identity drift before a physical request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-live-identity-'));
  const environment: NodeJS.ProcessEnv = {
    XIAOBA_ARENA_LIVE_MODE: 'barena',
    XIAOBA_LLM_PROVIDER: 'openai',
    XIAOBA_LLM_MODEL: 'fixture-model',
    XIAOBA_LLM_MAX_TOKENS: '1000',
    XIAOBA_ARENA_MAX_INPUT_TOKENS: '10000',
    XIAOBA_ARENA_MAX_PROVIDER_CALLS: '2',
    XIAOBA_ARENA_CREDENTIAL_ENV: 'FIXTURE_PROVIDER_KEY',
    XIAOBA_ARENA_API_BASE_ENV: 'FIXTURE_PROVIDER_BASE',
    FIXTURE_PROVIDER_KEY: 'secret-value',
    FIXTURE_PROVIDER_BASE: 'https://provider.invalid/v1',
  };
  let invoked = false;
  try {
    configureArenaLiveAudit({ projectRoot: root, runId: 'identity-run', environment });
    await assert.rejects(
      () => runArenaAuditedProviderCall({
        component: 'usercat',
        scopeId: 'planner-turn-2',
        provider: 'openai',
        model: 'other-model',
        requestedOutputLimit: 500,
        messages: [{ role: 'user', content: 'hello' }],
        invoke: async () => {
          invoked = true;
          return { content: 'should not run' };
        },
      }),
      /provider identity mismatch/i,
    );
    assert.strictEqual(invoked, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
