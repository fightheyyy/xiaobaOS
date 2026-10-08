import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { createSandboxPolicy, shellQuote } from '../src/sandbox/policy';
import { sandboxExecutor } from '../src/sandbox/executor';
import { ToolManager } from '../src/tools/tool-manager';
import { MemoryFinalizer } from '../src/utils/memory-finalizer';

describe('Anthropic SDK execution boundary', () => {
  let root: string, workspace: string, available: boolean;
  let reason: string | undefined;
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-sdk-contract-'));
    workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
    const probe = await sandboxExecutor.probe(createSandboxPolicy({ cwd: workspace, scratchRoot: path.join(root, 'probe') }));
    available = probe.available; reason = probe.reason;
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  const policy = (name: string, extra = {}) => createSandboxPolicy({ cwd: workspace, scratchRoot: path.join(root, name), ...extra });

  test('missing dependencies fail closed without running the command', async () => {
    const result = await sandboxExecutor.execute({ policy: policy('missing'), command: 'touch should-not-exist', environment: { PATH: path.join(root, 'no-binaries') } });
    assert.equal(result.errorCode, 'SANDBOX_UNAVAILABLE');
    assert.equal(fs.existsSync(path.join(workspace, 'should-not-exist')), false);
  });

  test('writes stay in the workspace across subprocesses and symlinks', async t => {
    if (!available) return t.skip(reason);
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, 'escape'));
    const result = await sandboxExecutor.execute({ policy: policy('writes'), command: 'sh -c "echo okay > allowed.txt"' });
    assert.equal(result.status, 0, result.stderr);
    const escape = await sandboxExecutor.execute({ policy: policy('escape'), command: 'echo forbidden > escape/forbidden.txt' });
    assert.notEqual(escape.status, 0);
    assert.equal(fs.existsSync(path.join(outside, 'forbidden.txt')), false);
    assert.equal(fs.readFileSync(path.join(workspace, 'allowed.txt'), 'utf8').trim(), 'okay');
  });

  test('workspace secrets and parent environment values are unavailable', async t => {
    if (!available) return t.skip(reason);
    fs.writeFileSync(path.join(workspace, '.env'), 'secret-file-marker');
    process.env.XIAOBA_SANDBOX_TEST_SECRET = 'secret-env-marker';
    try {
      const result = await sandboxExecutor.execute({ policy: policy('secrets'), command: 'cat .env; printf "%s" "$XIAOBA_SANDBOX_TEST_SECRET"' });
      assert.equal(result.stdout.includes('secret-file-marker'), false);
      assert.equal(result.stdout.includes('secret-env-marker'), false);
      assert.match(result.stderr, /Permission denied|Operation not permitted/);
    } finally { delete process.env.XIAOBA_SANDBOX_TEST_SECRET; }
  });

  test('concurrent SDK workers cannot replace one another\'s write policy', async t => {
    if (!available) return t.skip(reason);
    const other = path.join(root, 'second-workspace'); fs.mkdirSync(other);
    const [a, b] = await Promise.all([
      sandboxExecutor.execute({ policy: policy('concurrent-a'), command: `sleep 0.1; echo forbidden > ${shellQuote(path.join(other, 'escaped.txt'))}` }),
      sandboxExecutor.execute({ policy: createSandboxPolicy({ cwd: other, scratchRoot: path.join(root, 'concurrent-b') }), command: 'echo allowed > own.txt' }),
    ]);
    assert.notEqual(a.status, 0); assert.equal(b.status, 0, b.stderr);
    assert.equal(fs.existsSync(path.join(other, 'escaped.txt')), false);
    assert.equal(fs.existsSync(path.join(other, 'own.txt')), true);
  });

  test('network proxy permits selected destinations and blocks direct TCP bypass', async t => {
    if (!available) return t.skip(reason);
    const server = http.createServer((_req, res) => res.end('network-marker'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    const url = `http://127.0.0.1:${port}`;
    try {
      const denied = await sandboxExecutor.execute({ policy: policy('network-denied'), command: `curl --proxy "$http_proxy" --noproxy "" -fsS --max-time 3 ${shellQuote(url)}` });
      assert.notEqual(denied.status, 0); assert.equal(denied.stdout.includes('network-marker'), false);
      const allowed = await sandboxExecutor.execute({ policy: policy('network-allowed', { allowedDomains: ['127.0.0.1'] }), command: `curl --proxy "$http_proxy" --noproxy "" -fsS --max-time 3 ${shellQuote(url)}` });
      assert.equal(allowed.status, 0, allowed.stderr); assert.equal(allowed.stdout, 'network-marker');
      const bypass = await sandboxExecutor.execute({ policy: policy('network-direct', { allowedDomains: ['127.0.0.1'] }), command: `curl --noproxy '*' -fsS --max-time 2 ${shellQuote(url)}` });
      assert.notEqual(bypass.status, 0); assert.equal(bypass.stdout.includes('network-marker'), false);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  test('output and time limits stop execution without later child writes', async t => {
    if (!available) return t.skip(reason);
    const output = await sandboxExecutor.execute({ policy: policy('output'), command: 'yes output', maxOutputBytes: 1000 });
    assert.equal(output.errorCode, 'SANDBOX_OUTPUT_LIMIT');
    const timeout = await sandboxExecutor.execute({ policy: policy('timeout'), command: '(sleep 1; touch late-child) & wait', timeoutMs: 700 });
    assert.equal(timeout.errorCode, 'SANDBOX_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(fs.existsSync(path.join(workspace, 'late-child')), false);
  });

  test('abort cancellation reports a distinct terminal state', async t => {
    if (!available) return t.skip(reason);
    const controller = new AbortController();
    const pending = sandboxExecutor.execute({ policy: policy('cancel'), command: 'sleep 30', abortSignal: controller.signal });
    setTimeout(() => controller.abort(), 500);
    assert.equal((await pending).errorCode, 'SANDBOX_CANCELLED');
  });

  test('all model providers use the SDK proxy for host-local endpoints', async t => {
    if (!available) return t.skip(reason);
    const server = http.createServer((req, res) => {
      req.resume(); res.setHeader('content-type', 'application/json');
      const content = 'provider-marker';
      res.end(JSON.stringify(req.url?.includes('messages')
        ? { id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock', content: [{ type: 'text', text: content }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
        : req.url?.includes('/api/chat') ? { message: { role: 'assistant', content }, done: true, prompt_eval_count: 1, eval_count: 1 }
        : { choices: [{ message: { role: 'assistant', content } }] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const app = path.resolve(__dirname, '..');
      for (const [file, name] of [['openai', 'OpenAIProvider'], ['anthropic', 'AnthropicProvider'], ['ollama', 'OllamaProvider']]) {
        const config = { apiUrl: `http://127.0.0.1:${(server.address() as any).port}`, apiKey: 'mock-key', model: 'mock' };
        const code = `const {${name}}=require(${JSON.stringify(path.join(app, 'dist/providers', `${file}-provider.js`))});new ${name}(${JSON.stringify(config)}).chat([{role:'user',content:'test'}]).then(r=>process.stdout.write(r.content)).catch(e=>{console.error(e.message);process.exitCode=1;});`;
        const result = await sandboxExecutor.execute({ policy: policy(`provider-${file}`, { allowedDomains: ['127.0.0.1'], readRoots: [path.join(app, 'dist'), path.join(app, 'node_modules'), path.join(app, 'package.json')] }),
          command: [process.execPath, '-e', code].map(shellQuote).join(' '), timeoutMs: 15_000 });
        assert.equal(result.status, 0, `${name}: ${result.stderr}`); assert.equal(result.stdout, 'provider-marker');
      }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  test('file tools enforce the SDK boundary, including symlink targets', async t => {
    if (!available) return t.skip(reason);
    const outsideFile = path.join(root, 'private-note'); fs.writeFileSync(outsideFile, 'private-marker');
    fs.symlinkSync(outsideFile, path.join(workspace, 'private-link'));
    const manager = new ToolManager(workspace);
    const call = (name: string, args: unknown) => manager.executeTool({ id: `sdk-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const write = await call('write_file', { file_path: 'tool-created', content: 'tool-marker' });
    assert.equal(write.status, 'success', JSON.stringify(write));
    const read = await call('read_file', { file_path: 'private-link' });
    assert.notEqual(read.status, 'success'); assert.equal(String(read.content).includes('private-marker'), false);
    const escape = await call('write_file', { file_path: outsideFile, content: 'overwrite' });
    assert.notEqual(escape.status, 'success'); assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'private-marker');
  });

  test('only the current session memory is restored inside the file boundary', async t => {
    if (!available) return t.skip(reason);
    const previous = process.env.XIAOBA_PROJECT_ROOT;
    process.env.XIAOBA_PROJECT_ROOT = root;
    try {
      const alice = MemoryFinalizer.getSessionDir('cli:alice', root), bob = MemoryFinalizer.getSessionDir('cli:bob', root);
      fs.mkdirSync(alice, { recursive: true }); fs.mkdirSync(bob, { recursive: true });
      fs.writeFileSync(path.join(alice, 'MEMORY.md'), 'alice-memory-marker');
      fs.writeFileSync(path.join(bob, 'MEMORY.md'), 'bob-private-marker');
      const manager = new ToolManager(workspace, { sessionId: 'cli:alice' });
      const read = (file: string) => manager.executeTool({ id: 'memory-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ file_path: file }) } });
      const own = await read(path.join(alice, 'MEMORY.md'));
      assert.equal(own.status, 'success', JSON.stringify(own)); assert.match(String(own.content), /alice-memory-marker/);
      const other = await read(path.join(bob, 'MEMORY.md'));
      assert.notEqual(other.status, 'success'); assert.equal(String(other.content).includes('bob-private-marker'), false);
    } finally { if (previous === undefined) delete process.env.XIAOBA_PROJECT_ROOT; else process.env.XIAOBA_PROJECT_ROOT = previous; }
  });
});
