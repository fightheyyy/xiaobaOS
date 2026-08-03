import * as fs from 'fs';
import * as path from 'path';

export type CodexAccessMode = 'read_only' | 'workspace_write';

export interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export interface CodexFileChange {
  path: string;
  kind: 'add' | 'delete' | 'update';
}

export interface CodexCommandSummary {
  command: string;
  status: string;
  exit_code?: number;
}

export interface CodexExternalToolSummary {
  server: string;
  tool: string;
  status: string;
}

export interface CodexExecutorResult {
  threadId: string;
  finalResponse: string;
  usage: CodexUsage | null;
  changes: CodexFileChange[];
  commands: CodexCommandSummary[];
  externalTools: CodexExternalToolSummary[];
  errors: string[];
}

export interface CodexExecutorRequest {
  task: string;
  threadId?: string;
  accessMode: CodexAccessMode;
  workingDirectory: string;
  abortSignal?: AbortSignal;
}

export interface CodexExecutor {
  run(request: CodexExecutorRequest): Promise<CodexExecutorResult>;
}

interface SdkThreadItemLike {
  type?: unknown;
  status?: unknown;
  command?: unknown;
  exit_code?: unknown;
  changes?: unknown;
  server?: unknown;
  tool?: unknown;
  message?: unknown;
}

interface SdkRunResultLike {
  items: SdkThreadItemLike[];
  finalResponse: string;
  usage: unknown;
}

interface SdkThreadLike {
  readonly id: string | null;
  run(input: string, options?: { signal?: AbortSignal }): Promise<SdkRunResultLike>;
}

interface SdkThreadOptionsLike {
  sandboxMode: 'read-only' | 'workspace-write';
  workingDirectory: string;
  skipGitRepoCheck: boolean;
  networkAccessEnabled: boolean;
  webSearchMode: 'disabled';
  approvalPolicy: 'never';
  additionalDirectories: string[];
}

interface SdkCodexLike {
  startThread(options: SdkThreadOptionsLike): SdkThreadLike;
  resumeThread(id: string, options: SdkThreadOptionsLike): SdkThreadLike;
}

interface SdkCodexOptionsLike {
  codexPathOverride?: string;
  env: Record<string, string>;
  config?: Record<string, unknown>;
}

interface CodexSdkModuleLike {
  Codex: new (options?: SdkCodexOptionsLike) => SdkCodexLike;
}

export type CodexSdkLoader = () => Promise<CodexSdkModuleLike>;

export interface OfficialCodexSdkAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  loadSdk?: CodexSdkLoader;
}

const MAX_COMMANDS = 40;
const MAX_ERRORS = 20;
const MAX_COMMAND_CHARS = 500;
const MAX_ERROR_CHARS = 1_000;

/**
 * Narrow adapter around OpenAI's official TypeScript SDK. XiaoBa owns the
 * trusted cwd/access/abort boundary; the SDK owns Codex JSONL and thread resume.
 */
export class OfficialCodexSdkAdapter implements CodexExecutor {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly loadSdk: CodexSdkLoader;

  constructor(options: OfficialCodexSdkAdapterOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.loadSdk = options.loadSdk ?? loadOfficialCodexSdk;
  }

  async run(request: CodexExecutorRequest): Promise<CodexExecutorResult> {
    if (this.environment.XIAOBA_ARENA === '1' || this.environment.XIAOBA_ARENA_SANDBOXED === '1') {
      throw Object.assign(
        new Error('Codex execution is disabled inside Arena clean runtimes.'),
        { code: 'CODEX_ARENA_FORBIDDEN' },
      );
    }
    const sdk = await this.loadSdk();
    const executableOverride = optionalTrimmed(this.environment.XIAOBA_CODEX_EXE);
    const disabledMcpServers = discoverConfiguredMcpServers(
      request.workingDirectory,
      this.environment,
    );
    const codex = new sdk.Codex({
      ...(executableOverride ? { codexPathOverride: executableOverride } : {}),
      env: buildCodexEnvironment(this.environment),
      config: buildRestrictedCodexConfig(disabledMcpServers),
    });
    const threadOptions: SdkThreadOptionsLike = {
      sandboxMode: request.accessMode === 'read_only' ? 'read-only' : 'workspace-write',
      workingDirectory: path.resolve(request.workingDirectory),
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      approvalPolicy: 'never',
      additionalDirectories: [],
    };
    const thread = request.threadId
      ? codex.resumeThread(request.threadId, threadOptions)
      : codex.startThread(threadOptions);
    const result = await thread.run(buildExecutorPrompt(request.task, request.accessMode), {
      signal: request.abortSignal,
    });
    const threadId = optionalTrimmed(thread.id) || request.threadId;
    if (!threadId) {
      throw new Error('Codex SDK completed without returning a thread id.');
    }

    return {
      threadId,
      finalResponse: String(result.finalResponse || ''),
      usage: normalizeUsage(result.usage),
      changes: collectFileChanges(result.items),
      commands: collectCommandSummaries(result.items),
      externalTools: collectExternalToolSummaries(result.items),
      errors: collectErrors(result.items),
    };
  }
}

export function buildCodexEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const output: Record<string, string> = {};
  const exactKeys = new Set([
    'PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'SHELL',
    'TMPDIR', 'TMP', 'TEMP', 'LANG', 'TERM', 'COLORTERM', 'NO_COLOR',
    'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    'CODEX_HOME', 'CODEX_API_KEY',
  ]);
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (exactKeys.has(key) || key.startsWith('LC_') || key.startsWith('XDG_')) {
      output[key] = value;
    }
  }
  return output;
}

