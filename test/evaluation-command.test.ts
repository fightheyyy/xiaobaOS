import { test } from 'node:test';
import * as assert from 'node:assert';
import { Command } from 'commander';
import { registerEvalCommand } from '../src/commands/eval';

test('registers one CaseSet-based Agent Eval command', () => {
  const program = new Command();
  registerEvalCommand(program);
  const evalCommand = program.commands.find(command => command.name() === 'eval');
  assert.ok(evalCommand);
  assert.match(evalCommand.description(), /real Agent behavior/);
  const run = evalCommand.commands.find(command => command.name() === 'run');
  assert.ok(run);
  assert.ok(run.options.some(option => option.long === '--case-set' && option.required));
  assert.ok(!evalCommand.commands.some(command => command.name() === 'gate'));
});
