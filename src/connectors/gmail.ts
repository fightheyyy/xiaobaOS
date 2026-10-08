import { AppConnector, AppRequest, AppResult, AppCallOptions, operation, string, text, limit, identifier, segment, validateRequest, ConnectorError, Json } from './app-connector';
import { AgentCredentials } from './credentials';
import { ConnectorFetch, ConnectorHttp, redactCredential } from './http';

const pagination = { limit, pageToken: string(1000) };
const format = { type: 'string', enum: ['full','metadata'] };
const email = { ...string(254), pattern: '^[^\\s<>@,;\\r\\n]+@[^\\s<>@,;\\r\\n]+\\.[^\\s<>@,;\\r\\n]+$' };
const addresses = { type: 'array', minItems: 1, maxItems: 50, items: email };
const mail = { to: addresses, cc: addresses, bcc: addresses, subject: { ...text(500), pattern: '^[^\\r\\n]*$' }, body: text(64000) };
export class GmailConnector implements AppConnector {
  readonly id = 'gmail'; readonly app = 'gmail' as const;
  readonly capabilities = ['account','messages','threads','labels','drafts','send'];
  readonly operations = [
    operation('account.get', 'Identify the Agent Gmail account.', 'read'),
    operation('history.list', 'Read newly added inbox messages after a Gmail history cursor.', 'read', { startHistoryId:{...string(100),pattern:'^[0-9]+$'},pageToken:string(1000),limit }, ['startHistoryId']),
    operation('messages.list', 'Search Agent mail with Gmail query syntax. Does not mark mail read.', 'read', { ...pagination, query: text(1000) }),
    operation('message.get', 'Read normalized mail, headers and attachment metadata; full text is bounded.', 'read', { messageId: identifier, format }, ['messageId']),
    operation('thread.get', 'Read a conversation thread.', 'read', { threadId: identifier, format }, ['threadId']),
    operation('labels.list', 'List mail labels.', 'read'),
    operation('drafts.list', 'List saved mail drafts.', 'read', pagination),
    operation('draft.get', 'Read one draft.', 'read', { draftId: identifier }, ['draftId']),
    operation('draft.create', 'Save a UTF-8 plain-text draft. Does not send.', 'write', mail, ['to','subject','body']),
    operation('draft.send', 'Send an existing draft from the Agent mailbox.', 'write', { draftId: identifier }, ['draftId']),
    operation('message.send', 'Send UTF-8 plain-text mail from the Agent mailbox.', 'write', mail, ['to','subject','body']),
    operation('message.modify', 'Add/remove labels (e.g. mark read). No permanent deletion.', 'write', { messageId: identifier,
      addLabelIds: { type: 'array', maxItems: 100, items: identifier }, removeLabelIds: { type: 'array', maxItems: 100, items: identifier } }, ['messageId']),
  ];
  private readonly http: ConnectorHttp;
  constructor(private readonly credentials: AgentCredentials, fetcher?: ConnectorFetch) { this.http = new ConnectorHttp('https://gmail.googleapis.com', fetcher); }
  configured(): boolean { return this.credentials.configured(this.app); }
  async invoke(request: AppRequest, options: AppCallOptions = {}): Promise<AppResult> {
    const operation = validateRequest(this.operations, request);
    const args = JSON.parse(JSON.stringify(request.args)) as Record<string,any>;
    const base = '/gmail/v1/users/me';
    let pathname: string, method: 'GET' | 'POST' = 'GET', body: unknown;
    const query: Record<string,unknown> = {};
    switch (request.operation) {
      case 'account.get': pathname = base + '/profile'; break;
      case 'history.list': pathname=base+'/history';query.startHistoryId=args.startHistoryId;query.historyTypes='messageAdded';query.labelId='INBOX';query.maxResults=args.limit ?? 50;query.pageToken=args.pageToken;break;
      case 'messages.list': pathname = base + '/messages'; query.q = args.query; break;
      case 'message.get': pathname = `${base}/messages/${segment(args.messageId)}`; query.format = args.format ?? 'full'; break;
      case 'thread.get': pathname = `${base}/threads/${segment(args.threadId)}`; query.format = args.format ?? 'full'; break;
      case 'labels.list': pathname = base + '/labels'; break;
      case 'drafts.list': pathname = base + '/drafts'; break;
      case 'draft.get': pathname = `${base}/drafts/${segment(args.draftId)}`; query.format = 'full'; break;
      case 'draft.create': pathname = base + '/drafts'; method = 'POST'; body = { message: { raw: encodeMail(args) } }; break;
      case 'draft.send': pathname = base + '/drafts/send'; method = 'POST'; body = { id: args.draftId }; break;
      case 'message.send': pathname = base + '/messages/send'; method = 'POST'; body = { raw: encodeMail(args) }; break;
      case 'message.modify':
        if (!args.addLabelIds?.length && !args.removeLabelIds?.length) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'A label change is required.');
        pathname = `${base}/messages/${segment(args.messageId)}/modify`; method = 'POST'; body = { addLabelIds: args.addLabelIds, removeLabelIds: args.removeLabelIds }; break;
      default: throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Unsupported operation.');
    }
    if (['messages.list','drafts.list'].includes(request.operation)) { query.maxResults = args.limit ?? 30; query.pageToken = args.pageToken; }
    const token = await this.credentials.token(this.app, options);
    const response = await this.http.request(method, pathname, token, { ...options, readOnly: operation.effect === 'read', query, body });
    let data = response.data as any;
    if (request.operation === 'message.get') data = normalizeMessage(data);
    if (request.operation === 'draft.get' && data?.message) data = { id: data.id, message: normalizeMessage(data.message) };
    if (request.operation === 'thread.get' && data?.messages) data = { id: data.id, historyId: data.historyId, messages: data.messages.slice(-50).map(normalizeMessage), truncated: data.messages.length > 50 };
    return { data: redactCredential(data as Json, token), ...(typeof data?.nextPageToken === 'string' ? { nextPage: data.nextPageToken } : {}) };
  }
}
function encodeMail(args: Record<string,any>): string {
  const headers = [`To: ${args.to.join(',\r\n ')}`];
  for (const [key,name] of [['cc','Cc'],['bcc','Bcc']]) if (args[key]) headers.push(`${name}: ${args[key].join(',\r\n ')}`);
  const chunks: string[] = []; let chunk = '';
  for (const char of args.subject) {
    if (Buffer.byteLength(chunk + char) > 42) { chunks.push(chunk); chunk = ''; }
    chunk += char;
  }
  if (chunk || !chunks.length) chunks.push(chunk);
  const subject = chunks.map(value => `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`).join('\r\n ');
  headers.push(`Subject: ${subject}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
  const encoded = Buffer.from(args.body, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
  return Buffer.from(headers.join('\r\n') + '\r\n\r\n' + encoded).toString('base64url');
}
function normalizeMessage(message: any): Json {
  if (!message || typeof message !== 'object') throw new ConnectorError('CONNECTOR_API_ERROR', 'Invalid Gmail message.');
  const bodies: string[] = [], attachments: Json[] = [];
  let remaining = 16000, truncated = false;
  const walk = (part: any, depth = 0) => {
    if (!part || depth > 20) return;
    if (part.filename) attachments.push({ name: String(part.filename), mimeType: String(part.mimeType || ''), size: Number(part.body?.size || 0), attachmentId: String(part.body?.attachmentId || '') });
    else if (part.body?.data && ['text/plain','text/html'].includes(part.mimeType)) {
      const decoded = Buffer.from(String(part.body.data), 'base64url').toString('utf8');
      if (decoded.length > remaining) truncated = true;
      if (remaining > 0) bodies.push(decoded.slice(0, remaining)); remaining = Math.max(0, remaining - decoded.length);
    }
    for (const child of part.parts || []) walk(child, depth + 1);
  };
  walk(message.payload);
  const headers = Object.fromEntries((message.payload?.headers || []).filter((header: any) => ['from','to','cc','subject','date','message-id','in-reply-to'].includes(String(header.name).toLowerCase())).map((header: any) => [String(header.name).toLowerCase(), String(header.value)]));
  return { id: String(message.id || ''), threadId: String(message.threadId || ''), labels: message.labelIds || [], snippet: String(message.snippet || ''), headers, body: bodies.join('\n'), attachments, truncated };
}
