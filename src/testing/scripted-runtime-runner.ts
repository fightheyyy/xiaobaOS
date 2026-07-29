import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import express from 'express';
import { createRoleAwareToolManager } from '../bootstrap/tool-manager';
import { AgentServices } from '../core/agent-session';
import { FeishuBot } from '../feishu';
import { MessageHandler } from '../feishu/message-handler';
import { PetChannel, normalizePetMessageSurfaceEvent } from '../pet/channel';
import { parseSkillActivationSignal } from '../skills/skill-activation-protocol';
import { Logger } from '../utils/logger';
import { buildEvalScorecard, defaultEvalOutDir } from './scripted-runtime-result';
import {
  runExternalEvalJudgeProvider,
  type EvalExternalJudgeRequest,
} from './scripted-runtime-judge';
import type { ChatResponse, Skill } from '../types';
import type { NormalizedSurfaceEvent } from '../types/surface-event';
import type { ToolCall } from '../types/tool';
import type {
  EvalBudgets,
  EvalCase,
  EvalCaseMetrics,
  EvalCaseResult,
  EvalDecision,
  EvalFailureRoute,
  EvalJudgeResult,
  EvalJudgeSpec,
  EvalRequiredArtifact,
  EvalReplayModelResponse,
  EvalReplaySurfaceTurn,
  EvalReplayDeliveryEvidence,
  EvalRunOptions,
  EvalScorecard,
  EvalSuite,
  EvalVerifierResult,
} from './scripted-runtime-types';

interface ParsedJsonl {
  path: string;
  content: string;
  lines: string[];
  entries: Record<string, unknown>[];
  parseErrors: Array<{ line: number; message: string }>;
}

const JSONL_FILE_CACHE = new Map<string, ParsedJsonl>();

interface ToolCallFact {
  id: string;
  name: string;
  argumentsText: string;
  resultText: string;
  status: string;
  ok?: boolean;
  errorCode: string;
  blockedReason: string;
  retryable?: boolean;
  retryCount?: number;
  retryBudget?: number;
  retryBudgetExhausted?: boolean;
  durationMs?: number;
  artifactManifest: ArtifactManifestItem[];
  deliveryEvidence: DeliveryEvidenceItem[];
  externalReceipts: SurfaceExternalReceipt[];
}

interface ArtifactManifestItem {
  path: string;
  type?: string;
  action?: string;
  metadata?: Record<string, unknown>;
}

interface DeliveryEvidenceItem {
  deliveryType: string;
  status: string;
  timestamp: string;
  deliveryId?: string;
  surface?: string;
  channelId?: string;
  textPreview?: string;
  fileName?: string;
  filePath?: string;
  errorCode?: string;
}

interface SurfaceRuntimeDeliveryEvidenceFact {
  surface: string;
  runtimeId: string;
  fileArtifactPaths: string[];
  item: DeliveryEvidenceItem;
}

interface SurfaceRuntimeExternalReceiptFact {
  surface: string;
  runtimeId: string;
  item: SurfaceExternalReceipt;
}

interface SkillActivationEvidence {
  skillName: string;
  prompt: string;
  maxTurns?: number;
  systemPromptCount: number;
  source: string;
}

interface SkillHandoffFact {
  fromSkill: string;
  toSkill: string;
  caseId: string;
  reason: string;
  artifacts: string[];
  source: string;
}

interface SkillFinalArtifact {
  skillName: string;
  caseId: string;
  artifact: string;
  decision: string;
  evidenceRefs: string[];
  source: string;
}

interface RoleHandoffFact {
  fromRole: string;
  toRole: string;
  caseId: string;
  reason: string;
  artifacts: string[];
  source: string;
}

interface RoleReviewDecision {
  roleId: string;
  caseId: string;
  decision: string;
  evidenceRefs: string[];
  source: string;
}

interface SurfaceExternalReceipt {
  receiptId: string;
  receiptType: string;
  surface: string;
  status: string;
  platformMessageId: string;
  platformFileKey: string;
  deliveryId: string;
  fileName: string;
  artifactPath: string;
  timestamp: string;
  evidenceRefs: string[];
  source: string;
}

interface StateBoundaryFact {
  boundary: string;
  kind: string;
  ref: string;
  source: string;
  record: Record<string, unknown>;
}

interface EvalVerifierContext {
  suite: EvalSuite;
  caseSpec: EvalCase;
  suitePath: string;
  suiteDir: string;
  outDir: string;
  jsonl?: ParsedJsonl;
  toolCalls: ToolCallFact[];
  metrics: EvalCaseMetrics;
  verifierResults?: EvalVerifierResult[];
}

type VerifierFn = (context: EvalVerifierContext, config: Record<string, unknown>) => EvalVerifierResult;
type JudgeFn = (context: EvalVerifierContext, spec: EvalJudgeSpec) => EvalJudgeResult | Promise<EvalJudgeResult>;

const FINAL_TOOL_STATUSES = new Set(['success', 'failure', 'timeout', 'cancel', 'cancelled', 'blocked']);
const FAILURE_STATUSES = new Set(['failure', 'failed', 'timeout', 'cancel', 'cancelled', 'blocked', 'error']);

const VERIFIERS: Record<string, VerifierFn> = {
  jsonl_parse: verifyJsonlParse,
  tool_transcript_completeness: verifyToolTranscriptCompleteness,
  tool_result_contract: verifyToolResultContract,
  runtime_observability: verifyRuntimeObservability,
  artifact_evidence: verifyArtifactEvidence,
  provider_network_readiness_contract: verifyProviderNetworkReadinessContract,
  delivery_evidence_contract: verifyDeliveryEvidenceContract,
  channel_delivery: verifyChannelDelivery,
  surface_runtime_e2e: verifySurfaceRuntimeE2e,
  bounded_retry: verifyBoundedRetry,
  budget_check: verifyBudgetCheck,
  assistant_text_contains: verifyAssistantTextContains,
  tool_sequence: verifyToolSequence,
  role_boundary: verifyRoleBoundary,
  cross_role_handoff: verifyCrossRoleHandoff,
  state_continuity: verifyStateContinuity,
  state_boundary_contract: verifyStateBoundaryContract,
  provider_transcript_normalization: verifyProviderTranscriptNormalization,
  provider_transcript_degradation: verifyProviderTranscriptDegradation,
  provider_error_fallback: verifyProviderErrorFallback,
  provider_failover_sequence: verifyProviderFailoverSequence,
  tool_permission_denial: verifyToolPermissionDenial,
  workspace_boundary: verifyWorkspaceBoundary,
  skill_activation_contract: verifySkillActivationContract,
  cross_skill_handoff: verifyCrossSkillHandoff,
  user_trace_candidate: verifyUserTraceCandidate,
  research_board_quality: verifyResearchBoardQuality,
  research_board_reviewer_semantic: verifyResearchBoardReviewerSemantic,
  researcher_review_packet: verifyResearcherReviewPacket,
};

export const EVAL_VERIFIER_IDS = Object.freeze(Object.keys(VERIFIERS));

const JUDGES: Record<string, JudgeFn> = {
  semantic_text_quality: judgeSemanticTextQuality,
  evidence_reference_quality: judgeEvidenceReferenceQuality,
  collaboration_quality: judgeCollaborationQuality,
  external_model_judge: judgeExternalModel,
};

export const EVAL_JUDGE_IDS = Object.freeze(Object.keys(JUDGES));

export {
  renderEvalReport,
  writeEvalScorecard,
} from './scripted-runtime-result';

