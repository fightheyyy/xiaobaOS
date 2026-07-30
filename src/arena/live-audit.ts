import * as fs from 'fs';
import * as path from 'path';
import { Message, ChatConfig, ChatResponse } from '../types';
import { ToolDefinition } from '../types/tool';
import { APP_VERSION } from '../version';

export type ArenaProviderCallComponent = 'target' | 'usercat' | 'inspector' | 'reviewer' | 'replay';

export const ARENA_LIVE_CALL_BOUNDS = Object.freeze({
  target_calls_per_turn: 4,
  usercat_calls_per_turn: 1,
  inspector_calls_per_attempt: 0,
  reviewer_calls_per_attempt: 0,
  replay_calls_per_case_turn: 4,
});

export interface ArenaLiveRuntimeContract {
  schema: 'barena.xiaoba_live_runtime_contract.v1';
  xiaoba_version: string;
  composite_call_contract: 'barena.xiaoba_composite_calls.v1';
  provider_call_record_schema: 'barena.provider_call.v1';
  bounds: typeof ARENA_LIVE_CALL_BOUNDS;
  enforcement: {
    input_token_limit: true;
    output_token_limit: true;
    sdk_max_retries: 0;
    authoritative_per_call_telemetry: true;
    complete_provider_identity: true;
    complete_cost_basis: true;
  };
}

interface ArenaLiveAuditState {
  runId: string;
  provider: string;
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxProviderCalls: number;
  providerConfig: ChatConfig;
  evidencePath: string;
  evidenceRef: string;
  totalCalls: number;
  scopeCalls: Map<string, number>;
}

export interface ConfigureArenaLiveAuditInput {
  projectRoot: string;
  runId: string;
  environment?: NodeJS.ProcessEnv;
}

export interface ArenaAuditedProviderCallInput {
  component?: ArenaProviderCallComponent;
  scopeId?: string;
  provider: string;
  model: string;
  requestedOutputLimit: number;
  messages: Message[];
  tools?: ToolDefinition[];
  invoke: () => Promise<ChatResponse>;
}

let state: ArenaLiveAuditState | undefined;

export function arenaLiveRuntimeContract(): ArenaLiveRuntimeContract {
  return {
    schema: 'barena.xiaoba_live_runtime_contract.v1',
    xiaoba_version: APP_VERSION,
    composite_call_contract: 'barena.xiaoba_composite_calls.v1',
    provider_call_record_schema: 'barena.provider_call.v1',
    bounds: ARENA_LIVE_CALL_BOUNDS,
    enforcement: {
      input_token_limit: true,
      output_token_limit: true,
      sdk_max_retries: 0,
      authoritative_per_call_telemetry: true,
      complete_provider_identity: true,
      complete_cost_basis: true,
    },
  };
}

