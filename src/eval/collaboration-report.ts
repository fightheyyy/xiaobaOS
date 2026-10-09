import * as fs from 'node:fs';
import * as path from 'node:path';
import { Outcome } from './evaluation';
import { COLLABORATION_BASELINES, CollaborationEvidence, CollaborationMode } from './collaboration-cases';

export interface CollaborationMeasurement {
  mode: CollaborationMode;
  outcome: Outcome;
  evidence?: CollaborationEvidence;
}
export interface RescueAnnotation { run_id: string; rescue_count: number; evidence: string }

/** Metrics are projections of canonical Outcomes and fresh observations. */
export function summarizeCollaboration(rows: CollaborationMeasurement[], annotations: RescueAnnotation[] = []) {
  if (rows.some(row => row.evidence && row.evidence.evidence_kind !== 'live-model')) throw new Error('Scripted engineering tests cannot be reported as Agent measurements');
  const modes = [...new Set(rows.map(row => row.mode))];
  const seen = new Set<string>(), known = new Set(rows.map(row => row.outcome.run_id));
  for (const annotation of annotations) {
    if (!known.has(annotation.run_id) || seen.has(annotation.run_id) || !Number.isInteger(annotation.rescue_count)
      || annotation.rescue_count < 0 || !annotation.evidence?.trim()) throw new Error('Invalid rescue annotation; requires unique known run_id, nonnegative count and evidence');
    seen.add(annotation.run_id);
  }
  return modes.flatMap(mode => ['async', 'events', 'memory'].map(category => {
    const group = rows.filter(row => row.mode === mode && (row.evidence?.category ?? row.outcome.case_id.split('.')[1]) === category);
    const live = group.filter(row => row.evidence?.evidence_kind === 'live-model' && !row.evidence.error);
    const latencies: number[] = [];
    let tp = 0, fp = 0, fn = 0, duplicates = 0;
    for (const { evidence } of live) {
      for (const [eventId, expected] of Object.entries(evidence!.notification_labels)) {
        // Any visible output caused by an event is an interruption, even if its
        // text omits the locator. Hard verifiers separately require useful ID.
        const notices = evidence!.deliveries.filter(d => d.cause === `event:${eventId}`);
        if (expected && notices.length) tp++;
        if (!expected && notices.length) fp++;
        if (expected && !notices.length) fn++;
        duplicates += Math.max(0, notices.length - 1);
      }
    }
    // Exact arithmetic gold is objective. Whole-scenario failures remain in
    // the denominator; a correct late answer may still have a measured latency.
    for (const row of live) {
      for (const [step, expected] of Object.entries(row.evidence!.interrupt_expectations)) {
        const at = row.evidence!.steps[step];
        const reply = row.evidence!.deliveries.find(d => d.cause === step && d.text.includes(expected));
        if (reply && at !== undefined) latencies.push(reply.at_ms - at);
      }
    }
    latencies.sort((a, b) => a - b);
    const rescues = annotations.filter(annotation => group.some(row => row.outcome.run_id === annotation.run_id));
    return {
      mode, category, baseline: COLLABORATION_BASELINES[category as keyof typeof COLLABORATION_BASELINES],
      total: group.length, pass: group.filter(row => row.outcome.status === 'pass').length,
      fail: group.filter(row => row.outcome.status === 'fail').length, blocked: group.filter(row => row.outcome.status === 'blocked').length,
      full_scenario_success_rate: group.length ? group.filter(row => row.outcome.status === 'pass').length / group.length : null,
      notification_precision: tp + fp ? tp / (tp + fp) : null,
      notification_recall: tp + fn ? tp / (tp + fn) : null,
      notification_true_positive: tp, notification_false_positive: fp, notification_false_negative: fn,
      duplicate_notice_count: duplicates,
      accepted_interrupt_latency_p50_ms: latencies.length ? percentile(latencies, .5) : null,
      accepted_interrupt_latency_p95_ms: latencies.length ? percentile(latencies, .95) : null,
      accepted_interrupt_latency_samples: latencies.length,
      interrupt_questions_total: group.reduce((sum, row) => sum + Object.keys(row.evidence?.interrupt_expectations ?? {}).length, 0),
      annotated_runs: rescues.length,
      mean_user_rescues: rescues.length ? rescues.reduce((sum, a) => sum + a.rescue_count, 0) / rescues.length : null,
      subject_model_calls: group.reduce((sum, row) => sum + (row.evidence?.model_calls ?? 0), 0),
      subject_tokens: group.every(row => row.evidence?.token_usage_complete) ? group.reduce((sum, row) => sum + row.evidence!.tokens, 0) : null,
    };
  }).filter(group => group.total > 0));
}

