import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/**
 * Node's built-in fetch (undici) ignores HTTP(S)_PROXY/NO_PROXY environment
 * variables, unlike axios. youtubei.js uses fetch, so behind an egress proxy
 * (corporate networks, sandboxed CI) its requests bypass the proxy and fail.
 * Installing EnvHttpProxyAgent as the global dispatcher makes fetch honor the
 * same proxy variables the rest of the server already respects.
 */
export function configureProxyFromEnv(): void {
  const hasProxy =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (hasProxy) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
  }
}