export function configureArenaLiveAudit(input: ConfigureArenaLiveAuditInput): string | undefined {
  const environment = input.environment ?? process.env;
  if (environment.XIAOBA_ARENA_LIVE_MODE !== 'barena') {
    state = undefined;
    return undefined;
  }

  const provider = requiredText(environment.XIAOBA_LLM_PROVIDER, 'XIAOBA_LLM_PROVIDER');
  const model = requiredText(environment.XIAOBA_LLM_MODEL, 'XIAOBA_LLM_MODEL');
  const maxInputTokens = positiveInteger(environment.XIAOBA_ARENA_MAX_INPUT_TOKENS, 'XIAOBA_ARENA_MAX_INPUT_TOKENS');
  const maxOutputTokens = positiveInteger(environment.XIAOBA_LLM_MAX_TOKENS, 'XIAOBA_LLM_MAX_TOKENS');
  const maxProviderCalls = positiveInteger(environment.XIAOBA_ARENA_MAX_PROVIDER_CALLS, 'XIAOBA_ARENA_MAX_PROVIDER_CALLS');
  const credentialEnv = requiredEnvName(environment.XIAOBA_ARENA_CREDENTIAL_ENV, 'XIAOBA_ARENA_CREDENTIAL_ENV');
  const apiBaseEnv = requiredEnvName(environment.XIAOBA_ARENA_API_BASE_ENV, 'XIAOBA_ARENA_API_BASE_ENV');
  const apiKey = provider === 'ollama'
    ? environment[credentialEnv]
    : requiredText(environment[credentialEnv], credentialEnv);
  const apiUrl = requiredText(environment[apiBaseEnv], apiBaseEnv);
  const providerKind = provider === 'anthropic' || provider === 'ollama' || provider === 'openai'
    ? provider
    : undefined;
  if (!providerKind) throw new Error(`Unsupported audited provider: ${provider}`);

  const projectRoot = path.resolve(input.projectRoot);
  const evidencePath = path.join(projectRoot, 'arena', 'runs', safeSegment(input.runId), 'debug', 'provider-calls.ndjson');
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, '', 'utf-8');

  state = {
    runId: input.runId,
    provider,
    model,
    maxInputTokens,
    maxOutputTokens,
    maxProviderCalls,
    providerConfig: {
      provider: providerKind,
      model,
      apiUrl,
      apiKey,
      maxTokens: maxOutputTokens,
    },
    evidencePath,
    evidenceRef: relativeRef(projectRoot, evidencePath),
    totalCalls: 0,
    scopeCalls: new Map(),
  };

  scrubProviderSecrets(environment, credentialEnv, apiBaseEnv);
  return evidencePath;
}

export function arenaLiveProviderConfig(): Partial<ChatConfig> | undefined {
  return state ? { ...state.providerConfig } : undefined;
}

export function arenaLiveAuditEnabled(): boolean {
  return Boolean(state);
}

export function arenaLiveAuditEvidencePath(): string | undefined {
  return state?.evidencePath;
}

export function arenaLiveAuditEvidenceRef(): string | undefined {
  return state?.evidenceRef;
}

export async function runArenaAuditedProviderCall(
  input: ArenaAuditedProviderCallInput,
): Promise<ChatResponse> {
  const current = state;
  if (!current) return input.invoke();
  if (!input.component || input.component === 'inspector' || input.component === 'reviewer') {
    throw new Error('Arena live provider call is missing a billable component.');
  }
  if (!input.scopeId?.trim()) {
    throw new Error(`Arena live ${input.component} provider call is missing its enforced scope.`);
  }
  if (input.provider !== current.provider || input.model !== current.model) {
    throw new Error(
      `Arena live provider identity mismatch: expected ${current.provider}/${current.model}, got ${input.provider}/${input.model}.`,
    );
  }
  if (!Number.isInteger(input.requestedOutputLimit) || input.requestedOutputLimit < 1 || input.requestedOutputLimit > current.maxOutputTokens) {
    throw new Error(`Arena live requested output limit exceeds ${current.maxOutputTokens}.`);
  }

  const scopeKey = `${input.component}:${input.scopeId}`;
  const scopeCalls = current.scopeCalls.get(scopeKey) ?? 0;
  const componentLimit = callsPerScope(input.component);
  if (scopeCalls >= componentLimit) {
    throw new Error(`Arena live ${input.component} call limit exceeded for scope ${input.scopeId}: ${scopeCalls}/${componentLimit}.`);
  }
  if (current.totalCalls >= current.maxProviderCalls) {
    throw new Error(`Arena live provider call limit exceeded: ${current.totalCalls}/${current.maxProviderCalls}.`);
  }

  const conservativeInputUpperBound = providerInputByteUpperBound(input.messages, input.tools);
  if (conservativeInputUpperBound > current.maxInputTokens) {
    throw new Error(
      `Arena live conservative input bound ${conservativeInputUpperBound} exceeds ${current.maxInputTokens} before provider invocation.`,
    );
  }

  current.totalCalls += 1;
  current.scopeCalls.set(scopeKey, scopeCalls + 1);
  const callIndex = current.totalCalls;
  let response: ChatResponse;
  try {
    response = await input.invoke();
  } catch (error) {
    appendProviderCall(current, input, callIndex, null, null);
    throw error;
  }

  const promptTokens = nonNegativeInteger(response.usage?.promptTokens);
  const completionTokens = nonNegativeInteger(response.usage?.completionTokens);
  appendProviderCall(current, input, callIndex, promptTokens, completionTokens);
  if (promptTokens === null || completionTokens === null) {
    throw new Error('Arena live provider response did not include authoritative token usage.');
  }
  if (promptTokens > current.maxInputTokens || completionTokens > current.maxOutputTokens) {
    throw new Error(
      `Arena live provider usage exceeded its token ceiling: input=${promptTokens}/${current.maxInputTokens}, output=${completionTokens}/${current.maxOutputTokens}.`,
    );
  }
  return response;
}

