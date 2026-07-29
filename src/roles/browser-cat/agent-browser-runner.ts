import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const AGENT_BROWSER_VERSION = '0.31.1';
export const AGENT_BROWSER_MAX_OUTPUT = 40_000;

const DEFAULT_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 5_000;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const ALLOWED_COMMANDS = new Set([
  'open',
  'snapshot',
  'click',
  'fill',
  'select',
  'scroll',
  'wait',
  'tab',
  'screenshot',
  'close',
]);

export type AgentBrowserDriverErrorCode =
  | 'BROWSER_DISABLED_IN_ARENA'
  | 'BROWSER_DRIVER_NOT_FOUND'
  | 'BROWSER_DRIVER_VERSION_MISMATCH'
  | 'BROWSER_DRIVER_INVALID_OUTPUT'
  | 'BROWSER_DRIVER_TIMEOUT'
  | 'BROWSER_DRIVER_CANCELLED'
  | 'BROWSER_DRIVER_EXECUTION_FAILED'
  | 'BROWSER_DRIVER_COMMAND_FORBIDDEN';

export interface AgentBrowserResponse {
  success: boolean;
  data?: unknown;
  error?: string | null;
  warning?: string;
  text?: string;
  tool_calls?: unknown[];
  _boundary?: {
    nonce?: string;
    origin?: string;
  };
}

export interface AgentBrowserDriverStatus {
  installed: boolean;
  ready: boolean;
  version: string;
  expectedVersion: string;
  binaryPath: string;
  doctor?: unknown;
}

export interface AgentBrowserRunOptions {
  sessionId: string;
  cwd: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  headed?: boolean;
}

export interface AgentBrowserRunner {
  getStatus(options: Pick<AgentBrowserRunOptions, 'cwd' | 'abortSignal'>): Promise<AgentBrowserDriverStatus>;
  run(command: string[], options: AgentBrowserRunOptions): Promise<AgentBrowserResponse>;
}

export interface AgentBrowserBinaryResolver {
  resolve(): string;
}

export interface AgentBrowserExecOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  windowsHide?: boolean;
}

export interface AgentBrowserExecResult {
  stdout: string;
  stderr: string;
}

export type AgentBrowserExecFile = (
  binaryPath: string,
  args: string[],
  options: AgentBrowserExecOptions,
) => Promise<AgentBrowserExecResult>;

export class AgentBrowserDriverError extends Error {
  constructor(
    readonly code: AgentBrowserDriverErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AgentBrowserDriverError';
  }
}

export class DefaultAgentBrowserBinaryResolver implements AgentBrowserBinaryResolver {
  constructor(
    private readonly applicationRoot = resolveXiaoBaApplicationRoot(),
    private readonly platform = process.platform,
    private readonly architecture = process.arch,
  ) {}

  resolve(): string {
    const binaryName = resolveAgentBrowserBinaryName(this.platform, this.architecture);
    const explicit = process.env.XIAOBA_AGENT_BROWSER_BIN?.trim();
    const resourcesPath = String((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || '').trim();
    const appRoot = process.env.XIAOBA_APP_ROOT?.trim();
    const candidates = [
      explicit,
      resourcesPath ? path.join(resourcesPath, 'drivers', 'agent-browser', binaryName) : undefined,
      appRoot ? path.join(appRoot, 'drivers', 'agent-browser', binaryName) : undefined,
      path.join(this.applicationRoot, 'drivers', 'agent-browser', binaryName),
      path.join(this.applicationRoot, 'node_modules', 'agent-browser', 'bin', binaryName),
      findExecutableOnPath('agent-browser'),
    ].filter((candidate): candidate is string => Boolean(candidate));

    for (const candidate of candidates) {
      if (isExecutableFile(candidate, this.platform)) {
        return candidate;
      }
    }

    throw new AgentBrowserDriverError(
      'BROWSER_DRIVER_NOT_FOUND',
      `agent-browser ${AGENT_BROWSER_VERSION} binary was not found. Install or package the pinned driver before using BrowserCat.`,
      { binaryName },
    );
  }
}

export function resolveXiaoBaApplicationRoot(
  moduleDirectory = __dirname,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configuredRoot = environment.XIAOBA_APP_ROOT?.trim();
  if (configuredRoot) return path.resolve(configuredRoot);
  return path.resolve(moduleDirectory, '..', '..', '..');
}

export class DefaultAgentBrowserRunner implements AgentBrowserRunner {
  private verifiedBinary?: { path: string; version: string };
  private readonly safeConfigPath: string;
  private readonly runtimeDirectory: string;

