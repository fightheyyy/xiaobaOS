import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import type {
  EvalFailureRoute,
  EvalJudgeProviderSpec,
  EvalJudgeRubricCriterion,
  EvalJudgeStatus,
  EvalLane,
  EvalRiskLevel,
  EvalTargetModule,
} from './scripted-runtime-types';

export interface EvalExternalJudgeRequest {
  judge_id: string;
  suite_id: string;
  case_id: string;
  case_name: string;
  lane: EvalLane;
  target_module: EvalTargetModule;
  risk_level: EvalRiskLevel;
  failure_route?: EvalFailureRoute;
  task?: string;
  prompt?: string;
  min_score: number;
  rubric: EvalJudgeRubricCriterion[];
  hard_verifiers: Array<{
    id: string;
    status: string;
    message: string;
  }>;
  assistant_text: string;
  evidence_text: string;
  evidence_refs: string[];
  modalities: Array<'text' | 'image'>;
}

export interface EvalExternalJudgeResponse {
  status?: EvalJudgeStatus;
  score: number;
  rationale: string;
  confidence?: number;
  evidence_refs?: string[];
  metrics?: Record<string, number | string | boolean>;
}

export interface EvalExternalJudgeProviderRunOptions {
  provider: EvalJudgeProviderSpec;
  request: EvalExternalJudgeRequest;
  suiteDir: string;
  artifactDir: string;
}

export interface EvalExternalJudgeProviderRunResult {
  provider_name: string;
  response: EvalExternalJudgeResponse;
  request_path: string;
  response_path: string;
  evidence_refs: string[];
}

interface FixtureJudgeFile {
  provider?: string;
  responses?: FixtureJudgeResponse[];
}

interface FixtureJudgeResponse extends Partial<EvalExternalJudgeResponse> {
  judge_id?: string;
  case_id?: string;
  status?: EvalJudgeStatus;
  score?: number;
  rationale?: string;
}

export async function runExternalEvalJudgeProvider(
  options: EvalExternalJudgeProviderRunOptions,
): Promise<EvalExternalJudgeProviderRunResult> {
  fs.mkdirSync(options.artifactDir, { recursive: true });
  const requestPath = path.join(options.artifactDir, 'request.json');
  const responsePath = path.join(options.artifactDir, 'response.json');
  fs.writeFileSync(requestPath, `${JSON.stringify(options.request, null, 2)}\n`, 'utf-8');

  const providerName = options.provider.name || options.provider.type;
  const response = options.provider.type === 'fixture'
    ? runFixtureJudgeProvider(options.provider, options.request, options.suiteDir)
    : await runOpenAICompatibleJudgeProvider(options.provider, options.request);

  fs.writeFileSync(responsePath, `${JSON.stringify({
    provider: providerName,
    ...response,
  }, null, 2)}\n`, 'utf-8');

  return {
    provider_name: providerName,
    response,
    request_path: requestPath,
    response_path: responsePath,
    evidence_refs: [requestPath, responsePath, ...(response.evidence_refs ?? [])],
  };
}

function runFixtureJudgeProvider(
  provider: EvalJudgeProviderSpec,
  request: EvalExternalJudgeRequest,
  suiteDir: string,
): EvalExternalJudgeResponse {
  if (!provider.fixture_path) {
    return blockedResponse('fixture provider requires fixture_path');
  }

  const fixturePath = resolveSuiteRelativePath(suiteDir, provider.fixture_path);
  if (!fs.existsSync(fixturePath)) {
    return blockedResponse(`fixture response not found: ${fixturePath}`);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as FixtureJudgeFile | FixtureJudgeResponse;
    const fixture = selectFixtureResponse(parsed, request);
    if (!fixture) {
      return blockedResponse(`fixture has no response for ${request.case_id}/${request.judge_id}`, [fixturePath]);
    }
    return normalizeExternalJudgeResponse(fixture, request.min_score, [fixturePath]);
  } catch (error) {
    return blockedResponse(`fixture response is invalid JSON: ${errorMessage(error)}`, [fixturePath]);
  }
}

