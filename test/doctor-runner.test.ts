import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { AgentBrowserDriverStatus } from '../src/roles/browser-cat/agent-browser-runner';
import { PeekabooDriverStatus } from '../src/roles/gui-cat/utils/peekaboo-runner';
import { DoctorRunnerDependencies, runDoctor } from '../src/doctor/doctor-runner';
import { RoleConfig } from '../src/types/role';

const roleConfigs: Record<string, RoleConfig> = {
  'browser-cat': { displayName: 'BrowserCat', promptFile: 'browser.md' },
  'gui-cat': { displayName: 'GuiCat', promptFile: 'gui.md' },
  'secretary-cat': { displayName: 'SecretaryCat', promptFile: 'secretary.md' },
  'custom-cat': { displayName: 'CustomCat', promptFile: 'custom.md' },
};

function readyBrowser(): AgentBrowserDriverStatus {
  return {
    installed: true,
    ready: true,
    version: '0.31.1',
    expectedVersion: '0.31.1',
    binaryPath: '/private/driver/agent-browser',
  };
}

function readyGui(): PeekabooDriverStatus {
  return {
    platform: 'darwin',
    macosVersion: '15.0',
    supportedPlatform: true,
    binaryPath: '/private/driver/peekaboo',
    version: '3.8.0',
    versionCompatible: true,
    permissions: {
      screenRecording: true,
      accessibility: true,
      eventSynthesizing: true,
    },
    ready: true,
  };
}

function dependencies(overrides: DoctorRunnerDependencies = {}): DoctorRunnerDependencies {
  return {
    now: () => new Date('2026-07-17T00:00:00.000Z'),
    appVersion: '0.2.0',
    nodeVersion: 'v20.18.1',
    platform: 'darwin',
    arch: 'arm64',
    environment: {},
    getProjectRoot: () => '/project',
    getRolesRoot: () => '/project/roles',
    directoryReadable: () => true,
    pathExists: () => true,
    getConfig: () => ({
      provider: 'openai',
      apiUrl: 'https://api.openai.com/v1',
      apiKey: 'test-secret-api-key',
      model: 'gpt-test',
    }),
    listRoles: () => Object.keys(roleConfigs).sort(),
    getRoleConfig: roleName => roleConfigs[roleName],
    resolveRole: roleName => {
      const normalized = roleName.toLowerCase();
      if (normalized === 'browser') return 'browser-cat';
      if (normalized === 'custom') return 'custom-cat';
      return roleConfigs[normalized] ? normalized : undefined;
    },
    browserStatus: async () => readyBrowser(),
    guiStatus: async () => readyGui(),
    secretaryStatus: async () => ({
      cliInstalled: true,
      profileMatched: true,
      userIdentity: 'ready',
      botIdentity: 'ready',
    }),
    ...overrides,
  };
}

function check(report: Awaited<ReturnType<typeof runDoctor>>, id: string) {
  const value = report.checks.find(item => item.id === id);
  assert.ok(value, `missing check ${id}`);
  return value;
}

