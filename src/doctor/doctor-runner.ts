import * as fs from 'fs';
import * as path from 'path';
import {
  AGENT_BROWSER_VERSION,
  AgentBrowserDriverStatus,
  DefaultAgentBrowserRunner,
} from '../roles/browser-cat/agent-browser-runner';
import {
  DefaultPeekabooRunner,
  PEEKABOO_VERSION_REQUIREMENT,
  PeekabooDriverStatus,
} from '../roles/gui-cat/utils/peekaboo-runner';
import {
  DefaultLarkCliRunner,
  LarkCliRunner,
  normalizeToolError,
  parseJsonOutput,
} from '../roles/secretary-cat/utils/lark-cli-runner';
import { normalizeFeishuAuthStatus } from '../roles/secretary-cat/tools/feishu-auth-tools';
import { ChatConfig } from '../types';
import { RoleConfig } from '../types/role';
import { ConfigManager } from '../utils/config';
import { RoleResolver } from '../utils/role-resolver';
import { APP_NODE_ENGINE, APP_VERSION } from '../version';
import {
  DoctorRunOptions,
  ReadinessCheck,
  ReadinessReport,
  SecretaryReadinessStatus,
} from './types';

const SUPPORTED_PROVIDERS = new Set(['openai', 'anthropic', 'ollama']);

export interface DoctorRunnerDependencies {
  now?: () => Date;
  appVersion?: string;
  nodeVersion?: string;
  nodeEngine?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  environment?: NodeJS.ProcessEnv;
  getProjectRoot?: () => string;
  getRolesRoot?: () => string;
  listRoles?: () => string[];
  getRoleConfig?: (roleName: string) => RoleConfig | undefined;
  resolveRole?: (roleName: string) => string | undefined;
  getConfig?: () => ChatConfig;
  browserStatus?: (cwd: string) => Promise<AgentBrowserDriverStatus>;
  guiStatus?: () => Promise<PeekabooDriverStatus>;
  secretaryStatus?: (cwd: string, environment: NodeJS.ProcessEnv) => Promise<SecretaryReadinessStatus>;
  pathExists?: (targetPath: string) => boolean;
  directoryReadable?: (targetPath: string) => boolean;
}

