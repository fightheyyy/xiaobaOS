import { AppConnector, AppRequest, AppResult, AppCallOptions, operation, string, text, limit, segment, validateRequest, ConnectorError, Json } from './app-connector';
import { AgentCredentials } from './credentials';
import { ConnectorFetch, ConnectorHttp, redactCredential } from './http';

const repo = { owner: { ...string(100), pattern: '^[A-Za-z0-9_-]+$' }, repo: { ...string(100), pattern: '^(?!\\.{1,2}$)[A-Za-z0-9_.-]+$' } };
const page = { limit, page: { type: 'integer', minimum: 1, maximum: 10000 } };
const number = { type: 'integer', minimum: 1 };
const state = { type: 'string', enum: ['open','closed','all'] };
export class GitHubConnector implements AppConnector {
  readonly id = 'github'; readonly app = 'github' as const;
  readonly capabilities = ['account','repositories','issues','pull_requests','files','actions'];
  readonly operations = [
    operation('account.get', 'Identify the Agent GitHub account.', 'read'),
    operation('repos.list', 'List repositories accessible to the Agent; explicit page pagination.', 'read', page),
    operation('repo.get', 'Read repository metadata.', 'read', repo, ['owner','repo']),
    operation('issues.list', 'List repository issues (GitHub may include PRs).', 'read', { ...repo, ...page, state }, ['owner','repo']),
    operation('issue.get', 'Read one issue.', 'read', { ...repo, number }, ['owner','repo','number']),
    operation('pulls.list', 'List pull requests.', 'read', { ...repo, ...page, state }, ['owner','repo']),
    operation('pull.get', 'Read one pull request.', 'read', { ...repo, number }, ['owner','repo','number']),
    operation('file.get', 'Read file/directory metadata. File contents are bounded decoded text.', 'read', { ...repo, path: text(1000), ref: string(200) }, ['owner','repo','path']),
    operation('workflow.runs', 'List repository Actions runs.', 'read', { ...repo, ...page }, ['owner','repo']),
    operation('issue.create', 'Create an issue in the Agent-authorized repository.', 'write', { ...repo, title: string(256), body: text() }, ['owner','repo','title']),
    operation('issue.comment', 'Post an issue/PR comment.', 'write', { ...repo, number, body: string(16000) }, ['owner','repo','number','body']),
    operation('issue.update', 'Update title/body/state of an issue.', 'write', { ...repo, number, title: string(256), body: text(), state: { type: 'string', enum: ['open','closed'] } }, ['owner','repo','number']),
    operation('pull.create', 'Create a pull request from an existing branch.', 'write', { ...repo, title: string(256), body: text(), head: string(200), base: string(200), draft: { type: 'boolean' } }, ['owner','repo','title','head','base']),
  ];
  private readonly http: ConnectorHttp;
  constructor(private readonly credentials: AgentCredentials, fetcher?: ConnectorFetch) { this.http = new ConnectorHttp('https://api.github.com', fetcher); }
  configured(): boolean { return this.credentials.configured(this.app); }
  async invoke(request: AppRequest, options: AppCallOptions = {}): Promise<AppResult> {
    const operation = validateRequest(this.operations, request);
    const args = JSON.parse(JSON.stringify(request.args)) as Record<string,any>;
    const base = `/repos/${segment(args.owner)}/${segment(args.repo)}`;
    let pathname: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', body: unknown;
    const query: Record<string,unknown> = {};
    switch (request.operation) {
      case 'account.get': pathname = '/user'; break;
      case 'repos.list': pathname = '/user/repos'; query.sort = 'updated'; break;
      case 'repo.get': pathname = base; break;
      case 'issues.list': pathname = base + '/issues'; query.state = args.state; break;
      case 'issue.get': pathname = `${base}/issues/${args.number}`; break;
      case 'pulls.list': pathname = base + '/pulls'; query.state = args.state; break;
      case 'pull.get': pathname = `${base}/pulls/${args.number}`; break;
      case 'file.get': {
        if (args.path.split('/').some((part: string) => part === '..' || part === '.') || args.path.includes('\\')) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Invalid repository file path.');
        pathname = base + '/contents/' + args.path.split('/').map(segment).join('/'); query.ref = args.ref; break;
      }
      case 'workflow.runs': pathname = base + '/actions/runs'; break;
      case 'issue.create': pathname = base + '/issues'; method = 'POST'; body = { title: args.title, body: args.body }; break;
      case 'issue.comment': pathname = `${base}/issues/${args.number}/comments`; method = 'POST'; body = { body: args.body }; break;
      case 'issue.update': {
        if (args.title === undefined && args.body === undefined && args.state === undefined) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'An issue update field is required.');
        pathname = `${base}/issues/${args.number}`; method = 'PATCH'; body = { title: args.title, body: args.body, state: args.state }; break;
      }
      case 'pull.create': pathname = base + '/pulls'; method = 'POST'; body = { title: args.title, body: args.body, head: args.head, base: args.base, draft: args.draft }; break;
      default: throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Unsupported operation.');
    }
    if (['repos.list','issues.list','pulls.list','workflow.runs'].includes(request.operation)) { query.per_page = args.limit ?? 30; query.page = args.page ?? 1; }
    const token = await this.credentials.token(this.app, options);
    const response = await this.http.request(method, pathname, token, { ...options, readOnly: operation.effect === 'read', query, body,
      headers: { 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'xiaobaOS', Accept: 'application/vnd.github+json' } });
    let data = response.data;
    if (request.operation === 'file.get' && data && !Array.isArray(data) && typeof data === 'object' && data.encoding === 'base64' && typeof data.content === 'string') {
      const decoded = Buffer.from(data.content, 'base64').toString('utf8');
      data = { ...data, content: decoded.slice(0,32000), encoding: 'utf-8', truncated: decoded.length > 32000 };
    }
    // Return page numbers only, never provider-supplied URLs to be followed with credentials.
    const next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/);
    let nextPage: string | undefined;
    if (next) { try { const value = new URL(next[1]).searchParams.get('page'); if (value && /^\d+$/.test(value)) nextPage = value; } catch {} }
    return { data: redactCredential(data as Json, token), ...(nextPage ? { nextPage } : {}) };
  }
}
