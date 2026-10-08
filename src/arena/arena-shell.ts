import { buildSandboxCommand } from '../sandbox/executor';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import type { ArenaCleanRuntimeIndex } from './types';
export interface BuildArenaShellCommandInput {
  cwd: string;
  command: string[];
  env: Record<string, string>;
  passThroughEnv: string[];
  sandboxPolicyPath?: string;
}

export function buildArenaShellCommand(input: BuildArenaShellCommandInput): string {
  const env = input.sandboxPolicyPath
    ? { ...input.env, XIAOBA_ARENA_SANDBOXED: '1' }
    : input.env;
  const envParts = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  for (const envName of input.passThroughEnv) {
    envParts.push(`${envName}="\${${envName}}"`);
  }
  const commandParts = input.command.map(shellQuote);
  const spawnCommand = ['env', '-i', ...envParts, ...commandParts].join(' ');
  const wrappedCommand = input.sandboxPolicyPath
    ? ['env', '-i', ...envParts, buildSandboxCommand(input.sandboxPolicyPath, input.command)].join(' ')
    : spawnCommand;
  return `cd ${shellQuote(input.cwd)} && ${wrappedCommand}`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Only model configuration crosses into trusted evaluation workers. */
export function arenaRuntimeEnvironment(runtime: ArenaCleanRuntimeIndex): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...runtime.launch.env, XIAOBA_ARENA_SANDBOXED: '1' };
  const file = environment.DOTENV_CONFIG_PATH;
  if (file && fs.existsSync(file)) {
    const parsed = dotenv.parse(fs.readFileSync(file));
    for (const [name, value] of Object.entries(parsed)) if (/^XIAOBA_LLM_/.test(name)) environment[name] = value;
  }
  delete environment.DOTENV_CONFIG_PATH;
  for (const name of runtime.launch.pass_through_env) if (process.env[name]) environment[name] = process.env[name];
  return environment;
}
