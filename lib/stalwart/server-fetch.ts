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
import { observeUpstream } from '@/lib/metrics/upstream';
import { desktopRedirectRefused } from '@/lib/desktop/server-redirect';
import { acquireStoredCredential, refusedCredentialResponse } from '@/lib/stalwart/stored-credential-budget';

const MAX_REDIRECTS = 5;
/** Deadline for one upstream request when the caller sets none. */
export const UPSTREAM_TIMEOUT_MS = 30_000;

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

export interface JmapServerFetchOptions {
  /**
   * False when the Authorization header is not a stored credential but one
   * typed in for this request: it then skips the stored-credential budget.
   */
  storedCredential?: boolean;
}

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
 * A credential the server refused is not sent again for a while; the call
 * gets a 401 without a request (lib/stalwart/stored-credential-budget.ts).
 * Requests that overlap are held to that too: while one request with an
 * unproven credential is out, the others with it wait for its answer
 * (acquireStoredCredential). That budget is for credentials replayed from a
 * context cookie. A caller sending one that was typed in for this request
 * passes `{ storedCredential: false }` and rate-limits it itself.
 */
export async function fetchJmapServer(
  url: string,
  givenInit: ServerFetchInit = {},
  trusted: boolean | undefined,
  options: JmapServerFetchOptions = {},
): Promise<Response> {
  if (options.storedCredential === false) {
    return observeUpstream('stalwart', (trace) => fetchUnbudgeted(url, withTraceHeaders(givenInit, trace), trusted));
  }
  const authHeader = new Headers(givenInit.headers).get('authorization');
  const pass = authHeader ? await acquireStoredCredential(authHeader) : null;
  if (authHeader && !pass) return refusedCredentialResponse();
  let response: Response;
  try {
    // With tracing on, Stalwart gets the trace context and its spans join ours.
    response = await observeUpstream('stalwart', (trace) => fetchUnbudgeted(url, withTraceHeaders(givenInit, trace), trusted));
  } catch (error) {
    pass?.failed();
    throw error;
  }
  pass?.answered(response.status);
  return response;
}

function withTraceHeaders(init: ServerFetchInit, trace: Record<string, string>): ServerFetchInit {
  if (Object.keys(trace).length === 0) return init;
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(trace)) headers.set(name, value);
  return { ...init, headers };
}

async function fetchUnbudgeted(
  url: string,
  givenInit: ServerFetchInit,
  trusted: boolean | undefined,
): Promise<Response> {
  // Every call gets a deadline: a slow or silent server (with custom
  // endpoints on, one the user chose) must not pin a connection for as long
  // as it likes. Callers with their own signal keep it.
  const init: ServerFetchInit = givenInit.signal ? givenInit : { ...givenInit, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) };
  // The desktop app's approved server gets its hops checked by hand as well.
  const approvedOnDesktop = process.env.NEXT_PUBLIC_BULWARK_DESKTOP === '1' && trusted !== false;
  if (trusted !== false && !approvedOnDesktop) {
    return fetch(url, init);
  }

  const { redirect, headers: initHeaders, ...rest } = init;
  const headers = headersToRecord(initHeaders);
  let currentUrl = url;
  let method = (rest.method ?? 'GET').toUpperCase();
  let body = rest.body;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const hop = { ...(rest as Omit<ServerFetchInit, 'redirect' | 'headers'>), method, body: body as never, headers };
    const response: PublicFetchResponse = approvedOnDesktop
      ? ((await fetch(currentUrl, { ...hop, redirect: 'manual' } as RequestInit)) as unknown as PublicFetchResponse)
      : await fetchPublicUrl(currentUrl, hop);

    if (redirect === 'manual' || response.status < 300 || response.status >= 400) {
      return response as unknown as Response;
    }

    const location = response.headers.get('location');
    if (!location) {
      return response as unknown as Response;
    }
    await response.body?.cancel().catch(() => {});

    const next = new URL(location, currentUrl);
    if (desktopRedirectRefused(currentUrl, next, approvedOnDesktop)) {
      throw new Error(`${currentUrl} redirected to a server that has not been approved`);
    }
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