export function loadEvalSuite(suitePath: string): EvalSuite {
  const resolved = path.resolve(suitePath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8')) as EvalSuite;
  validateSuiteShape(parsed, resolved);
  return parsed;
}

export async function runEvalSuite(options: EvalRunOptions): Promise<EvalScorecard> {
  const suitePath = path.resolve(options.suitePath);
  const suite = loadEvalSuite(suitePath);
  const runnableSuite = filterEvalSuiteCases(suite, options.caseIds, suitePath);
  const suiteDir = path.dirname(suitePath);
  const now = options.now ?? new Date();
  const outDir = options.outDir ? path.resolve(options.outDir) : defaultEvalOutDir(runnableSuite, now);

  fs.mkdirSync(outDir, { recursive: true });

  const cases = [];
  for (const caseSpec of runnableSuite.cases) {
    cases.push(await runEvalCase({
      suite: runnableSuite,
      caseSpec,
      suitePath,
      suiteDir,
      outDir,
    }));
  }

  const scorecard = buildEvalScorecard({
    suite: runnableSuite,
    suitePath,
    outDir,
    now,
    cases,
  });

  return scorecard;
}

function filterEvalSuiteCases(suite: EvalSuite, caseIds: string[] | undefined, suitePath: string): EvalSuite {
  if (!caseIds || caseIds.length === 0) {
    return suite;
  }

  const requested = new Set(caseIds);
  const selected = suite.cases.filter(item => requested.has(item.case_id));
  const selectedIds = new Set(selected.map(item => item.case_id));
  const missing = caseIds.filter(id => !selectedIds.has(id));
  if (missing.length > 0) {
    throw new Error(`eval suite ${suitePath} does not contain case ids: ${missing.join(', ')}`);
  }

  return {
    ...suite,
    cases: selected,
  };
}

async function runEvalCase(input: {
  suite: EvalSuite;
  caseSpec: EvalCase;
  suitePath: string;
  suiteDir: string;
  outDir: string;
}): Promise<EvalCaseResult> {
  let caseSpec = input.caseSpec;
  const preResults: EvalVerifierResult[] = [];

  if (input.caseSpec.replay) {
    try {
      const replayOutput = await runReplay({
        caseSpec: input.caseSpec,
        outDir: input.outDir,
      });
      caseSpec = {
        ...input.caseSpec,
        inputs: {
          ...(input.caseSpec.inputs ?? {}),
          jsonl: replayOutput.tracePath,
          artifacts_dir: replayOutput.artifactsDir,
        },
      };
      preResults.push(result('replay_execution', 'pass', 'deterministic replay completed', [replayOutput.tracePath]));
    } catch (error) {
      preResults.push(result(
        'replay_execution',
        'blocked',
        error instanceof Error ? error.message : String(error),
        [],
        input.caseSpec.failure_route,
      ));
    }
  }

  const jsonl = readCaseJsonl(caseSpec, input.suiteDir);
  const toolCalls = jsonl ? extractToolCalls(jsonl.entries) : [];
  const metrics = computeCaseMetrics(jsonl, toolCalls);
  const context: EvalVerifierContext = {
    suite: input.suite,
    caseSpec,
    suitePath: input.suitePath,
    suiteDir: input.suiteDir,
    outDir: input.outDir,
    jsonl,
    toolCalls,
    metrics,
  };

  const verifierResults = [
    ...preResults,
    ...caseSpec.hard_verifiers.map((spec) => {
      const verifier = VERIFIERS[spec.id];
      if (!verifier) {
        return result(spec.id, 'blocked', `unknown verifier: ${spec.id}`, [], caseSpec.failure_route);
      }
      return verifier(context, spec.config ?? {});
    }),
  ];
  context.verifierResults = verifierResults;
  const judgeResults = await runSoftJudges(context, caseSpec.soft_judges);

  const decision = decideCase(caseSpec, verifierResults, judgeResults);
  const failureRoute = findFailureRoute(caseSpec, verifierResults, judgeResults);

  return {
    case_id: caseSpec.case_id,
    name: caseSpec.name,
    lane: caseSpec.lane,
    target_module: caseSpec.target_module,
    risk_level: caseSpec.risk_level,
    decision,
    verifier_results: verifierResults,
    judge_results: judgeResults,
    metrics,
    failure_route: failureRoute,
  };
}

async function runReplay(input: {
  caseSpec: EvalCase;
  outDir: string;
}): Promise<{ tracePath: string; artifactsDir: string }> {
  const replay = input.caseSpec.replay;
  if (!replay) {
    throw new Error('case has no replay spec');
  }
  if (replay.mode === 'surface_runtime') {
    return runSurfaceRuntimeReplay(input);
  }
  throw new Error(`unsupported replay mode: ${(replay as { mode?: string }).mode}. eval replay only supports surface_runtime`);
}

function readNonEmptyLines(filePath: string): string[] {
  return fs.readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function writeReplayWorkspaceFiles(caseDir: string, files: Array<{ path: string; content: string }>): void {
  for (const file of files) {
    const relativePath = asString(file.path);
    if (!relativePath) {
      throw new Error('workspace_files entries require path');
    }
    const destination = path.resolve(caseDir, relativePath);
    const relative = path.relative(caseDir, destination);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`workspace file escapes replay case directory: ${relativePath}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, asString(file.content), 'utf-8');
  }
}

interface EvidencePathAlias {
  path: string;
  label: string;
}

function writeJsonEvidence(filePath: string, value: unknown, pathAliases: EvidencePathAlias[] = []): void {
  void pathAliases;
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function writeRawJsonlEvidence(sourcePath: string, destinationPath: string, pathAliases: EvidencePathAlias[] = []): void {
  void pathAliases;
  const lines = readNonEmptyLines(sourcePath);
  fs.writeFileSync(destinationPath, `${lines.join('\n')}\n`, 'utf-8');
}

async function runSurfaceRuntimeReplay(input: {
  caseSpec: EvalCase;
  outDir: string;
}): Promise<{ tracePath: string; artifactsDir: string }> {
  const replay = input.caseSpec.replay;
  if (!replay) {
    throw new Error('case has no replay spec');
  }
  if (replay.mode !== 'surface_runtime') {
    throw new Error(`unsupported surface runtime replay mode: ${replay.mode}`);
  }

  const caseDir = path.join(input.outDir, 'replays', safePathSegment(input.caseSpec.case_id));
  fs.rmSync(caseDir, { recursive: true, force: true });
  const artifactsDir = path.join(caseDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  const runtimeResult = replay.surface === 'feishu'
    ? await runFeishuSurfaceRuntime({ caseSpec: input.caseSpec, replay, caseDir, artifactsDir })
    : replay.surface === 'pet'
      ? await runPetSurfaceRuntime({ caseSpec: input.caseSpec, replay, caseDir, artifactsDir })
      : undefined;

  if (!runtimeResult) {
    throw new Error(`unsupported surface runtime surface: ${replay.surface ?? 'unknown'}`);
  }

  const tracePath = path.join(caseDir, 'trace.jsonl');
  const traceEntry = buildSurfaceRuntimeTraceEntry({
    caseSpec: input.caseSpec,
    replay,
    runtime: runtimeResult.runtime,
    aiService: runtimeResult.aiService,
  });
  const traceLines = [JSON.stringify(traceEntry)];
  if (runtimeResult.internalTracePath) {
    traceLines.push(...readNonEmptyLines(runtimeResult.internalTracePath));
  }
  fs.writeFileSync(tracePath, `${traceLines.join('\n')}\n`, 'utf-8');
  return { tracePath, artifactsDir };
}

interface SurfaceRuntimeRunResult {
  runtime: Record<string, unknown>;
  aiService: ScriptedReplayAIService;
  internalTracePath?: string;
}

async function runFeishuSurfaceRuntime(input: {
  caseSpec: EvalCase;
  replay: NonNullable<EvalCase['replay']>;
  caseDir: string;
  artifactsDir: string;
}): Promise<SurfaceRuntimeRunResult> {
  const raw = input.replay.surface_event?.raw ?? {};
  const requestArtifact = 'surface-runtime-request.json';
  writeJsonEvidence(path.join(input.artifactsDir, requestArtifact), raw, [
    { path: input.caseDir, label: '<replay-case>' },
  ]);

  const config = input.replay.surface_event?.adapter_config ?? {};
  const normalized = normalizeReplaySurfaceAdapterEvent(input.replay);
  const serviceBundle = createSurfaceRuntimeServices(input.replay, input.artifactsDir, 'feishu', normalized.sessionKey);
  const sender = new CapturingEvalFeishuSender();
  const originalCwd = process.cwd();
  const originalSilent = Logger.isSilentMode();
  Logger.setSilentMode(true);
  const bot = new FeishuBot({
    appId: 'eval-feishu-app',
    appSecret: 'eval-feishu-secret',
    sessionTTL: 10_000,
    botOpenId: asString(config.bot_open_id),
    botAliases: stringList(config.bot_aliases),
  }, {
    client: {} as any,
    wsClient: { start: () => undefined } as any,
    sender: sender as any,
    agentServices: serviceBundle.services,
  });

  try {
    process.chdir(input.caseDir);
    await (bot as any).onMessage(raw);
  } finally {
    await bot.destroy();
    Logger.setSilentMode(originalSilent);
    process.chdir(originalCwd);
  }

  const responseArtifact = 'surface-runtime-response.json';
  writeJsonEvidence(path.join(input.artifactsDir, responseArtifact), {
    replies: sender.replies,
    files: sender.files,
    external_delivery_receipts: sender.externalReceipts,
  }, [
    { path: input.caseDir, label: '<replay-case>' },
  ]);
  const fileArtifacts = collectSurfaceRuntimeFileArtifacts(input.artifactsDir, sender.files);
  const deliveryEvidence = buildFeishuSurfaceRuntimeDeliveryEvidence({
    replies: sender.replies,
    files: sender.files,
    surface: 'feishu',
    channelId: normalized.channelId,
  });

  return {
    aiService: serviceBundle.aiService,
    runtime: {
      surface: 'feishu',
      runtime_id: 'feishu_bot_event',
      event_type: input.replay.surface_event?.event_type ?? 'im.message.receive_v1',
      status_code: 200,
      session_key: normalized.sessionKey,
      channel_id: normalized.channelId,
      user_id: normalized.userId,
      user_message: normalized.userMessage,
      visible_delivery_count: sender.replies.length + sender.files.length,
      file_delivery_count: sender.files.length,
      file_names: sender.files.map(file => file.fileName),
      file_artifact_paths: fileArtifacts,
      delivery_evidence: deliveryEvidence,
      external_delivery_receipts: sender.externalReceipts,
      event_types: [
        'feishu.event.received',
        ...sender.replies.map(() => 'feishu.reply'),
        ...sender.files.map(() => 'feishu.file'),
      ],
      request_artifact_path: requestArtifact,
      response_artifact_path: responseArtifact,
      replies: sender.replies,
      files: sender.files,
    },
  };
}

async function runPetSurfaceRuntime(input: {
  caseSpec: EvalCase;
  replay: NonNullable<EvalCase['replay']>;
  caseDir: string;
  artifactsDir: string;
}): Promise<SurfaceRuntimeRunResult> {
  const workspaceDir = path.join(input.caseDir, 'workspace');
  const evidencePathAliases = [
    { path: input.artifactsDir, label: '<replay-artifacts>' },
    { path: workspaceDir, label: '<replay-workspace>' },
    { path: input.caseDir, label: '<replay-case>' },
  ];
  writeReplayWorkspaceFiles(input.artifactsDir, input.replay.workspace_files ?? []);
  writeSurfaceRuntimeWorkspace(workspaceDir, { roleName: 'engineer-cat', petId: 'alpha-puff' });
  const turns = normalizeSurfaceRuntimeTurns(input.replay);
  const requestBodies = turns.map((turn, index) => buildPetSurfaceRuntimeBody(input.caseSpec, turn, index));
  const normalized = normalizePetMessageSurfaceEvent(requestBodies[0]);
  const requestArtifact = 'surface-runtime-request.json';
  writeJsonEvidence(path.join(input.artifactsDir, requestArtifact), requestBodies.length === 1
    ? requestBodies[0]
    : { turn_count: requestBodies.length, turns: requestBodies }, evidencePathAliases);

  const serviceBundle = createSurfaceRuntimeServices(input.replay, input.artifactsDir, 'pet', normalized.sessionKey);
  const originalCwd = process.cwd();
  const originalSilent = Logger.isSilentMode();
  const originalAppRoot = process.env.XIAOBA_APP_ROOT;
  let server: http.Server | null = null;
  let channel: PetChannel | null = null;
  try {
    process.env.XIAOBA_APP_ROOT = originalCwd;
    process.chdir(workspaceDir);
    Logger.setSilentMode(true);
    channel = new PetChannel({
      services: serviceBundle.services,
      sessionTtlMs: 10_000,
    });
    const listening = await listenEvalRouter(channel.router);
    server = listening.server;

    const turnResponses: Array<{
      turn_index: number;
      status: number;
      content_type: string;
      body: string;
      response_artifact_path?: string;
      events_artifact_path?: string;
    }> = [];
    const allEvents: Record<string, unknown>[] = [];
    for (const [index, body] of requestBodies.entries()) {
      const messageResponse = await postJson(`${listening.baseUrl}/api/pet/message`, body);
      const events = parseSseEvents(messageResponse.text);
      allEvents.push(...events);
      const turnResponseArtifact = requestBodies.length > 1
        ? `surface-runtime-response-${index + 1}.json`
        : undefined;
      const turnEventsArtifact = requestBodies.length > 1
        ? `surface-runtime-events-${index + 1}.json`
        : undefined;
      if (turnResponseArtifact) {
        writeJsonEvidence(path.join(input.artifactsDir, turnResponseArtifact), {
          status: messageResponse.status,
          content_type: messageResponse.contentType,
          body: messageResponse.text,
        }, evidencePathAliases);
      }
      if (turnEventsArtifact) {
        writeJsonEvidence(path.join(input.artifactsDir, turnEventsArtifact), events, evidencePathAliases);
      }
      turnResponses.push({
        turn_index: index + 1,
        status: messageResponse.status,
        content_type: messageResponse.contentType,
        body: messageResponse.text,
        ...(turnResponseArtifact ? { response_artifact_path: turnResponseArtifact } : {}),
        ...(turnEventsArtifact ? { events_artifact_path: turnEventsArtifact } : {}),
      });
    }

    const settleMs = asNumber(input.replay.settle_ms) ?? 0;
    if (settleMs > 0) {
      await new Promise(resolve => setTimeout(resolve, settleMs));
    }
    const historyEvents = input.replay.include_surface_history === true
      ? await fetchPetRuntimeHistoryEvents(listening.baseUrl, {
        petId: asString(normalized.metadata?.petId) || 'alpha-puff',
        sessionKey: normalized.sessionKey,
      })
      : [];
    const events = mergeSurfaceRuntimeEvents(allEvents, historyEvents);
    const fileEvents = collectSurfaceRuntimeFileEvents(events);
    const fileArtifacts = collectSurfaceRuntimeFileArtifacts(input.artifactsDir, fileEvents);
    const deliveryEvidence = buildSseSurfaceRuntimeDeliveryEvidence(events, {
      surface: 'pet',
      channelId: normalized.channelId,
    });
    const externalDeliveryReceipts = buildSseSurfaceRuntimeExternalReceipts(events, {
      surface: 'pet',
      channelId: normalized.channelId,
    });
    const responseArtifact = 'surface-runtime-response.json';
    const eventsArtifact = 'surface-runtime-events.json';
    writeJsonEvidence(path.join(input.artifactsDir, responseArtifact), requestBodies.length === 1
      ? {
        status: turnResponses[0]?.status,
        content_type: turnResponses[0]?.content_type,
        body: turnResponses[0]?.body,
      }
      : { turn_count: requestBodies.length, turns: turnResponses }, evidencePathAliases);
    writeJsonEvidence(path.join(input.artifactsDir, eventsArtifact), events, evidencePathAliases);
    const shouldCaptureInternalTrace = input.replay.capture_internal_trace === true
      || Boolean(input.replay.surface_turns?.length);
    const sourceLog = shouldCaptureInternalTrace
      ? findSingleJsonl(path.join(workspaceDir, 'logs', 'sessions', 'pet'))
      : undefined;
    const internalTracePath = sourceLog
      ? path.join(input.artifactsDir, 'pet-session-trace.jsonl')
      : undefined;
    if (sourceLog && internalTracePath) {
      writeRawJsonlEvidence(sourceLog, internalTracePath, evidencePathAliases);
    }

    return {
      aiService: serviceBundle.aiService,
      ...(internalTracePath ? { internalTracePath } : {}),
      runtime: {
        surface: 'pet',
        runtime_id: 'pet_channel_router',
        method: 'POST',
        path: '/api/pet/message',
        status_code: Math.max(...turnResponses.map(item => item.status)),
        content_type: turnResponses.map(item => item.content_type).filter(Boolean).join(','),
        session_key: normalized.sessionKey,
        channel_id: normalized.channelId,
        user_id: normalized.userId,
        user_message: turns.map(turn => turn.user_message).join('\n'),
        turn_count: turns.length,
        visible_delivery_count: countVisibleSurfaceEvents(events),
        file_delivery_count: fileEvents.length,
        file_names: fileEvents.map(file => file.fileName).filter(Boolean),
        file_artifact_paths: fileArtifacts,
        delivery_evidence: deliveryEvidence,
        external_delivery_receipts: externalDeliveryReceipts,
        event_count: events.length,
        event_types: events.map(event => asString(asRecord(event)?.type)).filter(Boolean),
        request_artifact_path: requestArtifact,
        response_artifact_path: responseArtifact,
        events_artifact_path: eventsArtifact,
      },
    };
  } finally {
    await closeEvalServer(server);
    if (channel) {
      await channel.destroy();
    }
    Logger.setSilentMode(originalSilent);
    process.chdir(originalCwd);
    restoreEnvValue('XIAOBA_APP_ROOT', originalAppRoot);
  }
}

function normalizeSurfaceRuntimeTurns(replay: NonNullable<EvalCase['replay']>): EvalReplaySurfaceTurn[] {
  const turns = replay.surface_turns?.length
    ? replay.surface_turns
    : [{ user_message: replay.user_message, surface_event: replay.surface_event }];
  return turns.map((turn, index) => ({
    user_message: asString(turn.user_message) || replay.user_message,
    surface_event: turn.surface_event ?? (index === 0 ? replay.surface_event : undefined),
  }));
}

function buildPetSurfaceRuntimeBody(
  caseSpec: EvalCase,
  turn: EvalReplaySurfaceTurn,
  index: number,
): Record<string, unknown> {
  return {
    petId: 'alpha-puff',
    text: turn.user_message,
    source: 'eval-runtime',
    eventId: turn.surface_event?.event_id ?? `${safePathSegment(caseSpec.case_id)}.message.${index + 1}`,
    ...(turn.surface_event?.raw ?? {}),
  };
}

function readCaseJsonl(caseSpec: EvalCase, suiteDir: string): ParsedJsonl | undefined {
  if (!caseSpec.inputs?.jsonl) {
    return undefined;
  }
  const filePath = resolveSuiteRelativePath(suiteDir, caseSpec.inputs.jsonl);
  const parsed = readJsonlFile(filePath);
  const selector = caseSpec.inputs.jsonl_selector;
  if (!selector || Object.keys(selector).length === 0 || parsed.parseErrors.length > 0) {
    return parsed;
  }

  const selected: Array<{ line: string; entry: Record<string, unknown> }> = [];
  for (let index = 0; index < parsed.entries.length; index += 1) {
    const entry = parsed.entries[index];
    if (matchesJsonlSelector(entry, selector)) {
      selected.push({ line: parsed.lines[index], entry });
    }
  }

  return {
    path: filePath,
    content: selected.map(item => item.line).join('\n'),
    lines: selected.map(item => item.line),
    entries: selected.map(item => item.entry),
    parseErrors: [],
  };
}

function readJsonlFile(filePath: string): ParsedJsonl {
  const cached = JSONL_FILE_CACHE.get(filePath);
  if (cached) return cached;

  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
  const entries: Record<string, unknown>[] = [];
  const parseErrors: Array<{ line: number; message: string }> = [];

  if (!fs.existsSync(filePath)) {
    parseErrors.push({ line: 0, message: `jsonl input not found: ${filePath}` });
  } else {
    lines.forEach((line, index) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          entries.push(parsed as Record<string, unknown>);
        } else {
          parseErrors.push({ line: index + 1, message: 'line is not a JSON object' });
        }
      } catch (error) {
        parseErrors.push({
          line: index + 1,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  const parsed = {
    path: filePath,
    content,
    lines,
    entries,
    parseErrors,
  };
  JSONL_FILE_CACHE.set(filePath, parsed);
  return parsed;
}

function matchesJsonlSelector(
  entry: Record<string, unknown>,
  selector: NonNullable<EvalCase['inputs']>['jsonl_selector'],
): boolean {
  if (!selector) return true;
  if (selector.trace_id !== undefined && asString(entry.trace_id) !== selector.trace_id) return false;
  if (selector.episode_id !== undefined && asString(entry.episode_id) !== selector.episode_id) return false;
  if (selector.session_id !== undefined && asString(entry.session_id) !== selector.session_id) return false;
  if (selector.trace_index !== undefined && Number(entry.trace_index) !== selector.trace_index) return false;
  return true;
}

function computeCaseMetrics(jsonl: ParsedJsonl | undefined, toolCalls: ToolCallFact[]): EvalCaseMetrics {
  const entries = jsonl?.entries ?? [];
  let turns = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  for (const entry of entries) {
    if (entry.entry_type === 'turn' || typeof entry.turn === 'number' || entry.user || entry.assistant) {
      turns += 1;
    }
    const tokens = asRecord(entry.tokens);
    promptTokens += asNumber(tokens?.prompt) ?? 0;
    completionTokens += asNumber(tokens?.completion) ?? 0;
  }

  return {
    jsonl_lines: jsonl?.lines.length ?? 0,
    parsed_entries: entries.length,
    parse_errors: jsonl?.parseErrors.length ?? 0,
    turns,
    tool_calls: toolCalls.length,
    failed_tool_calls: toolCalls.filter(isFailureToolCall).length,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function extractToolCalls(entries: Record<string, unknown>[]): ToolCallFact[] {
  const toolCalls: ToolCallFact[] = [];
  for (const entry of entries) {
    const assistant = asRecord(entry.assistant);
    const assistantCalls = asArray(assistant?.tool_calls);
    const entryCalls = asArray(entry.tool_calls);
    for (const raw of [...assistantCalls, ...entryCalls]) {
      const call = asRecord(raw);
      if (!call) continue;
      toolCalls.push({
        id: asString(call.tool_call_id) || asString(call.id),
        name: asString(call.name) || asString(call.tool_name) || 'unknown_tool',
        argumentsText: stableText(call.arguments ?? call.args),
        resultText: stableText(call.result ?? call.output ?? call.content),
        status: asString(call.status).toLowerCase(),
        ok: asBoolean(call.ok),
        errorCode: asString(call.error_code),
        blockedReason: asString(call.blocked_reason),
        retryable: asBoolean(call.retryable),
        retryCount: asNumber(call.retry_count),
        retryBudget: asNumber(call.retry_budget),
        retryBudgetExhausted: asBoolean(call.retry_budget_exhausted),
        durationMs: asNumber(call.duration_ms),
        artifactManifest: parseArtifactManifest(call.artifact_manifest),
        deliveryEvidence: parseDeliveryEvidence(call.delivery_evidence),
        externalReceipts: parseExternalDeliveryReceipts(call.external_delivery_receipts, `tool:${asString(call.name) || 'unknown_tool'}`, asString(entry.surface)),
      });
    }
  }
  return toolCalls;
}

function verifyJsonlParse(context: EvalVerifierContext): EvalVerifierResult {
  if (!context.jsonl) {
    return result('jsonl_parse', 'blocked', 'case has no JSONL input', [], context.caseSpec.failure_route);
  }
  if (context.jsonl.parseErrors.length > 0) {
    return result('jsonl_parse', 'fail', `${context.jsonl.parseErrors.length} JSONL parse errors`, [context.jsonl.path], 'state_evidence', {
      parse_errors: context.jsonl.parseErrors.length,
    });
  }
  if (context.jsonl.entries.length === 0) {
    return result('jsonl_parse', 'blocked', 'JSONL input has no entries', [context.jsonl.path], 'state_evidence');
  }
  return result('jsonl_parse', 'pass', `parsed ${context.jsonl.entries.length} JSONL entries`, [context.jsonl.path], undefined, {
    parsed_entries: context.jsonl.entries.length,
  });
}

function verifyToolTranscriptCompleteness(context: EvalVerifierContext): EvalVerifierResult {
  const missingIds = context.toolCalls.filter(call => !call.id);
  const unmatched = context.toolCalls.filter(call => call.id && !hasToolResultEvidence(call));

  if (missingIds.length > 0 || unmatched.length > 0) {
    return result(
      'tool_transcript_completeness',
      'fail',
      `missing ids=${missingIds.length}, unmatched tool results=${unmatched.length}`,
      context.jsonl ? [context.jsonl.path] : [],
      'runtime',
      {
        tool_calls: context.toolCalls.length,
        missing_ids: missingIds.length,
        unmatched_tool_results: unmatched.length,
      },
    );
  }

  return result(
    'tool_transcript_completeness',
    'pass',
    `all ${context.toolCalls.length} tool calls have result evidence`,
    context.jsonl ? [context.jsonl.path] : [],
    undefined,
    { tool_calls: context.toolCalls.length },
  );
}

function verifyToolResultContract(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  const requireRetryable = config.require_retryable === true;
  const requireDurationMs = config.require_duration_ms === true;
  const minFailedToolCalls = asNumber(config.min_failed_tool_calls) ?? 0;
  const requiredFailedTools = new Set(stringList(config.required_failed_tools));
  const failures: string[] = [];
  const terminalStatuses = new Set(['success', 'failure', 'timeout', 'cancelled', 'blocked']);
  const failedToolCalls = context.toolCalls.filter(call => call.status && call.status !== 'success');

  for (const call of context.toolCalls) {
    const label = call.id || call.name || 'unknown_tool_call';
    if (!call.status) {
      failures.push(`${label}: missing status`);
      continue;
    }
    if (!terminalStatuses.has(call.status)) {
      failures.push(`${label}: invalid status=${call.status}`);
      continue;
    }

    if (call.ok === true && call.status !== 'success') {
      failures.push(`${label}: ok=true but status=${call.status}`);
    }
    if (call.ok === false && call.status === 'success') {
      failures.push(`${label}: ok=false but status=success`);
    }

    if (call.status === 'success') {
      if (call.errorCode) {
        failures.push(`${label}: success must not carry error_code`);
      }
    } else {
      if (!call.errorCode) {
        failures.push(`${label}: ${call.status} missing error_code`);
      }
      if (call.status === 'blocked' && !call.blockedReason) {
        failures.push(`${label}: blocked missing blocked_reason`);
      }
    }

    if (requireRetryable && call.retryable === undefined) {
      failures.push(`${label}: missing retryable`);
    }
    if (requireDurationMs && (!Number.isInteger(call.durationMs) || (call.durationMs ?? -1) < 0)) {
      failures.push(`${label}: missing or invalid duration_ms`);
    }
    if (call.retryCount !== undefined && (!Number.isInteger(call.retryCount) || call.retryCount < 0)) {
      failures.push(`${label}: invalid retry_count`);
    }
    if (call.retryBudget !== undefined && (!Number.isInteger(call.retryBudget) || call.retryBudget < 0)) {
      failures.push(`${label}: invalid retry_budget`);
    }
    if (call.retryBudgetExhausted === true) {
      if (call.status !== 'blocked') {
        failures.push(`${label}: retry_budget_exhausted requires blocked status`);
      }
      if (call.retryBudget === undefined) {
        failures.push(`${label}: retry_budget_exhausted missing retry_budget`);
      }
      if (call.retryCount === undefined) {
        failures.push(`${label}: retry_budget_exhausted missing retry_count`);
      }
      if (call.retryable === true) {
        failures.push(`${label}: exhausted retry budget must not remain retryable`);
      }
    }
  }

  if (failedToolCalls.length < minFailedToolCalls) {
    failures.push(`failed tool calls ${failedToolCalls.length} < ${minFailedToolCalls}`);
  }
  for (const toolName of requiredFailedTools) {
    if (!failedToolCalls.some(call => call.name === toolName)) {
      failures.push(`missing failed tool: ${toolName}`);
    }
  }

  if (failures.length > 0) {
    return result(
      'tool_result_contract',
      'fail',
      failures.slice(0, 6).join('; '),
      context.jsonl ? [context.jsonl.path] : [],
      'runtime',
      {
        contract_failures: failures.length,
        tool_calls: context.toolCalls.length,
        failed_tool_calls: failedToolCalls.length,
      },
    );
  }

  return result(
    'tool_result_contract',
    'pass',
    `all ${context.toolCalls.length} tool result facts satisfy terminal status contract`,
    context.jsonl ? [context.jsonl.path] : [],
    undefined,
    {
      tool_calls: context.toolCalls.length,
      failed_tool_calls: failedToolCalls.length,
    },
  );
}

function verifyRuntimeObservability(context: EvalVerifierContext): EvalVerifierResult {
  const unobservable = context.toolCalls.filter((call) => {
    if (!isFailureToolCall(call)) return false;
    if (!FINAL_TOOL_STATUSES.has(call.status)) return true;
    if (call.status === 'blocked') {
      return !call.errorCode && !call.blockedReason && !call.resultText;
    }
    return !call.errorCode;
  });

  if (unobservable.length > 0) {
    return result(
      'runtime_observability',
      'fail',
      `${unobservable.length} failing tool calls lack final status/error_code evidence`,
      context.jsonl ? [context.jsonl.path] : [],
      'runtime',
      { unobservable_failures: unobservable.length },
    );
  }

  return result(
    'runtime_observability',
    'pass',
    'all failing tool calls are observable',
    context.jsonl ? [context.jsonl.path] : [],
    undefined,
    { failed_tool_calls: context.metrics.failed_tool_calls },
  );
}

function verifyArtifactEvidence(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  const required = context.caseSpec.required_artifacts ?? [];
  const minRequiredArtifacts = asNumber(config.min_required_artifacts);
  const requireManifestEvidence = config.require_manifest_evidence === true;
  const requiredMetadataKeys = stringList(config.required_metadata_keys ?? config.required_manifest_metadata_keys);
  if (required.length === 0) {
    if (minRequiredArtifacts !== undefined && required.length < minRequiredArtifacts) {
      return result('artifact_evidence', 'fail', `case declares ${required.length} required artifacts, expected at least ${minRequiredArtifacts}`, [], 'state_evidence', {
        required_artifacts: required.length,
        min_required_artifacts: minRequiredArtifacts,
      });
    }
    return result('artifact_evidence', 'pass', 'case has no required artifacts', [], undefined, {
      required_artifacts: 0,
    });
  }

  const contractFailures: string[] = [];
  if (minRequiredArtifacts !== undefined && required.length < minRequiredArtifacts) {
    contractFailures.push(`expected at least ${minRequiredArtifacts} required artifacts, got ${required.length}`);
  }
  for (const artifact of required) {
    if (requireManifestEvidence && artifact.evidence !== 'manifest') {
      contractFailures.push(`${artifact.path} must use manifest evidence`);
    }
    for (const metadataKey of requiredMetadataKeys) {
      if (!artifact.metadata || !(metadataKey in artifact.metadata)) {
        contractFailures.push(`${artifact.path} must require metadata.${metadataKey}`);
      }
    }
  }

  const missing = required.filter(item => !hasArtifactEvidence(context, item));
  if (contractFailures.length > 0 || missing.length > 0) {
    const messageParts = [
      ...contractFailures,
      ...(missing.length > 0 ? [`${missing.length} required artifacts missing evidence`] : []),
    ];
    return result(
      'artifact_evidence',
      'fail',
      messageParts.join('; '),
      missing.map(item => item.path),
      'state_evidence',
      {
        required_artifacts: required.length,
        contract_failures: contractFailures.length,
        missing_artifacts: missing.length,
      },
    );
  }

  return result('artifact_evidence', 'pass', `all ${required.length} required artifacts have evidence`, required.map(item => item.path), undefined, {
    required_artifacts: required.length,
  });
}

function verifyProviderNetworkReadinessContract(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  const scorecardPath = typeof config.scorecard_path === 'string' ? config.scorecard_path : 'scorecard.json';
  const scorecardFile = findArtifactFile(context, scorecardPath);
  if (!scorecardFile) {
    return result(
      'provider_network_readiness_contract',
      'blocked',
      `provider-network readiness scorecard not found: ${scorecardPath}`,
      [],
      'state_evidence',
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(scorecardFile, 'utf-8')) as Record<string, unknown>;
  } catch (error) {
    return result(
      'provider_network_readiness_contract',
      'fail',
      `provider-network readiness scorecard is not parseable JSON: ${error instanceof Error ? error.message : String(error)}`,
      [scorecardFile],
      'state_evidence',
    );
  }

  const failures: string[] = [];
  const summary = asRecord(parsed.summary);
  const environment = asRecord(parsed.environment);
  const evidence = asRecord(parsed.evidence);
  const checks = Array.isArray(parsed.checks)
    ? parsed.checks.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  const allowedDecisions = stringList(config.allowed_decisions);
  const decision = asString(summary?.decision);
  const checksPassed = asNumber(summary?.checks_passed);
  const checksFailed = asNumber(summary?.checks_failed);
  const checksBlocked = asNumber(summary?.checks_blocked);
  const checksTotal = asNumber(summary?.checks_total);
  const actualPassed = checks.filter(item => item.status === 'pass').length;
  const actualFailed = checks.filter(item => item.status === 'fail').length;
  const actualBlocked = checks.filter(item => item.status === 'blocked').length;
  const replayEnabled = asBoolean(summary?.replay_enabled);
  const degradationVerified = asBoolean(summary?.degradation_verified);
  const optInCheck = checks.find(item => item.id === 'provider_network.opt_in');
  const providerErrorCheck = checks.find(item => item.id === 'provider_network.provider_error');
  const degradedTranscriptCheck = checks.find(item => item.id === 'provider_network.degraded_provider_transcript');

  if (parsed.provider_network_readiness_version !== '0.1') {
    failures.push('version must be 0.1');
  }
  if (!summary) failures.push('summary is required');
  if (!environment) failures.push('environment is required');
  if (!evidence) failures.push('evidence is required');
  if (!Array.isArray(parsed.checks)) failures.push('checks must be an array');
  if (allowedDecisions.length > 0 && !allowedDecisions.includes(decision)) {
    failures.push(`decision ${decision || 'missing'} is not allowed`);
  }
  if (checksTotal !== checks.length) failures.push('checks_total must equal checks array length');
  if (checksPassed !== actualPassed) failures.push('checks_passed must equal pass checks');
  if (checksFailed !== actualFailed) failures.push('checks_failed must equal fail checks');
  if (checksBlocked !== actualBlocked) failures.push('checks_blocked must equal blocked checks');

  const expectedDecision = actualFailed > 0
    ? 'fail'
    : actualBlocked > 0
      ? 'blocked'
      : 'pass';
  if (decision !== expectedDecision) {
    failures.push(`decision must be ${expectedDecision} for the observed checks`);
  }

  const optInPassed = optInCheck?.status === 'pass';
  if (replayEnabled !== optInPassed) {
    failures.push('replay_enabled must match provider_network.opt_in pass status');
  }
  const degradedTranscriptPassed = degradedTranscriptCheck?.status === 'pass';
  if (degradationVerified !== degradedTranscriptPassed) {
    failures.push('degradation_verified must match degraded provider transcript evidence');
  }

  for (const key of ['model_configured', 'api_base_configured', 'api_key_configured', 'use_default_config']) {
    if (typeof environment?.[key] !== 'boolean') {
      failures.push(`environment.${key} must be boolean`);
    }
  }
  if (environment?.expected_degradation !== true) {
    failures.push('environment.expected_degradation must be true');
  }
  const timeoutMs = asNumber(environment?.timeout_ms);
  if (timeoutMs === undefined || timeoutMs <= 0) {
    failures.push('environment.timeout_ms must be positive');
  }
  const provider = asString(environment?.provider);
  if (provider && !['openai', 'anthropic', 'ollama'].includes(provider)) {
    failures.push(`environment.provider ${provider} is invalid`);
  }

  const requiredCheckIds = stringList(config.required_check_ids);
  const checkIds = checks.map(item => asString(item.id)).filter(Boolean);
  for (const expected of requiredCheckIds) {
    if (!checkIds.includes(expected)) {
      failures.push(`missing check id: ${expected}`);
    }
  }
  for (const check of checks) {
    const id = asString(check.id);
    const status = asString(check.status);
    const severity = asString(check.severity);
    const message = asString(check.message);
    if (!id) failures.push('check.id is required');
    if (!['pass', 'fail', 'blocked'].includes(status)) failures.push(`check ${id || 'unknown'} has invalid status`);
    if (!['environment', 'configuration', 'execution', 'evidence'].includes(severity)) failures.push(`check ${id || 'unknown'} has invalid severity`);
    if (!message.trim()) failures.push(`check ${id || 'unknown'} must have a message`);
    const evidenceRef = asString(check.evidence_ref);
    if (evidenceRef && isUnsafeEvidenceReference(evidenceRef)) {
      failures.push(`check ${id || 'unknown'} evidence_ref must be repo-relative or placeholder-redacted`);
    }
  }

  for (const key of ['out_dir', 'workspace_dir', 'manifest_path', 'scorecard_path', 'report_path']) {
    const value = asString(evidence?.[key]);
    if (!value.trim()) {
      failures.push(`evidence.${key} is required`);
    } else if (isUnsafeEvidenceReference(value)) {
      failures.push(`evidence.${key} must be repo-relative or placeholder-redacted`);
    }
  }

  const sessionLogPath = asString(evidence?.session_log_path);
  if (sessionLogPath && isUnsafeEvidenceReference(sessionLogPath)) {
    failures.push('evidence.session_log_path must be repo-relative or placeholder-redacted');
  }

  if (config.require_blocked_default === true) {
    if (decision !== 'blocked') failures.push('blocked-default sample must have blocked decision');
    if (replayEnabled !== false) failures.push('blocked-default sample must keep replay_enabled=false');
    if (degradationVerified !== false) failures.push('blocked-default sample must keep degradation_verified=false');
    if (optInCheck?.status !== 'blocked') failures.push('blocked-default sample must include blocked provider_network.opt_in');
  }

  if (config.require_degradation_verified === true) {
    if (decision !== 'pass') failures.push('degradation sample must have pass decision');
    if (replayEnabled !== true) failures.push('degradation sample must keep replay_enabled=true');
    if (degradationVerified !== true) failures.push('degradation sample must keep degradation_verified=true');
    if (providerErrorCheck?.status !== 'pass') failures.push('degradation sample must include pass provider_network.provider_error');
    if (degradedTranscriptCheck?.status !== 'pass') failures.push('degradation sample must include pass provider_network.degraded_provider_transcript');
  }

  const sessionLogFile = sessionLogPath ? findArtifactFile(context, sessionLogPath) : undefined;
  if (config.require_session_log_evidence === true) {
    if (!sessionLogPath) {
      failures.push('session_log_path is required');
    } else if (!sessionLogFile) {
      failures.push(`session log evidence file not found: ${sessionLogPath}`);
    } else {
      const sessionFailures = validateProviderNetworkReadinessSessionLog(sessionLogFile);
      failures.push(...sessionFailures);
    }
  }

  if (failures.length > 0) {
    return result(
      'provider_network_readiness_contract',
      'fail',
      failures.slice(0, 10).join('; '),
      [scorecardFile, ...(sessionLogFile ? [sessionLogFile] : [])],
      'state_evidence',
      {
        contract_failures: failures.length,
        checks_total: checks.length,
        replay_enabled: replayEnabled === true,
        degradation_verified: degradationVerified === true,
      },
    );
  }

  return result(
    'provider_network_readiness_contract',
    'pass',
    `provider-network readiness scorecard is structured and decision-consistent (${decision})`,
    [scorecardFile, ...(sessionLogFile ? [sessionLogFile] : [])],
    undefined,
    {
      checks_total: checks.length,
      replay_enabled: replayEnabled === true,
      degradation_verified: degradationVerified === true,
    },
  );
}

function validateProviderNetworkReadinessSessionLog(sessionLogFile: string): string[] {
  const failures: string[] = [];
  let entries: Record<string, unknown>[] = [];
  try {
    const lines = fs.readFileSync(sessionLogFile, 'utf-8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    entries = lines.map(line => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    return [`session log is not parseable JSONL: ${error instanceof Error ? error.message : String(error)}`];
  }

  const events = entries.flatMap(entry => Array.isArray(entry.events) ? entry.events as Record<string, unknown>[] : [entry]);
  const providerErrorEvents = events.filter(entry =>
    entry.entry_type === 'runtime_event' && entry.event_type === 'provider_error'
  );
  const degradedTranscripts = entries
    .map(entry => asRecord(asRecord(entry.state_boundary)?.provider_transcript))
    .filter((record): record is Record<string, unknown> => Boolean(record))
    .filter(isProviderNetworkReadinessDegradedTranscript);

  if (providerErrorEvents.length === 0) {
    failures.push('session log must include provider_error runtime_event evidence');
  }
  if (degradedTranscripts.length === 0) {
    failures.push('session log must include structured degraded provider transcript boundary evidence');
  }
  return failures;
}

function isProviderNetworkReadinessDegradedTranscript(record: Record<string, unknown>): boolean {
  const fallbackChain = Array.isArray(record.fallback_chain) ? record.fallback_chain : [];
  return /^(provider-transcripts\/)?sha256:[a-f0-9]{16,64}$/i.test(asString(record.ref))
    && (record.status === 'degraded' || record.status === 'blocked')
    && record.degraded === true
    && Boolean(asString(record.degradation_reason) || asString(record.error_code))
    && fallbackChain.filter(item => typeof item === 'string' && item.trim()).length >= 2
    && Boolean(asString(record.blocked_reason))
    && record.raw_messages_stored === false
    && record.tool_result_payload_stored === false
    && record.raw_request_stored === false
    && record.raw_response_stored === false
    && record.raw_payload_stored === false;
}

function verifyDeliveryEvidenceContract(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  const minDeliveryEvidence = asNumber(config.min_delivery_evidence) ?? 1;
  const requireDeliveryTools = config.require_delivery_tools !== false;
  const requireFileManifest = config.require_file_manifest !== false;
  const requireRuntimeFileArtifact = config.require_file_artifact === true || config.require_file_artifacts === true;
  const requireTextPreview = config.require_text_preview !== false;
  const minExternalReceipts = asNumber(config.min_external_receipts ?? config.min_delivery_receipts) ?? 0;
  const requiredExternalReceiptTypes = stringList(config.required_external_receipt_types ?? config.external_receipt_types);
  const requireExternalReceiptIds = config.require_external_receipt_ids !== false;
  const requireExternalPlatformIds = config.require_external_platform_ids === true;
  const requireExternalReceiptEvidence = config.require_external_receipt_evidence_refs === true;

  const deliveryCalls = context.toolCalls.filter(call => call.name === 'send_text' || call.name === 'send_file');
  const toolDeliveryEvidence = context.toolCalls.flatMap(call => call.deliveryEvidence.map(item => ({ call, item })));
  const runtimeDeliveryEvidence = collectSurfaceRuntimeDeliveryEvidence(context);
  const toolExternalReceipts = context.toolCalls.flatMap(call => call.externalReceipts.map(item => ({
    source: `${call.name}:${call.id || 'unknown'}`,
    item,
  })));
  const runtimeExternalReceipts = collectSurfaceRuntimeExternalReceipts(context).map(({ surface, runtimeId, item }) => ({
    source: `surface_runtime:${surface}:${runtimeId}`,
    item,
  }));
  const deliveryEvidence: Array<{ source: string; toolName?: string; item: DeliveryEvidenceItem }> = [
    ...toolDeliveryEvidence.map(({ call, item }) => ({
      source: `${call.name}:${call.id || 'unknown'}`,
      toolName: call.name,
      item,
    })),
    ...runtimeDeliveryEvidence.map(({ surface, runtimeId, item }) => ({
      source: `surface_runtime:${surface}:${runtimeId}`,
      item,
    })),
  ];
  const externalReceipts = [...toolExternalReceipts, ...runtimeExternalReceipts];
  const failures: string[] = [];

  if (deliveryEvidence.length < minDeliveryEvidence) {
    failures.push(`delivery evidence ${deliveryEvidence.length} < ${minDeliveryEvidence}`);
  }

  for (const call of deliveryCalls) {
    if (!requireDeliveryTools || !isSuccessfulToolCall(call)) continue;
    if (call.deliveryEvidence.length === 0) {
      failures.push(`${call.name}:${call.id || 'unknown'} lacks delivery_evidence`);
    }
  }

  for (const { source, toolName, item } of deliveryEvidence) {
    if (item.deliveryType !== 'text' && item.deliveryType !== 'file') {
      failures.push(`${source} has invalid delivery_type`);
    }
    if (item.status !== 'delivered' && item.status !== 'failed' && item.status !== 'blocked') {
      failures.push(`${source} has invalid delivery status`);
    }
    if (!item.timestamp) {
      failures.push(`${source} lacks delivery timestamp`);
    }
    if (toolName === 'send_text' && item.deliveryType !== 'text') {
      failures.push(`${source} delivery evidence is not text`);
    }
    if (toolName === 'send_file' && item.deliveryType !== 'file') {
      failures.push(`${source} delivery evidence is not file`);
    }
    if (item.deliveryType === 'text' && item.status === 'delivered' && requireTextPreview && !item.textPreview) {
      failures.push(`${source} delivered text lacks text_preview`);
    }
    if (item.deliveryType === 'file' && item.status === 'delivered' && !item.fileName && !item.filePath) {
      failures.push(`${source} delivered file lacks file_name/file_path`);
    }
  }

  if (requireFileManifest) {
    const deliveredFileCallsWithoutManifest = deliveryCalls.filter(call => (
      call.name === 'send_file'
      && call.deliveryEvidence.some(item => item.deliveryType === 'file' && item.status === 'delivered')
      && !call.artifactManifest.some(item => item.action === 'sent')
    ));
    if (deliveredFileCallsWithoutManifest.length > 0) {
      failures.push(`${deliveredFileCallsWithoutManifest.length} delivered file call(s) lack sent artifact_manifest`);
    }
  }
  if (requireRuntimeFileArtifact) {
    const deliveredRuntimeFilesWithoutArtifact = runtimeDeliveryEvidence.filter(({ item, fileArtifactPaths }) => (
      item.deliveryType === 'file'
      && item.status === 'delivered'
      && !fileArtifactPaths.some(filePath =>
        surfaceRuntimePathOrNameMatches(filePath, item.fileName ?? item.filePath ?? '')
        && surfaceRuntimeArtifactExists(context, filePath)
      )
    ));
    if (deliveredRuntimeFilesWithoutArtifact.length > 0) {
      failures.push(`${deliveredRuntimeFilesWithoutArtifact.length} delivered runtime file evidence record(s) lack file artifact`);
    }
  }

  if (externalReceipts.length < minExternalReceipts) {
    failures.push(`external receipts ${externalReceipts.length} < ${minExternalReceipts}`);
  }

  const missingExternalReceiptTypes = requiredExternalReceiptTypes.filter(expected =>
    !externalReceipts.some(({ item }) => item.receiptType === expected)
  );
  if (missingExternalReceiptTypes.length > 0) {
    failures.push(`missing external receipt types: ${missingExternalReceiptTypes.join(', ')}`);
  }

  const invalidExternalReceipts = externalReceipts.filter(({ item }) => {
    if (requireExternalReceiptIds && !item.receiptId) return true;
    if (!surfaceExternalReceiptStatusPassed(item.status)) return true;
    if (!item.timestamp) return true;
    if (requireExternalPlatformIds && !surfaceExternalReceiptHasPlatformId(item)) return true;
    return requireExternalReceiptEvidence && item.evidenceRefs.length === 0;
  });
  if (invalidExternalReceipts.length > 0) {
    failures.push(`${invalidExternalReceipts.length} external receipt(s) lack required id/status/timestamp/platform/evidence refs`);
  }

  if (failures.length > 0) {
    return result('delivery_evidence_contract', 'fail', failures.join('; '), context.jsonl ? [context.jsonl.path] : [], 'state_evidence', {
      delivery_tools: deliveryCalls.length,
      delivery_evidence: deliveryEvidence.length,
      runtime_delivery_evidence: runtimeDeliveryEvidence.length,
      external_receipts: externalReceipts.length,
      runtime_external_receipts: runtimeExternalReceipts.length,
      failures: failures.length,
    });
  }

  return result('delivery_evidence_contract', 'pass', `observed ${deliveryEvidence.length} structured delivery evidence record(s)`, context.jsonl ? [context.jsonl.path] : [], undefined, {
    delivery_tools: deliveryCalls.length,
    delivery_evidence: deliveryEvidence.length,
    runtime_delivery_evidence: runtimeDeliveryEvidence.length,
    external_receipts: externalReceipts.length,
    runtime_external_receipts: runtimeExternalReceipts.length,
  });
}

function verifyChannelDelivery(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  const requiredTexts = stringList(config.required_texts ?? config.texts);
  const requiredFiles = stringList(config.required_files ?? config.files);
  const minDeliveries = asNumber(config.min_deliveries) ?? 1;
  const minTextDeliveries = asNumber(config.min_text_deliveries) ?? 0;
  const minFileDeliveries = asNumber(config.min_file_deliveries) ?? 0;
  const requireFileManifest = config.require_file_manifest !== false;

  const textCalls = context.toolCalls.filter(call => call.name === 'send_text' && isSuccessfulToolCall(call));
  const fileCalls = context.toolCalls.filter(call => call.name === 'send_file' && isSuccessfulToolCall(call));
  const deliveryCalls = [...textCalls, ...fileCalls];

  const failures: string[] = [];
  if (deliveryCalls.length < minDeliveries) failures.push(`deliveries ${deliveryCalls.length} < ${minDeliveries}`);
  if (textCalls.length < minTextDeliveries) failures.push(`text deliveries ${textCalls.length} < ${minTextDeliveries}`);
  if (fileCalls.length < minFileDeliveries) failures.push(`file deliveries ${fileCalls.length} < ${minFileDeliveries}`);

  const missingTexts = requiredTexts.filter(expected => !textCalls.some(call => deliveryCallContains(call, expected)));
  const missingFiles = requiredFiles.filter(expected => !fileCalls.some(call => fileDeliveryMatches(call, expected)));
  if (missingTexts.length > 0) failures.push(`missing delivered text: ${missingTexts.join(', ')}`);
  if (missingFiles.length > 0) failures.push(`missing delivered files: ${missingFiles.join(', ')}`);

  const fileCallsWithoutManifest = requireFileManifest
    ? fileCalls.filter(call => call.artifactManifest.length === 0)
    : [];
  if (fileCallsWithoutManifest.length > 0) {
    failures.push(`${fileCallsWithoutManifest.length} file deliveries lack artifact manifest`);
  }

  if (failures.length > 0) {
    return result('channel_delivery', 'fail', failures.join('; '), context.jsonl ? [context.jsonl.path] : [], 'surface', {
      deliveries: deliveryCalls.length,
      text_deliveries: textCalls.length,
      file_deliveries: fileCalls.length,
      missing_texts: missingTexts.length,
      missing_files: missingFiles.length,
      file_deliveries_without_manifest: fileCallsWithoutManifest.length,
    });
  }

  return result('channel_delivery', 'pass', `observed ${deliveryCalls.length} channel deliveries`, context.jsonl ? [context.jsonl.path] : [], undefined, {
    deliveries: deliveryCalls.length,
    text_deliveries: textCalls.length,
    file_deliveries: fileCalls.length,
    required_texts: requiredTexts.length,
    required_files: requiredFiles.length,
  });
}

function verifySurfaceRuntimeE2e(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  if (!context.jsonl) {
    return result('surface_runtime_e2e', 'blocked', 'case has no JSONL input', [], context.caseSpec.failure_route);
  }

  const runtimes = collectSurfaceRuntimeEntries(context);
  const runtime = runtimes[0];
  if (!runtime) {
    return result('surface_runtime_e2e', 'fail', 'missing surface_runtime evidence', [context.jsonl.path], 'surface');
  }

  const expectedSurface = asString(config.expected_surface ?? config.surface);
  const expectedRuntimeId = asString(config.expected_runtime_id ?? config.runtime_id);
  const expectedStatusCode = asNumber(config.expected_status_code ?? config.status_code) ?? 200;
  const expectedSessionKey = asString(config.expected_session_key ?? config.session_key);
  const expectedChannelId = asString(config.expected_channel_id ?? config.channel_id);
  const minVisibleDeliveries = asNumber(config.min_visible_deliveries ?? config.min_deliveries) ?? 1;
  const minFileDeliveries = asNumber(config.min_file_deliveries ?? config.min_files) ?? 0;
  const requiredFiles = stringList(config.required_files ?? config.required_file_names);
  const requireFileArtifacts = config.require_file_artifacts === true;
  const requiredEventTypes = stringList(config.required_event_types ?? config.event_types);
  const messageContains = stringList(config.user_message_contains ?? config.expected_user_message_contains);
  const requireRequestArtifact = config.require_request_artifact !== false;
  const requireResponseArtifact = config.require_response_artifact !== false;

  const failures: string[] = [];
  if (expectedSurface && runtime.surface !== expectedSurface) failures.push(`surface ${runtime.surface} != ${expectedSurface}`);
  if (expectedRuntimeId && runtime.runtimeId !== expectedRuntimeId) failures.push(`runtime_id ${runtime.runtimeId} != ${expectedRuntimeId}`);
  if (runtime.statusCode !== expectedStatusCode) failures.push(`status_code ${runtime.statusCode} != ${expectedStatusCode}`);
  if (expectedSessionKey && runtime.sessionKey !== expectedSessionKey) failures.push(`session_key ${runtime.sessionKey} != ${expectedSessionKey}`);
  if (expectedChannelId && runtime.channelId !== expectedChannelId) failures.push(`channel_id ${runtime.channelId} != ${expectedChannelId}`);
  if (runtime.visibleDeliveryCount < minVisibleDeliveries) {
    failures.push(`visible deliveries ${runtime.visibleDeliveryCount} < ${minVisibleDeliveries}`);
  }
  if (runtime.fileDeliveryCount < minFileDeliveries) {
    failures.push(`file deliveries ${runtime.fileDeliveryCount} < ${minFileDeliveries}`);
  }

  const missingEventTypes = requiredEventTypes.filter(eventType => !runtime.eventTypes.includes(eventType));
  if (missingEventTypes.length > 0) failures.push(`missing event types: ${missingEventTypes.join(', ')}`);

  const missingText = messageContains.filter(expected => !runtime.userMessage.includes(expected));
  if (missingText.length > 0) failures.push(`user_message missing text: ${missingText.join(', ')}`);

  const missingFiles = requiredFiles.filter(expected => !surfaceRuntimeFileMatches(runtime, expected));
  if (missingFiles.length > 0) failures.push(`missing files: ${missingFiles.join(', ')}`);

  if (requireFileArtifacts) {
    const missingArtifacts = requiredFiles.filter(expected =>
      !runtime.fileArtifactPaths.some(filePath =>
        surfaceRuntimePathOrNameMatches(filePath, expected) && surfaceRuntimeArtifactExists(context, filePath)
      )
    );
    if (missingArtifacts.length > 0) failures.push(`missing file artifacts: ${missingArtifacts.join(', ')}`);
  }

  if (requireRequestArtifact && (!runtime.requestArtifactPath || !surfaceRuntimeArtifactExists(context, runtime.requestArtifactPath))) {
    failures.push('surface runtime request artifact missing');
  }
  if (requireResponseArtifact && (!runtime.responseArtifactPath || !surfaceRuntimeArtifactExists(context, runtime.responseArtifactPath))) {
    failures.push('surface runtime response artifact missing');
  }

  if (failures.length > 0) {
    return result('surface_runtime_e2e', 'fail', failures.join('; '), [context.jsonl.path], 'surface', {
      surface: runtime.surface,
      runtime_id: runtime.runtimeId,
      failures: failures.length,
      visible_delivery_count: runtime.visibleDeliveryCount,
      file_delivery_count: runtime.fileDeliveryCount,
    });
  }

  return result('surface_runtime_e2e', 'pass', `${runtime.runtimeId} delivered ${runtime.visibleDeliveryCount} visible events`, [context.jsonl.path], undefined, {
    surface: runtime.surface,
    runtime_id: runtime.runtimeId,
    visible_delivery_count: runtime.visibleDeliveryCount,
    file_delivery_count: runtime.fileDeliveryCount,
    event_types: runtime.eventTypes.join(','),
  });
}

function verifyBoundedRetry(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  const maxRepeatedFailures = asNumber(config.max_repeated_failures) ?? 2;
  const failures = context.toolCalls.filter(call => FAILURE_STATUSES.has(call.status));
  const repeated = new Map<string, number>();
  for (const call of failures) {
    const key = `${call.name}:${call.argumentsText}`;
    repeated.set(key, (repeated.get(key) ?? 0) + 1);
  }

  const maxAttempts = maxRepeatedFailures + 1;
  const overBudget = [...repeated.entries()].filter(([, count]) => count > maxAttempts);
  const hasBlockedEvidence = context.toolCalls.some(call => call.status === 'blocked' || call.retryBudgetExhausted === true);
  if (overBudget.length > 0) {
    return result('bounded_retry', 'fail', `repeated failures exceed budget: ${overBudget.map(([key, count]) => `${key}=${count}`).join(', ')}`, context.jsonl ? [context.jsonl.path] : [], 'runtime', {
      repeated_failures: overBudget.length,
      max_repeated_failures: maxRepeatedFailures,
      max_attempts: maxAttempts,
    });
  }

  return result('bounded_retry', 'pass', hasBlockedEvidence ? 'bounded retry ended in blocked evidence' : 'tool retry attempts stayed within budget', context.jsonl ? [context.jsonl.path] : [], undefined, {
    failures: failures.length,
    max_repeated_failures: maxRepeatedFailures,
    max_attempts: maxAttempts,
    blocked_evidence: hasBlockedEvidence ? 1 : 0,
  });
}

function verifyBudgetCheck(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  const maxTurns = asNumber(config.max_turns) ?? context.caseSpec.budgets?.max_turns;
  const maxToolCalls = asNumber(config.max_tool_calls) ?? context.caseSpec.budgets?.max_tool_calls;
  const maxTokens = asNumber(config.max_tokens) ?? context.caseSpec.budgets?.max_tokens;
  const failures = [
    ...(maxTurns !== undefined && context.metrics.turns > maxTurns ? [`turns ${context.metrics.turns} > ${maxTurns}`] : []),
    ...(maxToolCalls !== undefined && context.metrics.tool_calls > maxToolCalls ? [`tool calls ${context.metrics.tool_calls} > ${maxToolCalls}`] : []),
    ...(maxTokens !== undefined && context.metrics.total_tokens > maxTokens ? [`tokens ${context.metrics.total_tokens} > ${maxTokens}`] : []),
  ];

  if (failures.length > 0) {
    return result('budget_check', 'fail', failures.join('; '), context.jsonl ? [context.jsonl.path] : [], context.caseSpec.failure_route ?? 'runtime', {
      turns: context.metrics.turns,
      tool_calls: context.metrics.tool_calls,
      tokens_total: context.metrics.total_tokens,
    });
  }

  return result('budget_check', 'pass', 'case stayed within configured budget', context.jsonl ? [context.jsonl.path] : [], undefined, {
    turns: context.metrics.turns,
    tool_calls: context.metrics.tool_calls,
    tokens_total: context.metrics.total_tokens,
  });
}

function verifyAssistantTextContains(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  const requiredTexts = stringList(config.required_texts ?? config.texts ?? config.terms);
  const forbiddenTexts = stringList(config.forbidden_texts ?? config.must_not_include);
  const caseSensitive = config.case_sensitive === true;
  const assistantText = collectUserVisibleText(context, config.include_delivery_tools === true);
  const missingRequired = requiredTexts.filter(item => !includesText(assistantText, item, caseSensitive));
  const forbiddenHits = forbiddenTexts.filter(item => includesText(assistantText, item, caseSensitive));
  const failures = [
    ...(missingRequired.length > 0 ? [`missing required text: ${missingRequired.join(', ')}`] : []),
    ...(forbiddenHits.length > 0 ? [`forbidden text: ${forbiddenHits.join(', ')}`] : []),
  ];

  if (failures.length > 0) {
    return result('assistant_text_contains', 'fail', failures.join('; '), context.jsonl ? [context.jsonl.path] : [], context.caseSpec.failure_route, {
      missing_required: missingRequired.length,
      forbidden_hits: forbiddenHits.length,
    });
  }

  return result('assistant_text_contains', 'pass', `assistant text satisfied ${requiredTexts.length} required text check(s)`, context.jsonl ? [context.jsonl.path] : [], undefined, {
    required_texts: requiredTexts.length,
    forbidden_texts: forbiddenTexts.length,
  });
}

function verifyToolSequence(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  const expectedNames = stringList(config.names ?? config.tool_names ?? config.sequence);
  const actualNames = context.toolCalls.map(call => call.name);
  const exact = config.exact === true || config.require_exact === true;
  const matched = exact
    ? actualNames.length === expectedNames.length && actualNames.every((name, index) => name === expectedNames[index])
    : containsSubsequence(actualNames, expectedNames);

  if (!matched) {
    return result('tool_sequence', 'fail', `expected tool sequence ${expectedNames.join(' -> ')}; observed ${actualNames.join(' -> ') || '[none]'}`, context.jsonl ? [context.jsonl.path] : [], context.caseSpec.failure_route ?? 'tool', {
      expected_tools: expectedNames.length,
      observed_tools: actualNames.length,
    });
  }

  return result('tool_sequence', 'pass', `observed tool sequence ${expectedNames.join(' -> ') || '[empty]'}`, context.jsonl ? [context.jsonl.path] : [], undefined, {
    expected_tools: expectedNames.length,
    observed_tools: actualNames.length,
  });
}

function verifyRoleBoundary(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  if (!context.jsonl) {
    return result('role_boundary', 'blocked', 'case has no JSONL input', [], context.caseSpec.failure_route ?? 'role');
  }

  const expectedRole = asString(config.expected_role ?? config.role);
  const requiredTexts = stringList(config.required_texts ?? config.texts);
  const forbiddenTexts = stringList(config.forbidden_texts ?? config.must_not_include);
  const allowedTools = new Set(stringList(config.allowed_tools));
  const assistantText = collectAssistantText(context);
  const observedRoles = new Set(context.jsonl.entries.flatMap(entry => [
    asString(entry.role_id),
    asString(asRecord(entry.assistant)?.role_id),
    asString(asRecord(entry.runtime_event)?.role_id),
  ].filter(Boolean)));
  const missingRole = expectedRole && !observedRoles.has(expectedRole) && !includesText(assistantText, expectedRole, false);
  const missingTexts = requiredTexts.filter(item => !includesText(assistantText, item, false));
  const forbiddenHits = forbiddenTexts.filter(item => includesForbiddenText(assistantText, item, false));
  const disallowedTools = allowedTools.size > 0
    ? context.toolCalls.map(call => call.name).filter(name => !allowedTools.has(name))
    : [];
  const failures = [
    ...(missingRole ? [`expected role not observed: ${expectedRole}`] : []),
    ...(missingTexts.length > 0 ? [`missing required text: ${missingTexts.join(', ')}`] : []),
    ...(forbiddenHits.length > 0 ? [`forbidden text: ${forbiddenHits.join(', ')}`] : []),
    ...(disallowedTools.length > 0 ? [`disallowed tools: ${[...new Set(disallowedTools)].join(', ')}`] : []),
  ];

  if (failures.length > 0) {
    return result('role_boundary', 'fail', failures.join('; '), [context.jsonl.path], 'role', {
      observed_roles: observedRoles.size,
      missing_texts: missingTexts.length,
      forbidden_hits: forbiddenHits.length,
      disallowed_tools: disallowedTools.length,
    });
  }

  return result('role_boundary', 'pass', expectedRole ? `role boundary held for ${expectedRole}` : 'role boundary held', [context.jsonl.path], undefined, {
    observed_roles: observedRoles.size,
    allowed_tools: allowedTools.size,
  });
}

function verifyUserTraceCandidate(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  if (!context.jsonl) {
    return result('user_trace_candidate', 'blocked', 'case has no UserCat trace JSONL input', [], context.caseSpec.failure_route ?? 'role');
  }

  const requiredFiles = stringList(config.required_files);
  const expectedFiles = requiredFiles.length > 0 ? requiredFiles : [
    'seed.json',
    'role-intent-map.json',
    'persona.json',
    'scenario-plan.json',
    'candidate-case.json',
    'trace-quality-self-check.json',
    'manifest.json',
    'dialogue-summary.md',
  ];
  const missingFiles = expectedFiles.filter(fileName => !findArtifactFile(context, fileName));
  const candidate = readJsonArtifactRecord(context, 'candidate-case.json');
  const selfCheck = readJsonArtifactRecord(context, 'trace-quality-self-check.json');
  const seed = readJsonArtifactRecord(context, 'seed.json');
  const roleIntent = readJsonArtifactRecord(context, 'role-intent-map.json');
  const scenarioPlan = readJsonArtifactRecord(context, 'scenario-plan.json');
  const manifest = readJsonArtifactRecord(context, 'manifest.json');

  const evidenceRefs = [
    context.jsonl.path,
    ...[candidate, selfCheck, seed, roleIntent, scenarioPlan, manifest]
      .map(item => item.path)
      .filter((item): item is string => Boolean(item)),
  ];

  const parseFailures = [candidate, selfCheck, seed, roleIntent, scenarioPlan, manifest]
    .filter(item => item.error)
    .map(item => item.error as string);
  const failures = [
    ...(missingFiles.length > 0 ? [`missing package files: ${missingFiles.join(', ')}`] : []),
    ...parseFailures,
  ];

  const candidateCase = candidate.record;
  const selfCheckRecord = selfCheck.record;
  const seedRecord = seed.record;
  const roleIntentRecord = roleIntent.record;
  const scenarioRecord = scenarioPlan.record;
  const manifestRecord = manifest.record;

  if (candidateCase && selfCheckRecord && seedRecord && roleIntentRecord && scenarioRecord && manifestRecord) {
    const expectedTargetRole = asString(config.expected_target_role);
    const allowedTargetRoles = stringList(config.allowed_target_roles);
    const minTurns = asNumber(config.min_turns) ?? 3;
    const candidateTargetRole = asString(candidateCase.target_role);
    const seedTargetRole = asString(seedRecord.target_role);
    const intentTargetRole = asString(roleIntentRecord.target_role);
    const manifestTargetRole = asString(manifestRecord.target_role);
    const candidateTurnCount = asNumber(candidateCase.turn_count) ?? 0;
    const manifestTurnCount = asNumber(manifestRecord.turn_count) ?? 0;
    const userTurnCount = context.jsonl.entries.filter(entry => asString(entry.type) === 'user_turn').length;
    const assistantTurnCount = context.jsonl.entries.filter(entry => asString(entry.type) === 'assistant_turn').length;
    const runStart = context.jsonl.entries.some(entry => asString(entry.type) === 'run_start');
    const runComplete = context.jsonl.entries.some(entry => asString(entry.type) === 'run_complete');
    const traceTargetRoles = new Set(context.jsonl.entries.map(entry => asString(entry.target_role)).filter(Boolean));
    const userTexts = context.jsonl.entries
      .filter(entry => asString(entry.type) === 'user_turn')
      .map(entry => asString(entry.text));
    const evidencePressure = userTexts.some(hasEvidencePressureText);
    const changedOrBoundaryPressure = userTexts.some(hasChangedOrBoundaryPressureText);
    const roleIntentArrays = [
      sanitizeRecordStringList(roleIntentRecord.role_exists_to),
      sanitizeRecordStringList(roleIntentRecord.must_demonstrate),
      sanitizeRecordStringList(roleIntentRecord.conversation_pressures),
    ];
    const turnPlan = sanitizeRecordStringList(scenarioRecord.turn_plan);
    const replayReadiness = asString(candidateCase.replay_readiness);
    const allowedReplayReadiness = stringList(config.allowed_replay_readiness);
    const replayReadinessSet = new Set(allowedReplayReadiness.length > 0
      ? allowedReplayReadiness
      : ['needs_fixture', 'needs_verifier', 'human_review', 'not_ready', 'blocked']);
    const forbiddenReplayReadiness = new Set([
      'accepted',
      'pass',
      'fail',
      'release_blocking',
      ...stringList(config.forbidden_replay_readiness),
    ]);
    const recommendedOwner = asString(candidateCase.recommended_next_owner);
    const ownerSet = new Set(['benchmark-maintainer', 'inspector-cat', 'discard']);
    const tracePathValue = asString(candidateCase.trace_path);
    const manifestTracePath = asString(manifestRecord.trace_path);
    const curationStatus = asString(candidateCase.curation_status).toLowerCase();
    const benchmarkAcceptance = asString(candidateCase.benchmark_acceptance).toLowerCase();

    failures.push(
      ...(expectedTargetRole && candidateTargetRole !== expectedTargetRole ? [`candidate target_role ${candidateTargetRole || '[missing]'} != ${expectedTargetRole}`] : []),
      ...(allowedTargetRoles.length > 0 && !allowedTargetRoles.includes(candidateTargetRole) ? [`target_role ${candidateTargetRole || '[missing]'} not in allowed target roles`] : []),
      ...(candidateTargetRole === 'user-cat' ? ['UserCat candidate cannot target UserCat itself'] : []),
      ...(seedTargetRole !== candidateTargetRole ? [`seed target_role ${seedTargetRole || '[missing]'} != candidate target_role ${candidateTargetRole || '[missing]'}`] : []),
      ...(intentTargetRole !== candidateTargetRole ? [`role intent target_role ${intentTargetRole || '[missing]'} != candidate target_role ${candidateTargetRole || '[missing]'}`] : []),
      ...(manifestTargetRole !== candidateTargetRole ? [`manifest target_role ${manifestTargetRole || '[missing]'} != candidate target_role ${candidateTargetRole || '[missing]'}`] : []),
      ...(traceTargetRoles.size > 0 && !traceTargetRoles.has(candidateTargetRole) ? ['trace target_role evidence does not match candidate target_role'] : []),
      ...(userTurnCount < minTurns ? [`user turns ${userTurnCount} < ${minTurns}`] : []),
      ...(assistantTurnCount < minTurns ? [`assistant turns ${assistantTurnCount} < ${minTurns}`] : []),
      ...(candidateTurnCount !== userTurnCount ? [`candidate turn_count ${candidateTurnCount} != user turns ${userTurnCount}`] : []),
      ...(manifestTurnCount !== userTurnCount ? [`manifest turn_count ${manifestTurnCount} != user turns ${userTurnCount}`] : []),
      ...(!runStart ? ['missing run_start event'] : []),
      ...(!runComplete ? ['missing run_complete event'] : []),
      ...(!evidencePressure ? ['missing evidence-pressure user turn'] : []),
      ...(!changedOrBoundaryPressure ? ['missing changed-constraint or boundary-pressure user turn'] : []),
      ...(roleIntentArrays.some(items => items.length === 0) ? ['role intent map lacks required non-empty arrays'] : []),
      ...(turnPlan.length < minTurns ? [`scenario turn_plan ${turnPlan.length} < ${minTurns}`] : []),
      ...(path.isAbsolute(tracePathValue) ? ['candidate trace_path must be workspace-relative'] : []),
      ...(path.isAbsolute(manifestTracePath) ? ['manifest trace_path must be workspace-relative'] : []),
      ...(!replayReadinessSet.has(replayReadiness) ? [`invalid replay_readiness: ${replayReadiness || '[missing]'}`] : []),
      ...(forbiddenReplayReadiness.has(replayReadiness) ? [`forbidden replay_readiness: ${replayReadiness}`] : []),
      ...(curationStatus !== 'not_curated' ? [`curation_status must be not_curated, saw ${curationStatus || '[missing]'}`] : []),
      ...(benchmarkAcceptance !== 'forbidden_until_curated' ? [`benchmark_acceptance must be forbidden_until_curated, saw ${benchmarkAcceptance || '[missing]'}`] : []),
      ...(!ownerSet.has(recommendedOwner) ? [`invalid recommended_next_owner: ${recommendedOwner || '[missing]'}`] : []),
      ...(selfCheckRecord.curation_required !== true ? ['self-check must require curation'] : []),
      ...(selfCheckRecord.benchmark_acceptance !== 'forbidden_until_curated' ? ['self-check must forbid benchmark acceptance until curation'] : []),
      ...(selfCheckRecord.worth_inspector_intake !== true ? ['self-check must mark this smoke candidate worth InspectorCat intake'] : []),
      ...(hasFinalJudgement(candidateCase) ? ['candidate case contains final judgement language'] : []),
      ...(hasFinalJudgement(selfCheckRecord) ? ['self-check contains final judgement language'] : []),
    );
  }

  if (failures.length > 0) {
    return result('user_trace_candidate', 'fail', failures.join('; '), evidenceRefs, context.caseSpec.failure_route ?? 'role', {
      missing_files: missingFiles.length,
      parse_failures: parseFailures.length,
    });
  }

  return result('user_trace_candidate', 'pass', 'UserCat candidate trace package is structurally curatable and keeps benchmark acceptance forbidden', evidenceRefs, undefined, {
    required_files: expectedFiles.length,
    user_turns: context.jsonl.entries.filter(entry => asString(entry.type) === 'user_turn').length,
    assistant_turns: context.jsonl.entries.filter(entry => asString(entry.type) === 'assistant_turn').length,
  });
}

function verifyResearchBoardQuality(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  const projectSlug = asString(config.project_slug);
  const boardPath = asString(config.board_path)
    || (projectSlug ? `data/researcher-cat/boards/${projectSlug}/board.json` : 'board.json');
  const markdownPath = asString(config.markdown_path)
    || (projectSlug ? `output/researcher-cat/boards/${projectSlug}/research-board.md` : 'research-board.md');
  const boardArtifact = readJsonArtifactRecord(context, boardPath);
  const board = boardArtifact.record;
  if (!board) {
    return result(
      'research_board_quality',
      'fail',
      boardArtifact.error || `Research Board missing: ${boardPath}`,
      boardArtifact.path ? [boardArtifact.path] : [boardPath],
      'state_evidence',
      { board_found: false },
    );
  }

  const markdownFile = findArtifactFile(context, markdownPath);
  const markdown = markdownFile ? fs.readFileSync(markdownFile, 'utf-8') : '';
  const claimBoard = objectArray(board.claim_board);
  const evidenceBoard = objectArray(board.evidence_board);
  const experimentQueue = objectArray(board.experiment_queue);
  const artifactBoard = objectArray(board.artifact_board);
  const riskBoard = objectArray(board.risk_board);
  const handoffs = objectArray(board.handoffs);
  const nextActions = objectArray(board.next_actions);
  const runRegistry = objectArray(board.run_registry);
  const failures: string[] = [];
  const caseSensitive = config.case_sensitive === true;

  requireMinCount(failures, 'claim_board', claimBoard.length, asNumber(config.min_claims) ?? 0);
  requireMinCount(failures, 'evidence_board', evidenceBoard.length, asNumber(config.min_evidence) ?? 0);
  requireMinCount(failures, 'experiment_queue', experimentQueue.length, asNumber(config.min_experiments) ?? 0);
  requireMinCount(failures, 'artifact_board', artifactBoard.length, asNumber(config.min_artifacts) ?? 0);
  requireMinCount(failures, 'risk_board', riskBoard.length, asNumber(config.min_risks) ?? 0);
  requireMinCount(failures, 'handoffs', handoffs.length, asNumber(config.min_handoffs) ?? 0);
  requireMinCount(failures, 'next_actions', nextActions.length, asNumber(config.min_next_actions) ?? 0);
  requireMinCount(failures, 'run_registry', runRegistry.length, asNumber(config.min_runs) ?? 0);

  const requiredClaimStatuses = stringList(config.required_claim_statuses);
  const claimStatuses = new Set(claimBoard.map(item => asString(item.status)).filter(Boolean));
  const missingClaimStatuses = requiredClaimStatuses.filter(status => !claimStatuses.has(status));
  if (missingClaimStatuses.length > 0) {
    failures.push(`missing claim statuses: ${missingClaimStatuses.join(', ')}`);
  }

  if (config.require_unsupported_claim === true && !claimBoard.some(item => isUnsupportedClaimStatus(asString(item.status)))) {
    failures.push('missing unsupported/weak/blocked claim evidence');
  }

  if (config.require_supported_claim_evidence !== false) {
    const unsupportedSupportedClaims = claimBoard.filter(item => {
      const status = asString(item.status);
      if (status !== 'supported' && status !== 'weakly_supported') return false;
      return stringList(item.evidence).length === 0;
    });
    if (unsupportedSupportedClaims.length > 0) {
      failures.push(`${unsupportedSupportedClaims.length} supported claims lack evidence refs`);
    }
  }

  const requiredHandoffRoles = stringList(config.required_handoff_roles);
  const handoffRoles = new Set(handoffs.map(item => asString(item.target_role)).filter(Boolean));
  const missingHandoffRoles = requiredHandoffRoles.filter(role => !handoffRoles.has(role));
  if (missingHandoffRoles.length > 0) {
    failures.push(`missing handoff roles: ${missingHandoffRoles.join(', ')}`);
  }

  const requiredRunStatuses = stringList(config.required_run_statuses);
  const runStatuses = new Set(runRegistry.map(item => asString(item.status)).filter(Boolean));
  const missingRunStatuses = requiredRunStatuses.filter(status => !runStatuses.has(status));
  if (missingRunStatuses.length > 0) {
    failures.push(`missing run statuses: ${missingRunStatuses.join(', ')}`);
  }

  if (config.require_artifact_path_sanitization !== false) {
    const pathFailures = [
      ...artifactBoard.flatMap(item => researchBoardPathFailures(asString(item.path), item, 'artifact_board.path')),
      ...runRegistry.flatMap(item => [
        ...researchBoardPathFailures(asString(item.log_path), item, 'run_registry.log_path', false),
        ...researchBoardPathFailures(asString(item.output_path), item, 'run_registry.output_path', false),
      ]),
    ];
    failures.push(...pathFailures);
  }

  const evidenceText = [
    JSON.stringify(board, null, 2),
    markdown,
  ].join('\n');
  const requiredTexts = stringList(config.required_texts ?? config.must_include);
  const forbiddenTexts = stringList(config.forbidden_texts ?? config.must_not_include);
  const missingRequiredTexts = requiredTexts.filter(text => !includesText(evidenceText, text, caseSensitive));
  const forbiddenTextHits = forbiddenTexts.filter(text => includesText(evidenceText, text, caseSensitive));
  if (missingRequiredTexts.length > 0) {
    failures.push(`missing required board text: ${missingRequiredTexts.join(', ')}`);
  }
  if (forbiddenTextHits.length > 0) {
    failures.push(`forbidden board text: ${forbiddenTextHits.join(', ')}`);
  }

  if (markdownPath && !markdownFile) {
    failures.push(`Research Board markdown missing: ${markdownPath}`);
  }

  const evidenceRefs = [
    ...(boardArtifact.path ? [boardArtifact.path] : [boardPath]),
    ...(markdownFile ? [markdownFile] : []),
  ];

  if (failures.length > 0) {
    return result('research_board_quality', 'fail', failures.join('; '), evidenceRefs, 'state_evidence', {
      claims: claimBoard.length,
      evidence: evidenceBoard.length,
      experiments: experimentQueue.length,
      artifacts: artifactBoard.length,
      risks: riskBoard.length,
      handoffs: handoffs.length,
      next_actions: nextActions.length,
      runs: runRegistry.length,
      failures: failures.length,
    });
  }

  return result('research_board_quality', 'pass', 'Research Board quality contract passed', evidenceRefs, undefined, {
    claims: claimBoard.length,
    evidence: evidenceBoard.length,
    experiments: experimentQueue.length,
    artifacts: artifactBoard.length,
    risks: riskBoard.length,
    handoffs: handoffs.length,
    next_actions: nextActions.length,
    runs: runRegistry.length,
  });
}

interface ResearchBoardSemanticCheck {
  id: string;
  pass: boolean;
  weight: number;
  critical?: boolean;
  message: string;
}

function verifyResearchBoardReviewerSemantic(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  const projectSlug = asString(config.project_slug);
  const boardPath = asString(config.board_path)
    || (projectSlug ? `data/researcher-cat/boards/${projectSlug}/board.json` : 'board.json');
  const markdownPath = asString(config.markdown_path)
    || (projectSlug ? `output/researcher-cat/boards/${projectSlug}/research-board.md` : 'research-board.md');
  const boardArtifact = readJsonArtifactRecord(context, boardPath);
  const board = boardArtifact.record;
  if (!board) {
    return result(
      'research_board_reviewer_semantic',
      'fail',
      boardArtifact.error || `Research Board missing: ${boardPath}`,
      boardArtifact.path ? [boardArtifact.path] : [boardPath],
      'state_evidence',
      { board_found: false },
    );
  }

  const markdownFile = findArtifactFile(context, markdownPath);
  const markdown = markdownFile ? fs.readFileSync(markdownFile, 'utf-8') : '';
  const evidenceText = [
    JSON.stringify(board, null, 2),
    markdown,
  ].join('\n');

  const claimBoard = objectArray(board.claim_board);
  const artifactBoard = objectArray(board.artifact_board);
  const handoffs = objectArray(board.handoffs);
  const riskBoard = objectArray(board.risk_board);
  const nextActions = objectArray(board.next_actions);
  const runRegistry = objectArray(board.run_registry);
  const caseSensitive = config.case_sensitive === true;
  const expectedReviewerRole = normalizeRoleId(asString(config.expected_reviewer_role) || 'reviewer-cat');
  const minScore = asNumber(config.min_score) ?? 0.8;
  const requiredTexts = stringList(config.required_semantic_texts ?? config.required_texts ?? config.must_include);
  const forbiddenTexts = stringList(config.forbidden_final_acceptance_texts ?? config.forbidden_texts ?? config.must_not_include);
  const finalAcceptanceHits = detectResearchBoardFinalAcceptanceHits(evidenceText, forbiddenTexts, caseSensitive);
  const deliveryArtifacts = selectResearchBoardDeliveryArtifacts(artifactBoard, stringList(config.delivery_artifact_paths));
  const checks: ResearchBoardSemanticCheck[] = [];

  if (config.require_reviewer_handoff !== false) {
    const matchingHandoffs = handoffs.filter(item => normalizeRoleId(asString(item.target_role)) === expectedReviewerRole);
    checks.push({
      id: 'reviewer_handoff',
      pass: matchingHandoffs.length > 0,
      weight: 2,
      critical: true,
      message: matchingHandoffs.length > 0
        ? `found ${matchingHandoffs.length} ${expectedReviewerRole} handoff(s)`
        : `missing ${expectedReviewerRole} handoff`,
    });
  }

  checks.push({
    id: 'no_final_acceptance',
    pass: finalAcceptanceHits.length === 0,
    weight: 2,
    critical: true,
    message: finalAcceptanceHits.length === 0
      ? 'no final acceptance language found in Research Board evidence'
      : `forbidden final acceptance language: ${finalAcceptanceHits.join(', ')}`,
  });

  if (config.require_unaccepted_claims !== false) {
    const hasUnacceptedClaim = claimBoard.some(item => isUnsupportedClaimStatus(asString(item.status)));
    checks.push({
      id: 'unaccepted_claim_discipline',
      pass: hasUnacceptedClaim,
      weight: 2,
      critical: true,
      message: hasUnacceptedClaim
        ? 'claim board keeps at least one claim unsupported/blocked/unknown'
        : 'claim board lacks unsupported/blocked/unknown claim discipline',
    });
  }

  if (config.require_evidence_for_non_unsupported !== false) {
    const claimsWithoutEvidence = claimBoard.filter(item => {
      const status = asString(item.status);
      if (!status || isUnsupportedClaimStatus(status)) return false;
      return stringList(item.evidence).length === 0;
    });
    checks.push({
      id: 'non_unsupported_claim_evidence',
      pass: claimsWithoutEvidence.length === 0,
      weight: 1.5,
      critical: true,
      message: claimsWithoutEvidence.length === 0
        ? 'all non-unsupported claims have evidence refs'
        : `${claimsWithoutEvidence.length} non-unsupported claim(s) lack evidence refs`,
    });
  }

  if (config.require_delivery_artifact_blockers === true || deliveryArtifacts.length > 0) {
    const deliveryResult = checkResearchBoardDeliveryArtifactReadiness(
      deliveryArtifacts,
      stringList(config.required_delivery_blocker_terms),
    );
    const deliveryFailures = [
      ...(config.require_delivery_artifact_blockers === true && deliveryArtifacts.length === 0 ? ['missing delivery artifact readiness entries'] : []),
      ...deliveryResult.failures,
    ];
    checks.push({
      id: 'delivery_artifact_blockers',
      pass: deliveryFailures.length === 0,
      weight: 2,
      critical: true,
      message: deliveryFailures.length === 0
        ? `${deliveryArtifacts.length} delivery artifact(s) remain blocked/planned until verification`
        : deliveryFailures.join('; '),
    });
  }

  if (requiredTexts.length > 0) {
    const missingRequiredTexts = requiredTexts.filter(text => !includesText(evidenceText, text, caseSensitive));
    checks.push({
      id: 'required_semantic_texts',
      pass: missingRequiredTexts.length === 0,
      weight: 1,
      message: missingRequiredTexts.length === 0
        ? 'required semantic markers found'
        : `missing semantic marker(s): ${missingRequiredTexts.join(', ')}`,
    });
  }

  checks.push({
    id: 'reviewable_state_surface',
    pass: riskBoard.length > 0 && nextActions.length > 0 && runRegistry.length > 0,
    weight: 1,
    message: riskBoard.length > 0 && nextActions.length > 0 && runRegistry.length > 0
      ? 'risk, next-action, and run-registry state are reviewable'
      : 'missing risk, next-action, or run-registry state for ReviewerCat',
  });

  const score = scoreResearchBoardSemanticChecks(checks);
  const criticalFailures = checks.filter(item => item.critical && !item.pass);
  const failedChecks = checks.filter(item => !item.pass);
  const evidenceRefs = [
    ...(boardArtifact.path ? [boardArtifact.path] : [boardPath]),
    ...(markdownFile ? [markdownFile] : []),
  ];

  if (criticalFailures.length > 0 || score < minScore) {
    return result(
      'research_board_reviewer_semantic',
      'fail',
      `Research Board reviewer semantic score ${score.toFixed(2)} < ${minScore.toFixed(2)} or critical checks failed: ${failedChecks.map(item => `${item.id}: ${item.message}`).join('; ')}`,
      evidenceRefs,
      'state_evidence',
      {
        score,
        checks_total: checks.length,
        checks_failed: failedChecks.length,
        critical_failures: criticalFailures.length,
        final_acceptance_hits: finalAcceptanceHits.length,
        delivery_artifacts_checked: deliveryArtifacts.length,
        claims_checked: claimBoard.length,
        handoffs: handoffs.length,
      },
    );
  }

  return result(
    'research_board_reviewer_semantic',
    'pass',
    `Research Board reviewer semantic score ${score.toFixed(2)} passed`,
    evidenceRefs,
    undefined,
    {
      score,
      checks_total: checks.length,
      checks_failed: 0,
      critical_failures: 0,
      final_acceptance_hits: finalAcceptanceHits.length,
      delivery_artifacts_checked: deliveryArtifacts.length,
      claims_checked: claimBoard.length,
      handoffs: handoffs.length,
    },
  );
}

function verifyResearcherReviewPacket(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  const projectSlug = asString(config.project_slug);
  const packetPath = asString(config.packet_path)
    || (projectSlug ? `data/researcher-cat/auto-research/${projectSlug}/reviewer-handoff.json` : 'reviewer-handoff.json');
  const markdownPath = asString(config.markdown_path)
    || (projectSlug ? `output/researcher-cat/auto-research/${projectSlug}/reviewer-handoff.md` : 'reviewer-handoff.md');
  const packetArtifact = readJsonArtifactRecord(context, packetPath);
  const packet = packetArtifact.record;
  if (!packet) {
    return result(
      'researcher_review_packet',
      'fail',
      packetArtifact.error || `Researcher review packet missing: ${packetPath}`,
      packetArtifact.path ? [packetArtifact.path] : [packetPath],
      'state_evidence',
      { packet_found: false },
    );
  }

  const markdownFile = findArtifactFile(context, markdownPath);
  const markdown = markdownFile ? fs.readFileSync(markdownFile, 'utf-8') : '';
  const requestedReviewer = asRecord(packet.requested_reviewer) ?? {};
  const evidenceBundle = asRecord(packet.evidence_bundle) ?? {};
  const acceptanceBoundary = asRecord(packet.acceptance_boundary) ?? {};
  const readinessSummary = objectArray(packet.readiness_summary);
  const blockers = objectArray(packet.blockers);
  const reviewChecklist = objectArray(packet.review_checklist);
  const minBlockers = asNumber(config.min_blockers) ?? 3;
  const minChecklistItems = asNumber(config.min_checklist_items) ?? 4;
  const expectedReviewerRole = normalizeRoleId(asString(config.expected_reviewer_role) || 'reviewer-cat');
  const requiredChecklistIds = stringList(config.required_checklist_ids);
  const requiredEvidenceRefs = stringList(config.required_evidence_refs);
  const forbiddenTexts = stringList(config.forbidden_final_acceptance_texts ?? config.forbidden_texts);
  const packetText = [JSON.stringify(packet, null, 2), markdown].join('\n');
  const finalAcceptanceHits = detectResearchBoardFinalAcceptanceHits(packetText, forbiddenTexts, config.case_sensitive === true);
  const failures: string[] = [];

  if (asNumber(packet.schema_version) !== 1) {
    failures.push('schema_version must be 1');
  }
  if (asString(packet.status) !== 'blocked_until_reviewer_verification') {
    failures.push(`status must be blocked_until_reviewer_verification, saw ${asString(packet.status) || '[missing]'}`);
  }
  if (normalizeRoleId(asString(requestedReviewer.target_role)) !== expectedReviewerRole) {
    failures.push(`requested reviewer must be ${expectedReviewerRole}`);
  }
  if (asString(requestedReviewer.decision_needed) !== 'closed_next_run_or_blocked') {
    failures.push('requested reviewer decision_needed must be closed_next_run_or_blocked');
  }
  if (acceptanceBoundary.reviewer_decision_required !== true) {
    failures.push('acceptance boundary must require reviewer_decision_required=true');
  }
  if (asString(acceptanceBoundary.researcher_decision) !== 'no_final_acceptance') {
    failures.push('acceptance boundary must keep researcher_decision=no_final_acceptance');
  }
  if (readinessSummary.length === 0) {
    failures.push('readiness_summary is empty');
  }
  if (blockers.length < minBlockers) {
    failures.push(`blockers ${blockers.length} < ${minBlockers}`);
  }
  if (reviewChecklist.length < minChecklistItems) {
    failures.push(`review_checklist ${reviewChecklist.length} < ${minChecklistItems}`);
  }

  const checklistIds = reviewChecklist.map(item => asString(item.id)).filter(Boolean);
  const missingChecklist = requiredChecklistIds.filter(id => !checklistIds.includes(id));
  if (missingChecklist.length > 0) {
    failures.push(`missing checklist item(s): ${missingChecklist.join(', ')}`);
  }

  const evidenceValues = Object.values(evidenceBundle).filter((item): item is string => typeof item === 'string');
  const missingEvidenceRefs = requiredEvidenceRefs.filter(ref => !evidenceValues.includes(ref));
  if (missingEvidenceRefs.length > 0) {
    failures.push(`missing evidence bundle ref(s): ${missingEvidenceRefs.join(', ')}`);
  }

  const unsafeEvidenceRefs = evidenceValues.filter(ref => path.isAbsolute(ref) || normalizePath(ref).startsWith('../') || ref.includes('/Users/'));
  if (unsafeEvidenceRefs.length > 0) {
    failures.push(`unsafe evidence bundle path(s): ${unsafeEvidenceRefs.join(', ')}`);
  }

  const checklistWithoutEvidence = reviewChecklist.filter(item => stringList(item.required_evidence).length === 0);
  if (checklistWithoutEvidence.length > 0) {
    failures.push(`${checklistWithoutEvidence.length} checklist item(s) lack required evidence refs`);
  }
  const blockerWithoutEvidence = blockers.filter(item => stringList(item.evidence).length === 0);
  if (blockerWithoutEvidence.length > 0) {
    failures.push(`${blockerWithoutEvidence.length} blocker(s) lack evidence refs`);
  }
  if (finalAcceptanceHits.length > 0) {
    failures.push(`forbidden final acceptance language: ${finalAcceptanceHits.join(', ')}`);
  }
  if (config.require_markdown !== false && !markdownFile) {
    failures.push(`reviewer handoff markdown missing: ${markdownPath}`);
  }

  const evidenceRefs = [
    ...(packetArtifact.path ? [packetArtifact.path] : [packetPath]),
    ...(markdownFile ? [markdownFile] : []),
  ];
  const metrics = {
    blockers: blockers.length,
    checklist_items: reviewChecklist.length,
    readiness_items: readinessSummary.length,
    evidence_bundle_refs: evidenceValues.length,
    final_acceptance_hits: finalAcceptanceHits.length,
    failures: failures.length,
  };

  if (failures.length > 0) {
    return result(
      'researcher_review_packet',
      'fail',
      failures.join('; '),
      evidenceRefs,
      'state_evidence',
      metrics,
    );
  }

  return result(
    'researcher_review_packet',
    'pass',
    'ResearcherCat ReviewerCat handoff packet is reviewable and keeps acceptance with ReviewerCat',
    evidenceRefs,
    undefined,
    metrics,
  );
}

function objectArray(value: unknown): Record<string, unknown>[] {
  return asArray(value).flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

function requireMinCount(failures: string[], label: string, actual: number, minimum: number): void {
  if (actual < minimum) {
    failures.push(`${label} ${actual} < ${minimum}`);
  }
}

function isUnsupportedClaimStatus(status: string): boolean {
  return ['unsupported', 'weakly_supported', 'contradicted', 'blocked', 'unknown'].includes(status);
}

function detectResearchBoardFinalAcceptanceHits(text: string, configuredForbiddenTexts: string[], caseSensitive: boolean): string[] {
  const defaultForbiddenTexts = [
    'Decision: pass',
    'close the case',
    'everything is done',
    '交付已验收',
    '最终验收通过',
    '已经可发',
    'ready to send',
    'ReviewerCat accepted',
    'ReviewerCat verified',
  ];
  return uniqueStringList([...defaultForbiddenTexts, ...configuredForbiddenTexts])
    .filter(item => includesText(text, item, caseSensitive));
}

function selectResearchBoardDeliveryArtifacts(
  artifactBoard: Record<string, unknown>[],
  configuredPaths: string[],
): Record<string, unknown>[] {
  if (configuredPaths.length > 0) {
    const configured = configuredPaths.map(normalizePath);
    return artifactBoard.filter((item) => {
      const itemPath = normalizePath(asString(item.path));
      return configured.some(expected => itemPath === expected || itemPath.endsWith(`/${expected}`) || path.basename(itemPath) === path.basename(expected));
    });
  }

  return artifactBoard.filter((item) => {
    const itemPath = normalizePath(asString(item.path)).toLowerCase();
    const type = asString(item.type).toLowerCase();
    return ['pdf', 'slides', 'figure'].includes(type)
      || /\.(?:gif|jpe?g|pdf|png|pptx?|svg|webp)$/.test(itemPath);
  });
}

function checkResearchBoardDeliveryArtifactReadiness(
  artifacts: Record<string, unknown>[],
  configuredRequiredTerms: string[],
): { failures: string[] } {
  const allowedStatuses = new Set(['planned', 'blocked', 'needs_review', 'unknown']);
  const forbiddenStatuses = new Set(['completed', 'delivered', 'sent', 'accepted', 'verified', 'done', 'pass']);
  const requiredTerms = configuredRequiredTerms.length > 0
    ? configuredRequiredTerms
    : ['version', 'compile', 'export', 'ReviewerCat'];
  const failures: string[] = [];

  artifacts.forEach((item, index) => {
    const label = asString(item.path) || asString(item.id) || `artifact[${index}]`;
    const status = asString(item.status).toLowerCase();
    if (!status || forbiddenStatuses.has(status) || !allowedStatuses.has(status)) {
      failures.push(`${label} has delivery status ${status || '[missing]'} instead of planned/blocked/needs_review`);
    }
    if (stringList(item.evidence).length === 0) {
      failures.push(`${label} lacks artifact evidence refs`);
    }
    const text = [
      asString(item.path),
      asString(item.type),
      asString(item.status),
      asString(item.note),
      stringList(item.evidence).join(' '),
    ].join('\n');
    const missingTerms = requiredTerms.filter(term => !includesText(text, term, false));
    if (missingTerms.length > 0) {
      failures.push(`${label} missing delivery blocker term(s): ${missingTerms.join(', ')}`);
    }
  });

  return { failures };
}

function scoreResearchBoardSemanticChecks(checks: ResearchBoardSemanticCheck[]): number {
  const totalWeight = checks.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return 0;
  const passedWeight = checks.reduce((sum, item) => sum + (item.pass ? item.weight : 0), 0);
  return Math.round((passedWeight / totalWeight) * 100) / 100;
}

function researchBoardPathFailures(
  value: string,
  record: Record<string, unknown>,
  field: string,
  requireHashForBlocked = true,
): string[] {
  if (!value) return [];
  const failures: string[] = [];
  const normalized = normalizePath(value);
  if (normalized.startsWith('[blocked-external-path:')) {
    if (requireHashForBlocked && !asString(record.original_path_hash)) {
      failures.push(`${field} blocked path lacks original_path_hash`);
    }
    return failures;
  }
  if (path.isAbsolute(normalized) || normalized.startsWith('../') || normalized.includes('/../')) {
    failures.push(`${field} is not workspace-relative: ${value}`);
  }
  return failures;
}

function verifyCrossRoleHandoff(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  if (!context.jsonl) {
    return result('cross_role_handoff', 'blocked', 'case has no JSONL input', [], context.caseSpec.failure_route);
  }

  const requiredRoleSequence = stringList(config.required_role_sequence ?? config.role_sequence)
    .map(normalizeRoleId)
    .filter(Boolean);
  const requiredHandoffs = asArray(config.required_handoffs ?? config.handoffs)
    .map(asRoleHandoffRequirement)
    .filter((item): item is Pick<RoleHandoffFact, 'fromRole' | 'toRole' | 'caseId'> => Boolean(item));
  const requiredTexts = stringList(config.required_texts ?? config.must_include);
  const forbiddenTexts = stringList(config.forbidden_texts ?? config.must_not_include);
  const requiredArtifacts = stringList(config.required_artifacts ?? config.required_artifact_refs ?? config.artifacts);
  const expectedFinalDecision = asString(config.expected_final_decision ?? config.final_decision);
  const requiredCaseId = asString(config.required_case_id ?? config.case_id);
  const caseSensitive = config.case_sensitive === true;

  if (requiredRoleSequence.length === 0 && requiredHandoffs.length === 0 && !expectedFinalDecision) {
    return result('cross_role_handoff', 'blocked', 'missing role sequence, handoff, or final decision config', [context.jsonl.path], context.caseSpec.failure_route);
  }

  const roleIds = collectRoleIds(context.jsonl.entries).map(normalizeRoleId).filter(Boolean);
  const handoffs = collectRoleHandoffFacts(context.jsonl.entries);
  const decisions = collectRoleReviewDecisions(context.jsonl.entries);
  const evidenceText = [
    context.jsonl.content,
    collectAssistantText(context),
    ...handoffs.map(item => `${item.fromRole}->${item.toRole} ${item.caseId} ${item.reason} ${item.artifacts.join(' ')}`),
    ...decisions.map(item => `${item.roleId} ${item.caseId} ${item.decision} ${item.evidenceRefs.join(' ')}`),
    ...context.toolCalls.flatMap(call => [
      call.name,
      call.argumentsText,
      call.resultText,
      ...call.artifactManifest.map(item => `${item.path} ${item.type ?? ''} ${item.action ?? ''}`),
    ]),
  ].join('\n');

  const missingSequence = requiredRoleSequence.length > 0 && !containsSubsequence(roleIds, requiredRoleSequence);
  const missingHandoffs = requiredHandoffs.filter(required => !handoffs.some(actual => roleHandoffMatches(actual, required)));
  const missingTexts = requiredTexts.filter(item => !includesText(evidenceText, item, caseSensitive));
  const forbiddenHits = forbiddenTexts.filter(item => includesText(evidenceText, item, caseSensitive));
  const missingArtifacts = requiredArtifacts.filter(item => !includesText(evidenceText, item, caseSensitive));
  const missingCaseId = requiredCaseId && !includesText(evidenceText, requiredCaseId, caseSensitive);
  const finalDecisionFound = !expectedFinalDecision || decisions.some(item => (
    includesText(item.decision, expectedFinalDecision, caseSensitive)
    && (!requiredCaseId || item.caseId === requiredCaseId)
  )) || includesText(evidenceText, `Decision: ${expectedFinalDecision}`, caseSensitive);

  const failures = [
    ...(missingSequence ? [`missing role sequence: ${requiredRoleSequence.join(' -> ')}`] : []),
    ...(missingHandoffs.length > 0 ? [`missing handoffs: ${missingHandoffs.map(item => `${item.fromRole}->${item.toRole}${item.caseId ? `:${item.caseId}` : ''}`).join(', ')}`] : []),
    ...(missingTexts.length > 0 ? [`missing required text: ${missingTexts.join(', ')}`] : []),
    ...(forbiddenHits.length > 0 ? [`forbidden text: ${forbiddenHits.join(', ')}`] : []),
    ...(missingArtifacts.length > 0 ? [`missing artifacts: ${missingArtifacts.join(', ')}`] : []),
    ...(missingCaseId ? [`missing case id: ${requiredCaseId}`] : []),
    ...(!finalDecisionFound ? [`missing final decision: ${expectedFinalDecision}`] : []),
  ];

  if (failures.length > 0) {
    return result('cross_role_handoff', 'fail', failures.join('; '), [context.jsonl.path], 'role', {
      roles_seen: roleIds.length,
      handoffs_seen: handoffs.length,
      decisions_seen: decisions.length,
      missing_handoffs: missingHandoffs.length,
      missing_required_texts: missingTexts.length,
      missing_artifacts: missingArtifacts.length,
      forbidden_text_hits: forbiddenHits.length,
      final_decision_found: finalDecisionFound,
    });
  }

  return result('cross_role_handoff', 'pass', 'cross-role handoff chain is complete', [context.jsonl.path], undefined, {
    roles_seen: roleIds.length,
    handoffs_seen: handoffs.length,
    decisions_seen: decisions.length,
    required_handoffs: requiredHandoffs.length,
    required_artifacts: requiredArtifacts.length,
    final_decision_found: finalDecisionFound,
  });
}

function verifyStateContinuity(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  if (!context.jsonl) {
    return result('state_continuity', 'blocked', 'case has no JSONL input', [], context.caseSpec.failure_route);
  }

  const requiredEvents = stringList(config.required_events ?? config.events);
  const requiredTexts = stringList(config.required_texts ?? config.texts);
  const minTurns = asNumber(config.min_turns);
  const caseSensitive = config.case_sensitive === true;
  const eventNames = collectEventNames(context.jsonl.entries);
  const evidenceText = context.jsonl.content;

  const missingEvents = requiredEvents.filter(expected => (
    !eventNames.some(actual => includesText(actual, expected, caseSensitive))
    && !includesText(evidenceText, expected, caseSensitive)
  ));
  const missingTexts = requiredTexts.filter(expected => !includesText(evidenceText, expected, caseSensitive));
  const turnViolation = minTurns !== undefined && context.metrics.turns < minTurns;

  const failures = [
    ...(missingEvents.length > 0 ? [`missing events: ${missingEvents.join(', ')}`] : []),
    ...(missingTexts.length > 0 ? [`missing state text: ${missingTexts.join(', ')}`] : []),
    ...(turnViolation ? [`turns ${context.metrics.turns} < ${minTurns}`] : []),
  ];

  if (failures.length > 0) {
    return result('state_continuity', 'fail', failures.join('; '), [context.jsonl.path], 'state_evidence', {
      missing_events: missingEvents.length,
      missing_texts: missingTexts.length,
      turns: context.metrics.turns,
    });
  }

  return result('state_continuity', 'pass', 'state continuity evidence is present', [context.jsonl.path], undefined, {
    required_events: requiredEvents.length,
    required_texts: requiredTexts.length,
    turns: context.metrics.turns,
  });
}

function verifyStateBoundaryContract(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  if (!context.jsonl) {
    return result('state_boundary_contract', 'blocked', 'case has no JSONL input', [], context.caseSpec.failure_route);
  }

  const configuredBoundaries = stringList(config.required_boundaries ?? config.boundaries)
    .map(normalizeStateBoundaryName)
    .filter(Boolean);
  const requiredBoundaries = configuredBoundaries.length > 0
    ? configuredBoundaries
    : [
      'durable_session',
      'working_trace',
      'provider_transcript',
      ...(config.require_visible_history === true ? ['visible_history'] : []),
    ];
  const facts = collectStateBoundaryFacts(context.jsonl.entries);
  const byBoundary = new Map<string, StateBoundaryFact>();
  for (const fact of facts) {
    if (fact.boundary && !byBoundary.has(fact.boundary)) {
      byBoundary.set(fact.boundary, fact);
    }
  }

  const missingBoundaries = requiredBoundaries.filter(boundary => !byBoundary.has(boundary));
  const requiredFacts = requiredBoundaries.flatMap(boundary => {
    const fact = byBoundary.get(boundary);
    return fact ? [fact] : [];
  });
  const missingRefs = requiredFacts.filter(fact => !fact.ref).map(fact => fact.boundary);
  const unsafeRefs = requiredFacts
    .filter(fact => fact.ref && isUnsafeStateBoundaryRef(fact.ref))
    .map(fact => fact.boundary);
  const duplicateRefs = collectDuplicateBoundaryRefs(requiredFacts);
  const providerFacts = facts.filter(fact => fact.boundary === 'provider_transcript');
  const badProviderFacts = providerFacts.filter(fact => !isProviderTranscriptReferenceOnly(fact));

  const failures = [
    ...(missingBoundaries.length > 0 ? [`missing boundaries: ${missingBoundaries.join(', ')}`] : []),
    ...(missingRefs.length > 0 ? [`missing refs: ${missingRefs.join(', ')}`] : []),
    ...(unsafeRefs.length > 0 ? [`unsafe refs: ${unsafeRefs.join(', ')}`] : []),
    ...(duplicateRefs.length > 0 ? [`duplicate boundary refs: ${duplicateRefs.join(', ')}`] : []),
    ...(badProviderFacts.length > 0 ? ['provider transcript evidence must be reference-only'] : []),
  ];

  if (failures.length > 0) {
    return result('state_boundary_contract', 'fail', failures.join('; '), [context.jsonl.path], 'state_evidence', {
      boundaries_seen: facts.length,
      required_boundaries: requiredBoundaries.length,
      missing_boundaries: missingBoundaries.length,
      missing_refs: missingRefs.length,
      unsafe_refs: unsafeRefs.length,
      duplicate_refs: duplicateRefs.length,
      provider_reference_violations: badProviderFacts.length,
    });
  }

  return result('state_boundary_contract', 'pass', 'state boundary evidence is separated', [context.jsonl.path], undefined, {
    boundaries_seen: facts.length,
    required_boundaries: requiredBoundaries.length,
    provider_transcript_refs: providerFacts.length,
  });
}

function verifyProviderTranscriptNormalization(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  if (!context.jsonl) {
    return result('provider_transcript_normalization', 'blocked', 'case has no JSONL input', [], context.caseSpec.failure_route);
  }

  const requireDigestRef = config.require_digest_ref !== false;
  const facts = collectStateBoundaryFacts(context.jsonl.entries)
    .filter(fact => fact.boundary === 'provider_transcript');
  const missingRefs = facts.filter(fact => !fact.ref);
  const unsafeRefs = facts.filter(fact => fact.ref && isUnsafeStateBoundaryRef(fact.ref));
  const nonReferenceFacts = facts.filter(fact => !isProviderTranscriptReferenceOnly(fact));
  const nonDigestRefs = requireDigestRef
    ? facts.filter(fact => fact.ref && !isNormalizedProviderTranscriptRef(fact.ref))
    : [];
  const rawPayloadFacts = facts.filter(fact => providerTranscriptRawPayloadKeys(fact.record).length > 0);

  const failures = [
    ...(facts.length === 0 ? ['missing provider transcript boundary evidence'] : []),
    ...(missingRefs.length > 0 ? [`missing provider transcript refs: ${missingRefs.map(item => item.source).join(', ')}`] : []),
    ...(unsafeRefs.length > 0 ? [`unsafe provider transcript refs: ${unsafeRefs.map(item => item.ref).join(', ')}`] : []),
    ...(nonReferenceFacts.length > 0 ? ['provider transcript facts must use reference/summary/pointer mode'] : []),
    ...(nonDigestRefs.length > 0 ? [`provider transcript refs must use normalized digest refs: ${nonDigestRefs.map(item => item.ref).join(', ')}`] : []),
    ...(rawPayloadFacts.length > 0 ? ['provider transcript facts must not contain raw provider payload keys'] : []),
  ];

  if (failures.length > 0) {
    return result('provider_transcript_normalization', 'fail', failures.join('; '), [context.jsonl.path], 'state_evidence', {
      provider_transcript_refs: facts.length,
      missing_refs: missingRefs.length,
      unsafe_refs: unsafeRefs.length,
      non_reference_facts: nonReferenceFacts.length,
      non_digest_refs: nonDigestRefs.length,
      raw_payload_facts: rawPayloadFacts.length,
    });
  }

  return result('provider_transcript_normalization', 'pass', 'provider transcript refs are normalized and reference-only', [context.jsonl.path], undefined, {
    provider_transcript_refs: facts.length,
    digest_refs_required: requireDigestRef,
  });
}

function verifyProviderTranscriptDegradation(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  if (!context.jsonl) {
    return result('provider_transcript_degradation', 'blocked', 'case has no JSONL input', [], context.caseSpec.failure_route);
  }

  const minDegradedRefs = asNumber(config.min_degraded_refs ?? config.min_refs) ?? 1;
  const requireDigestRef = config.require_digest_ref !== false;
  const requireExplicitStorageFlags = config.require_explicit_raw_payload_storage_flags !== false;
  const requireFallbackChain = config.require_fallback_chain === true;
  const requireBlockedReason = config.require_blocked_reason !== false;
  const expectedReasons = comparableStringList(config.expected_reasons ?? config.degradation_reasons);
  const expectedStatuses = comparableStringList(config.expected_statuses ?? config.statuses);
  const facts = collectStateBoundaryFacts(context.jsonl.entries)
    .filter(fact => fact.boundary === 'provider_transcript');
  const degradedFacts = facts.filter(isProviderTranscriptDegradedFact);
  const missingRefs = degradedFacts.filter(fact => !fact.ref);
  const nonReferenceFacts = degradedFacts.filter(fact => !isProviderTranscriptReferenceOnly(fact));
  const nonDigestRefs = requireDigestRef
    ? degradedFacts.filter(fact => fact.ref && !isNormalizedProviderTranscriptRef(fact.ref))
    : [];
  const rawPayloadFacts = degradedFacts.filter(fact => providerTranscriptRawPayloadKeys(fact.record).length > 0);
  const storageFlagViolations = degradedFacts.filter(fact => providerTranscriptStorageFlagViolations(fact.record).length > 0);
  const missingReasons = degradedFacts.filter(fact => providerTranscriptDegradationReasons(fact).length === 0);
  const missingBlockedReasons = requireBlockedReason
    ? degradedFacts.filter(fact => !asString(fact.record.blocked_reason).trim())
    : [];
  const missingFallbackChains = requireFallbackChain
    ? degradedFacts.filter(fact => providerTranscriptFallbackChain(fact).length < 2)
    : [];
  const missingExplicitFlags = requireExplicitStorageFlags
    ? degradedFacts.filter(fact => !hasExplicitProviderTranscriptRawPayloadStorageFlags(fact.record))
    : [];
  const observedReasons = uniqueStringList(degradedFacts.flatMap(providerTranscriptDegradationReasons).map(comparableText));
  const observedStatuses = uniqueStringList(degradedFacts.map(providerTranscriptStatus).map(comparableText).filter(Boolean));
  const missingExpectedReasons = expectedReasons.filter(reason => !observedReasons.includes(reason));
  const missingExpectedStatuses = expectedStatuses.filter(status => !observedStatuses.includes(status));

  const failures = [
    ...(degradedFacts.length < minDegradedRefs ? [`expected at least ${minDegradedRefs} degraded provider transcript refs, saw ${degradedFacts.length}`] : []),
    ...(missingRefs.length > 0 ? [`missing degraded provider transcript refs: ${missingRefs.map(item => item.source).join(', ')}`] : []),
    ...(nonReferenceFacts.length > 0 ? ['degraded provider transcript facts must remain reference/summary/pointer-only'] : []),
    ...(nonDigestRefs.length > 0 ? [`degraded provider transcript refs must use normalized digest refs: ${nonDigestRefs.map(item => item.ref).join(', ')}`] : []),
    ...(rawPayloadFacts.length > 0 ? ['degraded provider transcript facts must not contain raw provider payload keys'] : []),
    ...(storageFlagViolations.length > 0 ? ['degraded provider transcript storage flags must not allow raw request/response/message payloads'] : []),
    ...(missingReasons.length > 0 ? [`missing degradation reasons: ${missingReasons.map(item => item.source).join(', ')}`] : []),
    ...(missingBlockedReasons.length > 0 ? [`missing blocked reasons: ${missingBlockedReasons.map(item => item.source).join(', ')}`] : []),
    ...(missingFallbackChains.length > 0 ? [`missing fallback chains: ${missingFallbackChains.map(item => item.source).join(', ')}`] : []),
    ...(missingExplicitFlags.length > 0 ? [`missing explicit raw payload storage flags: ${missingExplicitFlags.map(item => item.source).join(', ')}`] : []),
    ...(missingExpectedReasons.length > 0 ? [`missing expected degradation reasons: ${missingExpectedReasons.join(', ')}`] : []),
    ...(missingExpectedStatuses.length > 0 ? [`missing expected degradation statuses: ${missingExpectedStatuses.join(', ')}`] : []),
  ];

  if (failures.length > 0) {
    return result('provider_transcript_degradation', 'fail', failures.join('; '), [context.jsonl.path], 'state_evidence', {
      provider_transcript_refs: facts.length,
      degraded_refs: degradedFacts.length,
      raw_payload_facts: rawPayloadFacts.length,
      storage_flag_violations: storageFlagViolations.length,
      observed_degradation_reasons: observedReasons.join('>') || 'none',
      observed_degradation_statuses: observedStatuses.join('>') || 'none',
    });
  }

  return result('provider_transcript_degradation', 'pass', 'provider transcript degradation evidence is structured and reference-only', [context.jsonl.path], undefined, {
    provider_transcript_refs: facts.length,
    degraded_refs: degradedFacts.length,
    observed_degradation_reasons: observedReasons.join('>') || 'none',
    observed_degradation_statuses: observedStatuses.join('>') || 'none',
  });
}

function verifyProviderErrorFallback(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  if (!context.jsonl) {
    return result('provider_error_fallback', 'blocked', 'case has no JSONL input', [], context.caseSpec.failure_route);
  }

  const providerTerms = stringList(config.provider_error_terms);
  const fallbackTerms = stringList(config.fallback_terms);
  const requiredTexts = stringList(config.required_texts);
  const requireRetryBudget = config.require_retry_budget === true;
  const requireBlockedBudget = config.require_blocked_budget === true;
  const caseSensitive = config.case_sensitive === true;
  const providerEvents = collectProviderErrorEvents(context.jsonl.entries);
  const evidenceText = [
    context.jsonl.content,
    ...context.toolCalls.map(call => `${call.name} ${call.status} ${call.errorCode} ${call.blockedReason} ${call.resultText}`),
    ...collectEventNames(context.jsonl.entries),
  ].join('\n');
  const providerNeedles = providerTerms.length > 0
    ? providerTerms
    : ['provider_error', 'provider error', 'rate_limit', 'model_rate_limit', 'provider_timeout', 'provider timeout'];
  const fallbackNeedles = fallbackTerms.length > 0
    ? fallbackTerms
    : ['fallback', 'retry', 'blocked', 'degraded', '降级'];

  const providerErrorFound = providerNeedles.some(term => includesText(evidenceText, term, caseSensitive));
  const fallbackFound = fallbackNeedles.some(term => includesText(evidenceText, term, caseSensitive));
  const missingRequiredTexts = requiredTexts.filter(term => !includesText(evidenceText, term, caseSensitive));
  const retryBudgetFound = providerEvents.some(hasProviderRetryBudgetEvidence);
  const blockedBudgetFound = providerEvents.some(hasProviderBlockedBudgetEvidence);
  const failures = [
    ...(!providerErrorFound ? ['missing provider error evidence'] : []),
    ...(!fallbackFound ? ['missing fallback/blocked evidence'] : []),
    ...(missingRequiredTexts.length > 0 ? [`missing required texts: ${missingRequiredTexts.join(', ')}`] : []),
    ...(requireRetryBudget && !retryBudgetFound ? ['missing provider retry budget evidence'] : []),
    ...(requireBlockedBudget && !blockedBudgetFound ? ['missing provider blocked budget evidence'] : []),
  ];

  if (failures.length > 0) {
    return result('provider_error_fallback', 'fail', failures.join('; '), [context.jsonl.path], 'provider', {
      provider_error_found: providerErrorFound,
      fallback_found: fallbackFound,
      missing_required_texts: missingRequiredTexts.length,
      provider_events: providerEvents.length,
      retry_budget_found: retryBudgetFound,
      blocked_budget_found: blockedBudgetFound,
    });
  }

  return result('provider_error_fallback', 'pass', 'provider error fallback evidence is present', [context.jsonl.path], undefined, {
    provider_error_found: true,
    fallback_found: true,
    required_texts: requiredTexts.length,
    provider_events: providerEvents.length,
    retry_budget_found: retryBudgetFound,
    blocked_budget_found: blockedBudgetFound,
  });
}

function collectProviderErrorEvents(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  return entries
    .flatMap(entry => Array.isArray(entry.events) ? entry.events as Record<string, unknown>[] : [entry])
    .filter(entry => (
      asString(entry.entry_type) === 'runtime_event'
      && asString(entry.event_type) === 'provider_error'
      && Boolean(asRecord(entry.provider_error))
    ));
}

function hasProviderRetryBudgetEvidence(entry: Record<string, unknown>): boolean {
  const budget = asRecord(entry.provider_failure_budget);
  return Boolean(
    budget
    && asString(entry.error_code)
    && asBoolean(entry.retryable) !== undefined
    && asNumber(entry.retry_count) !== undefined
    && asNumber(entry.retry_budget) !== undefined
    && asBoolean(entry.retry_budget_exhausted) !== undefined
    && asString(budget.scope) === 'session'
    && /^sha256:[a-f0-9]{16,64}$/.test(asString(budget.fingerprint))
    && asNumber(budget.prior_failure_count) !== undefined
  );
}

function hasProviderBlockedBudgetEvidence(entry: Record<string, unknown>): boolean {
  return hasProviderRetryBudgetEvidence(entry)
    && asString(entry.status) === 'blocked'
    && asBoolean(entry.retry_budget_exhausted) === true
    && Boolean(asString(entry.blocked_reason));
}

function verifyProviderFailoverSequence(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  if (!context.jsonl) {
    return result('provider_failover_sequence', 'blocked', 'case has no JSONL input', [], context.caseSpec.failure_route);
  }

  const expectedProviders = stringList(config.expected_providers ?? config.providers);
  const expectedEndpoints = stringList(config.expected_endpoints ?? config.endpoints);
  const expectedErrorCodes = stringList(config.expected_error_codes ?? config.error_codes);
  const requireDistinctProviders = config.require_distinct_providers !== false;
  const requireRetryBudget = config.require_retry_budget === true;
  const requireTerminalBlocked = config.require_terminal_blocked !== false;
  const requireMonotonicTimestamps = config.require_monotonic_timestamps !== false;
  const minEvents = asNumber(config.min_events) ?? Math.max(expectedProviders.length, expectedEndpoints.length, 2);
  const events = collectProviderErrorEvents(context.jsonl.entries).map(asProviderFailoverEvent);
  const providers = events.map(item => item.provider);
  const endpoints = events.map(item => item.endpoint);
  const errorCodes = events.map(item => item.errorCode);
  const failures = [
    ...(events.length < minEvents ? [`provider events ${events.length} < ${minEvents}`] : []),
    ...providerSequenceFailures('provider', providers, expectedProviders),
    ...providerSequenceFailures('endpoint', endpoints, expectedEndpoints),
    ...providerSequenceFailures('error_code', errorCodes, expectedErrorCodes),
  ];

  if (requireDistinctProviders) {
    const seenProviders = new Set(providers.filter(Boolean));
    if (seenProviders.size !== providers.filter(Boolean).length) {
      failures.push('provider sequence must use distinct providers');
    }
  }

  if (requireRetryBudget) {
    const missingBudget = events.filter(item => !hasProviderRetryBudgetEvidence(item.entry));
    if (missingBudget.length > 0) {
      failures.push(`provider events missing retry budget evidence: ${missingBudget.map(item => item.provider || item.source).join(', ')}`);
    }
  }

  if (requireTerminalBlocked) {
    const terminal = events[events.length - 1];
    if (!terminal) {
      failures.push('missing terminal provider event');
    } else {
      if (terminal.status !== 'blocked') failures.push(`terminal provider status ${terminal.status || '<missing>'} != blocked`);
      if (terminal.retryBudgetExhausted !== true) failures.push('terminal provider event must exhaust retry budget');
      if (!terminal.blockedReason) failures.push('terminal provider event missing blocked_reason');
    }
  }

  if (requireMonotonicTimestamps && !providerEventsHaveMonotonicTimestamps(events)) {
    failures.push('provider event timestamps must be monotonic');
  }

  if (failures.length > 0) {
    return result('provider_failover_sequence', 'fail', failures.join('; '), [context.jsonl.path], 'provider', {
      provider_events: events.length,
      provider_sequence: providers.join(' -> '),
      endpoint_sequence: endpoints.join(' -> '),
      error_code_sequence: errorCodes.join(' -> '),
    });
  }

  return result('provider_failover_sequence', 'pass', 'provider failover sequence evidence is ordered and bounded', [context.jsonl.path], undefined, {
    provider_events: events.length,
    provider_sequence: providers.join(' -> '),
    endpoint_sequence: endpoints.join(' -> '),
    error_code_sequence: errorCodes.join(' -> '),
    terminal_status: events[events.length - 1]?.status,
  });
}

function providerSequenceFailures(label: string, actual: string[], expected: string[]): string[] {
  if (expected.length === 0) return [];
  if (actual.length < expected.length) return [`${label} sequence too short: ${actual.join(' -> ')}`];
  const mismatches = expected.flatMap((value, index) => (
    actual[index] === value ? [] : [`${label}[${index}] ${actual[index] || '<missing>'} != ${value}`]
  ));
  return mismatches.length > 0 ? [`${label} sequence mismatch: ${mismatches.join(', ')}`] : [];
}

function asProviderFailoverEvent(entry: Record<string, unknown>): {
  entry: Record<string, unknown>;
  source: string;
  provider: string;
  endpoint: string;
  errorCode: string;
  status: string;
  retryBudgetExhausted?: boolean;
  blockedReason: string;
  timestamp: string;
} {
  const providerError = asRecord(entry.provider_error);
  return {
    entry,
    source: asString(entry.event_id) || asString(entry.timestamp) || 'provider_event',
    provider: asString(providerError?.provider),
    endpoint: asString(providerError?.endpoint),
    errorCode: asString(entry.error_code) || asString(providerError?.error_code),
    status: asString(entry.status),
    retryBudgetExhausted: asBoolean(entry.retry_budget_exhausted),
    blockedReason: asString(entry.blocked_reason),
    timestamp: asString(entry.timestamp),
  };
}

function providerEventsHaveMonotonicTimestamps(events: Array<{ timestamp: string }>): boolean {
  let previous = -Infinity;
  for (const event of events) {
    const time = Date.parse(event.timestamp);
    if (!Number.isFinite(time)) return false;
    if (time < previous) return false;
    previous = time;
  }
  return true;
}

function verifyToolPermissionDenial(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  const requiredTools = new Set(stringList(config.required_tools));
  const requiredErrorCodes = stringList(config.required_error_codes);
  const minDeniedCalls = asNumber(config.min_denied_calls) ?? 1;
  const deniedCalls = context.toolCalls.filter(call => {
    if (requiredTools.size > 0 && !requiredTools.has(call.name)) return false;
    return isPermissionDeniedCall(call, requiredErrorCodes);
  });
  const deniedSuccesses = deniedCalls.filter(isSuccessfulToolCall);
  const unobservableDenied = deniedCalls.filter(call => !call.errorCode && !call.blockedReason && !call.resultText);
  const assistantText = collectAssistantText(context);
  const requiredTexts = stringList(config.required_texts);
  const missingRequiredTexts = requiredTexts.filter(term => !includesText(assistantText, term, false));
  const failures = [
    ...(deniedCalls.length < minDeniedCalls ? [`denied calls ${deniedCalls.length} < ${minDeniedCalls}`] : []),
    ...(deniedSuccesses.length > 0 ? [`denied calls succeeded: ${deniedSuccesses.map(call => call.id || call.name).join(', ')}`] : []),
    ...(unobservableDenied.length > 0 ? [`denied calls lack observable evidence: ${unobservableDenied.length}`] : []),
    ...(missingRequiredTexts.length > 0 ? [`missing required assistant text: ${missingRequiredTexts.join(', ')}`] : []),
  ];

  if (failures.length > 0) {
    return result('tool_permission_denial', 'fail', failures.join('; '), context.jsonl ? [context.jsonl.path] : [], 'tool', {
      denied_calls: deniedCalls.length,
      denied_successes: deniedSuccesses.length,
      unobservable_denied: unobservableDenied.length,
      missing_required_texts: missingRequiredTexts.length,
    });
  }

  return result('tool_permission_denial', 'pass', `observed ${deniedCalls.length} permission/path denial calls`, context.jsonl ? [context.jsonl.path] : [], undefined, {
    denied_calls: deniedCalls.length,
    required_error_codes: requiredErrorCodes.length,
  });
}

function verifyWorkspaceBoundary(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  const requireDeniedAttempt = config.require_denied_attempt !== false;
  const deniedErrorCodes = stringList(config.denied_error_codes);
  const boundaryFacts = collectWorkspaceBoundaryFacts(context.toolCalls);
  const escapedCalls = boundaryFacts.filter(fact => fact.kind === 'tool_args');
  const escapedArtifacts = boundaryFacts.filter(fact => fact.kind === 'artifact_manifest');
  const successfulEscapes = escapedCalls.filter(fact => isSuccessfulToolCall(fact.call));
  const deniedEscapes = escapedCalls.filter(fact => isPermissionDeniedCall(fact.call, deniedErrorCodes));
  const unobservableEscapes = escapedCalls.filter(fact => !isSuccessfulToolCall(fact.call) && !fact.call.errorCode && !fact.call.blockedReason && !fact.call.resultText);
  const failures = [
    ...(successfulEscapes.length > 0 ? [`workspace escape succeeded: ${successfulEscapes.map(item => item.path).join(', ')}`] : []),
    ...(escapedArtifacts.length > 0 ? [`artifact manifest escaped workspace: ${escapedArtifacts.map(item => item.path).join(', ')}`] : []),
    ...(requireDeniedAttempt && deniedEscapes.length === 0 ? ['missing denied workspace escape attempt evidence'] : []),
    ...(unobservableEscapes.length > 0 ? [`workspace escape attempts lack denial evidence: ${unobservableEscapes.length}`] : []),
  ];

  if (failures.length > 0) {
    return result('workspace_boundary', 'fail', failures.join('; '), context.jsonl ? [context.jsonl.path] : [], 'tool', {
      escaped_calls: escapedCalls.length,
      denied_escapes: deniedEscapes.length,
      successful_escapes: successfulEscapes.length,
      escaped_artifacts: escapedArtifacts.length,
      unobservable_escapes: unobservableEscapes.length,
    });
  }

  return result('workspace_boundary', 'pass', 'workspace boundary was enforced', context.jsonl ? [context.jsonl.path] : [], undefined, {
    escaped_calls: escapedCalls.length,
    denied_escapes: deniedEscapes.length,
    escaped_artifacts: escapedArtifacts.length,
  });
}

function verifySkillActivationContract(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  if (!context.jsonl) {
    return result('skill_activation_contract', 'blocked', 'case has no JSONL input', [], context.caseSpec.failure_route);
  }

  const requiredSkills = stringList(config.required_skills ?? config.skills);
  const requiredPromptTexts = stringList(config.required_prompt_texts ?? config.prompt_texts);
  const requiredSystemPromptTexts = stringList(config.required_system_prompt_texts);
  const requiredAssistantTexts = stringList(config.required_assistant_texts);
  const requiredPostActivationTools = stringList(config.required_post_activation_tools);
  const minActivationToolCalls = asNumber(config.min_activation_tool_calls) ?? requiredSkills.length;
  const maxSystemPromptCountPerSkill = asNumber(config.max_system_prompt_count_per_skill) ?? 1;
  const requireToolSignal = config.require_tool_signal !== false;
  const requireSystemPrompt = config.require_system_prompt !== false;
  const caseSensitive = config.case_sensitive === true;

  const activations = collectSkillActivationEvidence(context.jsonl.entries, context.toolCalls);
  const assistantText = collectAssistantText(context);
  const skillToolCalls = context.toolCalls.filter(call => call.name === 'skill');
  const invalidSkillSignals = skillToolCalls.filter(call => !parseSkillActivationSignal(call.resultText));
  const evidenceText = [
    context.jsonl.content,
    assistantText,
    ...activations.map(item => `${item.skillName}\n${item.prompt}`),
  ].join('\n');
  const systemPromptText = activations
    .filter(item => item.source === 'system_prompt')
    .map(item => `${item.skillName}\n${item.prompt}`)
    .join('\n');

  const missingSkills = requiredSkills.filter(skill => !activations.some(item => item.skillName === skill));
  const missingToolSignals = requiredSkills.filter(skill => !activations.some(item => item.skillName === skill && item.source === 'tool_result'));
  const missingSystemPrompts = requiredSkills.filter(skill => !activations.some(item => item.skillName === skill && item.source === 'system_prompt'));
  const missingPromptTexts = requiredPromptTexts.filter(text => !includesText(evidenceText, text, caseSensitive));
  const missingSystemPromptTexts = requiredSystemPromptTexts.filter(text => !includesText(systemPromptText, text, caseSensitive));
  const missingAssistantTexts = requiredAssistantTexts.filter(text => !includesText(assistantText, text, caseSensitive));
  const systemPromptViolations = requiredSkills.filter((skill) => {
    const count = Math.max(...activations.filter(item => item.skillName === skill).map(item => item.systemPromptCount), 0);
    return count > maxSystemPromptCountPerSkill;
  });
  const toolNames = context.toolCalls.map(call => call.name);
  const missingPostActivationTools = requiredPostActivationTools.filter(name => !toolNames.includes(name));

  const failures = [
    ...(skillToolCalls.length < minActivationToolCalls ? [`skill tool calls ${skillToolCalls.length} < ${minActivationToolCalls}`] : []),
    ...(missingSkills.length > 0 ? [`missing skill activations: ${missingSkills.join(', ')}`] : []),
    ...(requireToolSignal && missingToolSignals.length > 0 ? [`missing activation tool signals: ${missingToolSignals.join(', ')}`] : []),
    ...(requireSystemPrompt && missingSystemPrompts.length > 0 ? [`missing system skill prompts: ${missingSystemPrompts.join(', ')}`] : []),
    ...(invalidSkillSignals.length > 0 ? [`invalid skill activation tool signals: ${invalidSkillSignals.map(call => call.id || call.name).join(', ')}`] : []),
    ...(missingPromptTexts.length > 0 ? [`missing prompt texts: ${missingPromptTexts.join(', ')}`] : []),
    ...(missingSystemPromptTexts.length > 0 ? [`missing system prompt texts: ${missingSystemPromptTexts.join(', ')}`] : []),
    ...(missingAssistantTexts.length > 0 ? [`missing assistant texts: ${missingAssistantTexts.join(', ')}`] : []),
    ...(systemPromptViolations.length > 0 ? [`system prompt count exceeded for: ${systemPromptViolations.join(', ')}`] : []),
    ...(missingPostActivationTools.length > 0 ? [`missing post-activation tools: ${missingPostActivationTools.join(', ')}`] : []),
  ];

  if (failures.length > 0) {
    return result('skill_activation_contract', 'fail', failures.join('; '), [context.jsonl.path], 'skill', {
      skill_tool_calls: skillToolCalls.length,
      activations: activations.length,
      missing_skills: missingSkills.length,
      missing_tool_signals: missingToolSignals.length,
      missing_system_prompts: missingSystemPrompts.length,
      missing_system_prompt_texts: missingSystemPromptTexts.length,
      invalid_skill_signals: invalidSkillSignals.length,
      system_prompt_violations: systemPromptViolations.length,
    });
  }

  return result('skill_activation_contract', 'pass', 'skill activation contract evidence is present', [context.jsonl.path], undefined, {
    skill_tool_calls: skillToolCalls.length,
    activations: activations.length,
    required_skills: requiredSkills.length,
    required_post_activation_tools: requiredPostActivationTools.length,
  });
}

function verifyCrossSkillHandoff(context: EvalVerifierContext, config: Record<string, unknown>): EvalVerifierResult {
  if (!context.jsonl) {
    return result('cross_skill_handoff', 'blocked', 'case has no JSONL input', [], context.caseSpec.failure_route);
  }

  const requiredSkillSequence = stringList(config.required_skill_sequence ?? config.skill_sequence)
    .map(normalizeSkillName)
    .filter(Boolean);
  const requiredHandoffs = asArray(config.required_handoffs ?? config.handoffs)
    .map(asSkillHandoffRequirement)
    .filter((item): item is Pick<SkillHandoffFact, 'fromSkill' | 'toSkill' | 'caseId'> => Boolean(item));
  const requiredTexts = stringList(config.required_texts ?? config.must_include);
  const forbiddenTexts = stringList(config.forbidden_texts ?? config.must_not_include);
  const requiredArtifacts = stringList(config.required_artifacts ?? config.required_artifact_refs ?? config.artifacts);
  const expectedFinalArtifact = asString(config.expected_final_artifact ?? config.final_artifact);
  const expectedFinalDecision = asString(config.expected_final_decision ?? config.final_decision);
  const requiredCaseId = asString(config.required_case_id ?? config.case_id);
  const caseSensitive = config.case_sensitive === true;

  if (
    requiredSkillSequence.length === 0
    && requiredHandoffs.length === 0
    && !expectedFinalArtifact
    && !expectedFinalDecision
  ) {
    return result('cross_skill_handoff', 'blocked', 'missing skill sequence, handoff, final artifact, or final decision config', [context.jsonl.path], context.caseSpec.failure_route);
  }

  const activations = collectSkillActivationEvidence(context.jsonl.entries, context.toolCalls);
  const skillNames = activations.map(item => normalizeSkillName(item.skillName)).filter(Boolean);
  const handoffs = collectSkillHandoffFacts(context.jsonl.entries);
  const finalArtifacts = collectSkillFinalArtifacts(context.jsonl.entries);
  const evidenceText = [
    context.jsonl.content,
    collectAssistantText(context),
    ...activations.map(item => `${normalizeSkillName(item.skillName)} ${item.prompt} ${item.source}`),
    ...handoffs.map(item => `${item.fromSkill}->${item.toSkill} ${item.caseId} ${item.reason} ${item.artifacts.join(' ')}`),
    ...finalArtifacts.map(item => `${item.skillName} ${item.caseId} ${item.artifact} ${item.decision} ${item.evidenceRefs.join(' ')}`),
    ...context.toolCalls.flatMap(call => [
      call.name,
      call.argumentsText,
      call.resultText,
      ...call.artifactManifest.map(item => `${item.path} ${item.type ?? ''} ${item.action ?? ''}`),
    ]),
  ].join('\n');

  const missingSequence = requiredSkillSequence.length > 0 && !containsSubsequence(skillNames, requiredSkillSequence);
  const missingHandoffs = requiredHandoffs.filter(required => !handoffs.some(actual => skillHandoffMatches(actual, required)));
  const missingTexts = requiredTexts.filter(item => !includesText(evidenceText, item, caseSensitive));
  const forbiddenHits = forbiddenTexts.filter(item => includesText(evidenceText, item, caseSensitive));
  const missingArtifacts = requiredArtifacts.filter(item => !includesText(evidenceText, item, caseSensitive));
  const missingCaseId = requiredCaseId && !includesText(evidenceText, requiredCaseId, caseSensitive);
  const finalArtifactFound = !expectedFinalArtifact || finalArtifacts.some(item => (
    includesText(item.artifact, expectedFinalArtifact, caseSensitive)
    && (!requiredCaseId || item.caseId === requiredCaseId)
  )) || includesText(evidenceText, expectedFinalArtifact, caseSensitive);
  const finalDecisionFound = !expectedFinalDecision || finalArtifacts.some(item => (
    includesText(item.decision, expectedFinalDecision, caseSensitive)
    && (!requiredCaseId || item.caseId === requiredCaseId)
  )) || includesText(evidenceText, `Decision: ${expectedFinalDecision}`, caseSensitive);

  const failures = [
    ...(missingSequence ? [`missing skill sequence: ${requiredSkillSequence.join(' -> ')}`] : []),
    ...(missingHandoffs.length > 0 ? [`missing skill handoffs: ${missingHandoffs.map(item => `${item.fromSkill}->${item.toSkill}${item.caseId ? `:${item.caseId}` : ''}`).join(', ')}`] : []),
    ...(missingTexts.length > 0 ? [`missing required text: ${missingTexts.join(', ')}`] : []),
    ...(forbiddenHits.length > 0 ? [`forbidden text: ${forbiddenHits.join(', ')}`] : []),
    ...(missingArtifacts.length > 0 ? [`missing artifacts: ${missingArtifacts.join(', ')}`] : []),
    ...(missingCaseId ? [`missing case id: ${requiredCaseId}`] : []),
    ...(!finalArtifactFound ? [`missing final artifact: ${expectedFinalArtifact}`] : []),
    ...(!finalDecisionFound ? [`missing final decision: ${expectedFinalDecision}`] : []),
  ];

  if (failures.length > 0) {
    return result('cross_skill_handoff', 'fail', failures.join('; '), [context.jsonl.path], 'skill', {
      activations: activations.length,
      skills_seen: skillNames.length,
      handoffs_seen: handoffs.length,
      final_artifacts: finalArtifacts.length,
      missing_handoffs: missingHandoffs.length,
      missing_required_texts: missingTexts.length,
      missing_artifacts: missingArtifacts.length,
      forbidden_text_hits: forbiddenHits.length,
    });
  }

  return result('cross_skill_handoff', 'pass', 'cross-skill handoff chain is complete', [context.jsonl.path], undefined, {
    activations: activations.length,
    required_skills: requiredSkillSequence.length,
    handoffs_seen: handoffs.length,
    final_artifacts: finalArtifacts.length,
    required_artifacts: requiredArtifacts.length,
  });
}

async function runSoftJudges(
  context: EvalVerifierContext,
  softJudges: EvalCase['soft_judges'],
): Promise<EvalJudgeResult[]> {
  const results: EvalJudgeResult[] = [];
  for (const rawSpec of softJudges ?? []) {
    const spec = normalizeJudgeSpec(rawSpec);
    const judge = JUDGES[spec.id];
    if (!judge) {
      results.push(judgeResult(spec.id || 'unknown_judge', 'blocked', 0, judgeMinScore(spec, 1), `unknown judge: ${spec.id}`, []));
      continue;
    }
    results.push(await judge(context, spec));
  }
  return results;
}

function judgeSemanticTextQuality(context: EvalVerifierContext, spec: EvalJudgeSpec): EvalJudgeResult {
  const config = spec.config ?? {};
  const caseSensitive = config.case_sensitive === true;
  const requiredTexts = stringList(config.required_texts ?? config.texts ?? config.must_include);
  const forbiddenTexts = stringList(config.forbidden_texts ?? config.must_not_include);
  const assistantText = collectUserVisibleText(context, config.include_delivery_tools === true);
  const minScore = judgeMinScore(spec, 0.75);

  if (requiredTexts.length === 0 && forbiddenTexts.length === 0) {
    return judgeResult(spec.id, 'blocked', 0, minScore, 'semantic_text_quality requires required_texts or forbidden_texts', [], {
      required_texts: 0,
      forbidden_texts: 0,
    });
  }

  const missingRequired = requiredTexts.filter(item => !includesText(assistantText, item, caseSensitive));
  const forbiddenHits = forbiddenTexts.filter(item => includesText(assistantText, item, caseSensitive));
  const components = [
    ...(requiredTexts.length > 0 ? [(requiredTexts.length - missingRequired.length) / requiredTexts.length] : []),
    ...(forbiddenTexts.length > 0 ? [forbiddenHits.length === 0 ? 1 : 0] : []),
  ];
  const score = roundScore(components.reduce((sum, item) => sum + item, 0) / components.length);
  const status = score >= minScore ? 'pass' : 'fail';
  const message = status === 'pass'
    ? `semantic text score ${score} >= ${minScore}`
    : `semantic text score ${score} < ${minScore}; missing=${missingRequired.join(', ') || 'none'}; forbidden=${forbiddenHits.join(', ') || 'none'}`;

  return judgeResult(spec.id, status, score, minScore, message, context.jsonl ? [context.jsonl.path] : [], {
    required_texts: requiredTexts.length,
    missing_required_texts: missingRequired.length,
    forbidden_texts: forbiddenTexts.length,
    forbidden_hits: forbiddenHits.length,
  });
}

function judgeEvidenceReferenceQuality(context: EvalVerifierContext, spec: EvalJudgeSpec): EvalJudgeResult {
  const config = spec.config ?? {};
  const requiredRefs = stringList(config.required_refs ?? config.refs ?? config.required_artifacts);
  const expectedRefs = requiredRefs.length > 0
    ? requiredRefs
    : (context.caseSpec.required_artifacts ?? []).map(item => item.path);
  const minScore = judgeMinScore(spec, 1);

  if (expectedRefs.length === 0) {
    return judgeResult(spec.id, 'blocked', 0, minScore, 'evidence_reference_quality requires refs or case required_artifacts', [], {
      required_refs: 0,
    });
  }

  const scanScope = asString(config.scan_scope) || 'trace';
  const evidenceText = scanScope === 'assistant'
    ? collectAssistantText(context)
    : collectJudgeEvidenceText(context);
  const caseSensitive = config.case_sensitive === true;
  const missingRefs = expectedRefs.filter(item => !includesText(evidenceText, item, caseSensitive));
  const score = roundScore((expectedRefs.length - missingRefs.length) / expectedRefs.length);
  const status = score >= minScore ? 'pass' : 'fail';
  const message = status === 'pass'
    ? `evidence reference score ${score} >= ${minScore}`
    : `evidence reference score ${score} < ${minScore}; missing=${missingRefs.join(', ')}`;

  return judgeResult(spec.id, status, score, minScore, message, context.jsonl ? [context.jsonl.path] : [], {
    required_refs: expectedRefs.length,
    missing_refs: missingRefs.length,
  });
}

function judgeCollaborationQuality(context: EvalVerifierContext, spec: EvalJudgeSpec): EvalJudgeResult {
  const config = spec.config ?? {};
  const requiredTexts = stringList(config.required_texts ?? config.texts);
  const effectiveRequiredTexts = requiredTexts.length > 0
    ? requiredTexts
    : ['Decision:', 'Evidence:', 'Residual risk:'];
  return judgeSemanticTextQuality(context, {
    ...spec,
    config: {
      ...config,
      required_texts: effectiveRequiredTexts,
    },
    min_score: judgeMinScore(spec, 0.67),
  });
}

async function judgeExternalModel(context: EvalVerifierContext, spec: EvalJudgeSpec): Promise<EvalJudgeResult> {
  const minScore = judgeMinScore(spec, 0.75);
  if (!spec.provider) {
    return judgeResult(spec.id, 'blocked', 0, minScore, 'external_model_judge requires provider config', []);
  }

  const request: EvalExternalJudgeRequest = {
    judge_id: spec.id,
    suite_id: context.suite.suite_id,
    case_id: context.caseSpec.case_id,
    case_name: context.caseSpec.name,
    lane: context.caseSpec.lane,
    target_module: context.caseSpec.target_module,
    risk_level: context.caseSpec.risk_level,
    failure_route: context.caseSpec.failure_route,
    task: context.caseSpec.task,
    prompt: spec.prompt || asString(spec.config?.prompt),
    min_score: minScore,
    rubric: spec.rubric ?? rubricFromConfig(spec.config),
    hard_verifiers: (context.verifierResults ?? []).map(item => ({
      id: item.id,
      status: item.status,
      message: item.message,
    })),
    assistant_text: collectAssistantText(context),
    evidence_text: collectJudgeEvidenceText(context),
    evidence_refs: collectJudgeEvidenceRefs(context),
    modalities: spec.provider.modalities ?? ['text'],
  };

  try {
    const providerResult = await runExternalEvalJudgeProvider({
      provider: spec.provider,
      request,
      suiteDir: context.suiteDir,
      artifactDir: path.join(
        context.outDir,
        'judges',
        safePathSegment(context.caseSpec.case_id),
        safePathSegment(spec.id),
      ),
    });
    const response = providerResult.response;
    const status = response.status === 'pass' && response.score < minScore
      ? 'fail'
      : response.status ?? (response.score >= minScore ? 'pass' : 'fail');
    const message = status === 'pass'
      ? `external model judge score ${response.score} >= ${minScore}: ${response.rationale}`
      : `external model judge ${status}: score ${response.score} < ${minScore}; ${response.rationale}`;

    return {
      ...judgeResult(spec.id, status, response.score, minScore, message, providerResult.evidence_refs, {
        provider_type: spec.provider.type,
        ...(response.metrics ?? {}),
      }),
      provider: providerResult.provider_name,
      confidence: response.confidence,
    };
  } catch (error) {
    return judgeResult(
      spec.id,
      'blocked',
      0,
      minScore,
      `external model judge failed: ${error instanceof Error ? error.message : String(error)}`,
      [],
      { provider_type: spec.provider.type },
    );
  }
}

function decideCase(caseSpec: EvalCase, results: EvalVerifierResult[], judgeResults: EvalJudgeResult[]): EvalDecision {
  if (caseSpec.quarantine) return 'quarantine';
  if (results.some(item => item.status === 'fail')) return 'fail';
  if (results.some(item => item.status === 'blocked')) return 'blocked';
  if (judgeResults.some(item => item.status === 'fail')) return 'fail';
  if (judgeResults.some(item => item.status === 'blocked')) return 'blocked';
  return 'pass';
}

function findFailureRoute(
  caseSpec: EvalCase,
  results: EvalVerifierResult[],
  judgeResults: EvalJudgeResult[],
): EvalFailureRoute | undefined {
  return results.find(item => item.status === 'fail' || item.status === 'blocked')?.failure_route
    ?? (judgeResults.some(item => item.status === 'fail' || item.status === 'blocked') ? caseSpec.failure_route : undefined)
    ?? caseSpec.failure_route;
}

function result(
  id: string,
  status: EvalVerifierResult['status'],
  message: string,
  evidenceRefs: string[],
  failureRoute?: EvalFailureRoute,
  metrics?: Record<string, number | string | boolean>,
): EvalVerifierResult {
  return {
    id,
    status,
    hard: true,
    message,
    evidence_refs: evidenceRefs,
    metrics,
    failure_route: status === 'pass' ? undefined : failureRoute,
  };
}

function normalizeJudgeSpec(rawSpec: string | EvalJudgeSpec): EvalJudgeSpec {
  if (typeof rawSpec === 'string') {
    return { id: rawSpec };
  }
  return rawSpec;
}

function judgeMinScore(spec: EvalJudgeSpec, fallback: number): number {
  return asNumber(spec.min_score) ?? asNumber(spec.config?.min_score) ?? fallback;
}

function judgeResult(
  id: string,
  status: EvalJudgeResult['status'],
  score: number,
  minScore: number,
  message: string,
  evidenceRefs: string[],
  metrics?: Record<string, number | string | boolean>,
): EvalJudgeResult {
  return {
    id,
    status,
    hard: false,
    score: roundScore(Math.max(0, Math.min(1, score))),
    max_score: 1,
    min_score: minScore,
    message,
    evidence_refs: evidenceRefs,
    metrics,
  };
}

function hasToolResultEvidence(call: ToolCallFact): boolean {
  return Boolean(call.resultText || call.status || call.errorCode || call.blockedReason);
}

function isSuccessfulToolCall(call: ToolCallFact): boolean {
  if (call.errorCode || isFailureToolCall(call)) return false;
  if (!call.status) return hasToolResultEvidence(call);
  return call.status === 'success' || call.status === 'ok' || call.status === 'sent';
}

function isFailureToolCall(call: ToolCallFact): boolean {
  if (FAILURE_STATUSES.has(call.status)) return true;
  if (call.status && FINAL_TOOL_STATUSES.has(call.status)) return false;
  return hasFailureSignal(call.resultText);
}

function hasFailureSignal(value: string): boolean {
  if (!value) return false;
  if (/\b(?:status|decision|validation_status|result)\s*[:=]\s*(?:fail|failed|failure|error|blocked|timeout|cancel|cancelled)\b/i.test(value)) {
    return true;
  }
  if (/\berror(?:_code)?\s*[:=]\s*(?!0\b|none\b|null\b|false\b)[^\s,;]+/i.test(value)) {
    return true;
  }
  if (/\b(?:failed|failures?|hardFailures|blocked|cancelled|cancellations?|timeouts?|errors?)\s*[:=]\s*[1-9]\d*/i.test(value)) {
    return true;
  }

  const withoutZeroCounters = value
    .replace(/\b(?:failed|failures?|hardFailures|blocked|cancelled|cancellations?|timeouts?|errors?)\s*[:=]\s*0\b/gi, '')
    .replace(/\berror(?:_code)?\s*[:=]\s*(?:0|none|null|false)\b/gi, '');
  return /\b(?:failed|failure|error|timeout|denied|exception|blocked|cancelled?)\b/i.test(withoutZeroCounters);
}

function deliveryCallContains(call: ToolCallFact, expected: string): boolean {
  const needle = expected.toLowerCase();
  return [
    call.argumentsText,
    call.resultText,
    ...call.artifactManifest.map(item => `${item.path} ${item.type ?? ''} ${item.action ?? ''}`),
  ].some(value => value.toLowerCase().includes(needle));
}

function fileDeliveryMatches(call: ToolCallFact, expected: string): boolean {
  const normalizedExpected = normalizePath(expected).toLowerCase();
  const manifestMatches = call.artifactManifest.some(item => normalizePath(item.path).toLowerCase().includes(normalizedExpected));
  if (manifestMatches) return true;
  return deliveryCallContains(call, expected);
}

function collectAssistantText(context: EvalVerifierContext): string {
  return (context.jsonl?.entries ?? [])
    .map(entry => asRecord(entry.assistant)?.text)
    .filter((item): item is string => typeof item === 'string')
    .join('\n');
}

function collectUserVisibleText(context: EvalVerifierContext, includeDeliveryTools: boolean): string {
  if (!includeDeliveryTools) return collectAssistantText(context);
  return [
    collectAssistantText(context),
    collectDeliveryToolText(context),
  ].filter(Boolean).join('\n');
}

function collectDeliveryToolText(context: EvalVerifierContext): string {
  return context.toolCalls
    .filter(call => call.name === 'send_text')
    .flatMap(call => [
      asString(asRecord(safeJsonParse(call.argumentsText))?.text),
      ...call.deliveryEvidence.map(item => item.textPreview ?? ''),
    ])
    .filter(Boolean)
    .join('\n');
}

function collectJudgeEvidenceText(context: EvalVerifierContext): string {
  return [
    collectAssistantText(context),
    context.jsonl?.content ?? '',
    ...context.toolCalls.flatMap(call => [
      call.argumentsText,
      call.resultText,
      ...call.artifactManifest.map(item => `${item.path} ${item.type ?? ''} ${item.action ?? ''}`),
    ]),
  ].join('\n');
}

function collectJudgeEvidenceRefs(context: EvalVerifierContext): string[] {
  const refs = new Set<string>();
  if (context.jsonl?.path) refs.add(context.jsonl.path);
  for (const verifier of context.verifierResults ?? []) {
    for (const ref of verifier.evidence_refs) {
      refs.add(ref);
    }
  }
  for (const artifact of context.caseSpec.required_artifacts ?? []) {
    refs.add(artifact.path);
  }
  for (const call of context.toolCalls) {
    for (const artifact of call.artifactManifest) {
      refs.add(artifact.path);
    }
  }
  return [...refs];
}

function collectSurfaceRuntimeEntries(context: EvalVerifierContext): Array<{
  surface: string;
  runtimeId: string;
  statusCode: number;
  sessionKey: string;
  channelId: string;
  userMessage: string;
  visibleDeliveryCount: number;
  fileDeliveryCount: number;
  fileNames: string[];
  fileArtifactPaths: string[];
  deliveryEvidence: DeliveryEvidenceItem[];
  externalReceipts: SurfaceExternalReceipt[];
  eventTypes: string[];
  requestArtifactPath: string;
  responseArtifactPath: string;
  eventsArtifactPath: string;
}> {
  return (context.jsonl?.entries ?? []).flatMap((entry) => {
    const runtime = asRecord(entry.surface_runtime);
    if (!runtime) return [];
    const fileNames = [
      ...stringList(runtime.file_names ?? runtime.fileNames),
      ...asArray(runtime.files)
        .map(item => asString(asRecord(item)?.fileName ?? asRecord(item)?.file_name))
        .filter(Boolean),
    ];
    const surface = asString(runtime.surface) || asString(entry.surface);
    const runtimeId = asString(runtime.runtime_id);
    return [{
      surface,
      runtimeId,
      statusCode: asNumber(runtime.status_code) ?? 0,
      sessionKey: asString(runtime.session_key),
      channelId: asString(runtime.channel_id),
      userMessage: asString(runtime.user_message) || asString(asRecord(entry.user)?.text),
      visibleDeliveryCount: asNumber(runtime.visible_delivery_count) ?? 0,
      fileDeliveryCount: asNumber(runtime.file_delivery_count ?? runtime.file_deliveries) ?? 0,
      fileNames,
      fileArtifactPaths: stringList(runtime.file_artifact_paths ?? runtime.fileArtifacts),
      deliveryEvidence: parseDeliveryEvidence(runtime.delivery_evidence),
      externalReceipts: parseExternalDeliveryReceipts(runtime.external_delivery_receipts, `surface_runtime:${surface}:${runtimeId}`, surface),
      eventTypes: stringList(runtime.event_types),
      requestArtifactPath: asString(runtime.request_artifact_path),
      responseArtifactPath: asString(runtime.response_artifact_path),
      eventsArtifactPath: asString(runtime.events_artifact_path),
    }];
  });
}

function collectSurfaceRuntimeDeliveryEvidence(context: EvalVerifierContext): SurfaceRuntimeDeliveryEvidenceFact[] {
  return collectSurfaceRuntimeEntries(context).flatMap(runtime =>
    runtime.deliveryEvidence.map(item => ({
      surface: runtime.surface,
      runtimeId: runtime.runtimeId,
      fileArtifactPaths: runtime.fileArtifactPaths,
      item,
    }))
  );
}

function collectSurfaceRuntimeExternalReceipts(context: EvalVerifierContext): SurfaceRuntimeExternalReceiptFact[] {
  return collectSurfaceRuntimeEntries(context).flatMap(runtime =>
    runtime.externalReceipts.map(item => ({
      surface: runtime.surface,
      runtimeId: runtime.runtimeId,
      item,
    }))
  );
}

function surfaceExternalReceiptStatusPassed(status: string): boolean {
  return ['accepted', 'available', 'delivered', 'ok', 'pass', 'passed', 'sent', 'success'].includes(status.toLowerCase());
}

function surfaceExternalReceiptHasPlatformId(receipt: SurfaceExternalReceipt): boolean {
  if (receipt.receiptType === 'message') return Boolean(receipt.platformMessageId);
  if (receipt.receiptType === 'file') return Boolean(receipt.platformMessageId || receipt.platformFileKey);
  if (receipt.receiptType === 'upload' || receipt.receiptType === 'download') return Boolean(receipt.platformFileKey);
  return Boolean(receipt.platformMessageId || receipt.platformFileKey || receipt.deliveryId);
}

function surfaceRuntimeFileMatches(runtime: ReturnType<typeof collectSurfaceRuntimeEntries>[number], expected: string): boolean {
  return runtime.fileNames.some(fileName => surfaceRuntimePathOrNameMatches(fileName, expected))
    || runtime.fileArtifactPaths.some(filePath => surfaceRuntimePathOrNameMatches(filePath, expected));
}

function surfaceRuntimePathOrNameMatches(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const normalizedActual = normalizePath(actual).toLowerCase();
  const normalizedExpected = normalizePath(expected).toLowerCase();
  return normalizedActual === normalizedExpected
    || normalizedActual.endsWith(`/${normalizedExpected}`)
    || path.basename(normalizedActual) === path.basename(normalizedExpected)
    || normalizedActual.includes(normalizedExpected);
}

function surfaceRuntimeArtifactExists(context: EvalVerifierContext, artifactPath: string): boolean {
  if (!artifactPath || !context.caseSpec.inputs?.artifacts_dir) {
    return false;
  }
  const artifactsDir = resolveSuiteRelativePath(context.suiteDir, context.caseSpec.inputs.artifacts_dir);
  return fs.existsSync(path.resolve(artifactsDir, artifactPath));
}

function isPermissionDeniedCall(call: ToolCallFact, requiredErrorCodes: string[] = []): boolean {
  const errorCode = call.errorCode.toLowerCase();
  const evidence = `${call.status} ${call.errorCode} ${call.blockedReason} ${call.resultText}`.toLowerCase();
  if (requiredErrorCodes.length > 0) {
    return requiredErrorCodes.some(code => errorCode === code.toLowerCase() || evidence.includes(code.toLowerCase()));
  }
  return /permission|denied|unauthorized|forbidden|path_denied|path_outside|outside_workspace|escape/.test(evidence);
}

function collectWorkspaceBoundaryFacts(toolCalls: ToolCallFact[]): Array<{
  kind: 'tool_args' | 'artifact_manifest';
  path: string;
  call: ToolCallFact;
}> {
  const facts: Array<{ kind: 'tool_args' | 'artifact_manifest'; path: string; call: ToolCallFact }> = [];
  for (const call of toolCalls) {
    for (const candidate of extractPathCandidates(call.argumentsText)) {
      if (isUnsafeWorkspacePath(candidate)) {
        facts.push({ kind: 'tool_args', path: candidate, call });
      }
    }
    for (const artifact of call.artifactManifest) {
      if (isUnsafeWorkspacePath(artifact.path)) {
        facts.push({ kind: 'artifact_manifest', path: artifact.path, call });
      }
    }
  }
  return facts;
}

function extractPathCandidates(text: string): string[] {
  const candidates = new Set<string>();
  const quoted = text.match(/(?:"(?:file_path|path|cwd|target|destination)"\s*:\s*"([^"]+)"|'(?:file_path|path|cwd|target|destination)'\s*:\s*'([^']+)')/g) ?? [];
  for (const item of quoted) {
    const match = item.match(/["'](?:file_path|path|cwd|target|destination)["']\s*:\s*["']([^"']+)["']/);
    if (match?.[1]) candidates.add(match[1]);
  }

  for (const match of text.matchAll(/(?:^|[\s"'])((?:\.\.\/|\/|~\/)[^"'\s,)}\]]+)/g)) {
    if (match[1]) candidates.add(match[1]);
  }
  return [...candidates];
}

function isUnsafeWorkspacePath(value: string): boolean {
  const normalized = normalizePath(value.trim());
  if (!normalized) return false;
  if (normalized.startsWith('/') || normalized.startsWith('~/') || /^[A-Za-z]:\//.test(normalized)) return true;
  return normalized.split('/').some(segment => segment === '..');
}

function rubricFromConfig(config: Record<string, unknown> | undefined): NonNullable<EvalJudgeSpec['rubric']> {
  const rawRubric = asArray(config?.rubric);
  const fromObjects = rawRubric
    .map(item => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map(item => ({
      id: asString(item.id) || asString(item.name),
      description: asString(item.description) || asString(item.text),
      weight: asNumber(item.weight),
    }))
    .filter(item => item.id && item.description);
  if (fromObjects.length > 0) {
    return fromObjects;
  }

  return stringList(config?.criteria).map((description, index) => ({
    id: `criterion_${index + 1}`,
    description,
  }));
}

function collectRoleIds(entries: Record<string, unknown>[]): string[] {
  const roleIds = new Set<string>();
  for (const entry of entries) {
    const directKeys = ['role_id', 'active_role', 'target_role'];
    for (const key of directKeys) {
      const roleId = asString(entry[key]);
      if (roleId) roleIds.add(roleId);
    }

    const roleValue = entry.role;
    if (typeof roleValue === 'string') {
      roleIds.add(roleValue);
    } else {
      const roleRecord = asRecord(roleValue);
      const roleId = asString(roleRecord?.id) || asString(roleRecord?.name);
      if (roleId) roleIds.add(roleId);
    }

    const assistant = asRecord(entry.assistant);
    const assistantRoleId = asString(assistant?.role_id) || asString(assistant?.active_role);
    if (assistantRoleId) roleIds.add(assistantRoleId);
  }
  return [...roleIds];
}

function normalizeRoleId(value: string): string {
  const lower = value.trim().toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, '');
  if (compact === 'inspectorcat') return 'inspector-cat';
  if (compact === 'engineercat') return 'engineer-cat';
  if (compact === 'reviewercat') return 'reviewer-cat';
  if (compact === 'researchercat') return 'researcher-cat';
  return lower.replace(/\s+/g, '-');
}

function asRoleHandoffRequirement(value: unknown): Pick<RoleHandoffFact, 'fromRole' | 'toRole' | 'caseId'> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const fromRole = normalizeRoleId(asString(record.from_role) || asString(record.fromRole) || asString(record.from));
  const toRole = normalizeRoleId(asString(record.to_role) || asString(record.toRole) || asString(record.to));
  if (!fromRole || !toRole) return undefined;
  return {
    fromRole,
    toRole,
    caseId: asString(record.case_id) || asString(record.caseId) || asString(record.id),
  };
}

function roleHandoffMatches(actual: RoleHandoffFact, required: Pick<RoleHandoffFact, 'fromRole' | 'toRole' | 'caseId'>): boolean {
  if (actual.fromRole !== required.fromRole || actual.toRole !== required.toRole) return false;
  return !required.caseId || actual.caseId === required.caseId;
}

function collectRoleHandoffFacts(entries: Record<string, unknown>[]): RoleHandoffFact[] {
  const facts: RoleHandoffFact[] = [];
  for (const entry of entries) {
    const turnRef = asString(entry.trace_id) || asString(entry.turn_id) || asString(entry.entry_type) || 'entry';
    const assistant = asRecord(entry.assistant);
    const runtimeEvent = asRecord(entry.runtime_event);
    const event = asRecord(entry.event);

    for (const raw of [
      entry.role_handoff,
      entry.handoff,
      assistant?.role_handoff,
      assistant?.handoff,
      runtimeEvent?.role_handoff,
      event?.role_handoff,
    ]) {
      const fact = asRoleHandoffFact(raw, turnRef);
      if (fact) facts.push(fact);
    }

    for (const raw of [
      ...asArray(entry.role_handoffs),
      ...asArray(entry.handoffs),
      ...asArray(assistant?.role_handoffs),
      ...asArray(assistant?.handoffs),
      ...asArray(entry.runtime_events).flatMap(item => asArray(asRecord(item)?.role_handoffs)),
    ]) {
      const fact = asRoleHandoffFact(raw, turnRef);
      if (fact) facts.push(fact);
    }
  }
  return facts;
}

function asRoleHandoffFact(value: unknown, source: string): RoleHandoffFact | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const fromRole = normalizeRoleId(
    asString(record.from_role)
    || asString(record.fromRole)
    || asString(record.from)
    || asString(record.source_role)
    || asString(record.sourceRole),
  );
  const toRole = normalizeRoleId(
    asString(record.to_role)
    || asString(record.toRole)
    || asString(record.to)
    || asString(record.target_role)
    || asString(record.targetRole)
    || asString(record.owner)
    || asString(record.assignee),
  );
  if (!fromRole || !toRole) return undefined;
  return {
    fromRole,
    toRole,
    caseId: asString(record.case_id) || asString(record.caseId) || asString(record.id),
    reason: asString(record.reason) || asString(record.summary),
    artifacts: roleArtifactRefs(record.artifacts ?? record.artifact_refs ?? record.evidence_refs ?? record.evidence),
    source,
  };
}

function collectRoleReviewDecisions(entries: Record<string, unknown>[]): RoleReviewDecision[] {
  const decisions: RoleReviewDecision[] = [];
  for (const entry of entries) {
    const turnRef = asString(entry.trace_id) || asString(entry.turn_id) || asString(entry.entry_type) || 'entry';
    const assistant = asRecord(entry.assistant);
    const fallbackRole = asString(entry.role_id) || asString(assistant?.role_id) || asString(entry.active_role);
    for (const raw of [
      entry.review_decision,
      entry.reviewer_decision,
      assistant?.review_decision,
      assistant?.reviewer_decision,
    ]) {
      const decision = asRoleReviewDecision(raw, fallbackRole, turnRef);
      if (decision) decisions.push(decision);
    }
  }
  return decisions;
}

function asRoleReviewDecision(value: unknown, fallbackRole: string, source: string): RoleReviewDecision | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const decision = asString(record.decision) || asString(record.status) || asString(record.result);
  if (!decision) return undefined;
  return {
    roleId: normalizeRoleId(asString(record.role_id) || asString(record.roleId) || fallbackRole),
    caseId: asString(record.case_id) || asString(record.caseId) || asString(record.id),
    decision,
    evidenceRefs: roleArtifactRefs(record.evidence_refs ?? record.evidence ?? record.artifacts),
    source,
  };
}

function roleArtifactRefs(value: unknown): string[] {
  const strings = stringList(value);
  if (strings.length > 0) return strings;
  const refs = asArray(value).flatMap((item) => {
    const record = asRecord(item);
    if (!record) return typeof item === 'string' ? [item] : [];
    return [
      asString(record.path),
      asString(record.file),
      asString(record.name),
    ].filter(Boolean);
  });
  return [...new Set(refs)];
}

function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

function asSkillHandoffRequirement(value: unknown): Pick<SkillHandoffFact, 'fromSkill' | 'toSkill' | 'caseId'> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const fromSkill = normalizeSkillName(
    asString(record.from_skill)
    || asString(record.fromSkill)
    || asString(record.from)
    || asString(record.source_skill)
    || asString(record.sourceSkill),
  );
  const toSkill = normalizeSkillName(
    asString(record.to_skill)
    || asString(record.toSkill)
    || asString(record.to)
    || asString(record.target_skill)
    || asString(record.targetSkill),
  );
  if (!fromSkill || !toSkill) return undefined;
  return {
    fromSkill,
    toSkill,
    caseId: asString(record.case_id) || asString(record.caseId) || asString(record.id),
  };
}

function skillHandoffMatches(actual: SkillHandoffFact, required: Pick<SkillHandoffFact, 'fromSkill' | 'toSkill' | 'caseId'>): boolean {
  if (actual.fromSkill !== required.fromSkill || actual.toSkill !== required.toSkill) return false;
  return !required.caseId || actual.caseId === required.caseId;
}

function collectSkillHandoffFacts(entries: Record<string, unknown>[]): SkillHandoffFact[] {
  const facts: SkillHandoffFact[] = [];
  for (const entry of entries) {
    const turnRef = asString(entry.trace_id) || asString(entry.turn_id) || asString(entry.entry_type) || 'entry';
    const assistant = asRecord(entry.assistant);
    const runtimeEvent = asRecord(entry.runtime_event);
    const event = asRecord(entry.event);

    for (const raw of [
      entry.skill_handoff,
      entry.handoff,
      assistant?.skill_handoff,
      assistant?.handoff,
      runtimeEvent?.skill_handoff,
      event?.skill_handoff,
    ]) {
      const fact = asSkillHandoffFact(raw, turnRef);
      if (fact) facts.push(fact);
    }

    for (const raw of [
      ...asArray(entry.skill_handoffs),
      ...asArray(entry.handoffs),
      ...asArray(assistant?.skill_handoffs),
      ...asArray(assistant?.handoffs),
      ...asArray(entry.runtime_events).flatMap(item => asArray(asRecord(item)?.skill_handoffs)),
    ]) {
      const fact = asSkillHandoffFact(raw, turnRef);
      if (fact) facts.push(fact);
    }
  }
  return facts;
}

function asSkillHandoffFact(value: unknown, source: string): SkillHandoffFact | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const fromSkill = normalizeSkillName(
    asString(record.from_skill)
    || asString(record.fromSkill)
    || asString(record.from)
    || asString(record.source_skill)
    || asString(record.sourceSkill),
  );
  const toSkill = normalizeSkillName(
    asString(record.to_skill)
    || asString(record.toSkill)
    || asString(record.to)
    || asString(record.target_skill)
    || asString(record.targetSkill)
    || asString(record.owner)
    || asString(record.assignee),
  );
  if (!fromSkill || !toSkill) return undefined;
  return {
    fromSkill,
    toSkill,
    caseId: asString(record.case_id) || asString(record.caseId) || asString(record.id),
    reason: asString(record.reason) || asString(record.summary),
    artifacts: skillArtifactRefs(record.artifacts ?? record.artifact_refs ?? record.evidence_refs ?? record.evidence),
    source,
  };
}

function collectSkillFinalArtifacts(entries: Record<string, unknown>[]): SkillFinalArtifact[] {
  const artifacts: SkillFinalArtifact[] = [];
  for (const entry of entries) {
    const turnRef = asString(entry.trace_id) || asString(entry.turn_id) || asString(entry.entry_type) || 'entry';
    const assistant = asRecord(entry.assistant);
    const fallbackSkill = asString(entry.skill_name) || asString(entry.active_skill) || asString(assistant?.skill_name);

    for (const raw of [
      entry.skill_final_artifact,
      entry.final_skill_artifact,
      entry.skill_decision,
      assistant?.skill_final_artifact,
      assistant?.final_skill_artifact,
      assistant?.skill_decision,
    ]) {
      const artifact = asSkillFinalArtifact(raw, fallbackSkill, turnRef);
      if (artifact) artifacts.push(artifact);
    }

    for (const raw of [
      ...asArray(entry.skill_final_artifacts),
      ...asArray(entry.final_skill_artifacts),
      ...asArray(assistant?.skill_final_artifacts),
      ...asArray(assistant?.final_skill_artifacts),
    ]) {
      const artifact = asSkillFinalArtifact(raw, fallbackSkill, turnRef);
      if (artifact) artifacts.push(artifact);
    }
  }
  return artifacts;
}

function asSkillFinalArtifact(value: unknown, fallbackSkill: string, source: string): SkillFinalArtifact | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const artifact = asString(record.artifact)
    || asString(record.artifact_path)
    || asString(record.artifactPath)
    || asString(record.path)
    || asString(record.scorecard);
  const decision = asString(record.decision) || asString(record.status) || asString(record.result);
  const evidenceRefs = skillArtifactRefs(record.evidence_refs ?? record.evidence ?? record.artifacts);
  if (!artifact && !decision && evidenceRefs.length === 0) return undefined;
  return {
    skillName: normalizeSkillName(asString(record.skill_name) || asString(record.skillName) || fallbackSkill),
    caseId: asString(record.case_id) || asString(record.caseId) || asString(record.id),
    artifact,
    decision,
    evidenceRefs,
    source,
  };
}

function skillArtifactRefs(value: unknown): string[] {
  return roleArtifactRefs(value);
}

function collectStateBoundaryFacts(entries: Record<string, unknown>[]): StateBoundaryFact[] {
  const facts: StateBoundaryFact[] = [];
  for (const [index, entry] of entries.entries()) {
    facts.push(
      ...collectStateBoundaryFactsFromValue(entry.state_boundary, `entry:${index}:state_boundary`),
      ...collectStateBoundaryFactsFromValue(entry.state_boundaries, `entry:${index}:state_boundaries`),
    );

    const state = asRecord(entry.state);
    facts.push(...collectStateBoundaryFactsFromValue(state?.state_boundary, `entry:${index}:state.state_boundary`));

    const runtimeEvent = asRecord(entry.runtime_event);
    facts.push(...collectStateBoundaryFactsFromValue(runtimeEvent?.state_boundary, `entry:${index}:runtime_event.state_boundary`));

    const event = asRecord(entry.event);
    facts.push(...collectStateBoundaryFactsFromValue(event?.state_boundary, `entry:${index}:event.state_boundary`));

    for (const [eventIndex, item] of asArray(entry.runtime_events).entries()) {
      const record = asRecord(item);
      facts.push(...collectStateBoundaryFactsFromValue(
        record?.state_boundary,
        `entry:${index}:runtime_events:${eventIndex}:state_boundary`,
      ));
    }
  }
  return facts;
}

function collectStateBoundaryFactsFromValue(value: unknown, source: string): StateBoundaryFact[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectStateBoundaryFactsFromValue(item, `${source}:${index}`));
  }

  const record = asRecord(value);
  if (!record) return [];

  const directBoundary = normalizeStateBoundaryName(record.boundary ?? record.name ?? record.type);
  if (directBoundary) {
    const fact = stateBoundaryFactFromRecord(directBoundary, record, source);
    return fact ? [fact] : [];
  }

  return Object.entries(record).flatMap(([key, child]) => {
    const childRecord = asRecord(child);
    if (childRecord) {
      const fact = stateBoundaryFactFromRecord(key, childRecord, `${source}.${key}`);
      return fact ? [fact] : [];
    }
    if (typeof child === 'string' && child.trim()) {
      const boundary = normalizeStateBoundaryName(key);
      if (!boundary) return [];
      return [{
        boundary,
        kind: '',
        ref: child.trim(),
        source: `${source}.${key}`,
        record: { ref: child.trim() },
      }];
    }
    return [];
  });
}

function stateBoundaryFactFromRecord(
  boundaryHint: unknown,
  record: Record<string, unknown>,
  source: string,
): StateBoundaryFact | undefined {
  const boundary = normalizeStateBoundaryName(record.boundary ?? record.name ?? record.type ?? boundaryHint);
  const ref = stateBoundaryRef(record);
  const kind = asString(record.kind ?? record.type).trim();
  if (!boundary && !ref && !kind) return undefined;
  return {
    boundary,
    kind,
    ref,
    source,
    record,
  };
}

function normalizeStateBoundaryName(value: unknown): string {
  const raw = asString(value).trim();
  if (!raw) return '';
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_');
  if ([
    'durable',
    'durable_state',
    'durable_session_state',
    'session_state',
    'session_jsonl',
  ].includes(normalized)) {
    return 'durable_session';
  }
  if ([
    'trace',
    'runtime_trace',
    'session_trace',
    'working_jsonl',
    'working_log',
  ].includes(normalized)) {
    return 'working_trace';
  }
  if ([
    'provider',
    'provider_ref',
    'provider_reference',
    'provider_transcript_ref',
  ].includes(normalized)) {
    return 'provider_transcript';
  }
  if ([
    'visible',
    'surface_history',
    'chat_history',
    'visible_chat_history',
  ].includes(normalized)) {
    return 'visible_history';
  }
  return normalized;
}

function stateBoundaryRef(record: Record<string, unknown>): string {
  for (const key of ['ref', 'path', 'uri', 'url', 'reference', 'artifact', 'evidence_ref', 'id']) {
    const value = asString(record[key]).trim();
    if (value) return value;
  }
  return '';
}

function collectDuplicateBoundaryRefs(facts: StateBoundaryFact[]): string[] {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const fact of facts) {
    if (!fact.ref) continue;
    const normalizedRef = normalizePath(fact.ref.trim());
    const previous = seen.get(normalizedRef);
    if (previous && previous !== fact.boundary) {
      duplicates.push(`${previous}/${fact.boundary}:${normalizedRef}`);
    } else {
      seen.set(normalizedRef, fact.boundary);
    }
  }
  return duplicates;
}

function isProviderTranscriptReferenceOnly(fact: StateBoundaryFact): boolean {
  if (!fact.ref) return false;
  const mode = asString(fact.record.mode).toLowerCase();
  const kind = fact.kind.toLowerCase();
  const referenceMode = kind.includes('ref')
    || mode === 'reference'
    || mode === 'summary'
    || mode === 'pointer';
  if (!referenceMode) return false;
  if (fact.record.raw_messages_stored === true) return false;
  if (fact.record.tool_result_payload_stored === true) return false;
  if (fact.record.raw_request_stored === true) return false;
  if (fact.record.raw_response_stored === true) return false;
  if (fact.record.raw_payload_stored === true) return false;
  if (asArray(fact.record.messages).length > 0) return false;
  if (asArray(fact.record.tool_results).length > 0) return false;
  if (asArray(fact.record.toolResults).length > 0) return false;
  if (asArray(fact.record.tool_calls).length > 0) return false;
  if (asArray(fact.record.toolCalls).length > 0) return false;
  return true;
}

function isProviderTranscriptDegradedFact(fact: StateBoundaryFact): boolean {
  const status = providerTranscriptStatus(fact).toLowerCase();
  const mode = asString(fact.record.mode).toLowerCase();
  return fact.record.degraded === true
    || fact.record.quality_degraded === true
    || ['degraded', 'blocked', 'fallback', 'failed', 'failure', 'timeout'].includes(status)
    || ['degraded', 'fallback'].includes(mode)
    || providerTranscriptDegradationReasons(fact).length > 0;
}

function providerTranscriptStatus(fact: StateBoundaryFact): string {
  return asString(fact.record.status ?? fact.record.degradation_status ?? fact.record.delivery_status).trim();
}

function providerTranscriptDegradationReasons(fact: StateBoundaryFact): string[] {
  const record = fact.record;
  return uniqueStringList([
    ...stringList(record.degradation_reason),
    ...stringList(record.degradation_code),
    ...stringList(record.error_code),
  ].map(item => item.trim()).filter(Boolean));
}

function providerTranscriptFallbackChain(fact: StateBoundaryFact): string[] {
  return stringList(
    fact.record.fallback_chain
    ?? fact.record.provider_chain
    ?? fact.record.provider_sequence
    ?? fact.record.providers,
  ).map(item => item.trim()).filter(Boolean);
}

function hasExplicitProviderTranscriptRawPayloadStorageFlags(record: Record<string, unknown>): boolean {
  return record.raw_messages_stored === false
    && record.tool_result_payload_stored === false
    && record.raw_request_stored === false
    && record.raw_response_stored === false
    && record.raw_payload_stored === false;
}

function providerTranscriptStorageFlagViolations(record: Record<string, unknown>): string[] {
  return [
    'raw_messages_stored',
    'tool_result_payload_stored',
    'raw_request_stored',
    'raw_response_stored',
    'raw_payload_stored',
  ].filter(key => record[key] === true);
}

function isNormalizedProviderTranscriptRef(ref: string): boolean {
  const normalized = normalizePath(ref.trim()).toLowerCase();
  return /^(provider-transcripts\/)?sha256:[a-f0-9]{16,64}$/.test(normalized);
}

function providerTranscriptRawPayloadKeys(record: Record<string, unknown>): string[] {
  return [
    'messages',
    'raw_messages',
    'rawMessages',
    'provider_messages',
    'providerMessages',
    'request_messages',
    'requestMessages',
    'tool_results',
    'toolResults',
    'tool_calls',
    'toolCalls',
    'raw_request',
    'rawRequest',
    'raw_response',
    'rawResponse',
    'provider_request',
    'providerRequest',
    'provider_response',
    'providerResponse',
    'raw_payload',
    'rawPayload',
  ].filter(key => hasMeaningfulValue(record[key]));
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function isUnsafeStateBoundaryRef(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.includes('\0')) return true;
  if (path.isAbsolute(trimmed)) return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return true;
  if (/^file:\/\//i.test(trimmed)) return true;
  return normalizePath(trimmed).split('/').includes('..');
}

function isUnsafeEvidenceReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed === '<repo-root>' || trimmed.startsWith('<repo-root>/')) return false;
  if (trimmed === '<workspace>' || trimmed.startsWith('<workspace>/')) return false;
  if (trimmed.includes('\0')) return true;
  if (path.isAbsolute(trimmed)) return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return true;
  if (/^file:\/\//i.test(trimmed)) return true;
  return normalizePath(trimmed).split('/').includes('..');
}

function collectEventNames(entries: Record<string, unknown>[]): string[] {
  const names = new Set<string>();
  const addFromRecord = (record: Record<string, unknown> | undefined) => {
    if (!record) return;
    for (const key of ['entry_type', 'event_type', 'type', 'name', 'state_event']) {
      const value = asString(record[key]);
      if (value) names.add(value);
    }
  };

  for (const entry of entries) {
    addFromRecord(entry);
    addFromRecord(asRecord(entry.runtime_event));
    addFromRecord(asRecord(entry.event));
    addFromRecord(asRecord(entry.state_event));
    for (const item of asArray(entry.runtime_events)) {
      addFromRecord(asRecord(item));
    }
  }
  return [...names];
}

function collectSkillActivationEvidence(entries: Record<string, unknown>[], toolCalls: ToolCallFact[]): SkillActivationEvidence[] {
  const evidence: SkillActivationEvidence[] = [];

  for (const entry of entries) {
    for (const raw of asArray(entry.skill_activations)) {
      const record = asRecord(raw);
      if (!record) continue;
      const skillName = asString(record.skill_name) || asString(record.skillName) || asString(record.name);
      if (!skillName) continue;
      evidence.push({
        skillName,
        prompt: asString(record.prompt) || asString(record.system_prompt),
        maxTurns: asNumber(record.max_turns) ?? asNumber(record.maxTurns),
        systemPromptCount: asNumber(record.system_prompt_count) ?? asNumber(record.systemPromptCount) ?? 0,
        source: asString(record.source) || 'skill_activations',
      });
    }

    for (const raw of asArray(entry.runtime_events)) {
      const record = asRecord(raw);
      if (!record) continue;
      const eventName = asString(record.name) || asString(record.event_type) || asString(record.type);
      if (!includesText(eventName, 'skill_activation', false)) continue;
      const skillName = asString(record.skill_name) || asString(record.skillName);
      if (!skillName) continue;
      evidence.push({
        skillName,
        prompt: asString(record.prompt),
        maxTurns: asNumber(record.max_turns) ?? asNumber(record.maxTurns),
        systemPromptCount: asNumber(record.system_prompt_count) ?? asNumber(record.systemPromptCount) ?? 0,
        source: asString(record.source) || 'runtime_event',
      });
    }
  }

  for (const call of toolCalls.filter(item => item.name === 'skill')) {
    const activation = parseSkillActivationSignal(call.resultText);
    if (!activation) continue;
    evidence.push({
      skillName: activation.skillName,
      prompt: activation.prompt,
      maxTurns: activation.maxTurns,
      systemPromptCount: 0,
      source: 'tool_result',
    });
  }

  return evidence;
}

function parseSkillSystemPrompt(content: string): { skillName: string; prompt: string } | undefined {
  const match = content.match(/^\[skill:([^\]]+)\]\n([\s\S]*)$/);
  if (!match) return undefined;
  return {
    skillName: match[1],
    prompt: match[2],
  };
}

function hasNonEmptyStateValue(state: Record<string, unknown>, key: string): boolean {
  const value = state[key];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function comparableStringList(value: unknown): string[] {
  return uniqueStringList(stringList(value).map(comparableText).filter(Boolean));
}

function comparableText(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function uniqueStringList(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function sanitizeRecordStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(item => String(item || '').trim()).filter(Boolean)
    : [];
}

function includesText(text: string, expected: string, caseSensitive: boolean): boolean {
  return caseSensitive
    ? text.includes(expected)
    : text.toLowerCase().includes(expected.toLowerCase());
}

function includesForbiddenText(text: string, expected: string, caseSensitive: boolean): boolean {
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? expected : expected.toLowerCase();
  if (!needle) return false;

  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const before = index > 0 ? haystack[index - 1] : '';
    const after = index + needle.length < haystack.length ? haystack[index + needle.length] : '';
    const startsWithWord = /[a-z0-9]/i.test(needle[0] ?? '');
    const endsWithWord = /[a-z0-9]/i.test(needle[needle.length - 1] ?? '');
    if ((!startsWithWord || !/[a-z0-9]/i.test(before)) && (!endsWithWord || !/[a-z0-9]/i.test(after))) {
      return true;
    }
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

function hasArtifactEvidence(context: EvalVerifierContext, required: EvalRequiredArtifact): boolean {
  const evidenceMode = required.evidence ?? 'manifest_or_file';
  if (evidenceMode === 'manifest' || evidenceMode === 'manifest_or_file') {
    const manifests = context.toolCalls.flatMap(call => call.artifactManifest);
    if (manifests.some(item => artifactMatches(item, required))) {
      return true;
    }
  }
  if (evidenceMode === 'file' || evidenceMode === 'manifest_or_file') {
    const artifactsDir = context.caseSpec.inputs?.artifacts_dir
      ? resolveSuiteRelativePath(context.suiteDir, context.caseSpec.inputs.artifacts_dir)
      : context.suiteDir;
    const fullPath = path.resolve(artifactsDir, required.path);
    if (fs.existsSync(fullPath)) {
      return true;
    }
  }
  return false;
}

function findArtifactFile(context: EvalVerifierContext, artifactPath: string): string | undefined {
  const artifactsDir = context.caseSpec.inputs?.artifacts_dir
    ? resolveSuiteRelativePath(context.suiteDir, context.caseSpec.inputs.artifacts_dir)
    : context.suiteDir;
  if (!fs.existsSync(artifactsDir)) {
    return undefined;
  }

  const direct = path.resolve(artifactsDir, artifactPath);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
    return direct;
  }

  const expected = normalizePath(artifactPath);
  const expectedBase = path.basename(expected);
  return listFiles(artifactsDir).find((filePath) => {
    const relative = normalizePath(path.relative(artifactsDir, filePath));
    return relative === expected || relative.endsWith(`/${expected}`) || path.basename(relative) === expectedBase;
  });
}

function readJsonArtifactRecord(
  context: EvalVerifierContext,
  artifactPath: string,
): { path?: string; record?: Record<string, unknown>; error?: string } {
  const filePath = findArtifactFile(context, artifactPath);
  if (!filePath) {
    return { error: `${artifactPath} not found` };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const record = asRecord(parsed);
    if (!record) {
      return { path: filePath, error: `${artifactPath} is not a JSON object` };
    }
    return { path: filePath, record };
  } catch (error) {
    return { path: filePath, error: `${artifactPath} parse error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function hasEvidencePressureText(text: string): boolean {
  return /证据|路径|日志|结果|能用|打开|看到|交付|proof|evidence|path|log|result|artifact/i.test(text);
}

function hasChangedOrBoundaryPressureText(text: string): boolean {
  return /漏说|补充|改一下|别动|无关|越界|权限|账号|确认|constraint|boundary|permission|unrelated|scope/i.test(text);
}

function hasFinalJudgement(record: Record<string, unknown>): boolean {
  const directDecision = asString(record.decision).toLowerCase();
  const curationStatus = asString(record.curation_status).toLowerCase();
  const benchmarkAcceptance = asString(record.benchmark_acceptance).toLowerCase();
  const replayReadiness = asString(record.replay_readiness).toLowerCase();
  const forbidden = new Set(['pass', 'fail', 'accepted', 'closed', 'release_blocking']);
  if (forbidden.has(directDecision) || forbidden.has(curationStatus) || forbidden.has(replayReadiness)) {
    return true;
  }
  if (benchmarkAcceptance === 'accepted') {
    return true;
  }
  return false;
}

function artifactMatches(item: ArtifactManifestItem, required: EvalRequiredArtifact): boolean {
  const itemPath = normalizePath(item.path);
  const requiredPath = normalizePath(required.path);
  const pathMatches = itemPath === requiredPath || itemPath.endsWith(`/${requiredPath}`) || path.basename(itemPath) === path.basename(requiredPath);
  const typeMatches = !required.type || item.type === required.type;
  const actionMatches = !required.action || item.action === required.action;
  const metadataMatches = !required.metadata || Object.entries(required.metadata).every(([key, value]) => {
    const itemValue = item.metadata?.[key];
    return stableText(itemValue) === stableText(value);
  });
  return pathMatches && typeMatches && actionMatches && metadataMatches;
}

function rLibraryPattern(libraryName: string): RegExp {
  const escaped = escapeRegExp(libraryName);
  return new RegExp(`\\b(?:library|require)\\s*\\(\\s*["']?${escaped}["']?\\s*\\)`, 'i');
}

function rFunctionPattern(functionName: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(functionName)}\\s*\\(`);
}

function rStructureFailures(content: string): string[] {
  const pairs: Array<[string, string, string]> = [
    ['(', ')', 'parentheses'],
    ['[', ']', 'brackets'],
    ['{', '}', 'braces'],
  ];

  return pairs
    .filter(([open, close]) => !balancedDelimiters(content, open, close))
    .map(([, , label]) => `unbalanced ${label}`);
}

function balancedDelimiters(content: string, open: string, close: string): boolean {
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const char of content) {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) depth -= 1;
    if (depth < 0) return false;
  }

  return depth === 0 && !quote;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function budgetViolations(metrics: EvalCaseMetrics, budgets?: EvalBudgets): string[] {
  if (!budgets) return [];
  const violations: string[] = [];
  if (budgets.max_turns !== undefined && metrics.turns > budgets.max_turns) violations.push('max_turns');
  if (budgets.max_tool_calls !== undefined && metrics.tool_calls > budgets.max_tool_calls) violations.push('max_tool_calls');
  if (budgets.max_tokens !== undefined && metrics.total_tokens > budgets.max_tokens) violations.push('max_tokens');
  return violations;
}

function validateSuiteShape(suite: EvalSuite, suitePath: string): void {
  if (!suite || typeof suite !== 'object') {
    throw new Error(`invalid eval suite: ${suitePath}`);
  }
  if (!suite.suite_id || !suite.name || !Array.isArray(suite.cases)) {
    throw new Error(`eval suite requires suite_id, name, and cases: ${suitePath}`);
  }
  for (const caseSpec of suite.cases) {
    if (!caseSpec.case_id || !caseSpec.name || !caseSpec.lane || !caseSpec.target_module || !Array.isArray(caseSpec.hard_verifiers)) {
      throw new Error(`invalid eval case in ${suitePath}`);
    }
  }
}

class ScriptedReplayAIService {
  private index = 0;
  readonly usage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  constructor(private readonly responses: EvalReplayModelResponse[]) {}

  async chatStream(): Promise<ChatResponse> {
    if (this.index >= this.responses.length) {
      throw new Error('scripted replay model responses exhausted');
    }
    const scripted = this.responses[this.index++];
    const promptTokens = scripted.usage?.prompt_tokens ?? 0;
    const completionTokens = scripted.usage?.completion_tokens ?? 0;
    this.usage.promptTokens += promptTokens;
    this.usage.completionTokens += completionTokens;
    this.usage.totalTokens += promptTokens + completionTokens;
    return {
      content: scripted.content ?? null,
      toolCalls: scripted.tool_calls?.map(call => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: typeof call.arguments === 'string'
            ? call.arguments
            : JSON.stringify(call.arguments ?? {}),
        },
      })),
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
    };
  }

  async chat(): Promise<ChatResponse> {
    return this.chatStream();
  }
}

class EmptyEvalSkillManager {
  async loadSkills(): Promise<void> {}
  getAllSkills(): unknown[] { return []; }
  getUserInvocableSkills(): unknown[] { return []; }
  getSkill(_name?: string): unknown | undefined { return undefined; }
  findAutoInvocableSkillByText(): undefined { return undefined; }
}

class StaticEvalSubAgentSkillManager extends EmptyEvalSkillManager {
  private readonly skill?: Skill;

  constructor(skillName?: string) {
    super();
    const normalized = asString(skillName).trim();
    if (!normalized) return;
    this.skill = {
      metadata: {
        name: normalized,
        description: 'Deterministic eval background task runner.',
        maxTurns: 6,
      },
      content: 'Run the delegated background task with base tools, write bounded artifacts, and return a concise completion summary to the parent agent.',
      filePath: `eval://skills/${normalized}/SKILL.md`,
    };
  }

  override getAllSkills(): Skill[] {
    return this.skill ? [this.skill] : [];
  }

  override getUserInvocableSkills(): Skill[] {
    return this.getAllSkills();
  }

  override getSkill(name: string): Skill | undefined {
    return this.skill && this.skill.metadata.name === name ? this.skill : undefined;
  }
}

class CapturingEvalFeishuSender {
  readonly replies: Array<{ chatId: string; text: string }> = [];
  readonly files: Array<{ chatId: string; filePath: string; fileName: string }> = [];
  readonly externalReceipts: Record<string, unknown>[] = [];

  async reply(chatId: string, text: string): Promise<Record<string, unknown>> {
    const index = this.replies.length + 1;
    this.replies.push({ chatId, text });
    const receipt = {
      receipt_id: `feishu.message.${index}`,
      receipt_type: 'message',
      surface: 'feishu',
      status: 'delivered',
      platform_message_id: `eval_feishu_message_${index}`,
      delivery_id: `feishu.reply.${index}`,
      timestamp: new Date().toISOString(),
    };
    this.externalReceipts.push(receipt);
    return receipt;
  }

  async sendFile(chatId: string, filePath: string, fileName: string): Promise<Record<string, unknown>[]> {
    const index = this.files.length + 1;
    this.files.push({ chatId, filePath, fileName });
    const timestamp = new Date().toISOString();
    const receipts = [
      {
        receipt_id: `feishu.upload.${index}`,
        receipt_type: 'upload',
        surface: 'feishu',
        status: 'accepted',
        platform_file_key: `eval_feishu_file_key_${index}`,
        file_name: fileName,
        artifact_path: filePath,
        timestamp,
      },
      {
        receipt_id: `feishu.file.${index}`,
        receipt_type: 'file',
        surface: 'feishu',
        status: 'delivered',
        platform_message_id: `eval_feishu_file_message_${index}`,
        platform_file_key: `eval_feishu_file_key_${index}`,
        delivery_id: `feishu.file.${index}`,
        file_name: fileName,
        artifact_path: filePath,
        timestamp,
      },
    ];
    this.externalReceipts.push(...receipts);
    return receipts;
  }

  async fetchMergeForwardTexts(_messageIds: string[]): Promise<string> {
    return '';
  }

  async downloadFile(_messageId: string, _fileKey: string, _fileName: string): Promise<string | null> {
    return null;
  }
}

function createSurfaceRuntimeServices(
  replay: NonNullable<EvalCase['replay']>,
  artifactsDir: string,
  surface: 'feishu' | 'pet',
  sessionId: string,
): { services: AgentServices; aiService: ScriptedReplayAIService } {
  const aiService = new ScriptedReplayAIService(replay.model_responses);
  const subagentResponses = replay.subagent_model_responses ?? [];
  const subAgentServiceFactory = subagentResponses.length > 0
    ? async (input: { roleName?: string; skillName?: string }) => {
      const skillManager = new StaticEvalSubAgentSkillManager(input.skillName);
      await skillManager.loadSkills();
      return {
        aiService: new ScriptedReplayAIService(subagentResponses),
        skillManager,
      };
    }
    : undefined;
  const toolManager = createRoleAwareToolManager(artifactsDir, {
    sessionId,
    surface,
    permissionProfile: 'strict',
    ...(subAgentServiceFactory ? { subAgentServiceFactory } : {}),
  });
  return {
    aiService,
    services: {
      aiService: aiService as any,
      toolManager,
      skillManager: new EmptyEvalSkillManager() as any,
    },
  };
}

async function listenEvalRouter(router: express.Router): Promise<{ server: http.Server; baseUrl: string }> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('eval HTTP server did not expose an address');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeEvalServer(server: http.Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  });
}

