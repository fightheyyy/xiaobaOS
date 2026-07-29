import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { AgentServices } from '../core/agent-session';
import { PetChannel } from '../pet/channel';
import { createReplayServices } from './replay-services';
import { runWithArenaAuditScope } from '../utils/ai-service';
import { Logger } from '../utils/logger';

export interface TraceReplayRunOptions {
  tracePath: string;
  outDir?: string;
  cwd?: string;
  petId?: string;
  sessionKey?: string;
  source?: string;
  maxTurns?: number;
  timeoutMs?: number;
  now?: Date;
  services?: AgentServices;
  /** Internal evaluator pin. It is never sourced from the Pet HTTP request. */
  requiredActiveSkillName?: string;
}

export interface TraceReplayInput {
  index: number;
  sourceLine: number;
  sourceTraceId?: string;
  sourceTraceIndex?: number;
  sourceSessionId?: string;
  sourceSessionType?: string;
  text: string;
}

export interface TraceReplayTurnResult {
  index: number;
  sourceLine: number;
  ok: boolean;
  status?: number;
  durationMs: number;
  text: string;
  textEventCount: number;
  files: Array<Record<string, unknown>>;
  tools: string[];
  visibleToUser?: boolean;
  eventCount: number;
  error?: string;
}

export interface TraceReplayComparison {
  oldTrace: TraceFacts;
  newTrace: TraceFacts;
  inputCountMatches: boolean;
  userInputsReplayed: boolean;
  slashCommandsMissingFromTrace: boolean;
  notes: string[];
}

export interface TraceFacts {
  traceCount: number;
  userTexts: string[];
  toolCounts: Record<string, number>;
  deliveryEvidenceCount: number;
  visibleCompletedCount: number;
  finalVisibleCount: number;
  failedTools: Array<{
    turn?: number;
    name: string;
    status?: string;
    errorCode?: string;
  }>;
}

export interface TraceReplayReport {
  replay_version: '0.1';
  run_id: string;
  generated_at: string;
  input_trace_path: string;
  out_dir: string;
  pet_id: string;
  session_key: string;
  replayed_turns: number;
  fresh_trace_path?: string;
  visible_history_path?: string;
  artifacts: {
    manifest_path: string;
    extracted_inputs_path: string;
    replay_results_path: string;
    comparison_path: string;
    report_path: string;
  };
  inputs: TraceReplayInput[];
  results: TraceReplayTurnResult[];
  comparison: TraceReplayComparison;
}

interface ParsedTraceLine {
  line: number;
  entry: Record<string, unknown>;
}

export async function runTraceReplay(options: TraceReplayRunOptions): Promise<TraceReplayReport> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const tracePath = path.resolve(cwd, options.tracePath);
  const now = options.now ?? new Date();
  const runId = `trace-replay-${formatTimestamp(now)}-${randomUUID().slice(0, 8)}`;
  const outDir = path.resolve(cwd, options.outDir ?? path.join('output', 'replay', 'trace-rerun', runId));
  const parsed = readTraceJsonl(tracePath);
  const inputs = extractReplayInputs(parsed, options.maxTurns);
  if (inputs.length === 0) {
    throw new Error(`trace has no replayable user.text entries: ${tracePath}`);
  }

  const petId = normalizePetId(options.petId || inferPetId(inputs) || 'xiaoba');
  const requestedSessionKey = (options.sessionKey || `pet:${petId}:role-base`).trim().replace(/:+$/, '')
    || `pet:${petId}:role-base`;
  // Provenance is runtime-owned: even callers that supply a custom key cannot
  // make replay output look like production traffic to the nightly observer.
  const sessionKey = `${requestedSessionKey}:${safePetSessionId(runId)}`;
  const source = options.source || 'trace-replay';
  fs.mkdirSync(outDir, { recursive: true });

  const previousCwd = process.cwd();
  const previousSilentMode = Logger.isSilentMode();
  let channel: PetChannel | null = null;
  let server: http.Server | null = null;
  try {
    process.chdir(cwd);
    Logger.setSilentMode(true);
    const services = options.services ?? await createDefaultReplayServices(
      cwd,
      requestedSessionKey,
      runId,
    );
    channel = new PetChannel({
      services,
      sessionTtlMs: 10_000,
      ...(options.requiredActiveSkillName && {
        requiredActiveSkillName: options.requiredActiveSkillName,
      }),
    });
    const listening = await listenReplayRouter(channel.router);
    server = listening.server;

    const results: TraceReplayTurnResult[] = [];
    for (const input of inputs) {
      results.push(await runWithArenaAuditScope(
        services.aiService,
        `${runId}:replay:${input.index}`,
        () => runReplayTurn({
          baseUrl: listening.baseUrl,
          petId,
          sessionKey,
          input,
          source,
          timeoutMs: options.timeoutMs ?? 180_000,
        }),
      ));
    }

    await new Promise(resolve => setTimeout(resolve, 20));

    const freshTracePath = findTracePathForSession(cwd, 'pet', sessionKey);
    const visibleHistoryPath = visibleHistoryPathForSession(cwd, sessionKey);
    const oldTrace = collectTraceFacts(parsed.map(item => item.entry));
    const newParsed = freshTracePath ? readTraceJsonl(freshTracePath).map(item => item.entry) : [];
    const newTrace = collectTraceFacts(newParsed);
    const comparison = buildComparison({
      oldTrace,
      newTrace,
      inputs,
      results,
      freshTracePath,
    });

    const report: TraceReplayReport = {
      replay_version: '0.1',
      run_id: runId,
      generated_at: now.toISOString(),
      input_trace_path: tracePath,
      out_dir: outDir,
      pet_id: petId,
      session_key: sessionKey,
      replayed_turns: inputs.length,
      ...(freshTracePath ? { fresh_trace_path: freshTracePath } : {}),
      ...(fs.existsSync(visibleHistoryPath) ? { visible_history_path: visibleHistoryPath } : {}),
      artifacts: {
        manifest_path: path.join(outDir, 'manifest.json'),
        extracted_inputs_path: path.join(outDir, 'extracted-inputs.json'),
        replay_results_path: path.join(outDir, 'replay-results.json'),
        comparison_path: path.join(outDir, 'comparison.json'),
        report_path: path.join(outDir, 'report.md'),
      },
      inputs,
      results,
      comparison,
    };

    writeTraceReplayArtifacts(report);
    return report;
  } finally {
    await closeServer(server);
    if (channel) await channel.destroy();
    Logger.setSilentMode(previousSilentMode);
    process.chdir(previousCwd);
  }
}

