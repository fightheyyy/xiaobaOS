import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildInspectorCatPrompt,
  parseInspectorFindingCases,
  runInspectorCat,
} from '../src/roles/inspector-cat/finding-case';

const request = {
  trace_refs: ['logs/session-a/traces.jsonl'],
  evidence_refs: ['output/session-a/report.md'],
  context: { scenario_id: 'scenario-a' },
};

describe('InspectorCat Finding + Case adapter', () => {
  test('runs in a fresh read-only Session and parses paired output', async () => {
    let captured: Parameters<NonNullable<Parameters<typeof runInspectorCat>[1]['runSession']>>[0]
      | undefined;
    const result = await runInspectorCat(request, {
      working_directory: process.cwd(),
      runSession: async input => {
        captured = input;
        return JSON.stringify({
          version: 1,
          finding_cases: [{
            finding: {
              summary: 'The user-visible answer omitted the requested artifact.',
              evidence_refs: ['logs/session-a/traces.jsonl'],
            },
            case: {
              case_id: 'case-artifact-delivery',
              task: 'Produce and deliver the requested report.',
              budget: { max_turns: 4 },
              oracle: {
                hard_verifiers: ['trace_exists', 'delivery_contract'],
                semantic_criteria: ['The delivered report answers the request.'],
              },
              source: {
                trace_refs: ['logs/session-a/traces.jsonl'],
                finding: 'Missing requested artifact delivery.',
              },
            },
          }],
        });
      },
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].case.case_id, 'case-artifact-delivery');
    assert.match(captured?.parent_session_id ?? '', /^inspection:/);
    assert.ok(captured?.hidden_tools.includes('write_file'));
    assert.ok(captured?.hidden_tools.includes('execute_shell'));
  });

  test('accepts no Finding when no replayable problem exists', () => {
    assert.deepEqual(
      parseInspectorFindingCases('{"version":1,"finding_cases":[]}', request),
      [],
    );
  });

  test('rejects invented evidence refs', () => {
    assert.throws(
      () => parseInspectorFindingCases(JSON.stringify({
        version: 1,
        finding_cases: [{
          finding: {
            summary: 'Invented problem',
            evidence_refs: ['logs/invented.jsonl'],
          },
          case: {
            case_id: 'invented',
            task: 'Do something',
            oracle: {
              hard_verifiers: [],
              semantic_criteria: ['It works'],
            },
            source: {
              trace_refs: ['logs/session-a/traces.jsonl'],
            },
          },
        }],
      }), request),
      /outside the request/,
    );
  });

  test('rejects an invented source Trace hidden beside a real one', () => {
    assert.throws(
      () => parseInspectorFindingCases(JSON.stringify({
        version: 1,
        finding_cases: [{
          finding: {
            summary: 'Mixed source refs',
            evidence_refs: ['logs/session-a/traces.jsonl'],
          },
          case: {
            case_id: 'mixed-source',
            task: 'Do something',
            oracle: {
              hard_verifiers: [],
              semantic_criteria: ['It works'],
            },
            source: {
              trace_refs: ['logs/session-a/traces.jsonl', 'logs/invented.jsonl'],
            },
          },
        }],
      }), request),
      /source Trace outside the request/,
    );
  });

  test('rejects Case budgets that Replay does not enforce', () => {
    for (const key of ['max_tool_calls', 'max_tokens']) {
      assert.throws(
        () => parseInspectorFindingCases(JSON.stringify({
          version: 1,
          finding_cases: [{
            finding: {
              summary: 'Replayable problem',
              evidence_refs: ['logs/session-a/traces.jsonl'],
            },
            case: {
              case_id: 'unsupported-budget',
              task: 'Do something',
              budget: { [key]: 10 },
              oracle: {
                hard_verifiers: [],
                semantic_criteria: ['It works'],
              },
              source: {
                trace_refs: ['logs/session-a/traces.jsonl'],
              },
            },
          }],
        }), request),
        new RegExp(`budget ${key} is unsupported`),
      );
    }
  });

  test('prompt explicitly forbids routing and recursive inspection', () => {
    const prompt = buildInspectorCatPrompt(request);
    assert.match(prompt, /Do not repair, judge, route, score/);
    assert.match(prompt, /recursively/);
  });
});
