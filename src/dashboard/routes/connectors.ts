import { Router, Request, Response, NextFunction } from 'express';
import { AgentConnectorService } from '../../connectors/service';
import { appId, ConnectorError } from '../../connectors/app-connector';
import { DEFAULT_CREDENTIAL_REFS } from '../../connectors/credentials';
import { ConnectorFetch } from '../../connectors/http';
import { GmailDashboardOAuth } from '../connector-oauth';

export interface DashboardConnectorOptions {
  service?: AgentConnectorService; environment?: NodeJS.ProcessEnv; fetcher?: ConnectorFetch; now?: () => number;
}
const isLoopback = (host: string) => host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1';
function localOrigin(req: Request): string {
  // Never use X-Forwarded-Host/Proto or trust a reverse proxy for local owner authority.
  if (!isLoopback(req.socket.remoteAddress || '')) throw new ConnectorError('CONNECTOR_PERMISSION_DENIED', 'Connector management requires local Dashboard access.');
  let url: URL;
  try { url = new URL('http://' + req.get('host')); } catch { throw new ConnectorError('CONNECTOR_PERMISSION_DENIED', 'Invalid Dashboard host.'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ConnectorError('CONNECTOR_PERMISSION_DENIED', 'Connector management requires a loopback Dashboard host.');
  }
  const port = req.socket.localPort;
  if (Number(url.port || 80) !== port) throw new ConnectorError('CONNECTOR_PERMISSION_DENIED', 'Dashboard host does not match this server.');
  return url.origin;
}
function managementBoundary(req: Request, res: Response, next: NextFunction): void {
  res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer');
  try {
    const origin = localOrigin(req);
    // Google callback is cross-site navigation, authorized by its single-use state.
    for (const header of req.path === '/gmail/oauth/callback' && req.method === 'GET' ? [] : ['origin', 'referer']) {
      const value = req.get(header);
      if (value && new URL(value).origin !== origin) throw new ConnectorError('CONNECTOR_PERMISSION_DENIED', 'Use the local Dashboard to manage connections.');
    }
    if (!['GET', 'HEAD'].includes(req.method) && (req.get('X-Xiaoba-Connector-Admin') !== '1' || !req.is('application/json'))) {
      throw new ConnectorError('CONNECTOR_PERMISSION_DENIED', 'Connector management request did not come from the Dashboard.');
    }
    next();
  } catch { res.status(403).json({ error: 'Connector management requires local, same-origin Dashboard access.', code: 'CONNECTOR_PERMISSION_DENIED' }); }
}
function body(req: Request, keys: string[]): Record<string, any> {
  const value = req.body;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) {
    throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Invalid connector management request.');
  }
  return value;
}
function failure(res: Response, error: unknown): void {
  if (error instanceof ConnectorError) res.status(error.code === 'CONNECTOR_PERMISSION_DENIED' ? 403 : error.code === 'CONNECTOR_CONFIG_INVALID' ? 409 : 400).json({ error: error.message, code: error.code });
  else res.status(500).json({ error: 'Connector management failed.', code: 'CONNECTOR_API_ERROR' });
}

export function createDashboardConnectorRouter(root: string, options: DashboardConnectorOptions = {}): Router {
  const router = Router(), service = options.service || new AgentConnectorService(root, options);
  const oauth = new GmailDashboardOAuth(service, options.environment, options.fetcher, options.now);
  router.use(managementBoundary);
  router.get('/', (_req, res) => {
    try { res.json({ connections: service.status(), gmailClientConfigured: oauth.clientConfigured() }); } catch (error) { failure(res, error); }
  });
  router.put('/:app/credentials', (req, res) => {
    try {
      const app = appId(req.params.app), fields = body(req, app === 'gmail' ? ['clientId', 'clientSecret', 'refreshToken'] : ['token']);
      if (!Object.keys(fields).length) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Enter app credentials first.');
      let credentials = fields;
      if (app === 'gmail' && !service.credentialStore.get(app)) {
        const refs = service.config.read().connections.gmail?.credentialRefs || DEFAULT_CREDENTIAL_REFS.gmail, environment = options.environment || process.env;
        const client = Object.fromEntries(['clientId', 'clientSecret'].filter(key => environment[refs[key]]?.trim()).map(key => [key, environment[refs[key]]!.trim()]));
        credentials = { ...client, ...fields };
      }
      service.credentialStore.set(app, credentials); if (app === 'gmail') oauth.clear(); service.config.configure(app, true);
      res.json({ ok: true });
    } catch (error) { failure(res, error); }
  });
  router.put('/:app', (req, res) => {
    try {
      const app = appId(req.params.app), { enabled } = body(req, ['enabled']);
      if (typeof enabled !== 'boolean') throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'enabled must be a boolean.');
      service.config.configure(app, enabled); if (app === 'gmail' && !enabled) oauth.clear(); res.json({ ok: true });
    } catch (error) { failure(res, error); }
  });
  router.delete('/:app/credentials', (req, res) => {
    try { body(req, []); const app = appId(req.params.app); service.config.configure(app, false); service.credentialStore.remove(app); if (app === 'gmail') oauth.clear(); res.json({ ok: true }); }
    catch (error) { failure(res, error); }
  });
  router.post('/:app/verify', async (req, res) => {
    try {
      body(req, []); const app = appId(req.params.app), controller = new AbortController();
      const cancel = () => { if (!res.writableEnded) controller.abort(); }; res.on('close', cancel);
      try { const result = await service.invoke(app, { operation: 'account.get', args: {} }, { surface: 'cli', sessionId: 'local-dashboard-management' }, { abortSignal: controller.signal }); res.json({ ok: true, account: result.data }); }
      finally { res.off('close', cancel); }
    } catch (error) { failure(res, error); }
  });
  router.post('/gmail/oauth/start', (req, res) => {
    try { body(req, []); res.json(oauth.start(localOrigin(req))); } catch (error) { failure(res, error); }
  });
  router.get('/gmail/oauth/callback', async (req, res) => {
    try { await oauth.complete(localOrigin(req), req.query.state, req.query.code, req.query.error); res.redirect('/?page=connectors&gmail=connected'); }
    catch (error) {
      // Redirect only a stable error code, never provider error text or the authorization code.
      const code = error instanceof ConnectorError ? error.code : 'CONNECTOR_API_ERROR';
      res.redirect('/?page=connectors&gmail=' + encodeURIComponent(code));
    }
  });
  router.use((_req, res) => { res.status(404).json({ error: 'Unknown connector management endpoint.' }); });
  return router;
}