export async function runDoctor(
  options: DoctorRunOptions = {},
  dependencies: DoctorRunnerDependencies = {},
): Promise<ReadinessReport> {
  const now = dependencies.now || (() => new Date());
  const environment = dependencies.environment || process.env;
  const cwd = path.resolve(options.cwd || process.cwd());
  const appVersion = dependencies.appVersion || APP_VERSION;
  const nodeVersion = dependencies.nodeVersion || process.version;
  const nodeEngine = dependencies.nodeEngine || APP_NODE_ENGINE;
  const platform = dependencies.platform || process.platform;
  const arch = dependencies.arch || process.arch;
  const getProjectRoot = dependencies.getProjectRoot || (() => RoleResolver.getProjectRoot());
  const getRolesRoot = dependencies.getRolesRoot || (() => RoleResolver.getRolesRoot());
  const listRoles = dependencies.listRoles || (() => RoleResolver.listAvailableRoles());
  const getRoleConfig = dependencies.getRoleConfig || ((roleName: string) => RoleResolver.getRoleConfig(roleName));
  const resolveRole = dependencies.resolveRole
    || ((roleName: string) => RoleResolver.resolveRoleDirectoryName(roleName));
  const getConfig = dependencies.getConfig || (() => ConfigManager.peekConfig());
  const pathExists = dependencies.pathExists || fs.existsSync;
  const directoryReadable = dependencies.directoryReadable || isReadableDirectory;

  const checks: ReadinessCheck[] = [];
  const projectRoot = safelyResolvePath(getProjectRoot, cwd);
  const rolesRoot = safelyResolvePath(getRolesRoot, path.join(projectRoot, 'roles'));
  const requestedRole = RoleResolver.getRequestedRoleName(options.requestedRole, environment) || 'base';

  checks.push(runtimeCheck(nodeVersion, nodeEngine, appVersion, platform, arch));
  checks.push(directoryCheck('project.root', 'Project root', projectRoot, true, directoryReadable));
  checks.push(directoryCheck('project.roles_root', 'Roles root', rolesRoot, true, directoryReadable));

  let config: ChatConfig;
  try {
    config = getConfig();
    checks.push(providerCheck(config));
  } catch {
    config = {};
    checks.push({
      id: 'provider.static_config',
      category: 'provider',
      label: 'Provider configuration',
      status: 'fail',
      required: true,
      summary: 'Provider configuration could not be read.',
      nextAction: 'Check .env and ~/.xiaoba/config.json, then rerun xiaoba doctor.',
    });
  }

  const roleInspection = inspectRoles({
    requestedRole,
    rolesRoot,
    listRoles,
    getRoleConfig,
    resolveRole,
    pathExists,
  });
  checks.push(...roleInspection.checks);

  const activeRole = roleInspection.activeRole;
  const secretaryEnvironment = {
    ...environment,
    ...(!environment.FEISHU_APP_ID?.trim() && config.feishu?.appId?.trim()
      ? { FEISHU_APP_ID: config.feishu.appId.trim() }
      : {}),
  };
  const [browserCheck, guiCheck, secretaryCheck] = await Promise.all([
    inspectBrowserDriver(
      activeRole === 'browser-cat',
      cwd,
      dependencies.browserStatus || defaultBrowserStatus,
    ),
    inspectGuiDriver(
      activeRole === 'gui-cat',
      dependencies.guiStatus || defaultGuiStatus,
    ),
    inspectSecretary(
      activeRole === 'secretary-cat',
      cwd,
      secretaryEnvironment,
      dependencies.secretaryStatus || defaultSecretaryStatus,
    ),
  ]);
  checks.push(browserCheck, guiCheck, secretaryCheck);
  checks.push(feishuSurfaceCheck(config, environment));
  checks.push(weixinSurfaceCheck(config, environment));

  const requiredIssues = checks.filter(check => check.required && ['fail', 'blocked'].includes(check.status)).length;
  const overall = requiredIssues > 0
    ? 'not_ready'
    : checks.some(check => check.status !== 'pass')
      ? 'degraded'
      : 'ready';

  return {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    overall,
    ready: requiredIssues === 0,
    app: {
      name: 'xiaoba-cli',
      version: appVersion,
      nodeVersion,
      platform,
      arch,
    },
    context: {
      cwd,
      projectRoot,
      rolesRoot,
      requestedRole,
      activeRole,
    },
    summary: {
      total: checks.length,
      passed: checks.filter(check => check.status === 'pass').length,
      warnings: checks.filter(check => check.status === 'warn').length,
      failed: checks.filter(check => check.status === 'fail').length,
      blocked: checks.filter(check => check.status === 'blocked').length,
      requiredIssues,
    },
    checks,
  };
}

function runtimeCheck(
  nodeVersion: string,
  nodeEngine: string,
  appVersion: string,
  platform: NodeJS.Platform,
  arch: string,
): ReadinessCheck {
  const actual = nodeVersion.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const minimum = nodeEngine.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/)?.slice(1).map(value => Number(value || 0));
  const supported = Boolean(actual && minimum && (
    actual[0] > minimum[0] || actual[0] === minimum[0] && (
      actual[1] > minimum[1] || actual[1] === minimum[1] && actual[2] >= minimum[2]
    )
  ));
  return {
    id: 'runtime.node',
    category: 'runtime',
    label: 'Runtime',
    status: supported ? 'pass' : 'fail',
    required: true,
    summary: supported
      ? `XiaoBa ${appVersion} is running on Node ${nodeVersion} (${platform}/${arch}).`
      : `Node ${nodeVersion} does not satisfy the required Node ${nodeEngine} runtime.`,
    ...(!supported && { nextAction: `Install a Node.js version matching ${nodeEngine} before running XiaoBa.` }),
    data: { appVersion, nodeVersion, nodeEngine, platform, arch },
  };
}

