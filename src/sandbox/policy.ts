import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

/** Trusted execution policy. Never exposed as a model tool parameter. */
export interface SandboxPolicy {
  version: 1;
  cwd: string;
  home: string;
  tmp: string;
  config: SandboxRuntimeConfig;
}

export const PACKAGE_DOMAINS = ['registry.npmjs.org', 'github.com', 'api.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com'];

export function createSandboxPolicy(input: {
  cwd: string;
  scratchRoot: string;
  readRoots?: string[];
  writeRoots?: string[];
  denyRead?: string[];
  denyWrite?: string[];
  allowedDomains?: string[];
  allowLocalBinding?: boolean;
}): SandboxPolicy {
  const cwd = fs.realpathSync(path.resolve(input.cwd));
  const home = path.resolve(input.scratchRoot, 'home');
  const tmp = path.resolve(input.scratchRoot, 'tmp');
  for (const dir of [home, tmp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const literals = (values: string[]) => [...new Set(values.flatMap(value => {
    const absolute = path.resolve(value);
    return fs.existsSync(absolute) ? [absolute, fs.realpathSync(absolute)] : [absolute];
  }))].map(value => ({ path: value, literal: true as const }));
  const helperFiles = ['socat', 'bwrap', 'rg'].flatMap(name => {
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
      const candidate = path.join(directory, name);
      try { fs.accessSync(candidate, fs.constants.X_OK); return [candidate]; } catch { /* Try next PATH entry. */ }
    }
    return [];
  });
  // SDK read rules default to allow. Deny user-data roots, then restore only
  // explicitly selected workspaces/runtime dependencies; finer secret denies win.
  return {
    version: 1, cwd, home, tmp,
    config: {
      filesystem: {
        denyRead: [...literals(['/home', '/Users', '/root', '/workspace', '/tmp', '/var', '/private/var', os.homedir(), ...(input.denyRead || [])]),
          '**/.env', '**/.env.*', '**/.ssh/**', '**/.aws/**', '**/data/connectors/**'],
        allowRead: literals([cwd, home, tmp, ...helperFiles, path.resolve(path.dirname(require.resolve('@anthropic-ai/sandbox-runtime')), '..'), path.dirname(process.execPath), '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/dev', '/System', '/Library', '/opt/homebrew', '/private/etc', '/var/db/timezone', '/private/var/db/timezone', ...(input.readRoots || [])]),
        allowWrite: literals([...(input.writeRoots ?? [cwd]), home, tmp]),
        denyWrite: [...literals(input.denyWrite || []), '**/.env', '**/.env.*', '**/.ssh/**', '**/.aws/**', '**/data/connectors/**'],
      },
      network: {
        allowedDomains: [...new Set(input.allowedDomains || [])], deniedDomains: [],
        allowLocalBinding: input.allowLocalBinding ?? false,
      },
      // Never weaken isolation merely because another sandbox is already active.
      enableWeakerNestedSandbox: false,
    },
  };
}

export function sandboxEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) {
    if (environment[name]) result[name] = environment[name];
  }
  return result;
}

export function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
