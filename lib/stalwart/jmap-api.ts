/**
 * Server-side helpers for talking to a JMAP API endpoint derived from the
 * stored `serverUrl`.
 *
 * A bare `fetch(`${serverUrl}/jmap/`)` breaks in two real deployments (#627):
 *
 *  - A 301/302 in front of the server (Cloudflare http→https upgrade,
 *    hostname normalization, trailing-slash rules) makes `fetch`'s default
 *    redirect handling re-issue the request as a GET. Stalwart answers
 *    `GET /jmap/` with `404 application/problem+json`, which the passthrough
 *    then forwards as an opaque 404.
 *  - The session's `apiUrl` may live on a path other than `/jmap/`.
 *
 * `postJmap` follows redirects manually so POST stays POST, and callers can
 * recover from a wrong path by resolving the session's `apiUrl` rebased onto
 * `serverUrl`'s host (the advertised public host may not be reachable from
 * this process — see calendar-agenda's session handling).
 */

import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import { UPSTREAM_JSON_MAX_BYTES, readJsonCapped } from '@/lib/security/capped-body';
import { forwardedClientHeaders } from '@/lib/auth/client-address';

const MAX_REDIRECTS = 3;

/**
 * `trusted` mirrors `StalwartCredentials.trusted`: pass `false` for a
 * user-chosen server so the request goes through the rebinding-safe fetch.
 */
export interface JmapFetchOptions {
  trusted?: boolean;
  /** Address of the browser behind the request, see lib/auth/client-address.ts. */
  clientIp?: string;
}

export interface JmapSessionDocument {
  apiUrl?: string;
  capabilities?: Record<string, unknown>;
  primaryAccounts?: Record<string, string>;
  accounts?: Record<string, unknown>;
}

/**
 * Redirects are followed only towards the same host (path/trailing-slash
 * fixes) or an https upgrade of the same hostname. Anything else would leak
 * the Authorization header to a third party.
 */
function isTrustedRedirect(from: URL, to: URL): boolean {
  if (to.host === from.host && to.protocol === from.protocol) return true;
  return to.protocol === 'https:' && to.hostname === from.hostname;
}

export class JmapRedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JmapRedirectError';
  }
}

/**
 * POST a JMAP request, preserving the POST method and body across redirects
 * (native `fetch` downgrades POST to GET on 301/302).
 */
export async function postJmap(
  apiUrl: string,
  authHeader: string,
  body: string,
  options: JmapFetchOptions = {},
): Promise<Response> {
  let url = new URL(apiUrl);
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt++) {
    const response = await fetchJmapServer(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        ...forwardedClientHeaders(options.clientIp),
      },
      body,
      redirect: 'manual',
    }, options.trusted);

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) return response;

    const next = new URL(location, url);
    if (!isTrustedRedirect(url, next)) {
      throw new JmapRedirectError(
        `JMAP endpoint redirected to an untrusted host: ${next.host}`,
      );
    }
    url = next;
  }
  throw new JmapRedirectError('Too many redirects from JMAP endpoint');
}

/**
 * Fetch the JMAP session document from the same host as `serverUrl`. Tries
 * Stalwart's canonical /jmap/session first (no redirect), then
 * /.well-known/jmap as a fallback for other servers. Returns null if neither
 * yields a usable session.
 */
export async function fetchJmapSession(
  serverUrl: string,
  authHeader: string,
  options: JmapFetchOptions = {},
): Promise<JmapSessionDocument | null> {
  const candidates = [`${serverUrl}/jmap/session`, `${serverUrl}/.well-known/jmap`];
  for (const url of candidates) {
    try {
      const res = await fetchJmapServer(url, {
        method: 'GET',
        headers: { Authorization: authHeader, ...forwardedClientHeaders(options.clientIp) },
        redirect: 'follow',
      }, options.trusted);
      if (!res.ok) continue;
      // An oversized session throws here, and the next candidate is tried.
      const session = await readJsonCapped<JmapSessionDocument>(res, UPSTREAM_JSON_MAX_BYTES);
      if (session && typeof session === 'object' && session.primaryAccounts) {
        return session;
      }
    } catch {
      // Try the next candidate (e.g. canonical path 404s on a non-Stalwart server).
    }
  }
  return null;
}

/**
 * Rebase the session's advertised `apiUrl` onto `serverUrl`'s origin, so
 * method calls go to the host this process can actually reach rather than
 * the server's configured public hostname.
 */
export function rebaseApiUrl(
  session: JmapSessionDocument | null,
  serverUrl: string,
): string | null {
  if (!session?.apiUrl) return null;
  try {
    const api = new URL(session.apiUrl, `${serverUrl}/`);
    const base = new URL(serverUrl);
    return new URL(api.pathname + api.search, base.origin).toString();
  } catch {
    return null;
  }
}