function directoryCheck(
  id: string,
  label: string,
  targetPath: string,
  required: boolean,
  directoryReadable: (targetPath: string) => boolean,
): ReadinessCheck {
  const ready = directoryReadable(targetPath);
  return {
    id,
    category: 'project',
    label,
    status: ready ? 'pass' : 'fail',
    required,
    summary: ready ? `${targetPath} is readable.` : `${targetPath} is missing or unreadable.`,
    ...(!ready && { nextAction: `Check the configured ${label.toLowerCase()} and its permissions.` }),
    data: { path: targetPath, readable: ready },
  };
}

function providerCheck(config: ChatConfig): ReadinessCheck {
  const provider = String(config.provider || '').trim().toLowerCase();
  const model = String(config.model || '').trim();
  const apiBase = String(config.apiUrl || '').trim();
  const providerSupported = SUPPORTED_PROVIDERS.has(provider);
  const apiBaseValid = isHttpUrl(apiBase);
  const apiKeyConfigured = Boolean(config.apiKey?.trim());
  const credentialsReady = provider === 'ollama' || apiKeyConfigured;
  const ready = providerSupported && Boolean(model) && apiBaseValid && credentialsReady;
  const missing = [
    ...(!providerSupported ? ['supported provider'] : []),
    ...(!model ? ['model'] : []),
    ...(!apiBaseValid ? ['valid API base'] : []),
    ...(!credentialsReady ? ['API key'] : []),
  ];

  return {
    id: 'provider.static_config',
    category: 'provider',
    label: 'Provider configuration',
    status: ready ? 'pass' : 'fail',
    required: true,
    summary: ready
      ? `${provider} / ${model} is statically configured; network reachability was not tested.`
      : `Missing or invalid: ${missing.join(', ')}.`,
    ...(!ready && { nextAction: 'Run xiaoba config or update .env, then rerun xiaoba doctor.' }),
    data: {
      provider: provider || 'missing',
      model: model || 'missing',
      apiBaseConfigured: apiBaseValid,
      apiKeyConfigured,
      networkChecked: false,
    },
  };
}