  constructor(
    private readonly resolver: AgentBrowserBinaryResolver = new DefaultAgentBrowserBinaryResolver(),
    private readonly executor: AgentBrowserExecFile = defaultExecFile,
    safeConfigPath?: string,
  ) {
    this.safeConfigPath = path.resolve(safeConfigPath || createSafeDriverConfigPath());
    this.runtimeDirectory = path.dirname(this.safeConfigPath);
  }

  async getStatus(options: Pick<AgentBrowserRunOptions, 'cwd' | 'abortSignal'>): Promise<AgentBrowserDriverStatus> {
    assertRealDriverAllowed();
    const binary = await this.ensurePinnedBinary(options);
    let doctor: unknown;
    try {
      const doctorResult = await this.execute(
        binary.path,
        ['--config', this.safeConfigPath, 'doctor', '--offline', '--quick', '--json'],
        {
          cwd: this.runtimeDirectory,
          timeout: DEFAULT_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER_BYTES,
          signal: options.abortSignal,
          env: buildDriverEnvironment(process.env, this.runtimeDirectory),
          windowsHide: true,
        },
      );
      doctor = parseJson(doctorResult.stdout, 'agent-browser doctor');
    } catch (error: any) {
      doctor = tryParseJson(String(error?.stdout || ''));
      if (!doctor) throw normalizeExecutionError(error);
    }
    const ready = Boolean(
      doctor
      && typeof doctor === 'object'
      && !Array.isArray(doctor)
      && (doctor as Record<string, unknown>).success === true,
    );
    return {
      installed: true,
      ready,
      version: binary.version,
      expectedVersion: AGENT_BROWSER_VERSION,
      binaryPath: binary.path,
      doctor,
    };
  }

  async run(command: string[], options: AgentBrowserRunOptions): Promise<AgentBrowserResponse> {
    assertRealDriverAllowed();
    validateDriverCommand(command);
    const binary = await this.ensurePinnedBinary(options);
    const args = buildPinnedDriverArgs(command, options, this.safeConfigPath);

    try {
      const result = await this.execute(binary.path, args, {
        cwd: this.runtimeDirectory,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        signal: options.abortSignal,
        env: buildDriverEnvironment(process.env, this.runtimeDirectory),
        windowsHide: true,
      });
      return parseAgentBrowserResponse(result.stdout);
    } catch (error: any) {
      const response = tryParseAgentBrowserResponse(String(error?.stdout || ''));
      if (response) {
        return response;
      }
      throw normalizeExecutionError(error);
    }
  }

  private async ensurePinnedBinary(
    options: Pick<AgentBrowserRunOptions, 'cwd' | 'abortSignal'>,
  ): Promise<{ path: string; version: string }> {
    if (this.verifiedBinary) {
      return this.verifiedBinary;
    }

    const binaryPath = this.resolver.resolve();
    let result: AgentBrowserExecResult;
    try {
      result = await this.execute(binaryPath, ['--version'], {
        cwd: this.runtimeDirectory,
        timeout: VERSION_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        signal: options.abortSignal,
        env: buildDriverEnvironment(process.env, this.runtimeDirectory),
        windowsHide: true,
      });
    } catch (error) {
      throw normalizeExecutionError(error);
    }
    const match = String(result.stdout || '').trim().match(/(?:agent-browser\s+)?(\d+\.\d+\.\d+)/i);
    const version = match?.[1] || '';
    if (version !== AGENT_BROWSER_VERSION) {
      throw new AgentBrowserDriverError(
        'BROWSER_DRIVER_VERSION_MISMATCH',
        `BrowserCat requires agent-browser ${AGENT_BROWSER_VERSION}, but found ${version || 'an unknown version'}.`,
        { binaryPath, expected: AGENT_BROWSER_VERSION, actual: version || null },
      );
    }

    this.verifiedBinary = { path: binaryPath, version };
    return this.verifiedBinary;
  }

