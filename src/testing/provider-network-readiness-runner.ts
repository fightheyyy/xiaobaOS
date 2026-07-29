import * as fs from 'fs';
import * as path from 'path';
import { AgentSession } from '../core/agent-session';
import { ToolManager } from '../tools/tool-manager';
import type { ChatConfig, ChatResponse, Message } from '../types';
import type { ToolDefinition } from '../types/tool';
import { AIService } from '../utils/ai-service';
import { ConfigManager } from '../utils/config';
import type { EvalDecision } from './scripted-runtime-types';

export type ProviderNetworkReadinessStatus = 'pass' | 'fail' | 'blocked';
export type ProviderNetworkReadinessSeverity = 'environment' | 'configuration' | 'execution' | 'evidence';

export interface ProviderNetworkReadinessRunOptions {
  outDir?: string;
  enabled?: boolean;
  useDefaultConfig?: boolean;
  provider?: ChatConfig['provider'];
  apiUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  now?: Date;
  prompt?: string;
  sessionKey?: string;
  aiServiceFactory?: (config: ChatConfig) => {
    chatStream(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse>;
    chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse>;
  };
}

export interface ProviderNetworkReadinessCheck {
  id: string;
  status: ProviderNetworkReadinessStatus;
  severity: ProviderNetworkReadinessSeverity;
  message: string;
  duration_ms?: number;
  evidence_ref?: string;
}

export interface ProviderNetworkReadinessReport {
  provider_network_readiness_version: '0.1';
  generated_at: string;
  summary: {
    decision: EvalDecision;
    checks_total: number;
    checks_passed: number;
    checks_failed: number;
    checks_blocked: number;
    replay_enabled: boolean;
    degradation_verified: boolean;
  };
  environment: {
    provider?: ChatConfig['provider'];
    model_configured: boolean;
    api_base_configured: boolean;
    api_key_configured: boolean;
    timeout_ms: number;
    use_default_config: boolean;
    expected_degradation: true;
  };
  checks: ProviderNetworkReadinessCheck[];
  evidence: {
    out_dir: string;
    workspace_dir: string;
    session_log_path?: string;
    manifest_path?: string;
    scorecard_path?: string;
    report_path?: string;
  };
}

class EmptySkillManager {
  async loadSkills(): Promise<void> {}
  getAllSkills(): any[] { return []; }
  getUserInvocableSkills(): any[] { return []; }
  getSkill(): any { return undefined; }
  findAutoInvocableSkillByText(): any { return undefined; }
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_PROMPT = 'Provider network degradation replay: produce a short response if the provider is healthy.';

export async function runProviderNetworkReadiness(
  options: ProviderNetworkReadinessRunOptions = {},
): Promise<ProviderNetworkReadinessReport> {
  const now = options.now ?? new Date();
  const outDir = path.resolve(options.outDir ?? path.join('output', 'test', 'provider-network-readiness'));
  const workspaceDir = path.join(outDir, 'workspace');
  const timeoutMs = options.timeoutMs ?? readPositiveInt(process.env.XIAOBA_PROVIDER_NETWORK_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  const enabled = options.enabled ?? process.env.XIAOBA_PROVIDER_NETWORK_REPLAY === 'true';
  const useDefaultConfig = options.useDefaultConfig ?? process.env.XIAOBA_PROVIDER_NETWORK_USE_DEFAULT_CONFIG === 'true';
  const explicitConfig = readExplicitProviderConfig(options);
  const hasInjectedAi = Boolean(options.aiServiceFactory);
  const effectiveConfig = buildEffectiveConfig(explicitConfig, useDefaultConfig);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const checks: ProviderNetworkReadinessCheck[] = [];
  checks.push(enabled
    ? pass('provider_network.opt_in', 'provider network replay is explicitly enabled', 'environment')
    : blocked('provider_network.opt_in', 'set XIAOBA_PROVIDER_NETWORK_REPLAY=true or pass --enable to run provider-network replay', 'environment'));

  if (!enabled) {
    return buildReport({ now, outDir, workspaceDir, timeoutMs, useDefaultConfig, config: effectiveConfig, checks });
  }

  const configCheck = validateProviderConfig(effectiveConfig, useDefaultConfig, hasInjectedAi);
  checks.push(configCheck);
  if (configCheck.status !== 'pass') {
    return buildReport({ now, outDir, workspaceDir, timeoutMs, useDefaultConfig, config: effectiveConfig, checks });
  }

  const started = Date.now();
  const previousCwd = process.cwd();
  let sessionLogPath: string | undefined;

  try {
    process.chdir(workspaceDir);
    const aiService = options.aiServiceFactory
      ? options.aiServiceFactory(effectiveConfig)
      : new AIService(effectiveConfig);
    const session = new AgentSession(options.sessionKey ?? 'provider-network:degradation', {
      aiService: aiService as any,
      toolManager: new ToolManager(),
      skillManager: new EmptySkillManager() as any,
    }, 'pet');

    await withTimeout(
      session.handleMessage(options.prompt ?? DEFAULT_PROMPT, { surface: 'pet' }),
      timeoutMs,
      'provider network replay timed out',
    );
    checks.push(pass('provider_network.runtime', 'Provider-network runtime path completed', 'execution', Date.now() - started));
  } catch (error) {
    checks.push(fail('provider_network.runtime', error instanceof Error ? error.message : String(error), 'execution', Date.now() - started));
  } finally {
    process.chdir(previousCwd);
  }

  sessionLogPath = findSingleSessionLog(workspaceDir);
  if (sessionLogPath) {
    checks.push(pass('provider_network.session_log', 'provider-network replay wrote session JSONL evidence', 'evidence', undefined, sessionLogPath));
    checks.push(...verifyProviderDegradationEvidence(sessionLogPath));
  } else {
    checks.push(fail('provider_network.session_log', 'provider-network replay did not write session JSONL evidence', 'evidence'));
    checks.push(blocked('provider_network.provider_error', 'provider_error evidence blocked because session log is missing', 'evidence'));
    checks.push(blocked('provider_network.degraded_provider_transcript', 'degraded provider transcript evidence blocked because session log is missing', 'evidence'));
  }

  return buildReport({
    now,
    outDir,
    workspaceDir,
    timeoutMs,
    useDefaultConfig,
    config: effectiveConfig,
    checks,
    sessionLogPath,
  });
}

export function writeProviderNetworkReadinessReport(
  report: ProviderNetworkReadinessReport,
  outDir = report.evidence.out_dir,
): ProviderNetworkReadinessReport {
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'manifest.json');
  const scorecardPath = path.join(outDir, 'scorecard.json');
  const reportPath = path.join(outDir, 'report.md');
  const withPaths: ProviderNetworkReadinessReport = {
    ...report,
    evidence: {
      ...report.evidence,
      out_dir: outDir,
      manifest_path: manifestPath,
      scorecard_path: scorecardPath,
      report_path: reportPath,
    },
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    generated_at: withPaths.generated_at,
    decision: withPaths.summary.decision,
    replay_enabled: withPaths.summary.replay_enabled,
    degradation_verified: withPaths.summary.degradation_verified,
    checks_total: withPaths.summary.checks_total,
    checks_blocked: withPaths.summary.checks_blocked,
    scorecard_path: withPaths.evidence.scorecard_path,
    report_path: withPaths.evidence.report_path,
  }, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(scorecardPath, `${JSON.stringify(withPaths, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(reportPath, `${renderProviderNetworkReadinessReport(withPaths)}\n`, 'utf-8');

  return withPaths;
}

export function renderProviderNetworkReadinessReport(report: ProviderNetworkReadinessReport): string {
  const rows = report.checks.map(item => [
    '|',
    item.id,
    '|',
    item.status,
    '|',
    item.severity,
    '|',
    item.message.replace(/\|/g, '\\|'),
    '|',
  ].join(' '));

  return [
    '# Provider Network Readiness Report',
    '',
    `- generated at: ${report.generated_at}`,
    `- decision: ${report.summary.decision}`,
    `- replay enabled: ${String(report.summary.replay_enabled)}`,
    `- degradation verified: ${String(report.summary.degradation_verified)}`,
    `- provider: ${report.environment.provider || 'auto'}`,
    `- api base configured: ${String(report.environment.api_base_configured)}`,
    `- api key configured: ${String(report.environment.api_key_configured)}`,
    `- model configured: ${String(report.environment.model_configured)}`,
    `- checks: ${report.summary.checks_passed}/${report.summary.checks_total} passed`,
    `- blocked checks: ${report.summary.checks_blocked}`,
    `- failed checks: ${report.summary.checks_failed}`,
    '',
    'This opt-in readiness gate records whether a configured provider-network replay can produce structured degraded provider transcript evidence. A blocked decision is environment evidence, not a successful production-network replay.',
    '',
    '## Checks',
    '',
    '| Check | Status | Severity | Message |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function readExplicitProviderConfig(options: ProviderNetworkReadinessRunOptions): Partial<ChatConfig> {
  return {
    provider: options.provider ?? providerFromEnv(),
    apiUrl: options.apiUrl ?? process.env.XIAOBA_PROVIDER_NETWORK_API_BASE,
    apiKey: options.apiKey ?? process.env.XIAOBA_PROVIDER_NETWORK_API_KEY,
    model: options.model ?? process.env.XIAOBA_PROVIDER_NETWORK_MODEL,
    temperature: 0,
    maxTokens: 64,
  };
}

function buildEffectiveConfig(explicitConfig: Partial<ChatConfig>, useDefaultConfig: boolean): ChatConfig {
  const base = useDefaultConfig ? ConfigManager.getConfig() : {};
  return {
    ...base,
    ...Object.fromEntries(Object.entries(explicitConfig).filter(([, value]) => value !== undefined && value !== '')),
  } as ChatConfig;
}

function validateProviderConfig(
  config: ChatConfig,
  useDefaultConfig: boolean,
  hasInjectedAi: boolean,
): ProviderNetworkReadinessCheck {
  if (hasInjectedAi) {
    return pass('provider_network.config', 'provider-network replay uses injected AI service for verification', 'configuration');
  }
  if (!useDefaultConfig && !config.apiUrl && !config.model) {
    return blocked(
      'provider_network.config',
      'explicit provider config is required unless --use-config or XIAOBA_PROVIDER_NETWORK_USE_DEFAULT_CONFIG=true is set',
      'configuration',
    );
  }
  const provider = inferProvider(config);
  if (!config.apiUrl) {
    return blocked('provider_network.config.api_base', 'provider API base is not configured', 'configuration');
  }
  if (!config.model) {
    return blocked('provider_network.config.model', 'provider model is not configured', 'configuration');
  }
  if (provider !== 'ollama' && !config.apiKey) {
    return blocked('provider_network.config.api_key', 'provider API key is not configured for non-Ollama provider', 'configuration');
  }
  return pass('provider_network.config', 'provider-network replay config is present', 'configuration');
}

function inferProvider(config: ChatConfig): ChatConfig['provider'] {
  if (config.provider === 'anthropic' || config.provider === 'ollama' || config.provider === 'openai') {
    return config.provider;
  }
  const apiUrl = (config.apiUrl || '').toLowerCase();
  const model = (config.model || '').toLowerCase();
  if (apiUrl.includes('anthropic') || apiUrl.includes('claude') || model.includes('claude')) {
    return 'anthropic';
  }
  if (apiUrl.includes('ollama') || apiUrl.includes(':11434') || apiUrl.endsWith('/api/chat') || model.includes('ollama')) {
    return 'ollama';
  }
  return 'openai';
}

function providerFromEnv(): ChatConfig['provider'] | undefined {
  const value = (process.env.XIAOBA_PROVIDER_NETWORK_PROVIDER || '').trim().toLowerCase();
  if (value === 'openai' || value === 'anthropic' || value === 'ollama') {
    return value;
  }
  return undefined;
}

function buildReport(input: {
  now: Date;
  outDir: string;
  workspaceDir: string;
  timeoutMs: number;
  useDefaultConfig: boolean;
  config: ChatConfig;
  checks: ProviderNetworkReadinessCheck[];
  sessionLogPath?: string;
}): ProviderNetworkReadinessReport {
  const checksFailed = input.checks.filter(item => item.status === 'fail').length;
  const checksBlocked = input.checks.filter(item => item.status === 'blocked').length;
  const degradationVerified = input.checks.some(item => item.id === 'provider_network.degraded_provider_transcript' && item.status === 'pass');
  const decision: EvalDecision = checksFailed > 0
    ? 'fail'
    : checksBlocked > 0
      ? 'blocked'
      : 'pass';

  return {
    provider_network_readiness_version: '0.1',
    generated_at: input.now.toISOString(),
    summary: {
      decision,
      checks_total: input.checks.length,
      checks_passed: input.checks.filter(item => item.status === 'pass').length,
      checks_failed: checksFailed,
      checks_blocked: checksBlocked,
      replay_enabled: input.checks.some(item => item.id === 'provider_network.opt_in' && item.status === 'pass'),
      degradation_verified: degradationVerified,
    },
    environment: {
      provider: inferProvider(input.config),
      model_configured: Boolean(input.config.model),
      api_base_configured: Boolean(input.config.apiUrl),
      api_key_configured: Boolean(input.config.apiKey),
      timeout_ms: input.timeoutMs,
      use_default_config: input.useDefaultConfig,
      expected_degradation: true,
    },
    checks: input.checks,
    evidence: {
      out_dir: input.outDir,
      workspace_dir: input.workspaceDir,
      ...(input.sessionLogPath && { session_log_path: input.sessionLogPath }),
    },
  };
}

function verifyProviderDegradationEvidence(sessionLogPath: string): ProviderNetworkReadinessCheck[] {
  const entries = readJsonl(sessionLogPath);
  const events = entries.flatMap(entry => Array.isArray(entry.events) ? entry.events : [entry]);
  const providerEvents = events.filter(entry => entry.entry_type === 'runtime_event' && entry.event_type === 'provider_error');
  const traces = entries.filter(entry => entry.entry_type === 'trace' || entry.entry_type === 'turn');
  const providerTranscriptRecords = traces
    .map(entry => asRecord(asRecord(entry.state_boundary)?.provider_transcript))
    .filter((record): record is Record<string, unknown> => Boolean(record));
  const degradedRecord = providerTranscriptRecords.find(record => isStructuredDegradedProviderTranscript(record));

  return [
    providerEvents.length > 0
      ? pass('provider_network.provider_error', 'provider_error runtime event evidence is present', 'evidence', undefined, sessionLogPath)
      : fail('provider_network.provider_error', 'provider_error runtime event evidence is missing', 'evidence', undefined, sessionLogPath),
    degradedRecord
      ? pass('provider_network.degraded_provider_transcript', 'degraded provider transcript boundary evidence is structured', 'evidence', undefined, sessionLogPath)
      : fail('provider_network.degraded_provider_transcript', 'structured degraded provider transcript boundary evidence is missing', 'evidence', undefined, sessionLogPath),
  ];
}

function isStructuredDegradedProviderTranscript(record: Record<string, unknown>): boolean {
  return typeof record.ref === 'string'
    && /^(provider-transcripts\/)?sha256:[a-f0-9]{16,64}$/i.test(record.ref)
    && (record.status === 'degraded' || record.status === 'blocked')
    && record.degraded === true
    && typeof (record.degradation_reason || record.error_code) === 'string'
    && Array.isArray(record.fallback_chain)
    && record.fallback_chain.filter(item => typeof item === 'string' && item.trim()).length >= 2
    && typeof record.blocked_reason === 'string'
    && record.raw_messages_stored === false
    && record.tool_result_payload_stored === false
    && record.raw_request_stored === false
    && record.raw_response_stored === false
    && record.raw_payload_stored === false;
}

function findSingleSessionLog(workspaceDir: string): string | undefined {
  const logRoot = path.join(workspaceDir, 'logs', 'sessions');
  const files = collectFiles(logRoot)
    .filter(file => file.endsWith('.jsonl') && !file.replace(/\\/g, '/').includes('/context-snapshots/'));
  const traceFiles = files.filter(file => path.basename(file) === 'traces.jsonl');
  return (traceFiles.length ? traceFiles : files)[0];
}

function collectFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectFiles(fullPath));
    } else {
      result.push(fullPath);
    }
  }
  return result;
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  return fs.readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pass(
  id: string,
  message: string,
  severity: ProviderNetworkReadinessSeverity,
  durationMs?: number,
  evidenceRef?: string,
): ProviderNetworkReadinessCheck {
  return compactCheck({ id, status: 'pass', severity, message, duration_ms: durationMs, evidence_ref: evidenceRef });
}

function fail(
  id: string,
  message: string,
  severity: ProviderNetworkReadinessSeverity,
  durationMs?: number,
  evidenceRef?: string,
): ProviderNetworkReadinessCheck {
  return compactCheck({ id, status: 'fail', severity, message, duration_ms: durationMs, evidence_ref: evidenceRef });
}

function blocked(
  id: string,
  message: string,
  severity: ProviderNetworkReadinessSeverity,
): ProviderNetworkReadinessCheck {
  return { id, status: 'blocked', severity, message };
}

function compactCheck(check: ProviderNetworkReadinessCheck): ProviderNetworkReadinessCheck {
  return Object.fromEntries(Object.entries(check).filter(([, value]) => value !== undefined)) as ProviderNetworkReadinessCheck;
}

function readPositiveInt(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
