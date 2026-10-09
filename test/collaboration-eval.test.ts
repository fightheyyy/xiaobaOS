import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadCollaborationCases, scoreCollaborationAssertions, verifyCollaboration, readCollaborationEvidence, CollaborationEvidence } from '../src/eval/collaboration-cases';
import { summarizeCollaboration } from '../src/eval/collaboration-report';
import { replayCollaborationCase } from '../src/replay/collaboration-replay';
import { Outcome, runEvaluation } from '../src/eval/evaluation';
import { Logger } from '../src/utils/logger';
import { FILE_MEMORY_PREFIX } from '../src/utils/file-memory-context';

const codeRoot = path.resolve('.');
const source = path.join(codeRoot, 'eval/case-sets/continuous-collaboration.json');
const suite = loadCollaborationCases(source);
const usage = { promptTokens: 80, completionTokens: 20, totalTokens: 100 };
const reply = (content: string) => ({ content, usage });
const tool = (name: string, args: unknown) => ({ content: null, usage, toolCalls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

test('24 scenarios are real input trajectories with three explicit capability baselines', () => {
  assert.equal(suite.cases.length, 24);
  for (const category of ['async', 'memory', 'events']) assert.equal(suite.cases.filter(item => item.setup!.category === category).length, 8);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-invalid-'));
  try {
    const mutated = structuredClone(suite);
    (mutated.cases[0] as any).model_responses = [{ content: 'answer' }];
    const file = path.join(temporary, 'cases.json'); fs.writeFileSync(file, JSON.stringify(mutated));
    assert.throws(() => loadCollaborationCases(file), /Scripted model actions/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('dry-run validates the execution matrix without model calls or a scorecard', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-plan-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/run-collaboration-eval.ts', '--dry-run', '--runs', '1', '--out', temporary], { cwd: codeRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(temporary, 'plan.json'), 'utf8')).total_trajectories, 48);
    assert.deepEqual(fs.readdirSync(temporary), ['plan.json']);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('actual shared loops demonstrate interruption and completion routing without treating the script as Agent Eval', async () => {
  const item = suite.cases.find(item => item.case_id === 'collaboration.async.interrupt')!;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-runtime-'));
  const cwd = process.cwd(), projectRoot = process.env.XIAOBA_PROJECT_ROOT;
  Logger.setSilentMode(true); process.env.XIAOBA_PROJECT_ROOT = codeRoot;
  const provider = () => ({
    chat: async () => reply('测试摘要'),
    chatStream: async (messages: any[], tools: any[]) => {
      const last = messages.filter(message => message.role !== 'system').at(-1);
      const visible = new Set(tools.map(tool => tool.name));
      if (last.role === 'tool') {
        if (last.name === 'fixture_app') {
          const result = String(last.content).match(/RESULT-alpha:FULL/);
          return visible.has('send_text') ? tool('send_text', { text: result?.[0] ?? '报告失败' }) : reply(String(last.content));
        }
        return reply('');
      }
      const text = String(last.content);
      if (text.includes('17+20')) return tool('send_text', { text: 'SUM-37' });
      if (text.includes('RESULT-alpha:FULL')) return tool('send_text', { text: 'RESULT-alpha:FULL' });
      if (visible.has('spawn_subagent')) return tool('spawn_subagent', { role_name: 'base', task_description: '检查 alpha', user_message: '分析 job alpha，范围 FULL，返回 result_code。' });
      return tool('fixture_app', { action: 'inspect', job_id: 'alpha', scope: 'FULL' });
    },
  });
  try {
    const results: CollaborationEvidence[] = [];
    for (const mode of ['candidate', 'baseline'] as const) {
      const root = path.join(temporary, mode); fs.mkdirSync(root); process.chdir(root);
      const replay = await replayCollaborationCase(item, { root, mode, model: { model: 'scripted-test' }, fixtureDelayMs: 250,
        timeoutMs: 10000, maxModelCalls: 30, maxTokens: 10000, aiServiceFactory: provider as any });
      assert.equal(replay.status, 'completed', replay.reason);
      const evidence = readCollaborationEvidence(replay); results.push(evidence);
      assert.equal(evidence.evidence_kind, 'scripted-test');
      assert.equal(verifyCollaboration({ case: item, replay })[0].status, 'blocked');
      const checks = scoreCollaborationAssertions(item.setup!, evidence);
      if (mode === 'candidate') assert.ok(checks.every(check => check.pass), JSON.stringify(checks));
      else assert.ok(checks.some(check => !check.pass && check.reason.startsWith('reply_before_job_end')));
      const question = evidence.deliveries.find(d => d.text === 'SUM-37')!;
      const work = evidence.tools.find(t => t.name === 'fixture_app')!;
      assert.equal(question.at_ms < work.end_ms, mode === 'candidate');
      assert.equal(evidence.deliveries.filter(d => d.text === 'RESULT-alpha:FULL').length, 1);
    }
    assert.ok(results[0].tools.some(t => t.name === 'spawn_subagent'));
    assert.ok(!results[1].tools.some(t => t.name === 'spawn_subagent'));
  } finally {
    process.chdir(cwd); if (projectRoot === undefined) delete process.env.XIAOBA_PROJECT_ROOT; else process.env.XIAOBA_PROJECT_ROOT = projectRoot;
    Logger.setSilentMode(false); fs.rmSync(temporary, { recursive: true, force: true });
  }
});

function evidence(overrides: Partial<CollaborationEvidence> = {}): CollaborationEvidence {
  return { schema: 'xiaoba.collaboration.v1', case_id: 'collaboration.events.example', category: 'events', mode: 'candidate', baseline: 'relay-all-events',
    evidence_kind: 'live-model', timing: { fixture_delay_ms: 20000, timers: 'simulated', context_boundary: 'explicit-reset' },
    model: {}, model_calls: 3, tokens: 100, token_usage_complete: true, deliveries: [], tools: [], steps: {}, memory: {}, notification_labels: {}, interrupt_expectations: {}, ...overrides };
}
function outcome(status: Outcome['status'], run_id = 'r1-test'): Outcome {
  return { run_id, case_id: 'collaboration.events.example', status, reasons: [], evidence_refs: [], verifier_results: [] };
}

test('silent agents get zero recall, no invented precision; blocked runs remain in denominator', () => {
  const rows = [{ mode: 'candidate' as const, outcome: outcome('fail'), evidence: evidence({ notification_labels: { important: true, noise: false } }) },
    { mode: 'candidate' as const, outcome: outcome('blocked', 'r2-blocked') }];
  const summary = summarizeCollaboration(rows)[0];
  assert.equal(summary.total, 2); assert.equal(summary.full_scenario_success_rate, 0);
  assert.equal(summary.notification_recall, 0); assert.equal(summary.notification_precision, null);
  assert.equal(summary.accepted_interrupt_latency_p50_ms, null); assert.equal(summary.mean_user_rescues, null);
  assert.equal(summary.subject_tokens, null);
});

test('notice spam counts without an event locator and cannot hide behind empty output IDs', () => {
  const summary = summarizeCollaboration([{ mode: 'candidate', outcome: outcome('fail'), evidence: evidence({
    notification_labels: { important: true, noise: false }, deliveries: [
      { session: 'alice', at_ms: 2, cause: 'event:important', text: '重要消息' },
      { session: 'alice', at_ms: 3, cause: 'event:noise', text: '打扰一下' },
    ],
  }) }])[0];
  assert.equal(summary.notification_precision, .5); assert.equal(summary.notification_recall, 1);
});

test('wrong-session and duplicated completed results are hard safety failures', () => {
  const setup = suite.cases[0].setup!;
  const observed = evidence({ deliveries: [
    { session: 'bob', at_ms: 20, cause: 'completion', text: 'RESULT-alpha:FULL' },
    { session: 'alice', at_ms: 21, cause: 'completion', text: 'RESULT-alpha:FULL' },
  ] });
  const results = scoreCollaborationAssertions(setup, observed);
  assert.ok(results.some(result => result.safety && !result.pass && result.reason.startsWith('correct-session')));
  assert.ok(results.some(result => result.safety && !result.pass && result.reason.startsWith('no duplicate')));
  assert.ok(results.some(result => result.safety && !result.pass && result.reason.startsWith('no invented')));
});

test('rescue counts require explicit evidence; scripted evidence cannot enter real measurement reports', () => {
  const rows = [{ mode: 'candidate' as const, outcome: outcome('pass'), evidence: evidence() }];
  assert.throws(() => summarizeCollaboration(rows, [{ run_id: 'unknown', rescue_count: 0, evidence: 'checked' }]), /Invalid rescue annotation/);
  assert.throws(() => summarizeCollaboration(rows, [{ run_id: 'r1-test', rescue_count: 0, evidence: '' }]), /Invalid rescue annotation/);
  assert.equal(summarizeCollaboration(rows, [{ run_id: 'r1-test', rescue_count: 2, evidence: 'visible transcript review' }])[0].mean_user_rescues, 2);
  assert.throws(() => summarizeCollaboration([{ ...rows[0], evidence: evidence({ evidence_kind: 'scripted-test' }) }]), /Scripted engineering/);
});

test('a correct late answer is measured even when the full scenario fails; acknowledgments are excluded', () => {
  const summary = summarizeCollaboration([{ mode: 'baseline', outcome: { ...outcome('fail'), case_id: 'collaboration.async.example' }, evidence: evidence({
    category: 'async', steps: { question: 10 }, interrupt_expectations: { question: 'SUM-37' }, deliveries: [
      { session: 'alice', at_ms: 11, cause: 'question', text: '我看看' },
      { session: 'alice', at_ms: 35, cause: 'question', text: 'SUM-37' },
    ],
  }) }])[0];
  assert.equal(summary.accepted_interrupt_latency_p50_ms, 25);
  assert.equal(summary.full_scenario_success_rate, 0);
});

test('real Evolution remember writes survive equal context resets; transcript-only baseline retains only the current dialogue', async () => {
  const item = suite.cases.find(item => item.case_id === 'collaboration.memory.stable-preference')!;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-memory-'));
  const cwd = process.cwd(), projectRoot = process.env.XIAOBA_PROJECT_ROOT;
  Logger.setSilentMode(true); process.env.XIAOBA_PROJECT_ROOT = codeRoot;
  const provider = () => ({ chat: async () => reply('测试摘要'), chatStream: async (messages: any[], tools: any[]) => {
    const last = messages.filter(message => message.role !== 'system').at(-1);
    const names = new Set(tools.map(tool => tool.name));
    if (last.role === 'tool') return reply(last.name === 'remember' ? '已写入周报安排' : '');
    if (names.has('remember')) return tool('remember', { content: '用户的周报固定周五交。', kind: 'fact', evidence: '用户明确要求，适用于固定周报安排' });
    if (String(last.content).includes('请长期记住')) {
      if (names.has('memory_record_lookup')) return tool('spawn_subagent', { role_name: 'evolution-cat', task_description: '记录周报安排', user_message: String(last.content) });
      return tool('send_text', { text: '当前对话中收到这个安排' });
    }
    if (String(last.content).includes('周报固定哪天') || String(last.content).includes('周报是哪天')) {
      const known = messages.some(message => typeof message.content === 'string' && message.content.includes('周五')
        && (message.role === 'user' || message.content.startsWith(FILE_MEMORY_PREFIX)));
      return tool('send_text', { text: known ? '周五' : '不知道' });
    }
    return reply('');
  } });
  try {
    for (const mode of ['candidate', 'baseline'] as const) {
      const root = path.join(temporary, mode); fs.mkdirSync(root); process.chdir(root);
      const replay = await replayCollaborationCase(item, { root, mode, model: { model: 'scripted-test' }, fixtureDelayMs: 100,
        timeoutMs: 10000, maxModelCalls: 40, maxTokens: 10000, aiServiceFactory: provider as any });
      assert.equal(replay.status, 'completed', replay.reason);
      const observed = readCollaborationEvidence(replay);
      assert.ok(observed.deliveries.some(d => d.cause === 'control' && d.text === '周五'));
      assert.equal(observed.deliveries.some(d => d.cause === 'probe' && d.text === '周五'), mode === 'candidate');
      assert.equal(Boolean(observed.memory.alice?.includes('周五')), mode === 'candidate');
      if (mode === 'candidate') assert.ok(scoreCollaborationAssertions(item.setup!, observed).every(check => check.pass));
    }
  } finally {
    process.chdir(cwd); if (projectRoot === undefined) delete process.env.XIAOBA_PROJECT_ROOT; else process.env.XIAOBA_PROJECT_ROOT = projectRoot;
    Logger.setSilentMode(false); fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('persisted reminders dispatch through the actual Event timer path and repeated ticks do not redeliver', async () => {
  const item = suite.cases.find(item => item.case_id === 'collaboration.events.explicit-reminder')!;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-timer-'));
  const cwd = process.cwd(), projectRoot = process.env.XIAOBA_PROJECT_ROOT;
  Logger.setSilentMode(true); process.env.XIAOBA_PROJECT_ROOT = codeRoot;
  const provider = () => ({ chat: async () => reply('测试摘要'), chatStream: async (messages: any[]) => {
    const last = messages.filter(message => message.role !== 'system').at(-1);
    if (last.role === 'tool') return reply('');
    return tool('schedule_reminder', { action: 'create', due_at: String(last.content).match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/)![0],
      purpose: 'REM-REVIEW：查看报告', source: 'user', mode: 'remind' });
  } });
  try {
    process.chdir(temporary);
    const replay = await replayCollaborationCase(item, { root: temporary, mode: 'candidate', model: { model: 'scripted-test' },
      fixtureDelayMs: 100, timeoutMs: 10000, maxModelCalls: 20, maxTokens: 10000, aiServiceFactory: provider as any });
    assert.equal(replay.status, 'completed', replay.reason);
    const observed = readCollaborationEvidence(replay);
    assert.equal(observed.deliveries.filter(d => d.cause === 'scheduled-reminder').length, 1);
    assert.ok(scoreCollaborationAssertions(item.setup!, observed).every(check => check.pass));
    assert.equal(observed.timing.timers, 'simulated');
  } finally {
    process.chdir(cwd); if (projectRoot === undefined) delete process.env.XIAOBA_PROJECT_ROOT; else process.env.XIAOBA_PROJECT_ROOT = projectRoot;
    Logger.setSilentMode(false); fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('collaboration Verifier obeys shared Eval declared-ID contract and passing checks do not become safety violations', async () => {
  const item = suite.cases.find(item => item.case_id === 'collaboration.memory.forget')!;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-shared-eval-'));
  try {
    const observed = evidence({ case_id: item.case_id, category: 'memory', memory: {} });
    fs.writeFileSync(path.join(temporary, 'trajectory.json'), JSON.stringify(observed));
    const trace = path.join(temporary, 'trajectory.jsonl'); fs.writeFileSync(trace, '{}\n');
    const result = await runEvaluation({ case_set: { case_set_id: 'synthetic-contract-test-only', cases: [item] }, runs_per_case: 1 }, {
      replay: async () => ({ case_id: item.case_id, run_id: 'synthetic-contract', status: 'completed', trace_ref: trace }),
      verify: async input => verifyCollaboration(input),
      review: async request => [{ run_id: request.runs[0].replay.run_id, status: 'pass', reasons: ['Synthetic Judge for shared-core contract test only'], evidence_refs: [trace] }],
    });
    assert.equal(result.outcomes[0].status, 'pass');
    assert.equal(result.outcomes[0].verifier_results[0].verifier_id, 'collaboration_contract');
    assert.equal(result.metrics.safety_violation_count, 0);
    observed.deliveries.push({ session: 'alice', text: 'ORBIT-472', at_ms: 20, cause: 'probe' });
    fs.writeFileSync(path.join(temporary, 'trajectory.json'), JSON.stringify(observed));
    const checks = verifyCollaboration({ case: item, replay: { case_id: item.case_id, run_id: 'synthetic-contract', status: 'completed', trace_ref: trace } });
    assert.equal(checks[0].status, 'fail');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
