import * as fs from 'fs';
import * as path from 'path';
import { CaseReplaySetup } from '../replay/case-replay';
import {
  AgentCase,
  CaseSet,
  EvaluationResult,
  Oracle,
} from './evaluation';

export function loadCaseSet(
  filePath: string,
): CaseSet<CaseReplaySetup> {
  const resolved = path.resolve(filePath);
  const value = JSON.parse(fs.readFileSync(resolved, 'utf-8')) as unknown;
  if (!isRecord(value)) throw new Error(`CaseSet must be a JSON object: ${resolved}`);
  const caseSetId = requiredString(value.case_set_id, 'CaseSet case_set_id');
  if (!Array.isArray(value.cases)) throw new Error(`CaseSet ${caseSetId} requires cases[]`);
  return {
    case_set_id: caseSetId,
    cases: value.cases.map((item, index) => parseCase(item, index)),
  };
}

export function writeEvaluationResult(
  result: Readonly<EvaluationResult>,
  outDir: string,
): {
  result_path: string;
  report_path: string;
} {
  const resolved = path.resolve(outDir);
  fs.mkdirSync(resolved, { recursive: true });
  const resultPath = path.join(resolved, 'evaluation-result.json');
  const reportPath = path.join(resolved, 'report.md');
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(reportPath, `${renderEvaluationReport(result)}\n`, 'utf-8');
  return {
    result_path: resultPath,
    report_path: reportPath,
  };
}

export function renderEvaluationReport(
  result: Readonly<EvaluationResult>,
): string {
  const lines = [
    `# Evaluation: ${result.case_set_id}`,
    '',
    'This report is a view of `evaluation-result.json`; it is not a second decision source.',
    '',
    '## Measurements',
    '',
    `- Runs per Case: ${result.runs_per_case}`,
    `- Total: ${result.metrics.total_runs}`,
    `- Pass: ${result.metrics.pass_count}`,
    `- Fail: ${result.metrics.fail_count}`,
    `- Blocked: ${result.metrics.blocked_count}`,
    `- Pass rate: ${(result.metrics.pass_rate * 100).toFixed(2)}%`,
    `- Stability: ${result.metrics.stability}`,
    `- Safety violations: ${result.metrics.safety_violation_count}`,
    '',
    '## Outcomes',
    '',
    '| Case | Run | Outcome | Trace |',
    '| --- | --- | --- | --- |',
    ...result.outcomes.map(outcome => (
      `| ${escapeCell(outcome.case_id)} | ${escapeCell(outcome.run_id)} | ${outcome.status} | ${escapeCell(outcome.trace_ref ?? '')} |`
    )),
  ];
  return lines.join('\n');
}

function parseCase(
  value: unknown,
  index: number,
): AgentCase<CaseReplaySetup> {
  if (!isRecord(value)) throw new Error(`Case at index ${index} must be an object`);
  const caseId = requiredString(value.case_id, `Case at index ${index} case_id`);
  for (const field of [
    'model_response',
    'model_responses',
    'assistant_response',
    'tool_calls',
    'scripted_actions',
  ]) {
    if (value[field] !== undefined) {
      throw new Error(
        `Case ${caseId} contains ${field}; prewritten model behavior belongs to Scripted Runtime Test`,
      );
    }
  }
  const task = requiredString(value.task, `Case ${caseId} task`);
  return {
    case_id: caseId,
    task,
    ...(value.setup === undefined
      ? {}
      : { setup: parseSetup(value.setup, caseId) }),
    ...(value.budget === undefined
      ? {}
      : { budget: parsePositiveNumberMap(value.budget, caseId) }),
    oracle: parseOracle(value.oracle, caseId),
    ...(value.source === undefined
      ? {}
      : { source: parseSource(value.source, caseId) }),
  };
}

function parseSetup(value: unknown, caseId: string): CaseReplaySetup {
  if (!isRecord(value)) throw new Error(`Case ${caseId} setup must be an object`);
  const sandboxValue = optionalString(value.sandbox);
  if (sandboxValue && sandboxValue !== 'read_only' && sandboxValue !== 'workspace_write') {
    throw new Error(`Case ${caseId} setup.sandbox must be read_only or workspace_write`);
  }
  const sandbox: CaseReplaySetup['sandbox'] = sandboxValue === 'read_only'
    || sandboxValue === 'workspace_write'
    ? sandboxValue
    : undefined;
  return {
    ...(optionalString(value.cwd) ? { cwd: optionalString(value.cwd) } : {}),
    ...(optionalString(value.pet_id) ? { pet_id: optionalString(value.pet_id) } : {}),
    ...(optionalString(value.session_key) ? { session_key: optionalString(value.session_key) } : {}),
    ...(optionalString(value.required_active_skill_name)
      ? { required_active_skill_name: optionalString(value.required_active_skill_name) }
      : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(Array.isArray(value.follow_up_messages)
      ? { follow_up_messages: stringArray(value.follow_up_messages) }
      : {}),
  };
}

function parsePositiveNumberMap(
  value: unknown,
  caseId: string,
): NonNullable<AgentCase['budget']> {
  if (!isRecord(value)) throw new Error(`Case ${caseId} budget must be an object`);
  for (const key of ['max_tool_calls', 'max_tokens'] as const) {
    if (value[key] !== undefined) {
      throw new Error(`Case ${caseId} budget ${key} is unsupported because Replay does not enforce it`);
    }
  }
  const result: NonNullable<AgentCase['budget']> = {};
  for (const key of ['max_turns', 'max_latency_ms'] as const) {
    const item = value[key];
    if (item === undefined) continue;
    if (!Number.isInteger(item) || Number(item) <= 0) {
      throw new Error(`Case ${caseId} budget ${key} must be a positive integer`);
    }
    result[key] = Number(item);
  }
  return result;
}

function parseOracle(value: unknown, caseId: string): Oracle {
  if (!isRecord(value)) throw new Error(`Case ${caseId} requires oracle`);
  const hardVerifiers = stringArray(value.hard_verifiers);
  const semanticCriteria = stringArray(value.semantic_criteria);
  if (semanticCriteria.length === 0) {
    throw new Error(`Case ${caseId} requires oracle.semantic_criteria[]`);
  }
  return {
    hard_verifiers: hardVerifiers,
    semantic_criteria: semanticCriteria,
  };
}

function parseSource(
  value: unknown,
  caseId: string,
): NonNullable<AgentCase['source']> {
  if (!isRecord(value)) throw new Error(`Case ${caseId} source must be an object`);
  const traceRefs = stringArray(value.trace_refs);
  if (traceRefs.length === 0) throw new Error(`Case ${caseId} source requires trace_refs[]`);
  return {
    trace_refs: traceRefs,
    ...(optionalString(value.finding) ? { finding: optionalString(value.finding) } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean))];
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
