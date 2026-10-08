import { execFile } from 'child_process';
import { Connector } from './connector';
import { ToolExecutionContext } from '../types/tool';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const REDACTED = '[REDACTED]';

export type SecretaryToolErrorCode =
  | 'AUTH_MISSING'
  | 'SCOPE_MISSING'
  | 'CLI_NOT_INSTALLED'
  | 'CLI_NOT_CONFIGURED'
  | 'API_ERROR'
  | 'VALIDATION_ERROR'
  | 'AMBIGUOUS_REQUEST'
  | 'WRITE_CONFIRMATION_REQUIRED'
  | 'TOOL_TIMEOUT';

export interface LarkCliRunOptions {
  cwd?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface LarkCliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface LarkCliExecOptions {
  cwd?: string;
  encoding: BufferEncoding;
  timeout: number;
  maxBuffer: number;
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
}

export type LarkCliExecFile = (
  command: string,
  args: string[],
  options: LarkCliExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface LarkCliRunner {
  run(args: string[], options?: LarkCliRunOptions): Promise<LarkCliRunResult>;
}

export class SecretaryToolError extends Error {
  readonly code: SecretaryToolErrorCode;
  readonly nextAction?: string;
  readonly details?: unknown;

  constructor(code: SecretaryToolErrorCode, message: string, options: { nextAction?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'SecretaryToolError';
    this.code = code;
    this.nextAction = options.nextAction;
    this.details = options.details;
  }
}

export class FeishuConnector implements LarkCliRunner, Connector<string[], LarkCliRunResult, LarkCliRunOptions> {
  readonly id = 'feishu';
  readonly app = 'feishu';
  readonly capabilities = ['auth', 'calendar', 'contacts', 'messages', 'tasks', 'mail', 'minutes', 'docs', 'drive', 'sheets', 'base'] as const;
  private surfaceProfile?: Promise<string | undefined>;

  constructor(
    private readonly command = 'lark-cli',
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly executor: LarkCliExecFile = defaultExecFile,
  ) {}

  run(args: string[], options: LarkCliRunOptions = {}): Promise<LarkCliRunResult> {
    return this.invoke(args, options);
  }

  async invoke(args: string[], options: LarkCliRunOptions = {}): Promise<LarkCliRunResult> {
    if (args.includes('--profile')) {
      throw new SecretaryToolError(
        'VALIDATION_ERROR',
        'SecretaryCat owns lark-cli profile selection; tool commands cannot override --profile.',
      );
    }

    try {
      const profile = await this.resolveSurfaceProfile(options);
      const commandArgs = profile ? ['--profile', profile, ...args] : args;
      const result = await this.executor(this.command, commandArgs, {
        cwd: options.cwd,
        encoding: 'utf-8',
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
        signal: options.abortSignal,
        env: buildLarkCliEnvironment(this.environment),
      });
      return {
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || ''),
        exitCode: 0,
      };
    } catch (error: any) {
      throw normalizeExecError(error);
    }
  }

  private async resolveSurfaceProfile(options: LarkCliRunOptions): Promise<string | undefined> {
    const surfaceAppId = String(this.environment.FEISHU_APP_ID || '').trim();
    if (!surfaceAppId) return undefined;

    if (!this.surfaceProfile) {
      this.surfaceProfile = this.findSurfaceProfile(surfaceAppId, options).catch(error => {
        this.surfaceProfile = undefined;
        throw error;
      });
    }
    return this.surfaceProfile;
  }

  private async findSurfaceProfile(surfaceAppId: string, options: LarkCliRunOptions): Promise<string> {
    const result = await this.executor(this.command, ['profile', 'list'], {
      cwd: options.cwd,
      encoding: 'utf-8',
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
      signal: options.abortSignal,
      env: buildLarkCliEnvironment(this.environment),
    });
    const profiles = parseProfileList(result.stdout);
    const matched = profiles.find(profile => profile.appId === surfaceAppId);
    if (!matched) {
      throw new SecretaryToolError(
        'CLI_NOT_CONFIGURED',
        'No lark-cli profile matches the configured Feishu Surface application.',
        {
          nextAction: 'Configure an official lark-cli profile with the same Feishu App ID, then retry. XiaoBa will not change the global active profile.',
        },
      );
    }
    return matched.name;
  }
}

export function buildLarkCliEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const exactKeys = new Set([
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
    'TMPDIR', 'TMP', 'TEMP', 'LANG',
    'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
    'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'LARKSUITE_CLI_CONFIG_DIR',
  ]);
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (exactKeys.has(key) || key.startsWith('LC_') || key.startsWith('XDG_')) {
      result[key] = value;
    }
  }
  return result;
}

function parseProfileList(stdout: string): Array<{ name: string; appId: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    throw new SecretaryToolError(
      'CLI_NOT_CONFIGURED',
      'lark-cli profile list returned invalid JSON.',
      { nextAction: 'Upgrade the official lark-cli and verify its profile configuration.' },
    );
  }
  if (!Array.isArray(raw)) {
    throw new SecretaryToolError('CLI_NOT_CONFIGURED', 'lark-cli profile list returned an invalid profile collection.');
  }
  return raw.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const profile = item as Record<string, unknown>;
    const name = typeof profile.name === 'string' ? profile.name.trim() : '';
    const appId = typeof profile.appId === 'string' ? profile.appId.trim() : '';
    return name && appId ? [{ name, appId }] : [];
  });
}

