import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildCodexEnvironment,
  CodexExecutor,
  CodexExecutorRequest,
  CodexExecutorResult,
  discoverConfiguredMcpServers,
  OfficialCodexSdkAdapter,
} from '../src/roles/engineer-cat/codex-sdk-adapter';
import { EngineerCodexRunTool } from '../src/roles/engineer-cat/codex-run-tool';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-codex-adapter-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

class FakeExecutor implements CodexExecutor {
  requests: CodexExecutorRequest[] = [];

  constructor(
    private readonly result?: CodexExecutorResult,
    private readonly error?: Error,
  ) {}

  async run(request: CodexExecutorRequest): Promise<CodexExecutorResult> {
    this.requests.push(request);
    if (this.error) throw this.error;
    return this.result ?? {
      threadId: 'thread-default',
      finalResponse: 'done',
      usage: null,
      changes: [],
      commands: [],
      externalTools: [],
      errors: [],
    };
  }
}

describe('EngineerCat codex_run tool', () => {
  test('keeps cwd and execution policy out of model arguments while returning resumable evidence', async () => {
    const root = temporaryRoot();
    const abortController = new AbortController();
    const executor = new FakeExecutor({
      threadId: 'thread-123',
      finalResponse: 'implemented and tested',
      usage: {
        input_tokens: 100,
        cached_input_tokens: 10,
        cache_write_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 5,
      },
      changes: [
        { path: 'src/example.ts', kind: 'update' },
        { path: 'src/new.ts', kind: 'add' },
      ],
      commands: [{ command: 'npm test', status: 'completed', exit_code: 0 }],
      externalTools: [],
      errors: [],
    });
    const tool = new EngineerCodexRunTool(executor);

    const output = await tool.execute({
      task: 'Implement the requested change.',
      access: 'workspace_write',
      thread_id: 'thread-previous',
    }, {
      workingDirectory: root,
      conversationHistory: [],
      roleName: 'engineer-cat',
      abortSignal: abortController.signal,
    });

    assert.strictEqual(output.status, 'success');
    assert.strictEqual(executor.requests.length, 1);
    assert.deepStrictEqual(executor.requests[0], {
      task: 'Implement the requested change.',
      accessMode: 'workspace_write',
      workingDirectory: root,
      abortSignal: abortController.signal,
      threadId: 'thread-previous',
    });
    const payload = JSON.parse(String(output.toolContent));
    assert.strictEqual(payload.backend, 'codex');
    assert.strictEqual(payload.thread_id, 'thread-123');
    assert.strictEqual(payload.executor_output_trust, 'untrusted_model_output');
    assert.deepStrictEqual(payload.changes, [
      { path: 'src/example.ts', kind: 'update' },
      { path: 'src/new.ts', kind: 'add' },
    ]);
    assert.deepStrictEqual(tool.getArtifactManifest({}, output, {
      workingDirectory: root,
      conversationHistory: [],
    }), [
      {
        path: 'src/example.ts',
        type: 'source_code',
        action: 'updated',
        metadata: { executor: 'codex', change_kind: 'update' },
      },
      {
        path: 'src/new.ts',
        type: 'source_code',
        action: 'created',
        metadata: { executor: 'codex', change_kind: 'add' },
      },
    ]);

    for (const forbiddenParameter of ['cwd', 'working_directory', 'binary', 'network', 'approval_policy']) {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(tool.definition.parameters.properties, forbiddenParameter),
        false,
      );
    }
  });

  test('defaults to workspace write and rejects invalid arguments before invoking Codex', async () => {
    const executor = new FakeExecutor();
    const tool = new EngineerCodexRunTool(executor);
    const context = {
      workingDirectory: temporaryRoot(),
      conversationHistory: [],
      roleName: 'engineer-cat',
    };

    const defaultOutput = await tool.execute({ task: 'small task' }, context);
    assert.strictEqual(defaultOutput.status, 'success');
    assert.strictEqual(executor.requests[0].accessMode, 'workspace_write');

    const invalidAccess = await tool.execute({ task: 'task', access: 'danger_full_access' }, context);
    assert.strictEqual(invalidAccess.status, 'failure');
    assert.strictEqual(invalidAccess.error_code, 'INVALID_TOOL_ARGUMENTS');

    const invalidThread = await tool.execute({ task: 'task', thread_id: '../escape' }, context);
    assert.strictEqual(invalidThread.status, 'failure');
    assert.strictEqual(invalidThread.error_code, 'INVALID_TOOL_ARGUMENTS');
    assert.strictEqual(executor.requests.length, 1);
  });

  test('maps unavailable, auth and cancellation errors to canonical terminal states', async () => {
    const context = {
      workingDirectory: temporaryRoot(),
      conversationHistory: [],
      roleName: 'engineer-cat',
    };
    const unavailable = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
    const unavailableOutput = await new EngineerCodexRunTool(
      new FakeExecutor(undefined, unavailable),
    ).execute({ task: 'task' }, context);
    assert.strictEqual(unavailableOutput.status, 'blocked');
    assert.strictEqual(unavailableOutput.error_code, 'CODEX_UNAVAILABLE');

    const authOutput = await new EngineerCodexRunTool(
      new FakeExecutor(undefined, new Error('401 unauthorized')),
    ).execute({ task: 'task' }, context);
    assert.strictEqual(authOutput.status, 'blocked');
    assert.strictEqual(authOutput.error_code, 'CODEX_AUTH_REQUIRED');

    const abortController = new AbortController();
    abortController.abort();
    const cancelledOutput = await new EngineerCodexRunTool(
      new FakeExecutor(undefined, new Error('aborted')),
    ).execute({ task: 'task' }, { ...context, abortSignal: abortController.signal });
    assert.strictEqual(cancelledOutput.status, 'cancelled');
    assert.strictEqual(cancelledOutput.error_code, 'CODEX_CANCELLED');

    let sdkLoaded = false;
    const arenaAdapter = new OfficialCodexSdkAdapter({
      environment: { XIAOBA_ARENA: '1' },
      loadSdk: async () => {
        sdkLoaded = true;
        throw new Error('must not load');
      },
    });
    const arenaOutput = await new EngineerCodexRunTool(arenaAdapter).execute({ task: 'task' }, context);
    assert.strictEqual(arenaOutput.status, 'blocked');
    assert.strictEqual(arenaOutput.error_code, 'CODEX_ARENA_FORBIDDEN');
    assert.strictEqual(sdkLoaded, false);
  });
});