export function resetArenaLiveAuditForTests(): void {
  state = undefined;
}

function appendProviderCall(
  current: ArenaLiveAuditState,
  input: ArenaAuditedProviderCallInput,
  callIndex: number,
  inputTokens: number | null,
  outputTokens: number | null,
): void {
  const identity = inferRunIdentity(current.runId);
  const record = {
    schema: 'barena.provider_call.v1',
    call_id: `${safeSegment(current.runId)}.provider-call.${String(callIndex).padStart(4, '0')}.${input.component}`,
    arm: identity.arm,
    case_id: identity.caseId,
    attempt: identity.attempt,
    component: input.component,
    provider: current.provider,
    model: current.model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    requested_output_limit: input.requestedOutputLimit,
    configured_max_retries: 0,
    observed_retries: 0,
    estimated_cost_usd: 0,
    billed_cost_usd: null,
    evidence_ref: current.evidenceRef,
  };
  fs.appendFileSync(current.evidencePath, `${JSON.stringify(record)}\n`, 'utf-8');
}

function callsPerScope(component: ArenaProviderCallComponent): number {
  if (component === 'target') return ARENA_LIVE_CALL_BOUNDS.target_calls_per_turn;
  if (component === 'usercat') return ARENA_LIVE_CALL_BOUNDS.usercat_calls_per_turn;
  if (component === 'replay') return ARENA_LIVE_CALL_BOUNDS.replay_calls_per_case_turn;
  return 0;
}

function providerInputByteUpperBound(messages: Message[], tools?: ToolDefinition[]): number {
  return Buffer.byteLength(JSON.stringify({ messages, tools: tools ?? [] }), 'utf-8') + 1024;
}

function scrubProviderSecrets(environment: NodeJS.ProcessEnv, credentialEnv: string, apiBaseEnv: string): void {
  const names = new Set([
    credentialEnv,
    apiBaseEnv,
    'XIAOBA_LLM_API_KEY',
    'XIAOBA_LLM_API_BASE',
  ]);
  for (const name of Object.keys(environment)) {
    if (/^XIAOBA_LLM_BACKUP(?:_[1-5])?_/i.test(name)) names.add(name);
  }
  for (const name of names) delete environment[name];
}

function inferRunIdentity(runId: string): { arm: 'baseline' | 'candidate'; caseId: string; attempt: number } {
  const match = runId.match(/(?:^|.*-)(baseline|candidate)-(.+)-([1-9]\d*)-[^-]+$/);
  return {
    arm: match?.[1] === 'candidate' ? 'candidate' : 'baseline',
    caseId: match?.[2] || 'arena-case',
    attempt: Number(match?.[3] || 1),
  };
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function requiredText(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${name} is required for Arena live audit.`);
  return text;
}

function requiredEnvName(value: unknown, name: string): string {
  const text = requiredText(value, name);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) throw new Error(`${name} must name an environment variable.`);
  return text;
}

function safeSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized || normalized === '.' || normalized === '..') throw new Error(`Invalid Arena run id: ${value}`);
  return normalized;
}

function relativeRef(projectRoot: string, filePath: string): string {
  return path.relative(projectRoot, filePath).split(path.sep).join('/');
}
