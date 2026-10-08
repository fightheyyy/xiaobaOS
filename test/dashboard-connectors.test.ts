import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { request as nodeRequest, Server } from 'node:http';
import express from 'express';
import { createHash } from 'node:crypto';
import { AgentConnectorService, ConnectorFetch } from '../src/connectors';
import { createApiRouter } from '../src/dashboard/routes/api';
import { MessageSessionManager } from '../src/core/message-session-manager';
import { ServiceManager } from '../src/dashboard/service-manager';
import { GmailDashboardOAuth } from '../src/dashboard/connector-oauth';

const fixture = { XIAOBA_GITHUB_TOKEN: 'environment-github-private', XIAOBA_GMAIL_CLIENT_ID: 'client-id', XIAOBA_GMAIL_CLIENT_SECRET: 'client-secret' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const owner = { surface: 'cli', sessionId: 'local-owner' };

describe('Dashboard Agent connector management', () => {
  let root: string, server: Server, base: string, service: AgentConnectorService, now: number;
  let calls: { url: URL; headers: Headers; form?: URLSearchParams }[];
  let reply: (url: URL) => Response | Promise<Response>;
  let fetcher: ConnectorFetch;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dashboard-connectors-')); calls = []; now = Date.now();
    reply = url => url.origin === 'https://oauth2.googleapis.com' ? json({ refresh_token: 'saved-google-refresh-private', access_token: 'google-access-private', expires_in: 3600 })
      : url.origin === 'https://gmail.googleapis.com' ? json({ emailAddress: 'agent@example.com' }) : json({ login: 'Agent', id: 1 });
    fetcher = async (input, init) => {
      const url = new URL(String(input)), headers = new Headers(init?.headers);
      calls.push({ url, headers, ...(typeof init?.body === 'string' && headers.get('content-type') === 'application/x-www-form-urlencoded' ? { form: new URLSearchParams(init.body) } : {}) });
      return reply(url);
    };
    service = new AgentConnectorService(root, { environment: fixture, fetcher, now: () => now });
    const app = express(); app.use(express.json());
    app.use('/api', createApiRouter(new ServiceManager(root), { connectors: { service, environment: fixture, fetcher, now: () => now } }));
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object'); base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { await MessageSessionManager.getManager('pet')?.destroy(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); fs.rmSync(root, { recursive: true, force: true }); });
  const admin = (data: unknown, extra: Record<string, string> = {}) => ({ headers: { 'Content-Type': 'application/json', 'X-Xiaoba-Connector-Admin': '1', ...extra }, body: JSON.stringify(data) });
  const request = (url: string, method: string, data: unknown = {}) => fetch(base + '/api/connectors' + url, { method, ...admin(data, { Origin: base }) });
  const rawRequest = (route: string, method: string, headers: Record<string, string>, data = '{}'): Promise<number> => new Promise((resolve, reject) => {
    const req = nodeRequest(base + '/api/connectors' + route, { method, headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    req.on('error', reject); req.end(method === 'GET' ? undefined : data);
  });

  test('page navigation, metadata and account verification use the shared service without exposing secrets', async () => {
    assert.equal((await fetch(base + '/api/navigation/open?page=connectors')).status, 200);
    const response = await fetch(base + '/api/connectors'); assert.equal(response.headers.get('cache-control'), 'no-store');
    const metadata = await response.json() as any;
    assert.equal(metadata.connections.length, 3); assert.equal(metadata.gmailClientConfigured, true);
    assert.ok(!JSON.stringify(metadata).includes('environment-github-private'));
    const verification = await request('/github/verify', 'POST'); assert.equal(verification.status, 200);
    assert.equal((await verification.json() as any).account.login, 'Agent'); assert.equal(calls[0].headers.get('authorization'), 'Bearer environment-github-private');
  });

  test('saving write-only tokens changes existing and restarted runtimes; config stays reference-only', async () => {
    const saved = await request('/github/credentials', 'PUT', { token: 'dashboard-github-private' }); assert.deepEqual(await saved.json(), { ok: true });
    assert.equal((await request('/gmail/credentials', 'PUT', {})).status, 400);
    assert.equal((await request('/gmail/credentials', 'PUT', { refreshToken: 'manual-refresh-private' })).status, 200);
    assert.equal(service.status().find(item => item.app === 'gmail')?.configured, true);
    await service.invoke('github', { operation: 'account.get', args: {} }, owner);
    const restarted = new AgentConnectorService(root, { environment: fixture, fetcher });
    await restarted.invoke('github', { operation: 'account.get', args: {} }, owner);
    assert.equal(calls[0].headers.get('authorization'), 'Bearer dashboard-github-private'); assert.equal(calls[1].headers.get('authorization'), 'Bearer dashboard-github-private');
    const metadata = await fetch(base + '/api/connectors'); assert.ok(!(await metadata.text()).includes('dashboard-github-private'));
    const config = fs.readFileSync(path.join(root, 'data/connectors/config.json'), 'utf8'); assert.ok(!config.includes('dashboard-github-private'));
    assert.equal(fs.statSync(path.join(root, 'data/connectors/credentials.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(root, 'data/connectors')).mode & 0o777, 0o700);
    const invalid = await request('/github/credentials', 'PUT', { token: 'new-token', extra: 'secret' }); assert.equal(invalid.status, 400);
    assert.equal((await request('/github/credentials', 'PUT', { token: 'line\nbreak' })).status, 400);
    assert.equal(service.credentialStore.get('github')?.token, 'dashboard-github-private');
  });

  test('loopback Host, same-origin and explicit mutation header reject browser CSRF and DNS rebinding', async () => {
    for (const headers of [{ 'Content-Type': 'application/json' }, { ...admin({}).headers, Origin: 'https://attacker.example' }, { ...admin({}).headers, Origin: 'null' }, { ...admin({}).headers, Referer: 'https://attacker.example/path' }]) {
      const response = await fetch(base + '/api/connectors/github/credentials', { method: 'PUT', headers, body: JSON.stringify({ token: 'attacker-token' }) }); assert.equal(response.status, 403, JSON.stringify(headers));
    }
    assert.equal(await rawRequest('/github/credentials', 'PUT', { ...admin({}).headers, Host: 'attacker.example' }, JSON.stringify({ token: 'attacker-token' })), 403);
    assert.equal(await rawRequest('', 'GET', { Host: 'attacker.example' }), 403);
    assert.equal(service.credentialStore.get('github'), undefined); assert.equal(calls.length, 0);
    // X-Forwarded-* cannot promote a non-local host to owner.
    assert.equal(await rawRequest('', 'GET', { Host: 'attacker.example', 'X-Forwarded-Host': new URL(base).host }), 403);
  });

  test('connection defaults expose all operations across sessions and retired access API is absent', async () => {
    await request('/github/credentials', 'PUT', { token: 'dashboard-private' });
    for (const requester of [{ surface: 'feishu', sessionId: 'user:alice' },{ surface: 'weixin', sessionId: 'user:bob' }]) {
      await service.invoke('github', { operation: 'account.get', args: {} }, requester);
      await service.invoke('github', { operation: 'repos.list', args: {} }, requester);
      await service.invoke('github', { operation: 'issue.create', args: { owner: 'Agent', repo: 'test', title: 'Allowed operation' } }, requester);
    }
    assert.equal((await request('/github/access', 'PUT', { surface: 'feishu', sessionKey: 'user:alice', operations: [] })).status, 404);
    const metadata = await (await fetch(base + '/api/connectors')).json() as any;
    assert.ok(!('requesters' in metadata)); assert.ok(!('catalog' in metadata));
    await request('/github', 'PUT', { enabled: false }); await assert.rejects(service.invoke('github', { operation: 'account.get', args: {} }, owner), { code: 'CONNECTOR_DISABLED' });
    await request('/github', 'PUT', { enabled: true }); await request('/github/credentials', 'DELETE');
    assert.equal(service.credentialStore.get('github'), undefined); assert.equal(service.status().find(item => item.app === 'github')?.enabled, false);
    await assert.rejects(service.invoke('github', { operation: 'account.get', args: {} }, owner), { code: 'CONNECTOR_DISABLED' });
  });

  test('Google authorization uses state, PKCE and every supported Gmail capability by default; callback persists only offline credentials', async () => {
    assert.equal((await request('/gmail/oauth/start', 'POST', { modes: ['read'] })).status, 400);
    const response = await request('/gmail/oauth/start', 'POST', {}); assert.equal(response.status, 200);
    const auth = new URL((await response.json() as any).url);
    assert.equal(auth.origin, 'https://accounts.google.com'); assert.equal(auth.searchParams.get('access_type'), 'offline');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256'); assert.ok(!auth.toString().includes('client-secret'));
    assert.equal(auth.searchParams.get('scope'),'https://www.googleapis.com/auth/gmail.modify');
    const state = auth.searchParams.get('state');
    const callback = await fetch(base + `/api/connectors/gmail/oauth/callback?state=${state}&code=one-time-private-code`, { redirect: 'manual', headers: { Referer: 'https://accounts.google.com/' } });
    assert.equal(callback.status, 302); assert.equal(callback.headers.get('location'), '/?page=connectors&gmail=connected');
    const exchange = calls[0].form!;
    assert.equal(exchange.get('code'), 'one-time-private-code'); assert.equal(exchange.get('redirect_uri'), auth.searchParams.get('redirect_uri'));
    assert.equal(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url'), auth.searchParams.get('code_challenge'));
    const saved = fs.readFileSync(path.join(root, 'data/connectors/credentials.json'), 'utf8');
    assert.ok(saved.includes('saved-google-refresh-private')); assert.ok(!saved.includes('google-access-private')); assert.ok(!saved.includes('one-time-private-code'));
    await service.invoke('gmail', { operation: 'account.get', args: {} }, owner);
    assert.equal(calls[1].form?.get('grant_type'), 'refresh_token'); assert.equal(calls[2].headers.get('authorization'), 'Bearer google-access-private');
    const repeated = await fetch(base + `/api/connectors/gmail/oauth/callback?state=${state}&code=one-time-private-code`, { redirect: 'manual' });
    assert.ok(repeated.headers.get('location')?.includes('CONNECTOR_VALIDATION_ERROR')); assert.equal(calls.length, 3);
  });

  test('expired, forged, denied and superseded OAuth callbacks never save credentials', async () => {
    const oauth = new GmailDashboardOAuth(service, fixture, fetcher, () => now);
    const start = () => new URL(oauth.start(base).url).searchParams.get('state');
    await assert.rejects(oauth.complete(base, 'forged', 'code', undefined), { code: 'CONNECTOR_VALIDATION_ERROR' });
    let state = start(); now += 11 * 60_000; await assert.rejects(oauth.complete(base, state, 'code', undefined), { code: 'CONNECTOR_VALIDATION_ERROR' });
    state = start(); await assert.rejects(oauth.complete(base, state, 'code', 'access_denied'), { code: 'CONNECTOR_AUTH_REQUIRED' });
    state = start(); await assert.rejects(oauth.complete('http://localhost:9999', state, 'code', undefined), { code: 'CONNECTOR_VALIDATION_ERROR' });
    state = start(); service.credentialStore.set('gmail', { clientId: 'changed-client', clientSecret: 'changed-secret' });
    await assert.rejects(oauth.complete(base, state, 'code', undefined), { code: 'CONNECTOR_VALIDATION_ERROR' });
    assert.equal(calls.length, 0); assert.equal(service.credentialStore.get('gmail')?.refreshToken, undefined);
  });

  test('disconnect during an OAuth exchange cannot reconnect the Agent; provider errors never leak', async () => {
    const oauth = new GmailDashboardOAuth(service, fixture, fetcher);
    const state = new URL(oauth.start(base).url).searchParams.get('state');
    let release!: (value: Response) => void; reply = () => new Promise<Response>(resolve => { release = resolve; });
    const complete = oauth.complete(base, state, 'private-code', undefined);
    oauth.clear(); service.config.configure('gmail', false);
    release(json({ refresh_token: 'new-private-token' }));
    await assert.rejects(complete, { code: 'CONNECTOR_VALIDATION_ERROR' }); assert.equal(service.credentialStore.get('gmail'), undefined);
    assert.equal(service.status().find(item => item.app === 'gmail')?.enabled, false);
    const next = new URL(oauth.start(base).url).searchParams.get('state');
    reply = () => json({ error: 'client-secret private-code' }, 400);
    await assert.rejects(oauth.complete(base, next, 'private-code', undefined), (error: any) => error.code === 'CONNECTOR_AUTH_REQUIRED' && !error.message.includes('client-secret'));
  });

  test('changing Google client invalidates the old refresh token; malformed private state fails closed', async () => {
    service.credentialStore.set('gmail', { clientId: 'client-id', clientSecret: 'client-secret', refreshToken: 'old-refresh' });
    service.credentialStore.set('gmail', { clientId: 'new-client' });
    assert.equal(service.credentialStore.get('gmail')?.refreshToken, undefined);
    assert.equal(service.status().find(item => item.app === 'gmail')?.configured, false);
    fs.writeFileSync(path.join(root, 'data/connectors/credentials.json'), '{broken');
    assert.equal((await fetch(base + '/api/connectors')).status, 409);
    assert.equal(service.available('github', 'read', owner), false); assert.equal(calls.length, 0);
  });
});
