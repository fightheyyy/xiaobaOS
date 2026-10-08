import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import Ajv from 'ajv';
import { AppId, APPS, AppCallOptions, ConnectorError } from './app-connector';
import { AgentCredentials, CredentialRefs, DEFAULT_CREDENTIAL_REFS, EnvironmentCredentials } from './credentials';
import { ConnectorFetch } from './http';

type AppSecrets = Record<string, string>;
interface CredentialFile { version: 1; apps: Partial<Record<AppId, AppSecrets>> }
const fields = (app: AppId) => Object.keys(DEFAULT_CREDENTIAL_REFS[app]);
const schema = { type: 'object', required: ['version', 'apps'], additionalProperties: false, properties: {
  version: { const: 1 }, apps: { type: 'object', additionalProperties: false, properties: Object.fromEntries(APPS.map(app => [app, {
    type: 'object', minProperties: 1, additionalProperties: false,
    properties: Object.fromEntries(fields(app).map(key => [key, { type: 'string', minLength: 1, maxLength: 16000, pattern: '^[^\\s]+$' }])),
    ...(app === 'gmail' ? {} : { required: ['token'] }),
  }])) },
} };
const validate = new Ajv({ strict: false }).compile<CredentialFile>(schema);

/** Agent-owned write-only secrets. Never expose read() through an HTTP/tool interface. */
export class AgentCredentialStore {
  private readonly file: string;
  constructor(root: string) { this.file = path.join(root, 'data/connectors/credentials.json'); }
  get(app: AppId): AppSecrets | undefined { return this.read().apps[app]; }
  set(app: AppId, secrets: AppSecrets): void {
    if (!APPS.includes(app) || !secrets || Array.isArray(secrets) || !Object.keys(secrets).length) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Invalid app credential fields.');
    // Validate the input before merging so unknown keys cannot be silently dropped.
    if (!validate({ version: 1, apps: { [app]: secrets } })) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Invalid app credential fields.');
    this.change(data => {
      const previous = data.apps[app];
      const next = { ...previous, ...secrets };
      if (app === 'gmail' && previous && ['clientId', 'clientSecret'].some(key => secrets[key] && secrets[key] !== previous[key]) && !secrets.refreshToken) delete next.refreshToken;
      data.apps[app] = next;
    });
  }
  remove(app: AppId): void { this.change(data => { delete data.apps[app]; }); }
  private read(): CredentialFile {
    if (!fs.existsSync(this.file)) return { version: 1, apps: {} };
    try {
      if (fs.statSync(this.file).size > 64 * 1024) throw new Error();
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!validate(data)) throw new Error();
      return data;
    } catch { throw new ConnectorError('CONNECTOR_CONFIG_INVALID', 'Invalid Agent credential store.'); }
  }
  private change(update: (data: CredentialFile) => void): void {
    const directory = path.dirname(this.file), lock = this.file + '.lock';
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { throw new ConnectorError('CONNECTOR_CONFIG_INVALID', 'Agent credential store is busy.'); }
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    try {
      const data = this.read(); update(data);
      const serialized = JSON.stringify(data, null, 2) + '\n';
      if (!validate(data) || Buffer.byteLength(serialized) > 64 * 1024) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Invalid app credential fields.');
      fs.writeFileSync(temporary, serialized, { mode: 0o600 }); fs.renameSync(temporary, this.file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); fs.rmdirSync(lock); }
  }
}

/** Existing environment authorization remains the fallback when no local record exists. */
export class StoredAgentCredentials implements AgentCredentials {
  private readonly localEnv: NodeJS.ProcessEnv = {};
  private readonly local: EnvironmentCredentials;
  private readonly external: EnvironmentCredentials;
  constructor(private readonly store: AgentCredentialStore, refs: (app: AppId) => CredentialRefs,
    environment?: NodeJS.ProcessEnv, fetcher?: ConnectorFetch, now?: () => number) {
    this.local = new EnvironmentCredentials(undefined, this.localEnv, fetcher, now);
    this.external = new EnvironmentCredentials(refs, environment, fetcher, now);
  }
  configured(app: AppId): boolean { return this.source(app).configured(app); }
  token(app: AppId, options?: AppCallOptions): Promise<string> { return this.source(app).token(app, options); }
  private source(app: AppId): AgentCredentials {
    const saved = this.store.get(app);
    if (!saved) return this.external;
    for (const [key, name] of Object.entries(DEFAULT_CREDENTIAL_REFS[app])) {
      if (saved[key]) this.localEnv[name] = saved[key]; else delete this.localEnv[name];
    }
    return this.local;
  }
}