async function postJson(url: string, body: Record<string, unknown>): Promise<{
  status: number;
  contentType: string;
  text: string;
  json?: Record<string, unknown>;
}> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, unknown> | undefined;
  try {
    const parsed = text ? JSON.parse(text) : undefined;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      json = parsed as Record<string, unknown>;
    }
  } catch {
    json = undefined;
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    text,
    json,
  };
}

async function fetchPetRuntimeHistoryEvents(
  baseUrl: string,
  input: { petId: string; sessionKey: string },
): Promise<Record<string, unknown>[]> {
  const url = `${baseUrl}/api/pet/history?petId=${encodeURIComponent(input.petId)}&sessionKey=${encodeURIComponent(input.sessionKey)}&limit=2000`;
  const response = await fetch(url);
  if (!response.ok) {
    return [];
  }
  try {
    const json = await response.json() as Record<string, unknown>;
    return asArray(json.events)
      .flatMap(item => asRecord(item) ? [asRecord(item)!] : []);
  } catch {
    return [];
  }
}

function mergeSurfaceRuntimeEvents(
  primary: Record<string, unknown>[],
  secondary: Record<string, unknown>[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const merged: Record<string, unknown>[] = [];
  for (const event of [...primary, ...secondary]) {
    const id = asString(event.id);
    const key = id
      ? `id:${id}`
      : `raw:${JSON.stringify(event)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged;
}

function parseSseEvents(body: string): Record<string, unknown>[] {
  return body
    .split('\n\n')
    .map(part => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const line = part.split('\n').find(item => item.startsWith('data: '));
      if (!line) return [];
      try {
        const parsed = JSON.parse(line.slice(6));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
}

function countVisibleSurfaceEvents(events: Record<string, unknown>[]): number {
  return events.filter(event => {
    const type = asString(event.type);
    if (type === 'text' || type === 'file') return true;
    if (type === 'done') {
      return event.visibleToUser !== false && Boolean(asString(event.text));
    }
    return false;
  }).length;
}

function buildFeishuSurfaceRuntimeDeliveryEvidence(input: {
  replies: Array<{ chatId: string; text: string }>;
  files: Array<{ chatId: string; filePath: string; fileName: string }>;
  surface: string;
  channelId: string;
}): EvalReplayDeliveryEvidence[] {
  const timestamp = new Date().toISOString();
  const textEvidence = input.replies.map((reply, index) => ({
    delivery_id: `${input.surface}.reply.${index + 1}`,
    surface: input.surface as EvalReplayDeliveryEvidence['surface'],
    channel_id: reply.chatId || input.channelId,
    delivery_type: 'text' as const,
    status: 'delivered' as const,
    timestamp,
    text_preview: reply.text.slice(0, 160),
  }));
  const fileEvidence = input.files.map((file, index) => ({
    delivery_id: `${input.surface}.file.${index + 1}`,
    surface: input.surface as EvalReplayDeliveryEvidence['surface'],
    channel_id: file.chatId || input.channelId,
    delivery_type: 'file' as const,
    status: 'delivered' as const,
    timestamp,
    file_name: file.fileName,
    file_path: file.filePath,
  }));
  return [...textEvidence, ...fileEvidence];
}

function buildSseSurfaceRuntimeDeliveryEvidence(
  events: Record<string, unknown>[],
  context: { surface: 'pet'; channelId: string },
): EvalReplayDeliveryEvidence[] {
  const timestamp = new Date().toISOString();
  return events.flatMap((event, index): EvalReplayDeliveryEvidence[] => {
    const type = asString(event.type);
    if (type === 'text') {
      const text = asString(event.text);
      return [{
        delivery_id: `${context.surface}.text.${index + 1}`,
        surface: context.surface,
        channel_id: context.channelId,
        delivery_type: 'text' as const,
        status: 'delivered' as const,
        timestamp,
        text_preview: text.slice(0, 160),
      }];
    }
    if (type === 'file') {
      const filePath = asString(event.filePath ?? event.path);
      const fileName = asString(event.fileName ?? event.name);
      return [{
        delivery_id: `${context.surface}.file.${index + 1}`,
        surface: context.surface,
        channel_id: context.channelId,
        delivery_type: 'file' as const,
        status: 'delivered' as const,
        timestamp,
        file_name: fileName || undefined,
        file_path: filePath || undefined,
      }];
    }
    if (type === 'done' && event.visibleToUser !== false) {
      const text = asString(event.text);
      if (!text) return [];
      return [{
        delivery_id: `${context.surface}.done.${index + 1}`,
        surface: context.surface,
        channel_id: context.channelId,
        delivery_type: 'text' as const,
        status: 'delivered' as const,
        timestamp,
        text_preview: text.slice(0, 160),
      }];
    }
    return [];
  });
}

function buildSseSurfaceRuntimeExternalReceipts(
  events: Record<string, unknown>[],
  context: { surface: 'pet'; channelId: string },
): Record<string, unknown>[] {
  const timestamp = new Date().toISOString();
  return events.flatMap((event, index): Record<string, unknown>[] => {
    const type = asString(event.type);
    if (type === 'text') {
      return [{
        receipt_id: `${context.surface}.message.${index + 1}`,
        receipt_type: 'message',
        surface: context.surface,
        status: 'delivered',
        delivery_id: `${context.surface}.text.${index + 1}`,
        timestamp,
      }];
    }
    if (type === 'file') {
      const filePath = asString(event.filePath ?? event.path);
      const fileName = asString(event.fileName ?? event.name);
      return [{
        receipt_id: `${context.surface}.file.${index + 1}`,
        receipt_type: 'file',
        surface: context.surface,
        status: 'delivered',
        delivery_id: `${context.surface}.file.${index + 1}`,
        ...(fileName && { file_name: fileName }),
        ...(filePath && { artifact_path: filePath }),
        timestamp,
      }];
    }
    if (type === 'done' && event.visibleToUser !== false && asString(event.text)) {
      return [{
        receipt_id: `${context.surface}.message.${index + 1}`,
        receipt_type: 'message',
        surface: context.surface,
        status: 'delivered',
        delivery_id: `${context.surface}.done.${index + 1}`,
        timestamp,
      }];
    }
    return [];
  });
}

function collectSurfaceRuntimeFileEvents(events: Record<string, unknown>[]): Array<{ filePath: string; fileName: string }> {
  return events
    .filter(event => asString(event.type) === 'file')
    .map(event => ({
      filePath: asString(event.filePath ?? event.path),
      fileName: asString(event.fileName ?? event.name),
    }))
    .filter(file => file.filePath || file.fileName);
}

function collectSurfaceRuntimeFileArtifacts(
  artifactsDir: string,
  files: Array<{ filePath?: string; fileName?: string }>,
): string[] {
  const candidates = new Set<string>();
  for (const file of files) {
    for (const value of [file.filePath, file.fileName]) {
      if (!value) continue;
      candidates.add(value);
      candidates.add(path.basename(value));
    }
  }

  const artifactPaths: string[] = [];
  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(artifactsDir, candidate);
    if (!fs.existsSync(resolved)) continue;
    const relative = path.relative(artifactsDir, resolved);
    artifactPaths.push(relative && !relative.startsWith('..') ? relative : resolved);
  }
  return [...new Set(artifactPaths)].sort();
}

function writeSurfaceRuntimeWorkspace(
  root: string,
  config: { roleName: string; petId: string },
): void {
  const petDir = path.join(root, 'desktop', 'dashboard', 'pets', config.petId);
  fs.mkdirSync(petDir, { recursive: true });
  fs.writeFileSync(path.join(petDir, 'pet.json'), `${JSON.stringify({
    id: config.petId,
    displayName: 'Alpha Puff',
    description: 'Eval surface runtime pet',
    spritesheetPath: 'spritesheet.webp',
  }, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(path.join(petDir, 'spritesheet.webp'), Buffer.from([0x52, 0x49, 0x46, 0x46]));

  const roleDir = path.join(root, 'roles', config.roleName);
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, 'role.json'), `${JSON.stringify({
    name: config.roleName,
    displayName: 'EngineerCat',
    description: 'Eval surface runtime role',
    metadata: { petId: config.petId },
  }, null, 2)}\n`, 'utf-8');
}

function normalizeReplaySurfaceAdapterEvent(replay: NonNullable<EvalCase['replay']>): NormalizedSurfaceEvent {
  const raw = replay.surface_event?.raw ?? {};
  if (replay.surface === 'feishu') {
    const config = replay.surface_event?.adapter_config ?? {};
    const handler = new MessageHandler();
    const botOpenId = asString(config.bot_open_id ?? config.botOpenId);
    if (botOpenId) {
      handler.setBotOpenId(botOpenId);
    }
    const aliases = stringList(config.bot_aliases ?? config.botAliases);
    if (aliases.length > 0) {
      handler.setMentionAliases(aliases);
    }

    const parsed = handler.parse(raw);
    if (!parsed) {
      throw new Error('Feishu MessageHandler returned null');
    }
    const sessionKey = parsed.chatType === 'group'
      ? `group:${parsed.chatId}`
      : `user:${parsed.senderId}`;

    return {
      surface: 'feishu',
      adapterId: 'feishu_message_handler',
      eventType: replay.surface_event?.event_type ?? 'im.message.receive_v1',
      eventId: parsed.messageId || replay.surface_event?.event_id,
      sessionKey,
      channelId: parsed.chatId,
      userId: parsed.senderId,
      userMessage: parsed.text,
      payloadType: parsed.msgType,
      mentionBot: parsed.mentionBot,
      metadata: {
        chatType: parsed.chatType,
        fileName: parsed.file?.fileName,
        fileType: parsed.file?.type,
        mergeForwardCount: parsed.mergeForwardIds?.length ?? 0,
        messageRef: replay.surface_event?.message_ref,
      },
    };
  }

  if (replay.surface === 'pet') {
    const body = asRecord(raw.body) ?? raw;
    return normalizePetMessageSurfaceEvent(body);
  }

  throw new Error(`unsupported surface adapter surface: ${replay.surface ?? 'unknown'}`);
}

function buildSurfaceRuntimeTraceEntry(input: {
  caseSpec: EvalCase;
  replay: NonNullable<EvalCase['replay']>;
  runtime: Record<string, unknown>;
  aiService: ScriptedReplayAIService;
}): Record<string, unknown> {
  return {
    schema_version: 2,
    entry_type: 'turn',
    turn_id: `${input.caseSpec.case_id}.turn.1`,
    turn: 1,
    timestamp: new Date().toISOString(),
    session_id: asString(input.runtime.session_key) || `eval:${input.caseSpec.case_id}`,
    session_type: 'eval',
    surface: input.runtime.surface ?? input.replay.surface ?? 'unknown',
    surface_runtime: input.runtime,
    runtime_events: [{
      type: 'surface_runtime.e2e',
      surface: input.runtime.surface ?? input.replay.surface ?? 'unknown',
      runtime_id: input.runtime.runtime_id,
      status: 'success',
      status_code: input.runtime.status_code,
      event_types: input.runtime.event_types,
    }],
    user: {
      text: asString(input.runtime.user_message) || input.replay.user_message,
    },
    assistant: {
      text: '',
      tool_calls: [],
    },
    tokens: {
      prompt: input.aiService.usage.promptTokens,
      completion: input.aiService.usage.completionTokens,
    },
  };
}

function parseArtifactManifest(value: unknown): ArtifactManifestItem[] {
  const values = asArray(value);
  return values.flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const artifactPath = asString(record.path);
    if (!artifactPath) return [];
    return [{
      path: artifactPath,
      type: asString(record.type) || undefined,
      action: asString(record.action) || undefined,
      metadata: asRecord(record.metadata) ?? undefined,
    }];
  });
}

