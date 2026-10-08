import { AppConnector, AppRequest, AppResult, AppCallOptions, operation, string, text, limit, uuid, segment, validateRequest, ConnectorError } from './app-connector';
import { AgentCredentials } from './credentials';
import { ConnectorFetch, ConnectorHttp } from './http';

const pagination = { limit, cursor: string(1000) };
const properties = { type: 'object', minProperties: 1, maxProperties: 100 };
const children = { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object' } };
export class NotionConnector implements AppConnector {
  readonly id = 'notion'; readonly app = 'notion' as const;
  readonly capabilities = ['account','search','pages','blocks','databases','data_sources'];
  readonly operations = [
    operation('account.get', 'Identify the Agent Notion integration.', 'read'),
    operation('search', 'Search pages/data sources shared with the Agent integration.', 'read', { ...pagination, query: text(1000) }),
    operation('page.get', 'Read page metadata/properties; use blocks.list for content.', 'read', { pageId: uuid }, ['pageId']),
    operation('blocks.list', 'Read page/block children with explicit cursor pagination.', 'read', { ...pagination, blockId: uuid }, ['blockId']),
    operation('database.get', 'Read database metadata and data source IDs.', 'read', { databaseId: uuid }, ['databaseId']),
    operation('data_source.query', 'Query a data source using the 2025-09-03 API.', 'read', { ...pagination, dataSourceId: uuid, filter: { type: 'object' }, sorts: { type: 'array', maxItems: 20, items: { type: 'object' } } }, ['dataSourceId']),
    operation('page.create', 'Create a page beneath a page or data source. Properties use Notion API shape.', 'write', {
      parent: { type: 'object', properties: { page_id: uuid, data_source_id: uuid }, additionalProperties: false, oneOf: [{ required: ['page_id'], not: { required: ['data_source_id'] } }, { required: ['data_source_id'], not: { required: ['page_id'] } }] }, properties, children,
    }, ['parent','properties']),
    operation('page.update', 'Update page properties or archive/unarchive a page.', 'write', { pageId: uuid, properties, archived: { type: 'boolean' } }, ['pageId']),
    operation('blocks.append', 'Append Notion block objects to a page/block.', 'write', { blockId: uuid, children }, ['blockId','children']),
  ];
  private readonly http: ConnectorHttp;
  constructor(private readonly credentials: AgentCredentials, fetcher?: ConnectorFetch) { this.http = new ConnectorHttp('https://api.notion.com', fetcher); }
  configured(): boolean { return this.credentials.configured(this.app); }
  async invoke(request: AppRequest, options: AppCallOptions = {}): Promise<AppResult> {
    const operation = validateRequest(this.operations, request);
    const args = JSON.parse(JSON.stringify(request.args)) as Record<string,any>;
    let pathname: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', body: unknown;
    const query: Record<string,unknown> = {};
    const pagination = { page_size: args.limit ?? 30, start_cursor: args.cursor };
    switch (request.operation) {
      case 'account.get': pathname = '/v1/users/me'; break;
      case 'search': pathname = '/v1/search'; method = 'POST'; body = { query: args.query, ...pagination }; break;
      case 'page.get': pathname = `/v1/pages/${segment(args.pageId)}`; break;
      case 'blocks.list': pathname = `/v1/blocks/${segment(args.blockId)}/children`; Object.assign(query, pagination); break;
      case 'database.get': pathname = `/v1/databases/${segment(args.databaseId)}`; break;
      case 'data_source.query': pathname = `/v1/data_sources/${segment(args.dataSourceId)}/query`; method = 'POST'; body = { filter: args.filter, sorts: args.sorts, ...pagination }; break;
      case 'page.create': pathname = '/v1/pages'; method = 'POST'; body = { parent: args.parent, properties: args.properties, children: args.children }; break;
      case 'page.update':
        if (args.properties === undefined && args.archived === undefined) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'A page update field is required.');
        pathname = `/v1/pages/${segment(args.pageId)}`; method = 'PATCH'; body = { properties: args.properties, archived: args.archived }; break;
      case 'blocks.append': pathname = `/v1/blocks/${segment(args.blockId)}/children`; method = 'PATCH'; body = { children: args.children }; break;
      default: throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Unsupported operation.');
    }
    const token = await this.credentials.token(this.app, options);
    const { data } = await this.http.request(method, pathname, token, { ...options, readOnly: operation.effect === 'read', query, body, headers: { 'Notion-Version': '2025-09-03' } });
    const next = data && typeof data === 'object' && !Array.isArray(data) ? data.next_cursor : undefined;
    return { data, ...(typeof next === 'string' && next ? { nextPage: next } : {}) };
  }
}
