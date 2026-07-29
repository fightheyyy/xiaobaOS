import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildReviewerCatJudgePrompt,
  createReviewerCatJudge,
  parseReviewerCatDecisions,
} from '../src/eval/reviewer-cat-judge';
import { ReviewerRequest } from '../src/eval/evaluation';

const request: ReviewerRequest = {
  case: {
    case_id: 'case-1',
    task: 'Complete the task with evidence.',
    oracle: {
      hard_verifiers: ['trace_exists'],
      semantic_criteria: ['The user-visible task is complete.'],
    },
  },
  runs: [
    {
      replay: {
        run_id: 'run-pass-hard',
        case_id: 'case-1',
        status: 'completed',
        trace_ref: 'logs/run-pass-hard/traces.jsonl',
      },
      verification: [{
        verifier_id: 'trace_exists',
        status: 'pass',
        reasons: [],
        evidence_refs: ['logs/run-pass-hard/traces.jsonl'],
      }],
    },
    {
      replay: {
        run_id: 'run-hard-fail',
        case_id: 'case-1',
        status: 'completed',
        trace_ref: 'logs/run-hard-fail/traces.jsonl',
      },
      verification: [{
        verifier_id: 'trace_exists',
        status: 'fail',
        reasons: ['missing completion evidence'],
        evidence_refs: ['logs/run-hard-fail/traces.jsonl'],
      }],
    },
  ],
};

describe('ReviewerCat shared Judge adapter', () => {
  test('starts a fresh read-only Judge Session and parses structured decisions', async () => {
    const calls: Array<{
      session_id: string;
      parent_session_id: string;
      prompt: string;
      hidden_tools: readonly string[];
    }> = [];
    const judge = createReviewerCatJudge({
      working_directory: process.cwd(),
      runSession: async input => {
        calls.push(input);
        return JSON.stringify({
          version: 1,
          decisions: [{
            run_id: 'run-pass-hard',
            status: 'pass',
            reasons: ['Oracle is satisfied'],
            evidence_refs: ['logs/run-pass-hard/traces.jsonl'],
          }],
        });
      },
    });

    const first = await judge(request);
    const second = await judge(request);

    assert.equal(first[0].status, 'pass');
    assert.notEqual(calls[0].session_id, calls[1].session_id);
    assert.notEqual(calls[0].parent_session_id, calls[1].parent_session_id);
    assert.ok(calls[0].hidden_tools.includes('write_file'));
    assert.match(calls[0].prompt, /Review all runs together/);
    assert.match(calls[0].prompt, /run-hard-fail/);
  });

  test('requires exactly one decision for each hard-check-passing run', () => {
    assert.throws(
      () => parseReviewerCatDecisions(JSON.stringify({
        version: 1,
        decisions: [],
      }), request),
      /omitted run decisions/,
    );
    assert.throws(
      () => parseReviewerCatDecisions(JSON.stringify({
        version: 1,
        decisions: [{
          run_id: 'run-hard-fail',
          status: 'pass',
          reasons: [],
          evidence_refs: [],
        }],
      }), request),
      /unexpected run_id/,
    );
  });

  test('prompt contains the complete Case and Trace evidence set', () => {
    const prompt = buildReviewerCatJudgePrompt(request);
    assert.match(prompt, /case-1/);
    assert.match(prompt, /run-pass-hard/);
    assert.match(prompt, /run-hard-fail/);
    assert.match(prompt, /semantic_criteria/);
  });

  test('rejects evidence that was not supplied to the Judge Session', () => {
    assert.throws(
      () => parseReviewerCatDecisions(JSON.stringify({
        version: 1,
        decisions: [{
          run_id: 'run-pass-hard',
          status: 'pass',
          reasons: ['looks complete'],
          evidence_refs: ['invented/trace.jsonl'],
        }],
      }), request),
      /outside the request/,
    );
  });
});