function parseDeliveryEvidence(value: unknown): DeliveryEvidenceItem[] {
  const values = asArray(value);
  return values.flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    return [{
      deliveryId: asString(record.delivery_id) || undefined,
      surface: asString(record.surface) || undefined,
      channelId: asString(record.channel_id) || undefined,
      deliveryType: asString(record.delivery_type).toLowerCase(),
      status: asString(record.status).toLowerCase(),
      timestamp: asString(record.timestamp),
      textPreview: asString(record.text_preview) || undefined,
      fileName: asString(record.file_name) || undefined,
      filePath: asString(record.file_path) || undefined,
      errorCode: asString(record.error_code) || undefined,
    }];
  });
}

function asSurfaceExternalReceipt(value: unknown, source: string, fallbackSurface: string): SurfaceExternalReceipt[] {
  const record = asRecord(value);
  if (!record) return [];
  const receiptId = asString(record.receipt_id) || asString(record.receiptId) || asString(record.id);
  const receiptType = asString(record.receipt_type) || asString(record.receiptType) || asString(record.type);
  const platformMessageId = asString(record.platform_message_id) || asString(record.platformMessageId) || asString(record.message_id) || asString(record.messageId);
  const platformFileKey = asString(record.platform_file_key) || asString(record.platformFileKey) || asString(record.file_key) || asString(record.fileKey);
  const deliveryId = asString(record.delivery_id) || asString(record.deliveryId);
  const fileName = asString(record.file_name) || asString(record.fileName) || asString(record.name);
  const artifactPath = asString(record.artifact_path) || asString(record.artifactPath) || asString(record.path);
  if (!receiptId && !receiptType && !platformMessageId && !platformFileKey && !deliveryId) return [];
  return [{
    receiptId,
    receiptType,
    surface: asString(record.surface) || fallbackSurface,
    status: asString(record.status),
    platformMessageId,
    platformFileKey,
    deliveryId,
    fileName,
    artifactPath,
    timestamp: asString(record.timestamp) || asString(record.delivered_at) || asString(record.created_at),
    evidenceRefs: stringList(record.evidence_refs ?? record.evidenceRefs ?? record.artifacts),
    source,
  }];
}

