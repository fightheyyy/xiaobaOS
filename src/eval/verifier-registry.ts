import * as fs from 'fs';
import {
  AgentCase,
  ReplayResult,
  VerifierResult,
} from './evaluation';

export function verifyReplayTrace<Setup>(input: {
  case: Readonly<AgentCase<Setup>>;
  replay: Readonly<ReplayResult>;
}): VerifierResult[] {
  return input.case.oracle.hard_verifiers.map(verifierId => (
    runVerifier(verifierId, input.replay)
  ));
}

function runVerifier(
  verifierId: string,
  replay: Readonly<ReplayResult>,
): VerifierResult {
  if (verifierId === 'trace_exists') return verifyTraceExists(replay);
  if (verifierId === 'no_failed_tools') return verifyNoFailedTools(replay);
  if (verifierId === 'read_only_tools') return verifyReadOnlyTools(replay);
  return {
    verifier_id: verifierId,
    status: 'blocked',
    reasons: [`Unknown hard verifier: ${verifierId}`],
    evidence_refs: replay.trace_ref ? [replay.trace_ref] : [],
  };
}

function verifyReadOnlyTools(replay: Readonly<ReplayResult>): VerifierResult {
  const traceRef = replay.trace_ref;
  if (!traceRef || !fs.existsSync(traceRef)) {
    return {
      verifier_id: 'read_only_tools',
      status: 'blocked',
      reasons: ['Cannot inspect tool boundaries without a fresh Trace'],
      evidence_refs: traceRef ? [traceRef] : [],
    };
  }

  let toolNames: string[];
  try {
    toolNames = readToolCalls(traceRef)
      .map(call => String(call.name || '').trim())
      .filter(Boolean);
  } catch {
    return {
      verifier_id: 'read_only_tools',
      status: 'blocked',
      reasons: ['Fresh Trace is not valid JSONL'],
      evidence_refs: [traceRef],
    };
  }
  const allowed = new Set(['read_file', 'glob', 'grep']);
  const forbidden = [...new Set(toolNames.filter(name => !allowed.has(name)))];
  return {
    verifier_id: 'read_only_tools',
    status: forbidden.length === 0 ? 'pass' : 'fail',
    reasons: [
      forbidden.length === 0
        ? 'Replay used only the read-only tool set'
        : `Replay used forbidden tool(s): ${forbidden.join(', ')}`,
    ],
    evidence_refs: [traceRef],
    ...(forbidden.length > 0 ? { safety_violations: forbidden } : {}),
  };
}

function verifyTraceExists(replay: Readonly<ReplayResult>): VerifierResult {
  const traceRef = replay.trace_ref;
  const exists = Boolean(
    traceRef
    && fs.existsSync(traceRef)
    && fs.statSync(traceRef).isFile()
    && fs.statSync(traceRef).size > 0,
  );
  return {
    verifier_id: 'trace_exists',
    status: exists ? 'pass' : 'fail',
    reasons: [exists ? 'Fresh Trace exists' : 'Fresh Trace is missing or empty'],
    evidence_refs: traceRef ? [traceRef] : [],
  };
}

function verifyNoFailedTools(replay: Readonly<ReplayResult>): VerifierResult {
  const traceRef = replay.trace_ref;
  if (!traceRef || !fs.existsSync(traceRef)) {
    return {
      verifier_id: 'no_failed_tools',
      status: 'blocked',
      reasons: ['Cannot inspect tool results without a fresh Trace'],
      evidence_refs: traceRef ? [traceRef] : [],
    };
  }

  let toolCalls: Record<string, unknown>[];
  try {
    toolCalls = readToolCalls(traceRef);
  } catch {
    return {
      verifier_id: 'no_failed_tools',
      status: 'blocked',
      reasons: ['Fresh Trace is not valid JSONL'],
      evidence_refs: [traceRef],
    };
  }

  const failures = toolCalls.filter(call => (
    ['fail', 'failed', 'failure', 'error', 'blocked', 'cancelled'].includes(String(call.status || '').toLowerCase())
    || (typeof call.error_code === 'string' && Boolean(call.error_code))
  ));
  const missingStatus = toolCalls.filter(call => (
    typeof call.status !== 'string' || !call.status.trim()
  ));

  if (failures.length > 0) {
    return {
      verifier_id: 'no_failed_tools',
      status: 'fail',
      reasons: [`${failures.length} tool call(s) ended unsuccessfully`],
      evidence_refs: [traceRef],
    };
  }
  if (missingStatus.length > 0) {
    return {
      verifier_id: 'no_failed_tools',
      status: 'blocked',
      reasons: [`${missingStatus.length} tool call(s) lack structured terminal status`],
      evidence_refs: [traceRef],
    };
  }
  return {
    verifier_id: 'no_failed_tools',
    status: 'pass',
    reasons: ['All tool calls have successful terminal status'],
    evidence_refs: [traceRef],
  };
}

function readToolCalls(traceRef: string): Record<string, unknown>[] {
  const rows = fs.readFileSync(traceRef, 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as unknown);
  return rows.flatMap(row => (
    isRecord(row)
    && isRecord(row.assistant)
    && Array.isArray(row.assistant.tool_calls)
      ? row.assistant.tool_calls
      : []
  )).filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
