import * as crypto from 'crypto';
import { FindingCase } from '../../arena/arena-workflow';
import { AgentCase, CaseBudget, Oracle } from '../../eval/evaluation';

const READ_ONLY_INSPECTOR_HIDDEN_TOOLS = [
  'write_file',
  'edit_file',
  'execute_shell',
  'spawn_subagent',
  'check_subagent',
  'stop_subagent',
  'resume_subagent',
  'ask_parent',
];

export interface InspectorCatRequest {
  trace_refs: readonly string[];
  evidence_refs?: readonly string[];
  context?: Readonly<Record<string, unknown>>;
}

export interface InspectorCatOptions {
  working_directory: string;
  runSession?: (input: {
    session_id: string;
    parent_session_id: string;
    prompt: string;
    hidden_tools: readonly string[];
  }) => Promise<string>;
}

export function createInspectorCat<Setup = unknown>(
  options: InspectorCatOptions,
): (request: InspectorCatRequest) => Promise<readonly FindingCase<Setup>[]> {
  return request => runInspectorCat<Setup>(request, options);
}

export async function runInspectorCat<Setup = unknown>(
  request: InspectorCatRequest,
  options: InspectorCatOptions,
): Promise<readonly FindingCase<Setup>[]> {
  validateRequest(request);
  const sessionId = `inspector-${crypto.randomUUID()}`;
  const parentSessionId = `inspection:${crypto.randomUUID()}`;
  const prompt = buildInspectorCatPrompt(request);
  const raw = options.runSession
    ? await options.runSession({
      session_id: sessionId,
      parent_session_id: parentSessionId,
      prompt,
      hidden_tools: READ_ONLY_INSPECTOR_HIDDEN_TOOLS,
    })
    : await runDefaultInspectorCatSession({
      workingDirectory: options.working_directory,
      sessionId,
      parentSessionId,
      prompt,
    });
  return parseInspectorFindingCases<Setup>(raw, request);
}

export function buildInspectorCatPrompt(request: InspectorCatRequest): string {
  return [
    'This is a formal read-only InspectorCat call.',
    'Inspect only the supplied Trace and evidence refs.',
    'Return 0..n paired Finding + executable Case values using the version 1 JSON contract.',
    'Do not repair, judge, route, score, or inspect any Replay Trace recursively.',
    '',
    JSON.stringify(request, null, 2),
  ].join('\n');
}

export function parseInspectorFindingCases<Setup = unknown>(
  raw: string,
  request: InspectorCatRequest,
): FindingCase<Setup>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new Error('InspectorCat must return one JSON object without prose');
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.finding_cases)) {
    throw new Error('InspectorCat returned an invalid version 1 finding_cases object');
  }

  const allowedEvidence = new Set([
    ...request.trace_refs,
    ...(request.evidence_refs ?? []),
  ]);
  const caseIds = new Set<string>();
  return parsed.finding_cases.map((value: unknown): FindingCase<Setup> => {
    if (!isRecord(value) || !isRecord(value.finding) || !isRecord(value.case)) {
      throw new Error('InspectorCat finding_cases entries require finding and case objects');
    }
    const findingSummary = requiredString(value.finding.summary, 'Finding summary');
    const findingEvidence = stringArray(value.finding.evidence_refs);
    if (findingEvidence.length === 0) throw new Error('Finding requires evidence_refs');
    assertAllowedRefs(findingEvidence, allowedEvidence, 'Finding');

    const caseId = requiredString(value.case.case_id, 'Case id');
    if (caseIds.has(caseId)) throw new Error(`InspectorCat returned duplicate Case id: ${caseId}`);
    caseIds.add(caseId);
    const task = requiredString(value.case.task, `Case ${caseId} task`);
    const oracle = parseOracle(value.case.oracle, caseId);
    const source = parseSource(value.case.source, caseId, request.trace_refs);

    const evaluationCase: AgentCase<Setup> = {
      case_id: caseId,
      task,
      ...(value.case.setup !== undefined ? { setup: value.case.setup as Setup } : {}),
      ...(value.case.budget !== undefined
        ? { budget: parseBudget(value.case.budget, caseId) }
        : {}),
      oracle,
      source,
    };
    return {
      finding: {
        summary: findingSummary,
        evidence_refs: findingEvidence,
      },
      case: evaluationCase,
    };
  });
}

