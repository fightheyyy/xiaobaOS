import { AppCallOptions, AppId, ConnectorError } from './app-connector';
import { ConnectorFetch, ConnectorHttp } from './http';
import { createHash } from 'crypto';

export type CredentialRefs = Record<string,string>;
export const DEFAULT_CREDENTIAL_REFS: Record<AppId, CredentialRefs> = {
  github: { token: 'XIAOBA_GITHUB_TOKEN' }, notion: { token: 'XIAOBA_NOTION_TOKEN' },
  gmail: { clientId: 'XIAOBA_GMAIL_CLIENT_ID', clientSecret: 'XIAOBA_GMAIL_CLIENT_SECRET', refreshToken: 'XIAOBA_GMAIL_REFRESH_TOKEN' },
};
/** Credentials belong to the Agent. Neither sessions nor model arguments select a credential. */
export interface AgentCredentials {
  configured(app: AppId): boolean;
  token(app: AppId, options?: AppCallOptions): Promise<string>;
}
export class EnvironmentCredentials implements AgentCredentials {
  private gmailCache?: { key: string; token: string; expires: number };
  private refreshing?: { key: string; promise: Promise<string> };
  constructor(private readonly refs: (app: AppId) => CredentialRefs = app => DEFAULT_CREDENTIAL_REFS[app],
    private readonly environment: NodeJS.ProcessEnv = process.env, private readonly fetcher: ConnectorFetch = fetch,
    private readonly now: () => number = Date.now) {}
  configured(app: AppId): boolean {
    const refs = this.refs(app);
    return Object.keys(DEFAULT_CREDENTIAL_REFS[app]).every(key => typeof refs[key] === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(refs[key]) && Boolean(this.environment[refs[key]]?.trim()));
  }
  async token(app: AppId, options: AppCallOptions = {}): Promise<string> {
    if (options.abortSignal?.aborted) throw new ConnectorError('CONNECTOR_ABORTED', 'App call cancelled.');
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Invalid timeout.');
    const values = Object.fromEntries(Object.entries(this.refs(app)).map(([key,name]) => [key,this.environment[name]?.trim()]));
    if (!this.configured(app)) throw new ConnectorError('CONNECTOR_AUTH_REQUIRED', `Configure the Agent's ${app} credentials.`);
    if (app !== 'gmail') return values.token!;
    const key = createHash('sha256').update(JSON.stringify(values)).digest('hex');
    if (this.gmailCache?.key === key && this.gmailCache.expires > this.now() + 60_000) return this.gmailCache.token;
    let promise = this.refreshing?.key === key ? this.refreshing.promise : undefined;
    if (!promise) {
      // Shared refresh has its own bound; one cancelled caller must not cancel other waiters.
      promise = this.refreshGmail(values as Record<string,string>, key);
      this.refreshing = { key, promise };
      const current = promise;
      void current.finally(() => { if (this.refreshing?.promise === current) this.refreshing = undefined; }).catch(() => {});
    }
    return waitForToken(promise, options);
  }
  private async refreshGmail(values: Record<string,string>, key: string): Promise<string> {
    let result;
    try {
      result = await new ConnectorHttp('https://oauth2.googleapis.com', this.fetcher).request('POST', '/token', '', {
        readOnly: true, form: new URLSearchParams({ client_id: values.clientId, client_secret: values.clientSecret, refresh_token: values.refreshToken, grant_type: 'refresh_token' }),
      });
    } catch (error) {
      if (error instanceof ConnectorError && [400,401,403].includes(error.httpStatus || 0)) throw new ConnectorError('CONNECTOR_AUTH_REQUIRED','Google authorization could not be refreshed. Reauthorize the Agent account.');
      throw error;
    }
    const data = result.data as Record<string,unknown> | null;
    if (!data || typeof data.access_token !== 'string' || !data.access_token || typeof data.expires_in !== 'number' || data.expires_in <= 0) {
      throw new ConnectorError('CONNECTOR_AUTH_REQUIRED', 'Google authorization could not be refreshed. Reauthorize the Agent account.');
    }
    this.gmailCache = { key, token: data.access_token, expires: this.now() + data.expires_in * 1000 };
    return data.access_token;
  }
}
function waitForToken(promise: Promise<string>, options: AppCallOptions): Promise<string> {
  return new Promise((resolve,reject) => {
    let settled = false;
    const finish = (error?: ConnectorError, value?: string) => {
      if (settled) return; settled = true;
      clearTimeout(timer); options.abortSignal?.removeEventListener('abort',abort);
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(new ConnectorError('CONNECTOR_ABORTED','App call cancelled.'));
    const timer = setTimeout(() => finish(new ConnectorError('CONNECTOR_TIMEOUT','Authorization refresh timed out.',true)), options.timeoutMs ?? 15_000); timer.unref();
    options.abortSignal?.addEventListener('abort',abort,{ once: true });
    if (options.abortSignal?.aborted) abort();
    void promise.then(value => finish(undefined,value),error => finish(error));
  });
}