async function runOpenAICompatibleJudgeProvider(
  provider: EvalJudgeProviderSpec,
  request: EvalExternalJudgeRequest,
): Promise<EvalExternalJudgeResponse> {
  const apiKeyEnv = provider.api_key_env || 'OPENAI_API_KEY';
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    return blockedResponse(`missing judge provider API key env: ${apiKeyEnv}`);
  }
  if (!provider.model) {
    return blockedResponse('openai_compatible provider requires model');
  }

  const baseUrl = (provider.base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const payload = {
    model: provider.model,
    temperature: provider.temperature ?? 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          'You are a strict agent evaluation judge.',
          'Return JSON only with: status, score, rationale, confidence, evidence_refs.',
          'Score must be between 0 and 1. Status must be pass, fail, or blocked.',
          'Do not ignore hard verifier evidence; if evidence is insufficient, use blocked.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify(request),
      },
    ],
  };

  try {
    const response = await axios.post(`${baseUrl}/chat/completions`, payload, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      timeout: provider.timeout_ms ?? 60000,
      validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
      return blockedResponse(`judge provider HTTP ${response.status}`, [], {
        http_status: response.status,
      });
    }

    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      return blockedResponse('judge provider returned no message content');
    }

    const parsed = parseJsonObjectFromText(content);
    return normalizeExternalJudgeResponse(parsed, request.min_score, [], {
      provider_latency_ms: asNumber(response.headers?.['x-response-time']) ?? 0,
    });
  } catch (error) {
    return blockedResponse(`judge provider request failed: ${errorMessage(error)}`);
  }
}

function selectFixtureResponse(
  parsed: FixtureJudgeFile | FixtureJudgeResponse,
  request: EvalExternalJudgeRequest,
): FixtureJudgeResponse | undefined {
  if (Array.isArray((parsed as FixtureJudgeFile).responses)) {
    return (parsed as FixtureJudgeFile).responses?.find(item => (
      (!item.case_id || item.case_id === request.case_id)
      && (!item.judge_id || item.judge_id === request.judge_id)
    ));
  }
  return parsed as FixtureJudgeResponse;
}

function normalizeExternalJudgeResponse(
  raw: unknown,
  minScore: number,
  evidenceRefs: string[] = [],
  metrics: Record<string, number | string | boolean> = {},
): EvalExternalJudgeResponse {
  const record = asRecord(raw);
  if (!record) {
    return blockedResponse('judge response is not an object', evidenceRefs);
  }

  const score = clampScore(asNumber(record.score) ?? 0);
  const status = normalizeStatus(asString(record.status)) ?? (score >= minScore ? 'pass' : 'fail');
  const confidence = asNumber(record.confidence);
  const rationale = asString(record.rationale) || asString(record.message) || `judge score ${score}`;
  const responseRefs = stringList(record.evidence_refs);

  return {
    status,
    score,
    rationale,
    confidence: confidence === undefined ? undefined : clampScore(confidence),
    evidence_refs: [...evidenceRefs, ...responseRefs],
    metrics: {
      ...metrics,
      response_evidence_refs: responseRefs.length,
    },
  };
}

function blockedResponse(
  rationale: string,
  evidenceRefs: string[] = [],
  metrics: Record<string, number | string | boolean> = {},
): EvalExternalJudgeResponse {
  return {
    status: 'blocked',
    score: 0,
    rationale,
    confidence: 0,
    evidence_refs: evidenceRefs,
    metrics,
  };
}

function parseJsonObjectFromText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('no JSON object found in judge response');
    }
    return JSON.parse(match[0]);
  }
}

function normalizeStatus(value: string): EvalJudgeStatus | undefined {
  if (value === 'pass' || value === 'fail' || value === 'blocked') {
    return value;
  }
  return undefined;
}

function resolveSuiteRelativePath(suiteDir: string, targetPath: string): string {
  return path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(suiteDir, targetPath);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