async function runDefaultInspectorCatSession(input: {
  workingDirectory: string;
  sessionId: string;
  parentSessionId: string;
  prompt: string;
}): Promise<string> {
  const [
    { SubAgentSession },
    { SkillManager },
    { AIService },
  ] = await Promise.all([
    import('../../core/sub-agent-session'),
    import('../../skills/skill-manager'),
    import('../../utils/ai-service'),
  ]);
  const skills = new SkillManager('inspector-cat');
  await skills.loadSkills();
  const session = new SubAgentSession(
    input.sessionId,
    new AIService(),
    skills,
    {
      roleName: 'inspector-cat',
      skillName: 'log-review',
      taskDescription: 'read-only Trace to Finding + Case',
      userMessage: input.prompt,
      workingDirectory: input.workingDirectory,
      parentSessionId: input.parentSessionId,
      allowSkillSelection: false,
      hiddenTools: READ_ONLY_INSPECTOR_HIDDEN_TOOLS,
    },
  );
  await session.run();
  const info = session.getInfo();
  if (info.status !== 'completed' || !info.resultSummary?.trim()) {
    throw new Error(`InspectorCat Session failed: ${info.resultSummary || info.status}`);
  }
  return info.resultSummary;
}

function validateRequest(request: InspectorCatRequest): void {
  if (request.trace_refs.length === 0) throw new Error('InspectorCat requires at least one Trace');
  if (request.trace_refs.some(ref => !ref.trim())) throw new Error('InspectorCat received an empty Trace ref');
}

function parseOracle(value: unknown, caseId: string): Oracle {
  if (!isRecord(value)) throw new Error(`Case ${caseId} requires an Oracle`);
  const hardVerifiers = stringArray(value.hard_verifiers);
  const semanticCriteria = stringArray(value.semantic_criteria);
  if (semanticCriteria.length === 0) {
    throw new Error(`Case ${caseId} requires semantic Oracle criteria`);
  }
  return {
    hard_verifiers: hardVerifiers,
    semantic_criteria: semanticCriteria,
  };
}

function parseSource(
  value: unknown,
  caseId: string,
  allowedTraceRefs: readonly string[],
): AgentCase['source'] {
  if (!isRecord(value)) throw new Error(`Case ${caseId} requires source Trace refs`);
  const traceRefs = stringArray(value.trace_refs);
  if (traceRefs.length === 0 || !traceRefs.some(ref => allowedTraceRefs.includes(ref))) {
    throw new Error(`Case ${caseId} is not linked to an inspected Trace`);
  }
  const inventedRefs = traceRefs.filter(ref => !allowedTraceRefs.includes(ref));
  if (inventedRefs.length > 0) {
    throw new Error(
      `Case ${caseId} referenced source Trace outside the request: ${inventedRefs.join(', ')}`,
    );
  }
  return {
    trace_refs: traceRefs,
    ...(typeof value.finding === 'string' && value.finding.trim()
      ? { finding: value.finding.trim() }
      : {}),
  };
}

function parseBudget(value: unknown, caseId: string): CaseBudget {
  if (!isRecord(value)) throw new Error(`Case ${caseId} budget must be an object`);
  for (const key of ['max_tool_calls', 'max_tokens'] as const) {
    if (value[key] !== undefined) {
      throw new Error(`Case ${caseId} budget ${key} is unsupported because Replay does not enforce it`);
    }
  }
  const budget: CaseBudget = {};
  for (const key of ['max_turns', 'max_latency_ms'] as const) {
    const item = value[key];
    if (item === undefined) continue;
    if (!Number.isInteger(item) || Number(item) <= 0) {
      throw new Error(`Case ${caseId} budget ${key} must be a positive integer`);
    }
    budget[key] = Number(item);
  }
  return budget;
}

function assertAllowedRefs(
  refs: readonly string[],
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = refs.filter(ref => !allowed.has(ref));
  if (unknown.length > 0) {
    throw new Error(`${label} referenced evidence outside the request: ${unknown.join(', ')}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean))];
}