  private async execute(
    binaryPath: string,
    args: string[],
    options: AgentBrowserExecOptions,
  ): Promise<AgentBrowserExecResult> {
    return this.executor(binaryPath, args, options);
  }
}

export function buildPinnedDriverArgs(
  command: string[],
  options: AgentBrowserRunOptions,
  safeConfigPath: string = createSafeDriverConfigPath(),
): string[] {
  validateDriverCommand(command);
  return [
    '--config', safeConfigPath,
    '--json',
    '--content-boundaries',
    '--max-output',
    String(AGENT_BROWSER_MAX_OUTPUT),
    '--namespace', 'xiaoba',
    '--session', options.sessionId,
    '--restore', options.sessionId,
    '--idle-timeout', '3m',
    ...(options.headed ? ['--headed'] : []),
    ...command,
  ];
}

export function resolveAgentBrowserBinaryName(
  platform: NodeJS.Platform,
  architecture: string,
): string {
  const arch = architecture === 'x64' || architecture === 'x86_64'
    ? 'x64'
    : architecture === 'arm64' || architecture === 'aarch64'
      ? 'arm64'
      : '';
  if (!arch) {
    throw new AgentBrowserDriverError(
      'BROWSER_DRIVER_NOT_FOUND',
      `agent-browser does not provide a binary for ${platform}-${architecture}.`,
    );
  }

  if (platform === 'darwin') return `agent-browser-darwin-${arch}`;
  if (platform === 'win32' && arch === 'x64') return 'agent-browser-win32-x64.exe';
  if (platform === 'linux') {
    const libc = isMuslRuntime() ? 'linux-musl' : 'linux';
    return `agent-browser-${libc}-${arch}`;
  }
  throw new AgentBrowserDriverError(
    'BROWSER_DRIVER_NOT_FOUND',
    `agent-browser does not provide a binary for ${platform}-${architecture}.`,
  );
}

export function parseAgentBrowserResponse(stdout: string): AgentBrowserResponse {
  const parsed = parseJson(stdout, 'agent-browser command');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgentBrowserDriverError(
      'BROWSER_DRIVER_INVALID_OUTPUT',
      'agent-browser returned a non-object JSON response.',
    );
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.success !== 'boolean') {
    throw new AgentBrowserDriverError(
      'BROWSER_DRIVER_INVALID_OUTPUT',
      'agent-browser response is missing a boolean success field.',
    );
  }
  return record as unknown as AgentBrowserResponse;
}

function tryParseAgentBrowserResponse(stdout: string): AgentBrowserResponse | undefined {
  if (!stdout.trim()) return undefined;
  try {
    return parseAgentBrowserResponse(stdout);
  } catch {
    return undefined;
  }
}

function parseJson(stdout: string, source: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new AgentBrowserDriverError(
      'BROWSER_DRIVER_INVALID_OUTPUT',
      `${source} returned empty output.`,
    );
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new AgentBrowserDriverError(
      'BROWSER_DRIVER_INVALID_OUTPUT',
      `${source} returned invalid JSON output.`,
      { preview: trimmed.slice(0, 500) },
    );
  }
}

function tryParseJson(stdout: string): unknown | undefined {
  if (!stdout.trim()) return undefined;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
}