describe('runDoctor', () => {
  test('keeps optional driver and surface gaps non-blocking for Base', async () => {
    const browserError = Object.assign(new Error('not installed'), { code: 'BROWSER_DRIVER_NOT_FOUND' });
    const report = await runDoctor({ requestedRole: 'base' }, dependencies({
      browserStatus: async () => { throw browserError; },
      guiStatus: async () => ({
        platform: 'linux',
        supportedPlatform: false,
        versionCompatible: false,
        permissions: { screenRecording: false, accessibility: false, eventSynthesizing: false },
        ready: false,
        reason: 'GuiCat requires macOS 15 or newer.',
      }),
      secretaryStatus: async () => ({
        cliInstalled: false,
        profileMatched: null,
        userIdentity: 'missing',
        botIdentity: 'missing',
      }),
    }));

    assert.strictEqual(report.ready, true);
    assert.strictEqual(report.overall, 'degraded');
    assert.strictEqual(check(report, 'drivers.browser').required, false);
    assert.strictEqual(check(report, 'drivers.browser').status, 'warn');
    assert.strictEqual(report.summary.requiredIssues, 0);
  });

  test('blocks an active BrowserCat when its pinned driver is unavailable', async () => {
    const report = await runDoctor({ requestedRole: 'browser-cat' }, dependencies({
      browserStatus: async () => {
        throw Object.assign(new Error('missing'), { code: 'BROWSER_DRIVER_NOT_FOUND' });
      },
    }));

    assert.strictEqual(report.ready, false);
    assert.strictEqual(report.overall, 'not_ready');
    assert.strictEqual(check(report, 'drivers.browser').required, true);
    assert.strictEqual(check(report, 'drivers.browser').status, 'blocked');
  });

  test('applies active-role requirements to GuiCat and SecretaryCat', async () => {
    const guiReport = await runDoctor({ requestedRole: 'gui-cat' }, dependencies({
      guiStatus: async () => ({
        platform: 'darwin',
        macosVersion: '15.0',
        supportedPlatform: true,
        versionCompatible: true,
        permissions: { screenRecording: true, accessibility: false, eventSynthesizing: false },
        ready: false,
        reason: 'Accessibility permission missing.',
      }),
    }));
    assert.strictEqual(check(guiReport, 'drivers.gui').required, true);
    assert.strictEqual(guiReport.ready, false);

    const secretaryReport = await runDoctor({ requestedRole: 'secretary-cat' }, dependencies({
      secretaryStatus: async () => ({
        cliInstalled: true,
        profileMatched: true,
        userIdentity: 'missing',
        botIdentity: 'missing',
      }),
    }));
    assert.strictEqual(check(secretaryReport, 'drivers.secretary').required, true);
    assert.strictEqual(secretaryReport.ready, false);
  });

  test('accepts Ollama without an API key and rejects OpenAI without one', async () => {
    const ollama = await runDoctor({}, dependencies({
      getConfig: () => ({
        provider: 'ollama',
        apiUrl: 'http://127.0.0.1:11434/api/chat',
        model: 'qwen3',
      }),
    }));
    assert.strictEqual(check(ollama, 'provider.static_config').status, 'pass');

    const openai = await runDoctor({}, dependencies({
      getConfig: () => ({
        provider: 'openai',
        apiUrl: 'https://api.openai.com/v1',
        model: 'gpt-test',
      }),
    }));
    assert.strictEqual(check(openai, 'provider.static_config').status, 'fail');
    assert.strictEqual(openai.ready, false);
  });

  test('treats every installed Role as a runnable package', async () => {
    const exact = await runDoctor({ requestedRole: 'custom-cat' }, dependencies());
    assert.strictEqual(check(exact, 'roles.active').status, 'pass');
    assert.strictEqual(exact.context.activeRole, 'custom-cat');
    assert.strictEqual(exact.ready, true);

    const alias = await runDoctor({ requestedRole: 'custom' }, dependencies());
    assert.strictEqual(check(alias, 'roles.active').status, 'pass');
    assert.strictEqual(alias.context.activeRole, 'custom-cat');
    assert.strictEqual(alias.ready, true);
  });

  test('reports a missing Role without enabling a Role-specific Driver requirement', async () => {
    const report = await runDoctor({ requestedRole: 'missing-cat' }, dependencies());

    assert.strictEqual(report.context.activeRole, null);
    assert.strictEqual(check(report, 'roles.active').status, 'fail');
    assert.strictEqual(check(report, 'drivers.browser').required, false);
  });

  test('aligns Secretary profile matching and Weixin checks with runtime configuration sources', async () => {
    let secretaryAppId = '';
    const report = await runDoctor({}, dependencies({
      environment: {},
      getConfig: () => ({
        provider: 'ollama',
        apiUrl: 'http://127.0.0.1:11434',
        model: 'qwen3',
        feishu: { appId: 'configured-app-id', appSecret: 'configured-secret' },
        weixin: { token: 'config-only-token' },
      }),
      secretaryStatus: async (_cwd, environment) => {
        secretaryAppId = environment.FEISHU_APP_ID || '';
        return {
          cliInstalled: true,
          profileMatched: true,
          userIdentity: 'ready',
          botIdentity: 'ready',
        };
      },
    }));

    assert.strictEqual(secretaryAppId, 'configured-app-id');
    assert.strictEqual(check(report, 'surfaces.feishu').status, 'pass');
    assert.strictEqual(check(report, 'surfaces.weixin').status, 'warn');
  });

  test('reports unreadable configuration as the actual Provider failure', async () => {
    const report = await runDoctor({}, dependencies({
      getConfig: () => { throw new Error('malformed config'); },
    }));

    assert.strictEqual(check(report, 'provider.static_config').status, 'fail');
    assert.match(check(report, 'provider.static_config').summary, /could not be read/);
    assert.strictEqual(report.ready, false);
  });

  test('reports runtime and root failures without leaking secret probe values', async () => {
    const secret = 'secret-token-never-print';
    const report = await runDoctor({}, dependencies({
      nodeVersion: 'v16.20.0',
      directoryReadable: target => target !== '/project/roles',
      getConfig: () => ({
        provider: 'openai',
        apiUrl: 'https://api.openai.com/v1',
        apiKey: secret,
        model: 'gpt-test',
      }),
      secretaryStatus: async () => ({
        cliInstalled: true,
        profileMatched: true,
        userIdentity: secret,
        botIdentity: 'ready',
      }),
    }));

    assert.strictEqual(check(report, 'runtime.node').status, 'fail');
    assert.strictEqual(check(report, 'project.roles_root').status, 'fail');
    assert.strictEqual(report.ready, false);
    assert.ok(!JSON.stringify(report).includes(secret));
    assert.strictEqual((check(report, 'drivers.secretary').data || {}).userIdentity, 'unknown');
  });
});