describe('Official Codex SDK adapter boundary', () => {
  test('uses start/resume with fixed sandbox options and sanitized environment', async () => {
    const root = temporaryRoot();
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), [
      '[mcp_servers.local_tools]',
      'command = "unsafe-helper"',
      '[mcp_servers."browser-tools"]',
      'url = "http://localhost:1234"',
    ].join('\n'));

    let constructorOptions: any;
    let threadOptions: any;
    let resumeId: string | undefined;
    let prompt = '';
    let signal: AbortSignal | undefined;
    const fakeThread = {
      id: 'thread-resumed',
      async run(input: string, options?: { signal?: AbortSignal }) {
        prompt = input;
        signal = options?.signal;
        return {
          finalResponse: 'complete',
          usage: {
            input_tokens: 3,
            cached_input_tokens: 1,
            cache_write_input_tokens: 0,
            output_tokens: 2,
            reasoning_output_tokens: 1,
          },
          items: [
            {
              type: 'file_change',
              status: 'completed',
              changes: [{ path: 'src/a.ts', kind: 'update' }],
            },
            {
              type: 'command_execution',
              command: 'npm test',
              status: 'completed',
              exit_code: 0,
              aggregated_output: 'secret command output is intentionally omitted',
            },
          ],
        };
      },
    };
    class FakeCodex {
      constructor(options: any) {
        constructorOptions = options;
      }
      startThread(options: any) {
        threadOptions = options;
        return fakeThread;
      }
      resumeThread(id: string, options: any) {
        resumeId = id;
        threadOptions = options;
        return fakeThread;
      }
    }
    const adapter = new OfficialCodexSdkAdapter({
      environment: {
        HOME: home,
        PATH: '/safe/bin',
        CODEX_API_KEY: 'codex-secret',
        XIAOBA_CODEX_EXE: '/fixed/codex',
        XIAOBA_LLM_API_KEY: 'must-not-leak',
        FEISHU_APP_SECRET: 'must-not-leak',
      },
      loadSdk: async () => ({ Codex: FakeCodex as any }),
    });
    const abortController = new AbortController();

    const result = await adapter.run({
      task: 'Fix it.',
      threadId: 'thread-old',
      accessMode: 'read_only',
      workingDirectory: root,
      abortSignal: abortController.signal,
    });

    assert.strictEqual(resumeId, 'thread-old');
    assert.deepStrictEqual(threadOptions, {
      sandboxMode: 'read-only',
      workingDirectory: root,
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      approvalPolicy: 'never',
      additionalDirectories: [],
    });
    assert.strictEqual(constructorOptions.codexPathOverride, '/fixed/codex');
    assert.strictEqual(constructorOptions.env.CODEX_API_KEY, 'codex-secret');
    assert.strictEqual(constructorOptions.env.XIAOBA_LLM_API_KEY, undefined);
    assert.strictEqual(constructorOptions.env.FEISHU_APP_SECRET, undefined);
    assert.strictEqual(constructorOptions.env.XIAOBA_CODEX_EXE, undefined);
    assert.deepStrictEqual(constructorOptions.config, {
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
      mcp_servers: {
        'browser-tools': { enabled: false },
        local_tools: { enabled: false },
      },
    });
    assert.match(prompt, /read-only task/);
    assert.match(prompt, /Do not use web search, network access, MCP tools/);
    assert.strictEqual(signal, abortController.signal);
    assert.strictEqual(result.threadId, 'thread-resumed');
    assert.deepStrictEqual(result.changes, [{ path: 'src/a.ts', kind: 'update' }]);
    assert.deepStrictEqual(result.commands, [{ command: 'npm test', status: 'completed', exit_code: 0 }]);
    assert.strictEqual(JSON.stringify(result).includes('secret command output'), false);
  });

  test('environment and MCP discovery expose only the intended boundary', () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codex', 'config.toml'), '[mcp_servers.project]\ncommand = "helper"\n');
    assert.deepStrictEqual(discoverConfiguredMcpServers(root, { HOME: path.join(root, 'home') }), ['project']);
    assert.deepStrictEqual(buildCodexEnvironment({
      PATH: '/bin',
      HOME: '/home/test',
      LC_ALL: 'C',
      XDG_CONFIG_HOME: '/config',
      OPENAI_API_KEY: 'forbidden',
      XIAOBA_LLM_API_KEY: 'forbidden',
      FEISHU_APP_SECRET: 'forbidden',
    }), {
      PATH: '/bin',
      HOME: '/home/test',
      LC_ALL: 'C',
      XDG_CONFIG_HOME: '/config',
    });
  });
});