function inspectRoles(input: {
  requestedRole: string;
  rolesRoot: string;
  listRoles: () => string[];
  getRoleConfig: (roleName: string) => RoleConfig | undefined;
  resolveRole: (roleName: string) => string | undefined;
  pathExists: (targetPath: string) => boolean;
}): { activeRole: string | null; checks: ReadinessCheck[] } {
  const checks: ReadinessCheck[] = [];
  let roleNames: string[] = [];
  try {
    roleNames = input.listRoles();
  } catch {
    checks.push({
      id: 'roles.inventory',
      category: 'roles',
      label: 'Role inventory',
      status: 'fail',
      required: true,
      summary: 'Installed roles could not be enumerated.',
      nextAction: 'Check roles root contents and role.json permissions.',
    });
    return { activeRole: null, checks };
  }

  const baseRequested = RoleResolver.isBaseRoleName(input.requestedRole);
  let activeRole: string | null = null;
  if (baseRequested) {
    checks.push({
      id: 'roles.active',
      category: 'roles',
      label: 'Active role',
      status: 'pass',
      required: true,
      summary: 'Base role is selected and has no role-specific driver requirement.',
      data: { role: 'base' },
    });
  } else {
    const resolvedRole = safeResolveRole(input.resolveRole, input.requestedRole);
    if (!resolvedRole) {
      checks.push({
        id: 'roles.active',
        category: 'roles',
        label: 'Active role',
        status: 'fail',
        required: true,
        summary: `Role ${input.requestedRole} was not found.`,
        nextAction: `Choose one of: base${roleNames.length > 0 ? `, ${roleNames.join(', ')}` : ''}.`,
        data: { requestedRole: input.requestedRole },
      });
    } else {
      try {
        if (!input.getRoleConfig(resolvedRole)) {
          throw new Error('role.json is missing');
        }
        activeRole = resolvedRole;
        checks.push({
          id: 'roles.active',
          category: 'roles',
          label: 'Active role',
          status: 'pass',
          required: true,
          summary: `${resolvedRole} is installed and runnable.`,
          data: { role: resolvedRole },
        });
      } catch {
        checks.push({
          id: 'roles.active',
          category: 'roles',
          label: 'Active role',
          status: 'fail',
          required: true,
          summary: `${resolvedRole} has an invalid role.json.`,
          nextAction: `Repair ${path.join(input.rolesRoot, resolvedRole, 'role.json')} and rerun xiaoba doctor.`,
          data: { role: resolvedRole },
        });
      }
    }
  }

  for (const roleName of roleNames) {
    const required = roleName === activeRole;
    try {
      const config = input.getRoleConfig(roleName);
      if (!config) {
        checks.push(rolePackageFailure(roleName, required, 'role.json is missing.'));
        continue;
      }
      const promptFile = String(config.promptFile || '').trim();
      const promptReady = Boolean(promptFile && input.pathExists(path.join(input.rolesRoot, roleName, 'prompts', promptFile)));
      if (!promptReady) {
        checks.push(rolePackageFailure(roleName, required, 'The declared prompt file is missing.'));
        continue;
      }
      checks.push({
        id: `roles.package.${roleName}`,
        category: 'roles',
        label: config.displayName || roleName,
        status: 'pass',
        required,
        summary: `${roleName} package is valid and installed.`,
        data: { role: roleName, promptConfigured: true },
      });
    } catch {
      checks.push(rolePackageFailure(roleName, required, 'role.json could not be parsed.'));
    }
  }

  return { activeRole, checks };
}

function rolePackageFailure(roleName: string, required: boolean, summary: string): ReadinessCheck {
  return {
    id: `roles.package.${roleName}`,
    category: 'roles',
    label: roleName,
    status: 'fail',
    required,
    summary,
    nextAction: `Repair the ${roleName} package under the roles root.`,
    data: { role: roleName },
  };
}

async function inspectBrowserDriver(
  required: boolean,
  cwd: string,
  statusProbe: (cwd: string) => Promise<AgentBrowserDriverStatus>,
): Promise<ReadinessCheck> {
  try {
    const status = await statusProbe(cwd);
    return {
      id: 'drivers.browser',
      category: 'drivers',
      label: 'BrowserCat driver',
      status: status.ready ? 'pass' : required ? 'blocked' : 'warn',
      required,
      summary: status.ready
        ? `agent-browser ${status.version} passed its offline doctor.`
        : `agent-browser ${status.version || 'unknown'} did not pass its offline doctor.`,
      ...(!status.ready && { nextAction: `Install and verify agent-browser ${status.expectedVersion}.` }),
      data: {
        installed: status.installed,
        ready: status.ready,
        version: status.version || 'unknown',
        expectedVersion: status.expectedVersion,
      },
    };
  } catch (error: any) {
    const code = typeof error?.code === 'string' ? error.code : 'BROWSER_STATUS_FAILED';
    return {
      id: 'drivers.browser',
      category: 'drivers',
      label: 'BrowserCat driver',
      status: required ? 'blocked' : 'warn',
      required,
      summary: code === 'BROWSER_DRIVER_NOT_FOUND'
        ? 'The pinned agent-browser driver is not installed.'
        : `Browser driver readiness check failed (${code}).`,
      nextAction: `Install the pinned agent-browser ${AGENT_BROWSER_VERSION} binary or set XIAOBA_AGENT_BROWSER_BIN.`,
      data: { installed: false, ready: false, errorCode: code },
    };
  }
}

