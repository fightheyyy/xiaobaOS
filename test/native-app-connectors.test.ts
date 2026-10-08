import { beforeEach, afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { AgentConnectorService, AgentConnectorConfigStore, EnvironmentCredentials, GitHubConnector, NotionConnector, GmailConnector, ConnectorHttp, ConnectorError } from '../src/connectors';
import type { ConnectorFetch, AgentCredentials } from '../src/connectors';
import { createConnectorTools } from '../src/tools/connector-tools';
import { ToolManager } from '../src/tools/tool-manager';
import { AgentSession } from '../src/core/agent-session';
import { registerConnectorCommand } from '../src/commands/connector';
import { Logger } from '../src/utils/logger';

interface Call { url: URL; method: string; headers: Headers; body?: any; raw?: string; signal?: AbortSignal }
const environment = { XIAOBA_GITHUB_TOKEN: 'github-private-token', XIAOBA_NOTION_TOKEN: 'notion-private-token', XIAOBA_GMAIL_CLIENT_ID: 'google-client', XIAOBA_GMAIL_CLIENT_SECRET: 'google-client-secret', XIAOBA_GMAIL_REFRESH_TOKEN: 'google-refresh-private' };
const owner = { surface: 'cli', sessionId: 'agent-owner' };
const pageId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const staticCredentials: AgentCredentials = { configured: () => true, token: async () => 'private-token' };
function fakeHttp(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher: ConnectorFetch = async (input, init) => {
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const call: Call = { url: new URL(String(input)), method: init?.method || 'GET', headers: new Headers(init?.headers), raw, signal: init?.signal || undefined };
    if (raw && call.headers.get('content-type') === 'application/json') call.body = JSON.parse(raw);
    calls.push(call); return reply(call);
  };
  return { calls, fetcher };
}
const json = (data: unknown, init?: ResponseInit) => new Response(JSON.stringify(data), { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
const toolCall = (name: string, args: any) => ({ id: 'test-call', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

describe('Agent-owned native app connectors', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-native-connectors-')); Logger.setSilentMode(true); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); Logger.setSilentMode(false); });

  test('GitHub uses official REST headers, encodes targets, limits pagination and returns page cursors rather than URLs', async () => {
    const http = fakeHttp(() => json([{ number: 2 }], { headers: { Link: '<https://api.github.com/repos/agent/test/issues?page=2>; rel="next"' } }));
    const connector = new GitHubConnector(staticCredentials, http.fetcher);
    const result = await connector.invoke({ operation: 'issues.list', args: { owner: 'agent', repo: 'test', state: 'open', limit: 5, page: 1 } });
    assert.equal(http.calls[0].url.origin, 'https://api.github.com');
    assert.equal(http.calls[0].url.pathname, '/repos/agent/test/issues');
    assert.equal(http.calls[0].url.searchParams.get('per_page'), '5');
    assert.equal(http.calls[0].headers.get('x-github-api-version'), '2022-11-28');
    assert.equal(result.nextPage, '2');
    await assert.rejects(connector.invoke({ operation: 'issues.list', args: { owner: '../victim', repo: 'test' } }), /Invalid/);
    await assert.rejects(connector.invoke({ operation: 'repos.list', args: { limit: 101 } }), /Invalid/);
    assert.equal(http.calls.length, 1);
  });

  test('GitHub issue/PR creation maps only declared payload fields and file contents are decoded with truncation', async () => {
    const http = fakeHttp(call => call.url.pathname.includes('/contents/') ? json({ encoding: 'base64', content: Buffer.from('x'.repeat(33000)).toString('base64') }) : json({ number: 5 }));
    const connector = new GitHubConnector(staticCredentials,http.fetcher);
    await connector.invoke({ operation: 'pull.create', args: { owner: 'Agent', repo: 'xiaobaOS', title: 'Fix', head: 'fix', base: 'main', draft: true } });
    assert.equal(http.calls[0].method,'POST'); assert.equal(http.calls[0].url.pathname,'/repos/Agent/xiaobaOS/pulls');
    assert.deepEqual(http.calls[0].body,{ title: 'Fix', head: 'fix', base: 'main', draft: true });
    const file = await connector.invoke({ operation: 'file.get', args: { owner: 'Agent', repo: 'xiaobaOS', path: 'folder/a b.md', ref: 'main' } });
    assert.equal(http.calls[1].url.pathname,'/repos/Agent/xiaobaOS/contents/folder/a%20b.md');
    assert.equal((file.data as any).content.length,32000); assert.equal((file.data as any).truncated,true);
    await assert.rejects(connector.invoke({ operation: 'file.get', args: { owner: 'Agent', repo: 'xiaobaOS', path: '../secret' } }), /Invalid/);
    await assert.rejects(connector.invoke({ operation: 'issue.create', args: { owner: 'Agent', repo: 'xiaobaOS', title: 'Issue', token: 'forged' } }), /Invalid/);
  });

  test('Notion pins data-source API semantics and query is classified as a read despite POST', async () => {
    const http = fakeHttp(() => json({ results: [], has_more: true, next_cursor: 'next-cursor' }));
    const connector = new NotionConnector(staticCredentials,http.fetcher);
    const result = await connector.invoke({ operation: 'data_source.query', args: { dataSourceId: pageId, limit: 5, cursor: 'previous' } });
    assert.equal(connector.operations.find(item => item.name === 'data_source.query')!.effect,'read');
    assert.equal(http.calls[0].url.pathname, '/v1/data_sources/' + pageId + '/query');
    assert.equal(http.calls[0].headers.get('notion-version'), '2025-09-03');
    assert.deepEqual(http.calls[0].body,{ page_size: 5, start_cursor: 'previous' }); assert.equal(result.nextPage,'next-cursor');
    await assert.rejects(connector.invoke({ operation: 'page.get', args: { pageId: '../../secret' } }), /Invalid/);
    await assert.rejects(connector.invoke({ operation: 'page.create', args: { parent: { page_id: pageId, data_source_id: pageId }, properties: { title: {} } } }), /Invalid/);
  });

  test('Notion page/block writes preserve Unicode and reject empty updates', async () => {
    const http = fakeHttp(() => json({ id: pageId }));
    const connector = new NotionConnector(staticCredentials,http.fetcher);
    const properties = { title: { title: [{ text: { content: 'Agent 的笔记' } }] } };
    await connector.invoke({ operation: 'page.create', args: { parent: { page_id: pageId }, properties } });
    assert.deepEqual(http.calls[0].body, { parent: { page_id: pageId }, properties });
    await connector.invoke({ operation: 'page.update', args: { pageId, archived: true } });
    assert.equal(http.calls[1].method,'PATCH'); assert.deepEqual(http.calls[1].body,{ archived: true });
    await assert.rejects(connector.invoke({ operation: 'page.update', args: { pageId } }), /required/);
  });

  test('Gmail searches only me, exposes cursors and normalizes text/attachment metadata without raw payloads', async () => {
    const http = fakeHttp(call => call.url.pathname.endsWith('/messages') ? json({ messages: [{ id: 'a1' }], nextPageToken: 'next' }) : json({ id: 'a1', threadId: 'thread1', payload: { headers: [{ name: 'Subject', value: '中文邮件' }], parts: [
      { mimeType: 'text/plain', body: { data: Buffer.from('你好'.repeat(9000)).toString('base64url') } },
      { filename: 'report.pdf', mimeType: 'application/pdf', body: { size: 1024, attachmentId: 'attachment-1' } },
    ] } }));
    const connector = new GmailConnector(staticCredentials,http.fetcher);
    assert.equal((await connector.invoke({ operation: 'messages.list', args: { query: 'is:unread', limit: 5 } })).nextPage,'next');
    assert.equal(http.calls[0].url.pathname,'/gmail/v1/users/me/messages'); assert.equal(http.calls[0].url.searchParams.get('q'),'is:unread');
    const message = (await connector.invoke({ operation: 'message.get', args: { messageId: 'a1' } })).data as any;
    assert.equal(message.headers.subject,'中文邮件'); assert.equal(message.body.length,16000); assert.equal(message.truncated,true);
    assert.equal(message.attachments[0].attachmentId,'attachment-1'); assert.ok(!('payload' in message));
    await assert.rejects(connector.invoke({ operation: 'message.get', args: { messageId: 'a1', userId: 'someone-else' } }), /Invalid/);
  });

  test('Gmail drafts/sends use MIME/base64url, preserve UTF-8 and reject header injection before authentication', async () => {
    const http = fakeHttp(() => json({ id: 'draft1' }));
    const connector = new GmailConnector(staticCredentials,http.fetcher);
    const args = { to: ['friend@example.com'], subject: '你好', body: 'Agent 的邮件\n第二行' };
    await connector.invoke({ operation: 'draft.create', args });
    assert.equal(http.calls[0].url.pathname,'/gmail/v1/users/me/drafts');
    const mime = Buffer.from(http.calls[0].body.message.raw,'base64url').toString();
    assert.ok(mime.includes('To: friend@example.com\r\n'));
    assert.ok(mime.includes(Buffer.from('你好').toString('base64')));
    assert.equal(Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g,''),'base64').toString(),args.body);
    await connector.invoke({ operation: 'message.send', args }); assert.equal(http.calls[1].url.pathname,'/gmail/v1/users/me/messages/send');
    await connector.invoke({ operation: 'draft.send', args: { draftId: 'draft1' } }); assert.deepEqual(http.calls[2].body,{ id: 'draft1' });
    await assert.rejects(connector.invoke({ operation: 'message.send', args: { ...args, subject: 'Hello\r\nBcc: attacker@example.com' } }), /Invalid/);
    await assert.rejects(connector.invoke({ operation: 'message.send', args: { ...args, to: ['a@example.com\r\nBcc: evil@example.com'] } }), /Invalid/);
    assert.equal(http.calls.length,3);
  });

  test('OAuth refresh is single-flight, cached to expiry, and never returned as app data', async () => {
    let now = 1000;
    const http = fakeHttp(() => json({ access_token: 'google-access-private', expires_in: 3600 }));
    const credentials = new EnvironmentCredentials(undefined,environment,http.fetcher,() => now);
    assert.equal(credentials.configured('gmail'),true);
    await Promise.all([credentials.token('gmail'),credentials.token('gmail')]);
    assert.equal(http.calls.length,1);
    const form = new URLSearchParams(http.calls[0].raw);
    assert.equal(http.calls[0].url.origin,'https://oauth2.googleapis.com'); assert.equal(form.get('grant_type'),'refresh_token');
    assert.equal(form.get('refresh_token'),environment.XIAOBA_GMAIL_REFRESH_TOKEN);
    await credentials.token('gmail'); assert.equal(http.calls.length,1);
    now += 3600 * 1000; await credentials.token('gmail'); assert.equal(http.calls.length,2);
    const missing = new EnvironmentCredentials(undefined,{},http.fetcher);
    await assert.rejects(missing.token('gmail'), { code: 'CONNECTOR_AUTH_REQUIRED' }); assert.equal(http.calls.length,2);
  });

  test('transport forbids URL/header escape and redirects, redacts auth echoes, and sanitizes upstream failures', async () => {
    const http = fakeHttp(call => { assert.equal(call.headers.get('authorization'),'Bearer private-token'); return json({ echo: 'private-token', result: 'ok' }); });
    const transport = new ConnectorHttp('https://api.github.com',http.fetcher);
    const response = await transport.request('GET','/user','private-token');
    assert.equal((response.data as any).echo,'[REDACTED]');
    await assert.rejects(transport.request('GET','//evil.example/steal','private-token'), /Invalid/);
    await assert.rejects(transport.request('GET','https://evil.example','private-token'), /Invalid/); assert.equal(http.calls.length,1);
    const failures = fakeHttp(() => json({ error: 'private-token google-client-secret' }, { status: 401 }));
    await assert.rejects(new ConnectorHttp('https://api.github.com',failures.fetcher).request('GET','/user','private-token'), (error: any) => error.code === 'CONNECTOR_AUTH_REQUIRED' && !error.message.includes('private-token'));
  });

  test('response streaming enforces bounds without trusting content-length and abort/timeout remain distinct', async () => {
    const large = fakeHttp(() => new Response('x'.repeat(1024 * 1024 + 1)));
    await assert.rejects(new ConnectorHttp('https://api.github.com',large.fetcher).request('GET','/user','token'), { code: 'CONNECTOR_RESPONSE_TOO_LARGE' });
    const hanging = fakeHttp(call => new Promise((_resolve,reject) => call.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    const transport = new ConnectorHttp('https://api.github.com',hanging.fetcher);
    // Keep a test-only ref'ed timer while the production timeout correctly remains unref'ed.
    const keepAlive = setTimeout(() => {},1000);
    try {
      await assert.rejects(transport.request('GET','/user','token',{ timeoutMs: 20 }), { code: 'CONNECTOR_TIMEOUT', retryable: true });
      const controller = new AbortController(); const request = transport.request('GET','/user','token',{ abortSignal: controller.signal }); controller.abort();
      await assert.rejects(request,{ code: 'CONNECTOR_ABORTED', retryable: false });
      controller.abort(); await assert.rejects(transport.request('GET','/user','token',{ abortSignal: controller.signal }), { code: 'CONNECTOR_ABORTED' });
    } finally { clearTimeout(keepAlive); }
  });

  test('read rate limits can be retried; unknown write outcomes are never marked retryable', async () => {
    const limit = fakeHttp(() => json({},{ status: 429 }));
    const transport = new ConnectorHttp('https://api.github.com',limit.fetcher);
    await assert.rejects(transport.request('GET','/user','token'), { code: 'CONNECTOR_RATE_LIMITED', retryable: true });
    await assert.rejects(transport.request('POST','/issues','token',{ body: {} }), { code: 'CONNECTOR_RATE_LIMITED', retryable: false });
    const broken: ConnectorFetch = async () => { throw new Error('secret in network error'); };
    await assert.rejects(new ConnectorHttp('https://api.github.com',broken).request('POST','/issues','token'), (error: any) => !error.retryable && !error.message.includes('secret'));
  });

  test('all valid main conversations share the Agent account and full operations by default', async () => {
    const http = fakeHttp(() => json({ login: 'Agent' }));
    const service = new AgentConnectorService(root,{ environment, fetcher: http.fetcher });
    const alice = { surface: 'feishu', sessionId: 'user:alice' }, bob = { surface: 'pet', sessionId: 'pet:bob' };
    for (const requester of [alice,bob]) {
      await service.invoke('github',{ operation: 'account.get', args: {} },requester);
      await service.invoke('github',{ operation: 'repos.list', args: {} },requester);
    }
    assert.equal(http.calls[0].headers.get('authorization'),http.calls[2].headers.get('authorization'));
    await assert.rejects(service.invoke('github',{ operation: 'account.get', args: {} },{ ...owner, parentSessionId: 'parent' }), { code: 'CONNECTOR_PERMISSION_DENIED' });
    await assert.rejects(service.invoke('github',{ operation: 'account.get', args: {} },{ sessionId: 'spoofed', surface: 'unknown' }), { code: 'CONNECTOR_PERMISSION_DENIED' });
    service.config.configure('github',false); await assert.rejects(service.invoke('github',{ operation: 'account.get', args: {} },owner), { code: 'CONNECTOR_DISABLED' });
    assert.equal(service.status()[2].owner,'agent'); assert.ok(!JSON.stringify(service.status()).includes('private-token'));
  });

  test('config preserves credentials refs, ignores retired grants and fails closed on malformed state', async () => {
    const http = fakeHttp(() => json({ login: 'Agent' }));
    const service = new AgentConnectorService(root,{ environment, fetcher: http.fetcher });
    const file = path.join(root,'data/connectors/config.json');
    service.config.configure('github',true);
    fs.writeFileSync(file,JSON.stringify({ ...service.config.read(), requesters: [{ app: 'github', surface: 'weixin', sessionKey: 'user:alice', operations: ['account.get'] }] }));
    // Old per-session restrictions do not prevent another conversation or operation.
    await service.invoke('github',{ operation: 'repos.list', args: {} },{ surface: 'feishu', sessionId: 'user:bob' });
    service.config.configure('github',true,{ token: 'CUSTOM_GITHUB_TOKEN' });
    const saved = fs.readFileSync(file,'utf8');
    assert.ok(!saved.includes('requesters')); assert.ok(!saved.includes('github-private-token')); assert.equal(fs.statSync(file).mode & 0o777,0o600);
    assert.deepEqual(new AgentConnectorConfigStore(root).read(),service.config.read());
    assert.throws(() => service.config.configure('github',true,{ token: 'literal-secret-value' }), /Invalid/);
    assert.equal(fs.readFileSync(file,'utf8'),saved);
    fs.writeFileSync(file,'{broken'); assert.throws(() => service.status(),{ code: 'CONNECTOR_CONFIG_INVALID' });
  });

  test('model tools expose all operations to configured main sessions and still reject context spoofing', async () => {
    const http = fakeHttp(() => json({ login: 'Agent' })); const service = new AgentConnectorService(root,{ environment, fetcher: http.fetcher });
    const manager = new ToolManager(root,{},createConnectorTools(service));
    const requester = { surface: 'feishu' as const, sessionId: 'user:anyone' };
    assert.ok(manager.getToolDefinitions(requester).some(tool => tool.name === 'github_read'));
    assert.equal((await manager.executeTool(toolCall('github_read',{ operation: 'account.get', args: {} }),[],requester)).status,'success');
    assert.equal((await manager.executeTool(toolCall('github_read',{ operation: 'repos.list', args: {} }),[],requester)).status,'success');
    const result = await manager.executeTool(toolCall('github_read',{ operation: 'account.get', args: {}, sessionId: owner.sessionId }),[],requester);
    assert.equal(result.error_code,'CONNECTOR_VALIDATION_ERROR'); assert.equal(http.calls.length,2);
    assert.ok(!manager.getToolDefinitions({ ...requester, parentSessionId: 'parent' }).some(tool => tool.name === 'github_read'));
    service.config.configure('github',false);
    assert.ok(!manager.getToolDefinitions(requester).some(tool => tool.name === 'github_read'));
    assert.equal((await manager.executeTool(toolCall('github_read',{ operation: 'account.get', args: {} }),[],requester)).status,'blocked');
  });

  test('confirmed writes bind full nested JSON, preserve case, reject negation, changed keys and stale/internal confirmations', async () => {
    const http = fakeHttp(() => json({ number: 1 })); const service = new AgentConnectorService(root,{ environment, fetcher: http.fetcher });
    const manager = new ToolManager(root,{},createConnectorTools(service));
    const args = { operation: 'issue.create', args: { owner: 'Agent', repo: 'xiaobaOS', title: 'Fix Unicode 中文', body: 'Exact BODY' } };
    const history = [{ role: 'user', content: '帮我创建 issue' },{ role: 'assistant', content: '请确认：\n```json\n' + JSON.stringify(args) + '\n```' },{ role: 'assistant', content: null },{ role: 'user', content: '确认' }];
    assert.equal((await manager.executeTool(toolCall('github_write_confirmed',args),history,owner)).status,'success');
    for (const changed of [{ ...args, args: { ...args.args, body: 'changed' } },{ ...args, args: { ...args.args, owner: 'Attacker' } }]) {
      assert.equal((await manager.executeTool(toolCall('github_write_confirmed',changed),history,owner)).error_code,'TOOL_CONFIRMATION_PAYLOAD_MISMATCH');
    }
    for (const content of ['不要执行','[scheduled_wakeup]\n确认 ' + JSON.stringify(args)]) {
      const denied = await manager.executeTool(toolCall('github_write_confirmed',args),[...history.slice(0,-1),{ role: 'user', content }],owner);
      assert.equal(denied.status,'blocked');
    }
    const stale = [...history.slice(0,-1),{ role: 'user', content: '换个话题' },{ role: 'assistant', content: '你好' },{ role: 'user', content: '确认' }];
    assert.equal((await manager.executeTool(toolCall('github_write_confirmed',args),stale,owner)).error_code,'TOOL_CONFIRMATION_PAYLOAD_MISMATCH');
    assert.equal(http.calls.length,1);
  });

  test('local CLI configuration and verification use the same service, without secret-valued arguments', async () => {
    const http = fakeHttp(() => json({ login: 'Agent' })); const service = new AgentConnectorService(root,{ environment: { CUSTOM_GITHUB_TOKEN: 'custom-private-token' }, fetcher: http.fetcher });
    const outputs: string[] = [], log = console.log; console.log = (...values) => { outputs.push(values.join(' ')); };
    try {
      for (const args of [ ['configure','github','--token-env','CUSTOM_GITHUB_TOKEN'], ['verify','github'] ]) {
        const program = new Command(); registerConnectorCommand(program,{ service }); await program.parseAsync(['node','xiaoba','connector',...args]);
      }
    } finally { console.log = log; }
    assert.ok(!outputs.join('').includes('custom-private-token')); assert.ok(outputs.some(output => output.includes('Agent')));
    assert.ok(!Object.keys(service.config.read()).includes('requesters')); assert.equal(http.calls.length,1);
  });

  test('actual AgentSession reads the Agent account, presents a delivered proposal and performs exactly the confirmed write', async () => {
    const previousCwd = process.cwd(); process.chdir(root);
    const http = fakeHttp(call => call.method === 'GET' ? json({ login: 'Agent' }) : json({ number: 1, html_url: 'https://github.com/Agent/xiaobaOS/issues/1' }));
    const service = new AgentConnectorService(root,{ environment, fetcher: http.fetcher });
    const write = { operation: 'issue.create', args: { owner: 'Agent', repo: 'xiaobaOS', title: 'Fix 中文', body: 'Keep Case' } };
    const steps = [
      { content: null, toolCalls: [toolCall('github_read',{ operation: 'account.get', args: {} })] },
      { content: null, toolCalls: [toolCall('send_text',{ text: '请确认这项操作：\n' + JSON.stringify(write) })] },
      { content: '' },
      { content: null, toolCalls: [toolCall('github_write_confirmed',write)] },
      { content: null, toolCalls: [toolCall('send_text',{ text: '已创建 issue #1' })] },
      { content: '' },
    ];
    let calls = 0;
    const aiService = { async chatStream(messages: any[], tools: any[]) {
      assert.ok(!JSON.stringify(messages).includes(environment.XIAOBA_GITHUB_TOKEN));
      if (calls === 3) assert.ok(tools.some(tool => tool.name === 'github_write_confirmed'));
      return steps[calls++];
    } };
    const session = new AgentSession('user:agent-owner',{ aiService: aiService as any, toolManager: new ToolManager(root,{},createConnectorTools(service)),
      skillManager: { loadSkills: async () => {}, getAllSkills: () => [], getUserInvocableSkills: () => [], getSkill: () => undefined, findAutoInvocableSkillByText: () => undefined } as any },'feishu');
    const sent: string[] = [];
    const channel = { chatId: 'agent-owner-chat', reply: async (_id: string,text: string) => { sent.push(text); }, sendFile: async () => {} };
    try {
      await session.handleMessage('查一下你的 GitHub，然后创建这个 issue',{ surface: 'feishu', channel });
      assert.equal(http.calls.length,1); assert.ok(sent[0].includes(JSON.stringify(write)));
      const result = await session.handleMessage('确认',{ surface: 'feishu', channel });
      assert.ok(!result.failed); assert.equal(http.calls.length,2); assert.equal(http.calls[1].method,'POST');
      assert.deepEqual(http.calls[1].body,{ title: 'Fix 中文', body: 'Keep Case' }); assert.ok(sent.includes('已创建 issue #1'));
    } finally { await session.cleanup(); process.chdir(previousCwd); }
  });
  test('one cancelled OAuth waiter does not cancel another; invalid refresh authorization is sanitized', async () => {
    let release!: (response: Response) => void;
    const http = fakeHttp(() => new Promise<Response>(resolve => { release = resolve; }));
    const credentials = new EnvironmentCredentials(undefined,environment,http.fetcher);
    const controller = new AbortController();
    const first = credentials.token('gmail',{ abortSignal: controller.signal });
    const second = credentials.token('gmail');
    controller.abort(); await assert.rejects(first,{ code: 'CONNECTOR_ABORTED' });
    release(json({ access_token: 'access-private', expires_in: 3600 }));
    assert.equal(await second,'access-private'); assert.equal(http.calls.length,1);
    const denied = fakeHttp(() => json({ error: 'invalid_grant', secret: environment.XIAOBA_GMAIL_REFRESH_TOKEN },{ status: 400 }));
    await assert.rejects(new EnvironmentCredentials(undefined,environment,denied.fetcher).token('gmail'),
      (error: any) => error.code === 'CONNECTOR_AUTH_REQUIRED' && !error.message.includes(environment.XIAOBA_GMAIL_REFRESH_TOKEN));
  });

  test('Agent Gmail service refreshes once and never returns auth responses or decoded credential echoes', async () => {
    const http = fakeHttp(call => call.url.origin === 'https://oauth2.googleapis.com'
      ? json({ access_token: 'access-private', expires_in: 3600 })
      : call.url.pathname.endsWith('/profile') ? json({ emailAddress: 'agent@example.com' })
      : json({ id: 'a1', payload: { mimeType: 'text/plain', body: { data: Buffer.from('echo access-private').toString('base64url') } } }));
    const service = new AgentConnectorService(root,{ environment, fetcher: http.fetcher });
    const profile = await service.invoke('gmail',{ operation: 'account.get', args: {} },owner);
    assert.deepEqual(profile.data,{ emailAddress: 'agent@example.com' });
    const message = await service.invoke('gmail',{ operation: 'message.get', args: { messageId: 'a1' } },owner);
    assert.equal((message.data as any).body,'echo [REDACTED]'); assert.equal(http.calls.length,3);
    assert.equal(http.calls[2].headers.get('authorization'),'Bearer access-private');
    const github = new GitHubConnector(staticCredentials,fakeHttp(() => json({ encoding: 'base64', content: Buffer.from('echo private-token').toString('base64') })).fetcher);
    assert.equal(((await github.invoke({ operation: 'file.get', args: { owner: 'Agent', repo: 'test', path: 'a.txt' } })).data as any).content,'echo [REDACTED]');
  });

  test('Notion POST reads and GitHub secondary rate limits remain safe retry candidates', async () => {
    const rate = fakeHttp(() => json({},{ status: 429 }));
    await assert.rejects(new NotionConnector(staticCredentials,rate.fetcher).invoke({ operation: 'search', args: {} }), { code: 'CONNECTOR_RATE_LIMITED', retryable: true });
    const secondary = fakeHttp(() => json({},{ status: 403, headers: { 'retry-after': '30' } }));
    await assert.rejects(new GitHubConnector(staticCredentials,secondary.fetcher).invoke({ operation: 'account.get', args: {} }), { code: 'CONNECTOR_RATE_LIMITED', retryable: true });
    await assert.rejects(new GitHubConnector(staticCredentials,secondary.fetcher).invoke({ operation: 'issue.create', args: { owner: 'Agent', repo: 'test', title: 'Retry?' } }), { code: 'CONNECTOR_RATE_LIMITED', retryable: false });
  });

  test('hidden channel text and failed send_text never authorize writes; operation catalog stays bounded', async () => {
    const http = fakeHttp(() => json({ number: 1 })); const service = new AgentConnectorService(root,{ environment, fetcher: http.fetcher });
    const tools = createConnectorTools(service), manager = new ToolManager(root,{},tools);
    const args = { operation: 'issue.create', args: { owner: 'Agent', repo: 'test', title: 'Confirmed?' } };
    const requester = { surface: 'feishu' as const, sessionId: 'user:owner' };
    const hidden = [{ role: 'user', content: 'create issue' },{ role: 'assistant', content: JSON.stringify(args) },{ role: 'user', content: '确认' }];
    assert.equal((await manager.executeTool(toolCall('github_write_confirmed',args),hidden,requester)).status,'blocked');
    const failed = [{ role: 'user', content: 'create issue' },{ role: 'assistant', content: null, tool_calls: [toolCall('send_text',{ text: JSON.stringify(args) })] },
      { role: 'tool', name: 'send_text', tool_call_id: 'test-call', content: '发送失败' },{ role: 'user', content: '确认' }];
    assert.equal((await manager.executeTool(toolCall('github_write_confirmed',args),failed,requester)).status,'blocked'); assert.equal(http.calls.length,0);
    const newest = { ...args, args: { ...args.args, title: 'Latest proposal' } };
    const delivered = [{ role: 'user', content: 'create issue' },{ role: 'assistant', content: null, tool_calls: [
      { ...toolCall('send_text',{ text: JSON.stringify(args) }), id: 'older' },{ ...toolCall('send_text',{ text: JSON.stringify(newest) }), id: 'newer' }] },
      { role: 'tool', name: 'send_text', tool_call_id: 'older', content: '已发送' },{ role: 'tool', name: 'send_text', tool_call_id: 'newer', content: '已发送' },{ role: 'user', content: '确认' }];
    assert.equal((await manager.executeTool(toolCall('github_write_confirmed',args),delivered,requester)).status,'blocked');
    assert.equal((await manager.executeTool(toolCall('github_write_confirmed',newest),delivered,requester)).status,'success'); assert.equal(http.calls.length,1);

    const catalog = tools.find(tool => tool.definition.name === 'connector_describe')!;
    const summary = await catalog.execute({ app: 'github' },{} as any);
    assert.ok(!JSON.stringify(summary).includes('schema'));
    const detail = await catalog.execute({ app: 'github', operation: 'issue.create' },{} as any);
    assert.ok(JSON.stringify(detail).includes('schema'));
  });

});