const defaultExecFile: LarkCliExecFile = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, options, (error, stdout, stderr) => {
    if (error) {
      Object.assign(error, { stdout, stderr });
      reject(error);
      return;
    }
    resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
  });
});

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SecretaryToolError('VALIDATION_ERROR', `${field} is required.`);
  }
  return value.trim();
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function requireBooleanConfirmation(value: unknown, action: string): void {
  if (value !== true) {
    throw new SecretaryToolError(
      'WRITE_CONFIRMATION_REQUIRED',
      `${action} requires explicit user confirmation.`,
      { nextAction: 'Summarize the change and ask the user to confirm before calling this tool.' },
    );
  }
}

export function requireIsoDateTime(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!Number.isFinite(Date.parse(text))) {
    throw new SecretaryToolError('VALIDATION_ERROR', `${field} must be an ISO 8601 datetime with timezone.`);
  }
  return text;
}

export function toToolJson(payload: unknown): string {
  return JSON.stringify(redactSecrets(payload));
}

export function toErrorToolJson(error: unknown): string {
  const normalized = normalizeToolError(error);
  return toToolJson({
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.nextAction ? { next_action: normalized.nextAction } : {}),
      ...(normalized.details ? { details: redactSecrets(normalized.details) } : {}),
    },
  });
}

export async function runLarkCliJson(
  runner: LarkCliRunner,
  args: string[],
  context: ToolExecutionContext,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const result = await runner.run(args, {
    cwd: context.workingDirectory,
    timeoutMs: options.timeoutMs,
    abortSignal: context.abortSignal,
  });
  return redactSecrets(parseJsonOutput(result.stdout));
}

export function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const objectStart = trimmed.indexOf('{');
    const arrayStart = trimmed.indexOf('[');
    const starts = [objectStart, arrayStart].filter(index => index >= 0);
    if (starts.length === 0) {
      throw new SecretaryToolError('API_ERROR', 'lark-cli returned non-JSON output.', { details: trimmed.slice(0, 500) });
    }
    const start = Math.min(...starts);
    const objectEnd = trimmed.lastIndexOf('}');
    const arrayEnd = trimmed.lastIndexOf(']');
    const end = Math.max(objectEnd, arrayEnd);
    if (end <= start) {
      throw new SecretaryToolError('API_ERROR', 'lark-cli returned incomplete JSON output.', { details: trimmed.slice(0, 500) });
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      throw new SecretaryToolError('API_ERROR', 'lark-cli returned invalid JSON output.', { details: trimmed.slice(0, 500) });
    }
  }
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => redactSecrets(item));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = isSecretKey(key) ? REDACTED : redactSecrets(entry);
    }
    return result;
  }

  if (typeof value === 'string') {
    return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${REDACTED}`);
  }

  return value;
}

export function normalizeToolError(error: unknown): SecretaryToolError {
  if (error instanceof SecretaryToolError) {
    return error;
  }
  const message = String((error as any)?.message || error || 'Unknown secretary tool error.');
  return new SecretaryToolError(classifyErrorMessage(message), message);
}

function normalizeExecError(error: any): SecretaryToolError {
  const stderr = String(error?.stderr || '');
  const stdout = String(error?.stdout || '');
  const message = [stderr.trim(), stdout.trim(), String(error?.message || '').trim()]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1200);

  if (error?.code === 'ENOENT') {
    return new SecretaryToolError(
      'CLI_NOT_INSTALLED',
      'lark-cli is not installed or not on PATH.',
      { nextAction: 'Install and configure lark-cli before using SecretaryCat Feishu tools.' },
    );
  }

  if (error?.killed || error?.signal === 'SIGTERM' || /timed out/i.test(message)) {
    return new SecretaryToolError('TOOL_TIMEOUT', 'lark-cli command timed out.');
  }

  return new SecretaryToolError(classifyErrorMessage(message), message || 'lark-cli command failed.');
}

function classifyErrorMessage(message: string): SecretaryToolErrorCode {
  const lower = message.toLowerCase();
  if (lower.includes('not logged in') || lower.includes('login required') || lower.includes('user identity') || lower.includes('unauthorized')) {
    return 'AUTH_MISSING';
  }
  if (lower.includes('scope') || lower.includes('permission denied') || lower.includes('forbidden')) {
    return 'SCOPE_MISSING';
  }
  if (lower.includes('profile') || lower.includes('app_id') || lower.includes('app id') || lower.includes('not configured')) {
    return 'CLI_NOT_CONFIGURED';
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'TOOL_TIMEOUT';
  }
  return 'API_ERROR';
}

function isSecretKey(key: string): boolean {
  return /(^|_)(access_token|refresh_token|token|secret|password|private_key|client_secret|app_secret)$/i.test(key)
    || /token$/i.test(key)
    || /secret$/i.test(key);
}