function validateDriverCommand(command: string[]): void {
  const commandName = command[0] || '';
  if (!ALLOWED_COMMANDS.has(commandName)) {
    throw new AgentBrowserDriverError(
      'BROWSER_DRIVER_COMMAND_FORBIDDEN',
      `The agent-browser command "${commandName || '(empty)'}" is not exposed by BrowserCat.`,
    );
  }
}

function assertRealDriverAllowed(): void {
  if (process.env.XIAOBA_ARENA === '1' || process.env.XIAOBA_ARENA_SANDBOXED === '1') {
    throw new AgentBrowserDriverError(
      'BROWSER_DISABLED_IN_ARENA',
      'The real browser driver is disabled inside Arena. Inject a fake BrowserCat runner for evaluation.',
    );
  }
}

function normalizeExecutionError(error: unknown): AgentBrowserDriverError {
  if (error instanceof AgentBrowserDriverError) return error;
  const record = (error && typeof error === 'object') ? error as Record<string, unknown> : {};
  const code = String(record.code || '');
  const message = String(record.message || error || 'agent-browser execution failed.');
  if (code === 'ABORT_ERR' || /aborted|aborterror/i.test(message)) {
    return new AgentBrowserDriverError('BROWSER_DRIVER_CANCELLED', 'agent-browser execution was cancelled.');
  }
  if (Boolean(record.killed) || /timed out|timeout|ETIMEDOUT/i.test(message)) {
    return new AgentBrowserDriverError('BROWSER_DRIVER_TIMEOUT', 'agent-browser command timed out.');
  }
  if (code === 'ENOENT') {
    return new AgentBrowserDriverError(
      'BROWSER_DRIVER_NOT_FOUND',
      'The pinned agent-browser binary is missing or cannot be executed.',
    );
  }
  return new AgentBrowserDriverError(
    'BROWSER_DRIVER_EXECUTION_FAILED',
    message.slice(0, 1200),
  );
}

export function buildDriverEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  controlledRuntimeDirectory?: string,
): NodeJS.ProcessEnv {
  const requiredKeys = new Set([
    'PATH',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SHELL',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS',
    'LANG',
    'LC_ALL',
    'LD_LIBRARY_PATH',
    'DYLD_LIBRARY_PATH',
    'FONTCONFIG_PATH',
    'FONTCONFIG_FILE',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'PLAYWRIGHT_BROWSERS_PATH',
    'PUPPETEER_CACHE_DIR',
  ].map(key => key.toUpperCase()));
  const allowedAgentBrowserKeys = new Set([
    'AGENT_BROWSER_ALLOWED_DOMAINS',
  ]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upperKey = key.toUpperCase();
    if (requiredKeys.has(upperKey) || upperKey.startsWith('LC_') || allowedAgentBrowserKeys.has(upperKey)) {
      environment[key] = value;
    }
  }
  environment.AGENT_BROWSER_CONTENT_BOUNDARIES = '1';
  environment.AGENT_BROWSER_MAX_OUTPUT = String(AGENT_BROWSER_MAX_OUTPUT);
  environment.AGENT_BROWSER_NO_AUTO_DIALOG = '0';
  if (controlledRuntimeDirectory) {
    const runtimeRoot = path.resolve(controlledRuntimeDirectory);
    const homeDirectory = ensurePrivateDirectory(path.join(runtimeRoot, 'home'));
    const xdgRuntimeDirectory = ensurePrivateDirectory(path.join(runtimeRoot, 'xdg', 'runtime'));
    const xdgConfigDirectory = ensurePrivateDirectory(path.join(runtimeRoot, 'xdg', 'config'));
    const xdgCacheDirectory = ensurePrivateDirectory(path.join(runtimeRoot, 'xdg', 'cache'));
    const xdgDataDirectory = ensurePrivateDirectory(path.join(runtimeRoot, 'xdg', 'data'));
    const appDataDirectory = ensurePrivateDirectory(path.join(runtimeRoot, 'appdata', 'roaming'));
    const localAppDataDirectory = ensurePrivateDirectory(path.join(runtimeRoot, 'appdata', 'local'));
    const tempDirectory = ensurePrivateDirectory(path.join(runtimeRoot, 'tmp'));
    const socketDirectory = ensurePrivateDirectory(path.join(runtimeRoot, 'sockets'));
    environment.HOME = homeDirectory;
    environment.USERPROFILE = homeDirectory;
    environment.XDG_RUNTIME_DIR = xdgRuntimeDirectory;
    environment.XDG_CONFIG_HOME = xdgConfigDirectory;
    environment.XDG_CACHE_HOME = xdgCacheDirectory;
    environment.XDG_DATA_HOME = xdgDataDirectory;
    environment.APPDATA = appDataDirectory;
    environment.LOCALAPPDATA = localAppDataDirectory;
    environment.TMPDIR = tempDirectory;
    environment.TMP = tempDirectory;
    environment.TEMP = tempDirectory;
    environment.AGENT_BROWSER_SOCKET_DIR = socketDirectory;
  }
  return environment;
}