function parseExternalDeliveryReceipts(
  value: unknown,
  source: string,
  fallbackSurface: string,
): SurfaceExternalReceipt[] {
  return asArray(value).flatMap(item => asSurfaceExternalReceipt(item, source, fallbackSurface));
}

function listFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(fullPath);
    if (entry.isFile()) return [fullPath];
    return [];
  });
}

function findSingleJsonl(dir: string): string | undefined {
  if (!fs.existsSync(dir)) {
    return undefined;
  }
  const files = listFiles(dir)
    .filter(file => file.endsWith('.jsonl') && !isContextSnapshotPath(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const traceFiles = files.filter(file => path.basename(file) === 'traces.jsonl');
  return (traceFiles.length ? traceFiles : files)[0];
}

function isContextSnapshotPath(filePath: string): boolean {
  return filePath.replace(/\\/g, '/').includes('/context-snapshots/');
}

function containsSubsequence(actual: string[], expected: string[]): boolean {
  let expectedIndex = 0;
  for (const item of actual) {
    if (item === expected[expectedIndex]) {
      expectedIndex += 1;
      if (expectedIndex === expected.length) return true;
    }
  }
  return expectedIndex === expected.length;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_');
}

function resolveSuiteRelativePath(suiteDir: string, relativeOrAbsolute: string): string {
  return path.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : path.resolve(suiteDir, relativeOrAbsolute);
}

function stableText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Compatibility-backed Test entrypoint.
 *
 * This runner executes prewritten model actions against the real Runtime. It
 * verifies implementation behavior and must not be presented as Agent Eval.
 */
export function runScriptedRuntimeTestSuite(
  options: EvalRunOptions,
): Promise<EvalScorecard> {
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const suiteName = path.basename(options.suitePath, path.extname(options.suitePath));
  return runEvalSuite({
    ...options,
    outDir: options.outDir
      ? path.resolve(options.outDir)
      : path.resolve(process.cwd(), 'output', 'test', suiteName, stamp),
  });
}
