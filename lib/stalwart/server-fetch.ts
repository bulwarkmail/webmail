/**
 * Server-side fetch for the JMAP server stored in a user's auth-context
 * cookie.
 *
 * The stored `serverUrl` is trusted when it matches an admin-configured server
 * (`jmapServerUrl` / `jmapServers`); such servers may legitimately live on a
 * private network, so they get the plain `fetch`. When `allowCustomJmapEndpoint`
 * is on, the URL was chosen by the user at login. It was pre-checked and the
 * login verification was pinned, but a DNS name can be re-pointed at an
 * internal address *after* login, so every later request to it must go through
 * the rebinding-safe `fetchPublicUrl` (GHSA-24w9-8r42-8jwm, follow-up).
 *
 * Trust is derived from the current config on every read rather than persisted
 * in the cookie: existing sessions keep working after an upgrade, and removing
 * a server from the config immediately drops its sessions to the guarded path.
 */

import { configManager } from '@/lib/admin/config-manager';
import { parseJmapServers, resolveTrustedJmapUrl } from '@/lib/admin/jmap-servers';
import { fetchPublicUrl, type PublicFetchResponse } from '@/lib/security/url-guard';
import { forwardedClientIpHeaders } from '@/lib/security/forward-client-ip';

const MAX_REDIRECTS = 5;

export async function isTrustedJmapServerUrl(serverUrl: string): Promise<boolean> {
  await configManager.ensureLoaded();
  const configuredServerUrl =
    configManager.get<string>('jmapServerUrl', '') ||
    process.env.JMAP_SERVER_URL ||
    process.env.NEXT_PUBLIC_JMAP_SERVER_URL ||
    '';
  const serverList = parseJmapServers(configManager.get<unknown>('jmapServers', []));
  return resolveTrustedJmapUrl(serverUrl, configuredServerUrl, serverList) !== null;
}

export type ServerFetchInit = RequestInit & { duplex?: 'half' };

function headersToRecord(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  const iterable = init instanceof Headers ? init : new Headers(init);
  iterable.forEach((value, key) => { out[key] = value; });
  return out;
}

/**
 * Fetch `url` on behalf of a stored JMAP server.
 *
 * `trusted === false` routes through {@link fetchPublicUrl}; anything else
 * (including `undefined`, which only test doubles produce - real credentials
 * always carry an explicit boolean) uses the plain `fetch`.
 *
 * On the guarded path redirects are followed by hand so that every hop is
 * re-validated: `Authorization` is dropped when the origin changes, and a
 * 303 (or 301/302 on a POST) downgrades to GET like `fetch` would. Pass
 * `redirect: 'manual'` to get the 3xx response back instead.
 *
 * Trusted (admin-configured) servers also get the end user's address when
 * JMAP_FORWARD_CLIENT_IP is on (see forwardedClientIpHeaders); it overrides
 * any X-Forwarded-For the caller set. Custom endpoints never get it.
 */
export async function fetchJmapServer(
  url: string,
  init: ServerFetchInit = {},
  trusted: boolean | undefined,
): Promise<Response> {
  if (trusted !== false) {
    const clientIp = await forwardedClientIpHeaders();
    if (!clientIp['X-Forwarded-For']) return fetch(url, init);
    const headers = new Headers(init.headers);
    headers.set('X-Forwarded-For', clientIp['X-Forwarded-For']);
    return fetch(url, { ...init, headers });
  }

  const { redirect, headers: initHeaders, ...rest } = init;
  const headers = headersToRecord(initHeaders);
  let currentUrl = url;
  let method = (rest.method ?? 'GET').toUpperCase();
  let body = rest.body;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response: PublicFetchResponse = await fetchPublicUrl(currentUrl, {
      ...(rest as Omit<ServerFetchInit, 'redirect' | 'headers'>),
      method,
      body: body as never,
      headers,
    });

    if (redirect === 'manual' || response.status < 300 || response.status >= 400) {
      return response as unknown as Response;
    }

    const location = response.headers.get('location');
    if (!location) {
      return response as unknown as Response;
    }
    await response.body?.cancel().catch(() => {});

    const next = new URL(location, currentUrl);
    if (next.origin !== new URL(currentUrl).origin) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'authorization' || key.toLowerCase() === 'cookie') {
          delete headers[key];
        }
      }
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'content-type' || key.toLowerCase() === 'content-length') {
          delete headers[key];
        }
      }
    }
    currentUrl = next.toString();
  }

  throw new Error(`Too many redirects fetching ${url}`);
}