export function extractTraceReplayInputs(tracePath: string, maxTurns?: number): TraceReplayInput[] {
  return extractReplayInputs(readTraceJsonl(tracePath), maxTurns);
}

async function createDefaultReplayServices(
  cwd: string,
  sessionKey: string,
  runId: string,
): Promise<AgentServices> {
  return createReplayServices({
    working_directory: cwd,
    parent_session_id: `trace-replay:${runId}`,
    sandbox_mode: 'read_only',
    role_name: inferReplayRole(sessionKey),
  });
}

function inferReplayRole(sessionKey: string): string | undefined {
  const match = sessionKey.match(/(?:^|:)role-([a-z0-9][a-z0-9-]{0,63})(?:$|:)/i);
  const role = match?.[1]?.toLowerCase();
  return role && role !== 'base' ? role : undefined;
}

function readTraceJsonl(tracePath: string): ParsedTraceLine[] {
  if (!fs.existsSync(tracePath)) {
    throw new Error(`trace file not found: ${tracePath}`);
  }
  const lines = fs.readFileSync(tracePath, 'utf-8')
    .split(/\r?\n/);
  const parsed: ParsedTraceLine[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        parsed.push({ line: index + 1, entry });
      }
    } catch (error) {
      throw new Error(`invalid trace JSONL at ${tracePath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return parsed;
}

function extractReplayInputs(parsed: ParsedTraceLine[], maxTurns?: number): TraceReplayInput[] {
  const inputs = parsed
    .map((item): TraceReplayInput | null => {
      const user = asRecord(item.entry.user);
      const text = asString(user?.text).trim();
      if (!text) return null;
      return {
        index: 0,
        sourceLine: item.line,
        sourceTraceId: optionalString(item.entry.trace_id),
        sourceTraceIndex: optionalNumber(item.entry.trace_index),
        sourceSessionId: optionalString(item.entry.session_id),
        sourceSessionType: optionalString(item.entry.session_type),
        text,
      };
    })
    .filter((item): item is TraceReplayInput => Boolean(item));
  const limited = typeof maxTurns === 'number' && Number.isFinite(maxTurns) && maxTurns > 0
    ? inputs.slice(0, Math.trunc(maxTurns))
    : inputs;
  return limited.map((item, index) => ({ ...item, index: index + 1 }));
}

async function runReplayTurn(input: {
  baseUrl: string;
  petId: string;
  sessionKey: string;
  input: TraceReplayInput;
  source: string;
  timeoutMs: number;
}): Promise<TraceReplayTurnResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(`${input.baseUrl}/api/pet/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        petId: input.petId,
        sessionKey: input.sessionKey,
        text: input.input.text,
        source: input.source,
        eventId: `trace-replay-${input.input.index}`,
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    const events = parseSseEvents(raw);
    const done = events.find(event => asString(event.type) === 'done');
    const textEvents = events
      .filter(event => asString(event.type) === 'text')
      .map(event => asString(event.text));
    const files = events
      .filter(event => asString(event.type) === 'file');
    const tools = events
      .filter(event => asString(event.type) === 'tool_start')
      .map(event => asString(event.name))
      .filter(Boolean);
    return {
      index: input.input.index,
      sourceLine: input.input.sourceLine,
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - startedAt,
      text: textEvents.join('\n'),
      textEventCount: textEvents.length,
      files,
      tools,
      visibleToUser: typeof done?.visibleToUser === 'boolean' ? done.visibleToUser : undefined,
      eventCount: events.length,
    };
  } catch (error) {
    return {
      index: input.input.index,
      sourceLine: input.input.sourceLine,
      ok: false,
      durationMs: Date.now() - startedAt,
      text: '',
      textEventCount: 0,
      files: [],
      tools: [],
      eventCount: 0,
      error: error instanceof Error && error.name === 'AbortError'
        ? 'TURN_TIMEOUT'
        : error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseSseEvents(raw: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const block of raw.split('\n\n')) {
    const line = block.split('\n').find(item => item.startsWith('data: '));
    if (!line) continue;
    try {
      const parsed = JSON.parse(line.slice(6));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        events.push(parsed);
      }
    } catch {
      // Ignore malformed SSE blocks; the raw response is still represented by status.
    }
  }
  return events;
}

function collectTraceFacts(entries: Array<Record<string, unknown>>): TraceFacts {
  const toolCounts: Record<string, number> = {};
  const userTexts: string[] = [];
  const failedTools: TraceFacts['failedTools'] = [];
  let deliveryEvidenceCount = 0;
  let visibleCompletedCount = 0;
  let finalVisibleCount = 0;

  for (const entry of entries) {
    const user = asRecord(entry.user);
    const userText = asString(user?.text).trim();
    if (userText) userTexts.push(userText);

    const assistant = asRecord(entry.assistant);
    for (const call of asArray(assistant?.tool_calls)) {
      const record = asRecord(call);
      if (!record) continue;
      const name = asString(record.name);
      if (name) toolCounts[name] = (toolCounts[name] || 0) + 1;
      const delivery = asArray(record.delivery_evidence);
      deliveryEvidenceCount += delivery.length;
      const status = optionalString(record.status);
      if (status && status !== 'success') {
        failedTools.push({
          turn: optionalNumber(entry.turn),
          name,
          status,
          errorCode: optionalString(record.error_code),
        });
      }
    }

    for (const event of asArray(entry.events)) {
      const record = asRecord(event);
      if (!record || record.event_type !== 'session_completed') continue;
      if (record.visible_to_user === true) visibleCompletedCount++;
      if (record.final_response_visible === true) finalVisibleCount++;
    }
  }

  return {
    traceCount: entries.length,
    userTexts,
    toolCounts,
    deliveryEvidenceCount,
    visibleCompletedCount,
    finalVisibleCount,
    failedTools,
  };
}

export function collectTraceFactsFromFile(tracePath: string): TraceFacts {
  return collectTraceFacts(readTraceJsonl(tracePath).map(item => item.entry));
}

export function traceReplayReportPassed(
  report: Pick<TraceReplayReport, 'results' | 'comparison'>,
): boolean {
  const visibleEvidence = report.comparison.newTrace.finalVisibleCount > 0
    || report.comparison.newTrace.visibleCompletedCount > 0
    || report.comparison.newTrace.deliveryEvidenceCount > 0;
  return report.comparison.userInputsReplayed
    && report.results.length > 0
    && report.results.every(result => result.ok)
    && report.comparison.newTrace.failedTools.length === 0
    && visibleEvidence;
}

function buildComparison(input: {
  oldTrace: TraceFacts;
  newTrace: TraceFacts;
  inputs: TraceReplayInput[];
  results: TraceReplayTurnResult[];
  freshTracePath?: string;
}): TraceReplayComparison {
  const notes: string[] = [];
  if (!input.freshTracePath) {
    notes.push('fresh trace file was not found after replay');
  }
  if (input.oldTrace.userTexts.length !== input.inputs.length) {
    notes.push('replay input count differs from old trace user text count; max-turns or non-replayable rows may be involved');
  }
  if (input.results.some(result => !result.ok)) {
    notes.push('one or more replay turns failed at the HTTP/runtime boundary');
  }
  if (input.newTrace.finalVisibleCount > 0) {
    notes.push('fresh replay exposed final response to user; channel surfaces should usually use send_text/send_file only');
  }
  const slashCommandsMissingFromTrace = input.inputs.some(item => item.text.startsWith('/'));
  return {
    oldTrace: input.oldTrace,
    newTrace: input.newTrace,
    inputCountMatches: input.oldTrace.userTexts.length === input.newTrace.userTexts.length,
    userInputsReplayed: input.inputs.every((item, index) => input.newTrace.userTexts[index] === item.text),
    slashCommandsMissingFromTrace,
    notes,
  };
}

function writeTraceReplayArtifacts(report: TraceReplayReport): void {
  fs.mkdirSync(report.out_dir, { recursive: true });
  fs.writeFileSync(report.artifacts.manifest_path, `${JSON.stringify({
    replay_version: report.replay_version,
    run_id: report.run_id,
    generated_at: report.generated_at,
    input_trace_path: report.input_trace_path,
    pet_id: report.pet_id,
    session_key: report.session_key,
    replayed_turns: report.replayed_turns,
    fresh_trace_path: report.fresh_trace_path,
    visible_history_path: report.visible_history_path,
    artifacts: report.artifacts,
  }, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(report.artifacts.extracted_inputs_path, `${JSON.stringify(report.inputs, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(report.artifacts.replay_results_path, `${JSON.stringify(report.results, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(report.artifacts.comparison_path, `${JSON.stringify(report.comparison, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(report.artifacts.report_path, `${renderTraceReplayReport(report)}\n`, 'utf-8');
}

export function renderTraceReplayReport(report: TraceReplayReport): string {
  const oldTools = renderCounts(report.comparison.oldTrace.toolCounts);
  const newTools = renderCounts(report.comparison.newTrace.toolCounts);
  return [
    '# Trace Replay Report',
    '',
    `- run_id: ${report.run_id}`,
    `- input_trace: ${report.input_trace_path}`,
    `- fresh_trace: ${report.fresh_trace_path || '[missing]'}`,
    `- visible_history: ${report.visible_history_path || '[missing]'}`,
    `- session_key: ${report.session_key}`,
    `- replayed_turns: ${report.replayed_turns}`,
    '',
    '## Comparison',
    '',
    `- old_trace_count: ${report.comparison.oldTrace.traceCount}`,
    `- new_trace_count: ${report.comparison.newTrace.traceCount}`,
    `- input_count_matches: ${String(report.comparison.inputCountMatches)}`,
    `- user_inputs_replayed: ${String(report.comparison.userInputsReplayed)}`,
    `- old_delivery_evidence: ${report.comparison.oldTrace.deliveryEvidenceCount}`,
    `- new_delivery_evidence: ${report.comparison.newTrace.deliveryEvidenceCount}`,
    `- old_final_visible: ${report.comparison.oldTrace.finalVisibleCount}`,
    `- new_final_visible: ${report.comparison.newTrace.finalVisibleCount}`,
    `- old_tools: ${oldTools}`,
    `- new_tools: ${newTools}`,
    '',
    '## Notes',
    '',
    ...(report.comparison.notes.length
      ? report.comparison.notes.map(note => `- ${note}`)
      : ['- no structural replay notes']),
    '',
  ].join('\n');
}

async function listenReplayRouter(router: express.Router): Promise<{ server: http.Server; baseUrl: string }> {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('trace replay HTTP server did not expose an address');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server: http.Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function findTracePathForSession(cwd: string, sessionType: string, sessionKey: string): string | undefined {
  const root = path.resolve(cwd, 'logs', 'sessions', sessionType);
  const safe = safeLogSessionId(sessionKey);
  if (!fs.existsSync(root)) return undefined;
  const matches: string[] = [];
  for (const dateDir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dateDir.isDirectory()) continue;
    const candidate = path.join(root, dateDir.name, safe, 'traces.jsonl');
    if (fs.existsSync(candidate)) matches.push(candidate);
  }
  matches.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return matches[0];
}

function visibleHistoryPathForSession(cwd: string, sessionKey: string): string {
  return path.resolve(cwd, 'data', 'chat', 'sessions', `${sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
}

function inferPetId(inputs: TraceReplayInput[]): string | undefined {
  for (const input of inputs) {
    const match = input.sourceSessionId?.match(/^pet:([^:]+)/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function normalizePetId(value: string): string {
  const safe = value.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,80}$/i.test(safe)) {
    throw new Error(`invalid pet id for trace replay: ${value}`);
  }
  return safe;
}

function safePetSessionId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 72) || 'trace_replay';
}

function safeLogSessionId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'session';
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function renderCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? entries.map(([name, count]) => `${name}:${count}`).join(', ') : 'none';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
