import { AppCallOptions, ConnectorError, Json } from './app-connector';

export type ConnectorFetch = typeof fetch;
export interface HttpResult { data: Json; headers: Headers }
/** Fixed-origin, bounded transport; app adapters own paths and never accept URLs/headers from models. */
export class ConnectorHttp {
  constructor(private readonly origin: string, private readonly fetcher: ConnectorFetch = fetch) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('CONNECTOR_ORIGIN_INVALID');
  }
  async request(method: 'GET' | 'POST' | 'PATCH', pathname: string, token: string,
    options: AppCallOptions & { query?: Record<string, unknown>; body?: unknown; headers?: Record<string,string>; form?: URLSearchParams; readOnly?: boolean } = {}): Promise<HttpResult> {
    if (!pathname.startsWith('/') || pathname.startsWith('//') || /[?#\\]/.test(pathname)) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Invalid API path.');
    const url = new URL(this.origin + pathname);
    const safeToRetry = options.readOnly ?? method === 'GET';
    if (url.origin !== this.origin) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Invalid API origin.');
    for (const [key,value] of Object.entries(options.query || {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const body = options.form?.toString() ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    if (body && Buffer.byteLength(body) > 256 * 1024) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Request exceeds 256 KB.');
    const timeout = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120_000) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Invalid timeout.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.abortSignal?.aborted) throw new ConnectorError('CONNECTOR_ABORTED', 'App call cancelled.');
    options.abortSignal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout); timer.unref();
    try {
      const response = await this.fetcher(url, { method, redirect: 'error', signal: controller.signal, body,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': options.form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
          ...options.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
      if (!response.ok) {
        await response.body?.cancel();
        const rateLimited = response.status === 429 || response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'));
        const code = rateLimited ? 'CONNECTOR_RATE_LIMITED' : response.status === 401 ? 'CONNECTOR_AUTH_REQUIRED' : response.status === 403 ? 'CONNECTOR_PERMISSION_DENIED'
          : response.status === 404 ? 'CONNECTOR_NOT_FOUND' : response.status === 429 ? 'CONNECTOR_RATE_LIMITED' : 'CONNECTOR_API_ERROR';
        // Never expose upstream error bodies: providers may echo authorization/body fields.
        throw new ConnectorError(code, `App API returned HTTP ${response.status}.`, safeToRetry && (rateLimited || response.status >= 500), response.status);
      }
      const max = 1024 * 1024;
      if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); throw new ConnectorError('CONNECTOR_RESPONSE_TOO_LARGE', 'App response exceeds 1 MB. Narrow the query.'); }
      const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      if (reader) {
        try {
          while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
            if (size > max) { await reader.cancel(); throw new ConnectorError('CONNECTOR_RESPONSE_TOO_LARGE', 'App response exceeds 1 MB. Narrow the query.'); } chunks.push(next.value); }
        } finally { reader.releaseLock(); }
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      // Authentication echoes are never allowed into the transcript.
      let data: Json;
      try { data = raw.trim() ? JSON.parse(raw) : null; } catch { throw new ConnectorError('CONNECTOR_API_ERROR', 'App returned invalid JSON.'); }
      return { data: redactCredential(data, token), headers: response.headers };
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if (timedOut) throw new ConnectorError('CONNECTOR_TIMEOUT', safeToRetry ? 'App call timed out.' : 'App call timed out; write outcome may be unknown.', safeToRetry);
      if (controller.signal.aborted) throw new ConnectorError('CONNECTOR_ABORTED', safeToRetry ? 'App call cancelled.' : 'App call cancelled; write outcome may be unknown.');
      throw new ConnectorError('CONNECTOR_NETWORK_ERROR', safeToRetry ? 'App connection failed.' : 'App connection failed; write outcome may be unknown.', safeToRetry);
    } finally { clearTimeout(timer); options.abortSignal?.removeEventListener('abort', abort); }
  }
}

/** Apply after provider decoding too, so base64 content cannot echo the active credential. */
export function redactCredential(data: Json, token: string): Json {
  if (!token) return data;
  return JSON.parse(JSON.stringify(data, (_key, value) => typeof value === 'string' ? value.split(token).join('[REDACTED]') : value));
}