async function inspectGuiDriver(
  required: boolean,
  statusProbe: () => Promise<PeekabooDriverStatus>,
): Promise<ReadinessCheck> {
  try {
    const status = await statusProbe();
    const unavailable = !status.supportedPlatform || !status.versionCompatible || !status.ready;
    return {
      id: 'drivers.gui',
      category: 'drivers',
      label: 'GuiCat driver',
      status: unavailable ? required ? 'blocked' : 'warn' : 'pass',
      required,
      summary: status.ready
        ? `Peekaboo ${status.version || PEEKABOO_VERSION_REQUIREMENT} is ready with Screen Recording and Accessibility.`
        : status.reason || 'Peekaboo is not ready.',
      ...(!status.ready && { nextAction: `Install Peekaboo ${PEEKABOO_VERSION_REQUIREMENT} and grant Screen Recording and Accessibility permissions.` }),
      data: {
        supportedPlatform: status.supportedPlatform,
        ready: status.ready,
        version: status.version || 'missing',
        versionCompatible: status.versionCompatible,
        screenRecording: status.permissions.screenRecording,
        accessibility: status.permissions.accessibility,
      },
    };
  } catch {
    return {
      id: 'drivers.gui',
      category: 'drivers',
      label: 'GuiCat driver',
      status: required ? 'blocked' : 'warn',
      required,
      summary: 'GuiCat readiness check failed unexpectedly.',
      nextAction: `Verify Peekaboo ${PEEKABOO_VERSION_REQUIREMENT} and macOS permissions, then rerun xiaoba doctor.`,
      data: { ready: false },
    };
  }
}

async function inspectSecretary(
  required: boolean,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  statusProbe: (cwd: string, environment: NodeJS.ProcessEnv) => Promise<SecretaryReadinessStatus>,
): Promise<ReadinessCheck> {
  try {
    const status = await statusProbe(cwd, environment);
    const userIdentity = normalizeIdentityLabel(status.userIdentity);
    const botIdentity = normalizeIdentityLabel(status.botIdentity);
    const userReady = identityReady(userIdentity);
    const botReady = identityReady(botIdentity);
    const anyIdentityReady = userReady || botReady;
    const fullyReady = status.cliInstalled && status.profileMatched !== false && anyIdentityReady;
    const partial = fullyReady && !(userReady && botReady);
    return {
      id: 'drivers.secretary',
      category: 'drivers',
      label: 'SecretaryCat lark-cli',
      status: fullyReady ? partial ? 'warn' : 'pass' : required ? 'blocked' : 'warn',
      required,
      summary: fullyReady
        ? `lark-cli is available; user=${userIdentity}, bot=${botIdentity}.`
        : `lark-cli authentication is not ready; user=${userIdentity}, bot=${botIdentity}.`,
      ...(!fullyReady && { nextAction: 'Install/configure lark-cli and complete the required Feishu authentication.' }),
      data: {
        cliInstalled: status.cliInstalled,
        profileMatched: status.profileMatched,
        userIdentity,
        botIdentity,
      },
    };
  } catch (error) {
    const normalized = normalizeToolError(error);
    const installed = normalized.code !== 'CLI_NOT_INSTALLED';
    return {
      id: 'drivers.secretary',
      category: 'drivers',
      label: 'SecretaryCat lark-cli',
      status: required ? 'blocked' : 'warn',
      required,
      summary: secretaryErrorSummary(normalized.code),
      nextAction: normalized.nextAction || 'Install/configure lark-cli and rerun xiaoba doctor.',
      data: { cliInstalled: installed, ready: false, errorCode: normalized.code },
    };
  }
}

