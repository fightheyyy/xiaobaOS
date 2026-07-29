import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { ToolExecutionContext } from '../types/tool';
import { UserTraceRunTool } from '../roles/user-cat/tools/user-trace-run-tool';
import {
  ArenaInteractionResult,
  ArenaSubject,
  Scenario,
} from './arena-workflow';

export interface SubjectInteractionOptions {
  working_directory: string;
  trace_root?: string;
  executeUserTrace?: (input: {
    args: Record<string, unknown>;
    context: ToolExecutionContext;
    subject_skill_id?: string;
  }) => Promise<string>;
}

export function createSubjectInteraction(
  options: SubjectInteractionOptions,
): (input: {
  arena_run_id: string;
  subject: Readonly<ArenaSubject>;
  scenario: Readonly<Scenario>;
}) => Promise<ArenaInteractionResult> {
  return input => runSubjectInteraction(input, options);
}

export async function runSubjectInteraction(
  input: {
    arena_run_id: string;
    subject: Readonly<ArenaSubject>;
    scenario: Readonly<Scenario>;
  },
  options: SubjectInteractionOptions,
): Promise<ArenaInteractionResult> {
  const targetRole = input.subject.role_id || 'base';
  const runId = [
    'arena',
    safeSegment(input.arena_run_id),
    safeSegment(input.scenario.scenario_id),
    randomUUID(),
  ].join('-');
  const context: ToolExecutionContext = {
    workingDirectory: path.resolve(options.working_directory),
    conversationHistory: [],
    runId,
    roleName: 'user-cat',
    surface: 'pet',
  };
  const args = {
    cwd: '.',
    run_id: runId,
    target_role: targetRole,
    scenario: input.scenario.goal,
    messages: [input.scenario.goal],
    max_turns: input.scenario.turn_budget,
    interaction_mode: 'adaptive',
    seed: {
      scenario_id: input.scenario.scenario_id,
      user_context: input.scenario.user_context,
      constraints: input.scenario.constraints,
      subject_id: input.subject.subject_id,
    },
  };
  const output = options.executeUserTrace
    ? await options.executeUserTrace({
        args,
        context,
        subject_skill_id: input.subject.skill_id,
      })
    : await new UserTraceRunTool({
        ...(input.subject.skill_id
          ? { arenaSubjectSkillId: input.subject.skill_id }
          : {}),
      }).execute(args, context);
  const sessionKey = outputField(output, 'session_key');
  if (!sessionKey) throw new Error('UserCat interaction produced no native session_key');

  const traceRoot = path.resolve(options.trace_root ?? path.join('logs', 'sessions'));
  const traceRef = findSessionTrace(traceRoot, 'pet', sessionKey);
  if (!traceRef) {
    throw new Error(`UserCat interaction produced no standard Trace for ${sessionKey}`);
  }
  return { trace_refs: [traceRef] };
}

export function findSessionTrace(
  traceRoot: string,
  sessionType: string,
  sessionId: string,
): string | undefined {
  const root = path.join(path.resolve(traceRoot), safeSegment(sessionType));
  if (!fs.existsSync(root)) return undefined;
  const safeSessionId = safeSegment(sessionId);
  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(root, entry.name, safeSessionId, 'traces.jsonl'))
    .filter(filePath => fs.existsSync(filePath) && fs.statSync(filePath).isFile())
    .filter(filePath => traceBelongsToSession(filePath, sessionId))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  return candidates[0];
}

function traceBelongsToSession(filePath: string, sessionId: string): boolean {
  try {
    return fs.readFileSync(filePath, 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean)
      .some(line => {
        const value = JSON.parse(line) as Record<string, unknown>;
        return value.session_id === sessionId;
      });
  } catch {
    return false;
  }
}

function outputField(output: string, name: string): string | undefined {
  const prefix = `${name}=`;
  return output
    .split(/\r?\n/)
    .find(line => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim() || undefined;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'item';
}
