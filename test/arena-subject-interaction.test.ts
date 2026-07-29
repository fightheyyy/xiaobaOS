import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findSessionTrace,
  runSubjectInteraction,
} from '../src/arena/subject-interaction';

describe('Arena Subject interaction adapter', () => {
  test('returns the standard AgentSession Trace instead of the UserCat package trace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-arena-interaction-'));
    const sessionKey = 'pet:xiaoba:role-engineer-cat:usercat-simulation-arena-demo';
    const traceDir = path.join(
      root,
      'logs',
      'sessions',
      'pet',
      '2026-07-29',
      safeSegment(sessionKey),
    );
    const tracePath = path.join(traceDir, 'traces.jsonl');
    fs.mkdirSync(traceDir, { recursive: true });
    fs.writeFileSync(tracePath, `${JSON.stringify({
      schema_version: 3,
      entry_type: 'trace',
      session_id: sessionKey,
      user: { text: 'help me' },
      assistant: { text: 'done', tool_calls: [] },
    })}\n`);

    const result = await runSubjectInteraction({
      arena_run_id: 'run-1',
      subject: { subject_id: 'engineer', role_id: 'engineer-cat' },
      scenario: {
        scenario_id: 'demo',
        user_context: '',
        goal: 'help me',
        constraints: [],
        turn_budget: 2,
      },
    }, {
      working_directory: root,
      trace_root: path.join(root, 'logs', 'sessions'),
      executeUserTrace: async () => [
        'user_trace_run: status=completed',
        `session_key=${sessionKey}`,
        'trace=data/user-cat/traces/arena-demo/trace.jsonl',
      ].join('\n'),
    });

    assert.deepEqual(result.trace_refs, [tracePath]);
    assert.notEqual(result.trace_refs[0], 'data/user-cat/traces/arena-demo/trace.jsonl');
  });

  test('uses a fresh UserTrace run and Session for repeated Arena interactions', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-arena-fresh-session-'));
    const runIds: string[] = [];
    const contextRunIds: string[] = [];
    const executeUserTrace = async ({
      args,
      context,
    }: {
      args: Record<string, unknown>;
      context: { runId?: string };
    }): Promise<string> => {
      const runId = String(args.run_id);
      const sessionKey = `pet:xiaoba:role-engineer-cat:usercat-simulation-${runId}`;
      const traceDir = path.join(
        root,
        'logs',
        'sessions',
        'pet',
        '2026-07-29',
        safeSegment(sessionKey),
      );
      fs.mkdirSync(traceDir, { recursive: true });
      fs.writeFileSync(
        path.join(traceDir, 'traces.jsonl'),
        `${JSON.stringify({ session_id: sessionKey })}\n`,
      );
      runIds.push(runId);
      contextRunIds.push(String(context.runId));
      return `session_key=${sessionKey}`;
    };
    const input = {
      arena_run_id: 'same-run',
      subject: { subject_id: 'engineer', role_id: 'engineer-cat' },
      scenario: {
        scenario_id: 'same-scenario',
        user_context: '',
        goal: 'help me',
        constraints: [],
        turn_budget: 2,
      },
    };
    const options = {
      working_directory: root,
      trace_root: path.join(root, 'logs', 'sessions'),
      executeUserTrace,
    };

    const first = await runSubjectInteraction(input, options);
    const second = await runSubjectInteraction(input, options);

    assert.equal(runIds.length, 2);
    assert.notEqual(runIds[0], runIds[1]);
    assert.deepEqual(contextRunIds, runIds);
    assert.notDeepEqual(first.trace_refs, second.trace_refs);
    assert.equal(input.arena_run_id, 'same-run');
  });

  test('ignores a path whose rows belong to another Session', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-arena-trace-'));
    const sessionKey = 'pet:xiaoba:role-base:run';
    const traceDir = path.join(root, 'pet', '2026-07-29', safeSegment(sessionKey));
    fs.mkdirSync(traceDir, { recursive: true });
    fs.writeFileSync(
      path.join(traceDir, 'traces.jsonl'),
      `${JSON.stringify({ session_id: 'another-session' })}\n`,
    );
    assert.equal(findSessionTrace(root, 'pet', sessionKey), undefined);
  });
});

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'item';
}
