import { ConnectorActionReceipts } from './action-receipts';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import Ajv from 'ajv';
import { APPS, AppId, AppConnector, AppRequest, AppResult, AppCallOptions, ConnectorError, appId, validateRequest } from './app-connector';
import { DEFAULT_CREDENTIAL_REFS, AgentCredentials, CredentialRefs } from './credentials';
import { ConnectorFetch } from './http';
import { GitHubConnector } from './github';
import { NotionConnector } from './notion';
import { GmailConnector } from './gmail';
import { ConnectorRegistry } from './connector';
import { AgentCredentialStore, StoredAgentCredentials } from './credential-store';

export interface ConnectorRequester { sessionId?: string; surface?: string; parentSessionId?: string }
interface ConnectionConfig { enabled: boolean; credentialRefs?: CredentialRefs }
export interface AgentConnectorConfig { version: 1; connections: Partial<Record<AppId, ConnectionConfig>> }
const configSchema = { type: 'object', required: ['version','connections'], additionalProperties: false, properties: {
  version: { const: 1 }, connections: { type: 'object', additionalProperties: false, properties: Object.fromEntries(APPS.map(app => [app, {
    type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' }, credentialRefs: {
      type: 'object', required: Object.keys(DEFAULT_CREDENTIAL_REFS[app]), additionalProperties: false,
      properties: Object.fromEntries(Object.keys(DEFAULT_CREDENTIAL_REFS[app]).map(key => [key,{ type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,99}$' }])),
    } },
  }])) },
  // Accept legacy config for migration; requester grants are discarded by read().
  requesters: { type: 'array', maxItems: 1000, items: { type: 'object', required: ['surface','sessionKey','app','operations'], additionalProperties: false,
    properties: { surface: { enum: ['cli','feishu','weixin','pet'] }, sessionKey: { type: 'string', minLength: 1, maxLength: 500 }, app: { enum: APPS },
      operations: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 100 } } } } },
} };
const validateConfig = new Ajv({ strict: false }).compile<AgentConnectorConfig>(configSchema);
/** One Agent configuration per workspace. Connections are never stored under a session. */
export class AgentConnectorConfigStore {
  private readonly file: string;
  constructor(root: string) { this.file = path.join(root, 'data/connectors/config.json'); }
  read(): AgentConnectorConfig {
    if (!fs.existsSync(this.file)) return { version: 1, connections: {} };
    try { const config = JSON.parse(fs.readFileSync(this.file,'utf8')); if (!validateConfig(config)) throw new Error(); return { version: 1, connections: config.connections }; }
    catch { throw new ConnectorError('CONNECTOR_CONFIG_INVALID', 'Invalid Agent connector configuration.'); }
  }
  configure(app: AppId, enabled: boolean, credentialRefs?: CredentialRefs): void {
    this.change(config => { config.connections[app] = { enabled, ...(credentialRefs ? { credentialRefs } : config.connections[app]?.credentialRefs ? { credentialRefs: config.connections[app]!.credentialRefs } : {}) }; });
  }
  private change(update: (config: AgentConnectorConfig) => void): void {
    const directory = path.dirname(this.file), lock = this.file + '.lock';
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { throw new ConnectorError('CONNECTOR_CONFIG_INVALID', 'Connector config is busy or interrupted. Inspect before retry.'); }
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { const config = this.read(); update(config); if (!validateConfig(config)) throw new ConnectorError('CONNECTOR_CONFIG_INVALID','Invalid connector config change.');
      fs.writeFileSync(temporary, JSON.stringify(config,null,2) + '\n', { mode: 0o600 }); fs.renameSync(temporary, this.file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); fs.rmdirSync(lock); }
  }
}
export class AgentConnectorService {
  readonly config: AgentConnectorConfigStore;
  readonly credentialStore: AgentCredentialStore;
  readonly actionReceipts: ConnectorActionReceipts;
  private readonly connectors = new ConnectorRegistry<AppConnector>();
  constructor(root: string, options: { credentials?: AgentCredentials; environment?: NodeJS.ProcessEnv; fetcher?: ConnectorFetch; now?: () => number } = {}) {
    this.config = new AgentConnectorConfigStore(root);
    this.actionReceipts = new ConnectorActionReceipts(root);
    this.credentialStore = new AgentCredentialStore(root);
    const credentials = options.credentials || new StoredAgentCredentials(this.credentialStore, app => this.config.read().connections[app]?.credentialRefs || DEFAULT_CREDENTIAL_REFS[app], options.environment, options.fetcher, options.now);
    this.connectors.register(new GmailConnector(credentials, options.fetcher));
    this.connectors.register(new NotionConnector(credentials, options.fetcher));
    this.connectors.register(new GitHubConnector(credentials, options.fetcher));
  }
  /** Public app schemas, no account metadata or credential status for arbitrary chat participants. */
  describe(app?: AppId) { return [...this.connectors.values()].filter(item => !app || item.app === app).map(item => ({ app: item.app, capabilities: item.capabilities, operations: item.operations })); }
  status() {
    const config = this.config.read();
    return [...this.connectors.values()].map(item => ({ app: item.app, owner: 'agent' as const, enabled: config.connections[item.app]?.enabled !== false, configured: item.configured(), operations: item.operations.length }));
  }
  available(app: AppId, effect: 'read' | 'write', requester: ConnectorRequester): boolean {
    try { return this.connector(app).configured() && this.config.read().connections[app]?.enabled !== false
      && this.connector(app).operations.some(operation => operation.effect === effect && this.authorized(requester)); } catch { return false; }
  }
  async invoke(app: AppId, request: AppRequest, requester: ConnectorRequester, options: AppCallOptions = {}): Promise<AppResult> {
    const connector = this.connector(appId(app));
    const operation = validateRequest(connector.operations, request);
    if (!this.authorized(requester)) throw new ConnectorError('CONNECTOR_PERMISSION_DENIED', 'This requester cannot use that Agent app operation.');
    if (this.config.read().connections[app]?.enabled === false) throw new ConnectorError('CONNECTOR_DISABLED','Agent connection is disabled.');
    if (options.abortSignal?.aborted) throw new ConnectorError('CONNECTOR_ABORTED','App call cancelled.');
    return operation.effect === 'write'
      ? this.actionReceipts.execute(app,request,requester,options.actionId,() => connector.invoke(request,options))
      : connector.invoke(request, options);
  }
  private connector(app: AppId): AppConnector { const connector = this.connectors.get(app); if (!connector) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR','Unsupported app.'); return connector; }
  private authorized(requester: ConnectorRequester): boolean {
    // App resources belong to this Agent, and every valid main conversation can use them.
    // Role/tool visibility and consequential write confirmation remain runtime responsibilities.
    return Boolean(requester.sessionId && !requester.parentSessionId && ['cli','feishu','weixin','pet'].includes(requester.surface || ''));
  }
}
