import * as fs from 'fs';
import * as path from 'path';
import { AgentCase, ReplayResult } from '../eval/evaluation';
import {
  TraceReplayReport,
  TraceReplayRunOptions,
} from './trace-replay-runner';
import { runIsolatedTraceReplay } from './isolated-trace-replay';
import {
  assertReplaySandboxAvailable,
  ReplaySandboxMode,
} from './replay-services';

export interface CaseReplaySetup {
  cwd?: string;
  follow_up_messages?: readonly string[];
  pet_id?: string;
  session_key?: string;
  required_active_skill_name?: string;
  sandbox?: ReplaySandboxMode;
}

export interface CaseReplayAdapterOptions {
  working_directory: string;
  code_root?: string;
  out_root?: string;
  timeout_ms?: number;
  run?: (options: TraceReplayRunOptions) => Promise<TraceReplayReport>;
  runIsolated?: typeof runIsolatedTraceReplay;
}

/**
 * Adapts an executable Case to the current Pet/Agent Runtime.
 *
 * The returned status describes execution only. It deliberately ignores the
 * legacy comparison verdict; Verifier and ReviewerCat own judgment.
 */
export function createCaseReplayAdapter(
  options: CaseReplayAdapterOptions,
): (input: {
    case: Readonly<AgentCase<CaseReplaySetup>>;
    attempt: number;
  }) => Promise<ReplayResult> {
  return async input => {
    const runId = `${safeSegment(input.case.case_id)}-attempt-${input.attempt}`;
    const outRoot = path.resolve(
      options.working_directory,
      options.out_root ?? path.join('output', 'eval', 'replay'),
    );
    const outDir = path.join(outRoot, runId);
    const sourcePath = path.join(outDir, 'case-input.jsonl');
    fs.mkdirSync(outDir, { recursive: true });
    writeCaseInputTrace(sourcePath, input.case);

    try {
      const sandboxMode = input.case.setup?.sandbox ?? 'read_only';
      assertReplaySandboxAvailable(sandboxMode);
      const workingDirectory = path.resolve(
        options.working_directory,
        input.case.setup?.cwd ?? '.',
      );
      const timeoutMs = input.case.budget?.max_latency_ms ?? options.timeout_ms ?? 180_000;
      const maxTurns = input.case.budget?.max_turns
        ?? Math.max(1, 1 + (input.case.setup?.follow_up_messages?.length ?? 0));
      const sessionKey = input.case.setup?.session_key
        ?? `pet:${input.case.setup?.pet_id ?? 'xiaoba'}:role-base`;
      const report = options.run
        ? await options.run({
            tracePath: sourcePath,
            outDir,
            cwd: workingDirectory,
            petId: input.case.setup?.pet_id,
            sessionKey,
            source: `case-replay:${input.case.case_id}`,
            maxTurns,
            timeoutMs,
            requiredActiveSkillName: input.case.setup?.required_active_skill_name,
          })
        : await Promise.resolve((options.runIsolated ?? runIsolatedTraceReplay)({
            codeRoot: path.resolve(options.code_root ?? options.working_directory),
            workingDirectory,
            tracePath: sourcePath,
            outDir,
            parentSessionId: `evaluation:${input.case.case_id}:attempt:${input.attempt}`,
            ...(inferTargetRole(sessionKey) ? { targetRole: inferTargetRole(sessionKey) } : {}),
            requiredActiveSkillName: input.case.setup?.required_active_skill_name,
            sessionKey,
            source: `case-replay:${input.case.case_id}`,
            maxTurns,
            timeoutMs,
            sandboxMode,
          }));
      if (!report.fresh_trace_path) {
        return {
          run_id: report.run_id,
          case_id: input.case.case_id,
          status: 'blocked',
          reason: 'Case Replay produced no fresh Trace',
          metrics: replayMetrics(report),
        };
      }
      return {
        run_id: report.run_id,
        case_id: input.case.case_id,
        status: 'completed',
        trace_ref: report.fresh_trace_path,
        metrics: replayMetrics(report),
      };
    } catch (error) {
      return {
        run_id: runId,
        case_id: input.case.case_id,
        status: 'blocked',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

function inferTargetRole(sessionKey: string): string | undefined {
  const match = sessionKey.match(/(?:^|:)role-([a-z0-9][a-z0-9-]{0,63})(?:$|:)/i);
  const role = match?.[1]?.toLowerCase();
  return role && role !== 'base' ? role : undefined;
}

function writeCaseInputTrace(
  filePath: string,
  evaluationCase: Readonly<AgentCase<CaseReplaySetup>>,
): void {
  const messages = [
    evaluationCase.task,
    ...(evaluationCase.setup?.follow_up_messages ?? []),
  ];
  const rows = messages.map((text, index) => JSON.stringify({
    schema_version: 2,
    entry_type: 'turn',
    turn: index + 1,
    trace_id: `case:${evaluationCase.case_id}`,
    trace_index: index + 1,
    session_id: `case:${evaluationCase.case_id}`,
    session_type: 'case',
    user: { text },
    assistant: { text: '', tool_calls: [] },
    source: {
      case_id: evaluationCase.case_id,
      trace_refs: evaluationCase.source?.trace_refs ?? [],
    },
  }));
  fs.writeFileSync(filePath, `${rows.join('\n')}\n`, 'utf-8');
}

function replayMetrics(report: TraceReplayReport): ReplayResult['metrics'] {
  return {
    latency_ms: report.results.reduce((sum, result) => sum + result.durationMs, 0),
  };
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'case';
}