export function discoverConfiguredMcpServers(
  workingDirectory: string,
  environment: NodeJS.ProcessEnv,
): string[] {
  const configPaths = new Set<string>();
  const codexHome = optionalTrimmed(environment.CODEX_HOME);
  const home = optionalTrimmed(environment.HOME) || optionalTrimmed(environment.USERPROFILE);
  if (codexHome) configPaths.add(path.join(codexHome, 'config.toml'));
  else if (home) configPaths.add(path.join(home, '.codex', 'config.toml'));

  let cursor = path.resolve(workingDirectory);
  while (true) {
    configPaths.add(path.join(cursor, '.codex', 'config.toml'));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  const names = new Set<string>();
  const sectionPattern = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))(?:\.[^\]]+)?\s*\]\s*(?:#.*)?$/gm;
  for (const configPath of configPaths) {
    let content: string;
    try {
      content = fs.readFileSync(configPath, 'utf8');
    } catch {
      continue;
    }
    for (const match of content.matchAll(sectionPattern)) {
      const name = optionalTrimmed(match[1] || match[2]);
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

export function buildRestrictedCodexConfig(disabledMcpServers: string[]): Record<string, unknown> {
  return {
    notify: [],
    features: {
      apps: false,
      browser_use: false,
      browser_use_external: false,
      computer_use: false,
      hooks: false,
      image_generation: false,
      in_app_browser: false,
      multi_agent: false,
      plugins: false,
      remote_plugin: false,
      skill_mcp_dependency_install: false,
    },
    shell_environment_policy: {
      inherit: 'core',
      ignore_default_excludes: false,
      experimental_use_profile: false,
      include_only: [
        'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
        'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_*', 'TERM',
        'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'USERPROFILE',
      ],
    },
    ...(disabledMcpServers.length > 0 ? {
      mcp_servers: Object.fromEntries(
        disabledMcpServers.map(name => [name, { enabled: false }]),
      ),
    } : {}),
  };
}

function buildExecutorPrompt(task: string, accessMode: CodexAccessMode): string {
  const accessInstruction = accessMode === 'read_only'
    ? 'This is a read-only task. Inspect and report; do not modify files.'
    : 'You may modify files inside the provided working directory. Implement the task and run proportionate verification.';
  return [
    'You are the external coding executor for XiaoBa EngineerCat.',
    accessInstruction,
    'Stay inside the provided working directory. Do not use web search, network access, MCP tools, XiaoBa, or another coding agent.',
    'Follow repository instructions such as AGENTS.md. Preserve unrelated user changes and avoid destructive commands.',
    'Return a concise result with files changed, verification performed, and any remaining risk.',
    '',
    'Task from EngineerCat:',
    task,
  ].join('\n');
}

function collectFileChanges(items: SdkThreadItemLike[]): CodexFileChange[] {
  const changes = new Map<string, CodexFileChange>();
  for (const item of items || []) {
    if (item.type !== 'file_change' || item.status !== 'completed' || !Array.isArray(item.changes)) continue;
    for (const raw of item.changes) {
      if (!raw || typeof raw !== 'object') continue;
      const change = raw as Record<string, unknown>;
      const changePath = optionalTrimmed(change.path);
      const kind = change.kind;
      if (!changePath || (kind !== 'add' && kind !== 'delete' && kind !== 'update')) continue;
      changes.set(changePath, { path: changePath, kind });
    }
  }
  return [...changes.values()];
}

function collectCommandSummaries(items: SdkThreadItemLike[]): CodexCommandSummary[] {
  return (items || []).flatMap(item => {
    if (item.type !== 'command_execution') return [];
    const command = optionalTrimmed(item.command);
    if (!command) return [];
    return [{
      command: truncate(command, MAX_COMMAND_CHARS),
      status: optionalTrimmed(item.status) || 'unknown',
      ...(typeof item.exit_code === 'number' ? { exit_code: item.exit_code } : {}),
    }];
  }).slice(0, MAX_COMMANDS);
}

function collectExternalToolSummaries(items: SdkThreadItemLike[]): CodexExternalToolSummary[] {
  return (items || []).flatMap(item => {
    if (item.type !== 'mcp_tool_call') return [];
    const server = optionalTrimmed(item.server);
    const tool = optionalTrimmed(item.tool);
    if (!server || !tool) return [];
    return [{
      server,
      tool,
      status: optionalTrimmed(item.status) || 'unknown',
    }];
  });
}

function collectErrors(items: SdkThreadItemLike[]): string[] {
  return (items || []).flatMap(item => {
    if (item.type !== 'error') return [];
    const message = optionalTrimmed(item.message);
    return message ? [truncate(message, MAX_ERROR_CHARS)] : [];
  }).slice(0, MAX_ERRORS);
}

function normalizeUsage(value: unknown): CodexUsage | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Record<string, unknown>;
  return {
    input_tokens: nonNegativeNumber(usage.input_tokens),
    cached_input_tokens: nonNegativeNumber(usage.cached_input_tokens),
    cache_write_input_tokens: nonNegativeNumber(usage.cache_write_input_tokens),
    output_tokens: nonNegativeNumber(usage.output_tokens),
    reasoning_output_tokens: nonNegativeNumber(usage.reasoning_output_tokens),
  };
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalTrimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\u2026`;
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<CodexSdkModuleLike>;

async function loadOfficialCodexSdk(): Promise<CodexSdkModuleLike> {
  return dynamicImport('@openai/codex-sdk');
}