function percentile(sorted: number[], q: number): number { return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]; }

export function writeCollaborationReport(root: string, rows: CollaborationMeasurement[], annotations: RescueAnnotation[] = []) {
  const measurements = summarizeCollaboration(rows, annotations);
  const file = path.join(root, 'comparison.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'xiaoba.collaboration_comparison.v1', measurements,
    paired_runs: pairedRuns(rows), annotations, outcomes: rows.map(({ mode, outcome }) => ({ mode, ...outcome })) }, null, 2) + '\n');
  const lines = [
    '# 连续协作评测', '',
    '本报告只投影 shared Evaluation 的 Outcome 和新鲜执行证据，不创建第二套裁决。', '',
    '| 版本 | 场景 | 完整成功 / 总数 | 失败 | Blocked | 通知准确率 | 通知覆盖率 | 有效插话 P50 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...measurements.map(m => `| ${m.mode} | ${m.category} | ${m.pass}/${m.total} | ${m.fail} | ${m.blocked} | ${rate(m.notification_precision)} | ${rate(m.notification_recall)} | ${m.accepted_interrupt_latency_p50_ms === null ? '未测得' : (m.accepted_interrupt_latency_p50_ms / 1000).toFixed(2) + 's'} |`),
    '', '## 对照与口径', '',
    '- async：同模型、同温度、同工具接口，仅移除后台派发控制工具，采用每会话同步 FIFO。跨会话仍可并行。',
    '- memory：两边保留相同当前对话，在相同显式上下文重置后，仅基线移除长期记忆注入、读取和写入。不是“删掉基线聊天历史而保留候选聊天历史”。',
    '- events：基线直接转发每个到达事件，是无模型的规则基线；其 token/调用数不能用于证明候选模型更省成本。候选复用 EventDispatcher，判断是否值得通知。',
    '- 成功率分母包含 blocked，另列 blocked 数；同时列出两边都可判断的配对运行。不要只挑成功运行写简历。',
    '- 插话延迟从消息到达到包含精确算术答案的有效回答；空泛确认和错误答案不计。完整情境失败但插话答对时仍测延迟，避免只选成功样本；未回答不填零，另报有效样本数 / 问题总数。',
    '- 通知指标只统计带预先标签的外部事件；定时提醒另由完整情境验收。无通知时准确率为未测得，覆盖率仍计漏报。',
    '- 定时器使用模拟时钟；跨日使用显式上下文重置；外部应用为有固定工作延迟的封闭 fixture。不能外推成真实账号吞吐或 7×24 稳定性。',
    '- 用户补救次数默认未测得；须人工依据用户可见轨迹标注。正常需求变更和必要授权不计补救。本集没有自动模拟用户救场。',
    '- 工程测试/自检不产生真实模型成功率。', '',
    '每次运行保留 trajectory.json、trajectory.jsonl 及原生 logs；规则和语义结论见各轮 evaluation-result.json。',
  ];
  fs.writeFileSync(path.join(root, 'comparison.md'), lines.join('\n') + '\n');
  const template = rows.map(row => ({ run_id: row.outcome.run_id, rescue_count: null,
    evidence: '待人工审核；不能把 null 当成零次补救', trace_ref: row.outcome.trace_ref ?? null }));
  fs.writeFileSync(path.join(root, 'rescue-annotations.template.json'), JSON.stringify(template, null, 2) + '\n');
  return { comparison: file, report: path.join(root, 'comparison.md'), measurements };
}

function rate(value: number | null): string { return value === null ? '未测得' : `${(value * 100).toFixed(1)}%`; }

function pairedRuns(rows: CollaborationMeasurement[]) {
  const groups = new Map<string, CollaborationMeasurement[]>();
  for (const row of rows) {
    // Caller prefixes run IDs with repetition; Case IDs are stable across modes.
    const repetition = row.outcome.run_id.match(/^r\d+/)?.[0] ?? 'r1';
    const key = `${repetition}:${row.outcome.case_id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups].filter(([, group]) => new Set(group.map(row => row.mode)).size === 2).map(([pair, group]) => ({
    pair, comparable: group.every(row => row.outcome.status !== 'blocked'),
    candidate: group.find(row => row.mode === 'candidate')!.outcome.status,
    baseline: group.find(row => row.mode === 'baseline')!.outcome.status,
  }));
}
