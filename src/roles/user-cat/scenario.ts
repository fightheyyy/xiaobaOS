import * as crypto from 'crypto';
import { ArenaSubject, Scenario } from '../../arena/arena-workflow';

const USERCAT_HIDDEN_TOOLS = [
  'write_file',
  'edit_file',
  'execute_shell',
  'spawn_subagent',
  'check_subagent',
  'stop_subagent',
  'resume_subagent',
  'ask_parent',
  'analyze_log',
  'user_trace_run',
];

export interface UserCatScenarioOptions {
  working_directory: string;
  runSession?: (input: {
    session_id: string;
    parent_session_id: string;
    prompt: string;
    hidden_tools: readonly string[];
  }) => Promise<string>;
}

export function createUserCatScenarioProposer(
  options: UserCatScenarioOptions,
): (subject: Readonly<ArenaSubject>) => Promise<Scenario> {
  return subject => proposeUserCatScenario(subject, options);
}

export async function proposeUserCatScenario(
  subject: Readonly<ArenaSubject>,
  options: UserCatScenarioOptions,
): Promise<Scenario> {
  if (!subject.subject_id.trim()) throw new Error('UserCat Scenario requires subject_id');
  const sessionId = `usercat-scenario-${crypto.randomUUID()}`;
  const parentSessionId = `arena:scenario:${crypto.randomUUID()}`;
  const prompt = buildUserCatScenarioPrompt(subject);
  const raw = options.runSession
    ? await options.runSession({
      session_id: sessionId,
      parent_session_id: parentSessionId,
      prompt,
      hidden_tools: USERCAT_HIDDEN_TOOLS,
    })
    : await runDefaultUserCatSession({
      workingDirectory: options.working_directory,
      sessionId,
      parentSessionId,
      prompt,
    });
  return parseUserCatScenario(raw);
}

export function buildUserCatScenarioPrompt(subject: Readonly<ArenaSubject>): string {
  return [
    'Arena has no user-provided Scenario.',
    'Create one small, realistic end-user Scenario for this subject.',
    'Do not create a pressure plan, Oracle, verifier, hidden criterion, or judgment.',
    'Return JSON only:',
    '{"version":1,"scenario":{"scenario_id":"...","user_context":"...","goal":"...","constraints":["..."],"turn_budget":4}}',
    '',
    JSON.stringify({ subject }, null, 2),
  ].join('\n');
}

export function parseUserCatScenario(raw: string): Scenario {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new Error('UserCat Scenario must be one JSON object without prose');
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.scenario)) {
    throw new Error('UserCat returned an invalid version 1 Scenario object');
  }
  const scenario = parsed.scenario;
  const scenarioId = requiredString(scenario.scenario_id, 'Scenario id');
  const goal = requiredString(scenario.goal, `Scenario ${scenarioId} goal`);
  const userContext = typeof scenario.user_context === 'string'
    ? scenario.user_context.trim()
    : '';
  const constraints = stringArray(scenario.constraints);
  if (!Number.isInteger(scenario.turn_budget) || Number(scenario.turn_budget) <= 0) {
    throw new Error(`Scenario ${scenarioId} turn_budget must be a positive integer`);
  }
  return {
    scenario_id: scenarioId,
    user_context: userContext,
    goal,
    constraints,
    turn_budget: Number(scenario.turn_budget),
  };
}

async function runDefaultUserCatSession(input: {
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
  const skills = new SkillManager('user-cat');
  await skills.loadSkills();
  const session = new SubAgentSession(
    input.sessionId,
    new AIService(),
    skills,
    {
      roleName: 'user-cat',
      taskDescription: 'create one Arena Scenario seed',
      userMessage: input.prompt,
      workingDirectory: input.workingDirectory,
      parentSessionId: input.parentSessionId,
      allowSkillSelection: false,
      hiddenTools: USERCAT_HIDDEN_TOOLS,
    },
  );
  await session.run();
  const info = session.getInfo();
  if (info.status !== 'completed' || !info.resultSummary?.trim()) {
    throw new Error(`UserCat Scenario Session failed: ${info.resultSummary || info.status}`);
  }
  return info.resultSummary;
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
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
}
