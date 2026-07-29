import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadCaseSet,
  renderEvaluationReport,
  writeEvaluationResult,
} from '../src/eval/evaluation-files';
import { EvaluationResult } from '../src/eval/evaluation';

describe('Evaluation files', () => {
  test('loads the minimal CaseSet contract and rejects scripted model behavior', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-case-set-'));
    const filePath = path.join(root, 'cases.json');
    fs.writeFileSync(filePath, JSON.stringify({
      case_set_id: 'smoke',
      cases: [{
        case_id: 'case-1',
        task: 'Inspect the repository',
        setup: {
          follow_up_messages: ['Summarize the evidence'],
          sandbox: 'read_only',
        },
        budget: { max_turns: 4, max_latency_ms: 1_000 },
        oracle: {
          hard_verifiers: ['trace_exists'],
          semantic_criteria: ['The answer cites inspected evidence'],
        },
      }],
    }));

    const caseSet = loadCaseSet(filePath);
    assert.equal(caseSet.case_set_id, 'smoke');
    assert.equal(caseSet.cases[0].task, 'Inspect the repository');
    assert.deepEqual(caseSet.cases[0].setup?.follow_up_messages, ['Summarize the evidence']);
    assert.equal(caseSet.cases[0].setup?.sandbox, 'read_only');
    assert.deepEqual(caseSet.cases[0].budget, { max_turns: 4, max_latency_ms: 1_000 });

    fs.writeFileSync(filePath, JSON.stringify({
      case_set_id: 'invalid',
      cases: [{
        case_id: 'scripted',
        task: 'Pretend to run',
        model_responses: ['done'],
        oracle: { semantic_criteria: ['done'] },
      }],
    }));
    assert.throws(
      () => loadCaseSet(filePath),
      /Scripted Runtime Test/,
    );
  });

  test('loads the maintained real CaseSet and rejects an unknown sandbox policy', () => {
    const maintained = loadCaseSet(
      path.join(process.cwd(), 'eval', 'case-sets', 'xiaoba-core-readonly.json'),
    );
    assert.equal(maintained.case_set_id, 'xiaoba-core-readonly-v1');
    assert.equal(maintained.cases.length, 3);
    assert.equal(maintained.cases.every(item => item.setup?.sandbox === 'read_only'), true);
    assert.equal(
      maintained.cases.every(item => item.oracle.hard_verifiers.includes('read_only_tools')),
      true,
    );

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-case-set-sandbox-'));
    const filePath = path.join(root, 'cases.json');
    fs.writeFileSync(filePath, JSON.stringify({
      case_set_id: 'invalid-sandbox',
      cases: [{
        case_id: 'case-1',
        task: 'Inspect the repository',
        setup: { sandbox: 'external_side_effects' },
        oracle: { semantic_criteria: ['Grounded answer'] },
      }],
    }));
    assert.throws(() => loadCaseSet(filePath), /setup\.sandbox/);
  });

  test('rejects Case budgets that Replay does not enforce', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-unsupported-budget-'));
    const filePath = path.join(root, 'cases.json');
    for (const key of ['max_tool_calls', 'max_tokens']) {
      fs.writeFileSync(filePath, JSON.stringify({
        case_set_id: 'unsupported-budget',
        cases: [{
          case_id: 'case-1',
          task: 'Inspect the repository',
          budget: { [key]: 10 },
          oracle: {
            hard_verifiers: [],
            semantic_criteria: ['The answer cites inspected evidence'],
          },
        }],
      }));

      assert.throws(
        () => loadCaseSet(filePath),
        new RegExp(`budget ${key} is unsupported`),
      );
    }
  });

  test('writes one canonical result and a view-only report', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-evaluation-result-'));
    const result: EvaluationResult = {
      case_set_id: 'smoke',
      runs_per_case: 1,
      outcomes: [{
        case_id: 'case-1',
        run_id: 'run-1',
        status: 'pass',
        trace_ref: '/tmp/trace.jsonl',
        reasons: ['met criteria'],
        evidence_refs: ['/tmp/trace.jsonl'],
        verifier_results: [],
      }],
      metrics: {
        total_runs: 1,
        pass_count: 1,
        fail_count: 0,
        blocked_count: 0,
        pass_rate: 1,
        stability: 'stable',
        safety_violation_count: 0,
      },
    };
    const files = writeEvaluationResult(result, root);

    assert.equal(JSON.parse(fs.readFileSync(files.result_path, 'utf-8')).case_set_id, 'smoke');
    const report = fs.readFileSync(files.report_path, 'utf-8');
    assert.equal(report, `${renderEvaluationReport(result)}\n`);
    assert.match(report, /not a second decision source/);
    assert.doesNotMatch(report, /overall verdict/i);
  });
});