function feishuSurfaceCheck(config: ChatConfig, environment: NodeJS.ProcessEnv): ReadinessCheck {
  const appIdConfigured = Boolean(environment.FEISHU_APP_ID?.trim() || config.feishu?.appId?.trim());
  const appSecretConfigured = Boolean(environment.FEISHU_APP_SECRET?.trim() || config.feishu?.appSecret?.trim());
  const ready = appIdConfigured && appSecretConfigured;
  return {
    id: 'surfaces.feishu',
    category: 'surfaces',
    label: 'Feishu Surface',
    status: ready ? 'pass' : 'warn',
    required: false,
    summary: ready ? 'Feishu App ID and App Secret are configured.' : 'Feishu Surface credentials are incomplete.',
    ...(!ready && { nextAction: 'Set FEISHU_APP_ID and FEISHU_APP_SECRET before starting the Feishu Surface.' }),
    data: { appIdConfigured, appSecretConfigured },
  };
}

function weixinSurfaceCheck(_config: ChatConfig, environment: NodeJS.ProcessEnv): ReadinessCheck {
  const tokenConfigured = Boolean(environment.WEIXIN_TOKEN?.trim());
  return {
    id: 'surfaces.weixin',
    category: 'surfaces',
    label: 'Weixin Surface',
    status: tokenConfigured ? 'pass' : 'warn',
    required: false,
    summary: tokenConfigured ? 'Weixin token is configured.' : 'Weixin token is not configured.',
    ...(!tokenConfigured && { nextAction: 'Set WEIXIN_TOKEN before starting the Weixin Surface.' }),
    data: { tokenConfigured },
  };
}

async function defaultBrowserStatus(cwd: string): Promise<AgentBrowserDriverStatus> {
  return new DefaultAgentBrowserRunner().getStatus({ cwd });
}

async function defaultGuiStatus(): Promise<PeekabooDriverStatus> {
  return new DefaultPeekabooRunner().status({ includeBridge: false });
}

async function defaultSecretaryStatus(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  runner: LarkCliRunner = new DefaultLarkCliRunner('lark-cli', environment),
): Promise<SecretaryReadinessStatus> {
  const result = await runner.run(['auth', 'status'], { cwd, timeoutMs: 15_000 });
  const status = normalizeFeishuAuthStatus(parseJsonOutput(result.stdout));
  return {
    cliInstalled: true,
    profileMatched: environment.FEISHU_APP_ID?.trim() ? true : null,
    userIdentity: stringValue(status.user_identity) || 'missing',
    botIdentity: stringValue(status.bot_identity) || 'missing',
  };
}

function normalizeIdentityLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^(ready|active|valid|available|authenticated|ok|missing|expired|invalid|unavailable|unknown)$/.test(normalized)
    ? normalized
    : 'unknown';
}

function identityReady(value: string): boolean {
  return /^(ready|active|valid|available|authenticated|ok)$/i.test(value.trim());
}

function secretaryErrorSummary(code: string): string {
  switch (code) {
    case 'CLI_NOT_INSTALLED':
      return 'lark-cli is not installed or not on PATH.';
    case 'CLI_NOT_CONFIGURED':
      return 'No lark-cli profile matches the configured Feishu application.';
    case 'AUTH_MISSING':
      return 'lark-cli authentication is missing or expired.';
    case 'SCOPE_MISSING':
      return 'lark-cli authentication is missing required scopes.';
    case 'TOOL_TIMEOUT':
      return 'lark-cli auth status timed out.';
    default:
      return `lark-cli readiness check failed (${code}).`;
  }
}

function isReadableDirectory(targetPath: string): boolean {
  try {
    if (!fs.statSync(targetPath).isDirectory()) return false;
    fs.accessSync(targetPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function safelyResolvePath(resolver: () => string, fallback: string): string {
  try {
    return path.resolve(resolver());
  } catch {
    return path.resolve(fallback);
  }
}

function safeResolveRole(resolver: (roleName: string) => string | undefined, roleName: string): string | undefined {
  try {
    return resolver(roleName);
  } catch {
    return undefined;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
