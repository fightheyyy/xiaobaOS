import { HttpsProxyAgent } from 'https-proxy-agent';

function sandboxProxyUrl(): URL | undefined {
  if (process.env.XIAOBA_SANDBOXED !== '1') return undefined;
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
  if (!proxy) throw new Error('Sandbox model transport requires the SDK network proxy.');
  return new URL(proxy);
}

/** Explicit transport also routes host-local Ollama through the allowlisted proxy. */
export function sandboxAxiosProxy() {
  const url = sandboxProxyUrl();
  return url ? { proxy: { protocol: url.protocol.replace(':', ''), host: url.hostname, port: Number(url.port || 80),
    ...(url.username ? { auth: { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } } : {}),
  } } : {};
}

export function sandboxSdkAgent() {
  const url = sandboxProxyUrl();
  return url ? { httpAgent: new HttpsProxyAgent(url) } : {};
}
