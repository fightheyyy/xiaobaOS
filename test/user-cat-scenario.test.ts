import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildUserCatScenarioPrompt,
  parseUserCatScenario,
  proposeUserCatScenario,
} from '../src/roles/user-cat/scenario';

describe('UserCat Scenario fallback', () => {
  test('creates one small Scenario in a fresh Session', async () => {
    let parent = '';
    const scenario = await proposeUserCatScenario({
      subject_id: 'skill-weather',
      skill_id: 'weather',
    }, {
      working_directory: process.cwd(),
      runSession: async input => {
        parent = input.parent_session_id;
        assert.ok(input.hidden_tools.includes('analyze_log'));
        return JSON.stringify({
          version: 1,
          scenario: {
            scenario_id: 'weather-weekend',
            user_context: 'A traveler planning a weekend.',
            goal: 'Get a grounded weekend weather plan.',
            constraints: ['Keep it concise.'],
            turn_budget: 4,
          },
        });
      },
    });

    assert.equal(scenario.scenario_id, 'weather-weekend');
    assert.match(parent, /^arena:scenario:/);
  });

  test('rejects planning fields disguised as part of the Scenario contract', () => {
    const scenario = parseUserCatScenario(JSON.stringify({
      version: 1,
      scenario: {
        scenario_id: 'simple',
        user_context: '',
        goal: 'Complete one task.',
        constraints: [],
        turn_budget: 2,
        pressure_plan: ['force a failure'],
      },
    }));
    assert.deepEqual(Object.keys(scenario).sort(), [
      'constraints',
      'goal',
      'scenario_id',
      'turn_budget',
      'user_context',
    ]);
  });

  test('prompt excludes Oracle and scoring work', () => {
    const prompt = buildUserCatScenarioPrompt({ subject_id: 'role-browser' });
    assert.match(prompt, /Do not create a pressure plan, Oracle, verifier/);
  });
});
