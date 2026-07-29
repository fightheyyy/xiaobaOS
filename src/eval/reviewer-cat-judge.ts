import * as crypto from 'crypto';
import {
  ReviewerDecision,
  ReviewerRequest,
} from './evaluation';

const READ_ONLY_JUDGE_HIDDEN_TOOLS = [
  'write_file',
  'edit_file',
  'execute_shell',
  'spawn_subagent',
  'check_subagent',
  'stop_subagent',
  'resume_subagent',
  'ask_parent',
];

export interface ReviewerCatJudgeOptions {
  working_directory: string;
  runSession?: (input: {
    session_id: string;
    parent_session_id: string;
    prompt: string;
    hidden_tools: readonly string[];
  }) => Promise<string>;
}

export function createReviewerCatJudge<Setup = unknown>(
  options: ReviewerCatJudgeOptions,
): (request: ReviewerRequest<Setup>) => Promise<readonly ReviewerDecision[]> {
  return request => runReviewerCatJudge(request, options);
}

export async function runReviewerCatJudge<Setup = unknown>(
  request: ReviewerRequest<Setup>,
  options: ReviewerCatJudgeOptions,
): Promise<readonly ReviewerDecision[]> {
  const sessionId = `evaluation-reviewer-${crypto.randomUUID()}`;
  const parentSessionId = `evaluation:judge:${request.case.case_id}:${crypto.randomUUID()}`;
  const prompt = buildReviewerCatJudgePrompt(request);
  const raw = options.runSession
    ? await options.runSession({
      session_id: sessionId,
      parent_session_id: parentSessionId,
      prompt,
      hidden_tools: READ_ONLY_JUDGE_HIDDEN_TOOLS,
    })
    : await runDefaultReviewerCatSession({
      workingDirectory: options.working_directory,
      sessionId,
      parentSessionId,
      prompt,
    });
  return parseReviewerCatDecisions(raw, request);
}

export function buildReviewerCatJudgePrompt<Setup = unknown>(
  request: ReviewerRequest<Setup>,
): string {
  return [
    'This is a formal ReviewerCat Judge call.',
    'Use only the read-only evidence below. Do not execute Replay, tests, Shell, writes, or later actions.',
    'Review all runs together, but return one decision for every run whose hard verifiers all passed.',
    'Hard verifier fail/blocked runs are context only and must not receive a semantic override.',
    'Return JSON only using the exact version 1 decisions schema from your system prompt.',
    '',
    JSON.stringify(request, null, 2),
  ].join('\n');
}

export function parseReviewerCatDecisions<Setup = unknown>(
  raw: string,
  request: ReviewerRequest<Setup>,
): ReviewerDecision[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new Error('ReviewerCat Judge must return one JSON object without prose');
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.decisions)) {
    throw new Error('ReviewerCat Judge returned an invalid version 1 decisions object');
  }

  const expectedRunIds = new Set(
    request.runs
      .filter(run => run.verification.every(result => result.status === 'pass'))
      .map(run => run.replay.run_id),
  );
  const allowedEvidenceRefs = new Set(
    request.runs.flatMap(run => [
      ...(run.replay.trace_ref ? [run.replay.trace_ref] : []),
      ...run.verification.flatMap(result => result.evidence_refs),
    ]),
  );
  const seen = new Set<string>();
  const decisions = parsed.decisions.map((value: unknown): ReviewerDecision => {
    if (!isRecord(value)) throw new Error('ReviewerCat decision must be an object');
    const runId = asString(value.run_id);
    const status = asString(value.status);
    if (!expectedRunIds.has(runId)) {
      throw new Error(`ReviewerCat returned an unexpected run_id: ${runId || 'missing'}`);
    }
    if (seen.has(runId)) throw new Error(`ReviewerCat returned duplicate run_id: ${runId}`);
    if (status !== 'pass' && status !== 'fail' && status !== 'blocked') {
      throw new Error(`ReviewerCat returned invalid status for ${runId}`);
    }
    const reasons = stringArray(value.reasons);
    if (reasons.length === 0) {
      throw new Error(`ReviewerCat returned no reasons for ${runId}`);
    }
    const evidenceRefs = stringArray(value.evidence_refs);
    const inventedRefs = evidenceRefs.filter(ref => !allowedEvidenceRefs.has(ref));
    if (inventedRefs.length > 0) {
      throw new Error(
        `ReviewerCat referenced evidence outside the request: ${inventedRefs.join(', ')}`,
      );
    }
    seen.add(runId);
    return {
      run_id: runId,
      status,
      reasons,
      evidence_refs: evidenceRefs,
    };
  });

  const missing = [...expectedRunIds].filter(runId => !seen.has(runId));
  if (missing.length > 0) {
    throw new Error(`ReviewerCat omitted run decisions: ${missing.join(', ')}`);
  }
  return decisions;
}

async function runDefaultReviewerCatSession(input: {
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
    import('../core/sub-agent-session'),
    import('../skills/skill-manager'),
    import('../utils/ai-service'),
  ]);
  const skills = new SkillManager('reviewer-cat');
  await skills.loadSkills();
  const session = new SubAgentSession(
    input.sessionId,
    new AIService(),
    skills,
    {
      roleName: 'reviewer-cat',
      skillName: 'case-review',
      taskDescription: 'read-only Agent Evaluation Judge',
      userMessage: input.prompt,
      workingDirectory: input.workingDirectory,
      parentSessionId: input.parentSessionId,
      allowSkillSelection: false,
      hiddenTools: READ_ONLY_JUDGE_HIDDEN_TOOLS,
    },
  );
  await session.run();
  const info = session.getInfo();
  if (info.status !== 'completed' || !info.resultSummary?.trim()) {
    throw new Error(`ReviewerCat Judge Session failed: ${info.resultSummary || info.status}`);
  }
  return info.resultSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(asString)
    .filter(Boolean);
}