function ensurePrivateDirectory(directory: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  return directory;
}

function defaultExecFile(
  binaryPath: string,
  args: string[],
  options: AgentBrowserExecOptions,
): Promise<AgentBrowserExecResult> {
  return new Promise((resolve, reject) => {
    execFile(binaryPath, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      signal: options.signal,
      env: options.env,
      windowsHide: options.windowsHide,
      encoding: 'utf-8',
    }, (error, stdout, stderr) => {
      if (error) {
        const enriched = error as Error & { stdout?: string; stderr?: string };
        enriched.stdout = String(stdout || '');
        enriched.stderr = String(stderr || '');
        reject(enriched);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
    return isNativeAgentBrowserBinary(candidate, platform);
  } catch {
    return false;
  }
}

export function isNativeAgentBrowserBinary(candidate: string, platform: NodeJS.Platform): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(candidate, 'r');
    const header = Buffer.alloc(4);
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    if (bytesRead < 2) return false;
    const magic = header.toString('hex');
    if (platform === 'linux') return magic === '7f454c46';
    if (platform === 'win32') return magic.startsWith('4d5a');
    if (platform === 'darwin') {
      return new Set([
        'feedface',
        'cefaedfe',
        'feedfacf',
        'cffaedfe',
        'cafebabe',
        'bebafeca',
        'cafebabf',
        'bfbafeca',
      ]).has(magic);
    }
    return false;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function findExecutableOnPath(command: string): string | undefined {
  const pathValue = process.env.PATH || '';
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, command.endsWith(extension) ? command : `${command}${extension}`);
      if (isExecutableFile(candidate, process.platform)) return candidate;
    }
  }
  return undefined;
}

function createSafeDriverConfigPath(): string {
  // Unix-domain sockets have a small path limit (103 bytes on macOS). The
  // platform temp directory can itself be very long, so atomically create the
  // private runtime under the short system /tmp path on Unix.
  const sourceTestRoot = process.env.XIAOBA_SOURCE_CANDIDATE_TEST === '1'
    ? process.env.XIAOBA_SOURCE_TEST_TMP_ROOT
    : undefined;
  if (sourceTestRoot && !path.isAbsolute(sourceTestRoot)) {
    throw new Error('XIAOBA_SOURCE_TEST_TMP_ROOT must be absolute');
  }
  const tempRoot = process.platform === 'win32'
    ? os.tmpdir()
    : sourceTestRoot
      ? fs.realpathSync(sourceTestRoot)
      : '/tmp';
  const directory = fs.mkdtempSync(path.join(tempRoot, 'xab-'));
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, '{}\n', { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  process.once('exit', () => cleanupSafeDriverConfig(directory));
  return configPath;
}

function cleanupSafeDriverConfig(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Best effort only; the directory contains a non-secret empty config.
  }
}

function isMuslRuntime(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return fs.existsSync('/etc/alpine-release') || os.release().toLowerCase().includes('musl');
  }
}
