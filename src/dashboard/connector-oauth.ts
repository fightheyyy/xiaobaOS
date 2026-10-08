import { createHash, randomBytes } from 'crypto';
import { AgentConnectorService } from '../connectors/service';
import { DEFAULT_CREDENTIAL_REFS } from '../connectors/credentials';
import { ConnectorError } from '../connectors/app-connector';
import { ConnectorFetch, ConnectorHttp } from '../connectors/http';

// gmail.modify covers every implemented operation, including mail read/drafts/send/labels.
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
interface PendingOAuth { redirectUri: string; verifier: string; fingerprint: string; expires: number; generation: number }

/** Authorization is local deployment management, never a chat/session operation. */
export class GmailDashboardOAuth {
  private generation = 0;
  private readonly pending = new Map<string, PendingOAuth>();
  constructor(private readonly service: AgentConnectorService, private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly fetcher: ConnectorFetch = fetch, private readonly now: () => number = Date.now) {}
  clientConfigured(): boolean { try { this.client(); return true; } catch { return false; } }
  start(origin: string): { url: string } {
    const client = this.client();
    for (const [state, data] of this.pending) if (data.expires <= this.now()) this.pending.delete(state);
    if (this.pending.size >= 16) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Too many pending authorizations. Try later.');
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    const redirectUri = origin + '/api/connectors/gmail/oauth/callback';
    this.pending.set(state, { redirectUri, verifier, fingerprint: this.fingerprint(client), generation: this.generation, expires: this.now() + 10 * 60_000 });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: client.clientId, redirect_uri: redirectUri, response_type: 'code',
      access_type: 'offline', prompt: 'consent', scope: GMAIL_SCOPE,
      state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString() };
  }
  async complete(origin: string, state: unknown, code: unknown, providerError: unknown): Promise<void> {
    const data = typeof state === 'string' ? this.pending.get(state) : undefined;
    if (typeof state === 'string') this.pending.delete(state); // single use, including failed/cancelled exchanges
    if (!data || data.expires <= this.now() || data.redirectUri !== origin + '/api/connectors/gmail/oauth/callback') {
      throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Authorization expired or did not match this Dashboard. Start again.');
    }
    if (providerError) throw new ConnectorError('CONNECTOR_AUTH_REQUIRED', 'Google authorization was cancelled or denied.');
    if (typeof code !== 'string' || !code || code.length > 4000) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Missing authorization code.');
    const client = this.client();
    if (this.fingerprint(client) !== data.fingerprint) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'OAuth client changed. Start authorization again.');
    let result;
    try {
      result = await new ConnectorHttp('https://oauth2.googleapis.com', this.fetcher).request('POST', '/token', '', {
        form: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.clientId, client_secret: client.clientSecret,
          code, redirect_uri: data.redirectUri, code_verifier: data.verifier }),
      });
    } catch { throw new ConnectorError('CONNECTOR_AUTH_REQUIRED', 'Google authorization could not be completed. Start again.'); }
    if (data.generation !== this.generation || data.expires <= this.now() || this.fingerprint(this.client()) !== data.fingerprint) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Authorization was superseded. Start again.');
    const token = result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data.refresh_token : undefined;
    if (typeof token !== 'string' || !token) throw new ConnectorError('CONNECTOR_AUTH_REQUIRED', 'Google did not provide offline authorization. Authorize again with consent.');
    this.service.credentialStore.set('gmail', { ...client, refreshToken: token });
    this.service.config.configure('gmail', true);
  }
  clear(): void { this.pending.clear(); this.generation++; }
  private client(): { clientId: string; clientSecret: string } {
    const saved = this.service.credentialStore.get('gmail');
    const refs = this.service.config.read().connections.gmail?.credentialRefs || DEFAULT_CREDENTIAL_REFS.gmail;
    const clientId = saved ? saved.clientId : this.environment[refs.clientId]?.trim();
    const clientSecret = saved ? saved.clientSecret : this.environment[refs.clientSecret]?.trim();
    if (!clientId || !clientSecret) throw new ConnectorError('CONNECTOR_AUTH_REQUIRED', 'Configure the Google OAuth client first.');
    return { clientId, clientSecret };
  }
  private fingerprint(client: { clientId: string; clientSecret: string }): string { return createHash('sha256').update(JSON.stringify(client)).digest('hex'); }
}
