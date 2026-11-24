/**
 * Server entries that are only an extra account (#1687): a `jmapServers`
 * entry with `extraAccountOnly`, such as a legacy-proxy for external
 * mailboxes. The sign-in page doesn't offer it, and the sign-in routes refuse
 * it unless this browser is signed in to another configured server, one that
 * isn't extra-only itself.
 *
 * With `LOGIN_GRANT_SECRET` set, the credential check Bulwark's server makes
 * for such a sign-in also carries a login grant in `X-Bulwark-Login-Grant`:
 * a short-lived token signed with that secret, which a legacy-proxy with the
 * same secret needs before it takes an address it has no account for
 * (legacy-proxy src/auth/loginGrant.ts). The browser never sees the grant.
 *
 * Grant format, shared with the proxy: `bwg1.<payload>.<signature>`, payload
 * base64url JSON { aud, sub, pri, iat, exp, jti }, signature base64url
 * HMAC-SHA-256 over `bwg1.<payload>`.
 */

import { createHmac, randomBytes } from 'crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';
import { findServerByUrl, normalizeUrl, parseJmapServers, type JmapServerEntry } from '@/lib/admin/jmap-servers';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { fetchJmapSessionIdentity } from '@/lib/auth/verify-jmap-auth';
import { readCurrentStalwartAuthContext } from '@/lib/stalwart/auth-context';
import { isTrustedJmapServerUrl } from '@/lib/stalwart/server-fetch';
import { logger } from '@/lib/logger';

export const LOGIN_GRANT_HEADER = 'X-Bulwark-Login-Grant';
/** How long a grant is good for. The proxy allows 30 seconds of clock difference on top. */
export const LOGIN_GRANT_LIFETIME_SEC = 60;
/** The shortest secret the proxy accepts. */
const MIN_SECRET_BYTES = 32;

export interface LoginGrantClaims {
  aud: string;
  sub: string;
  pri: string;
  iat: number;
  exp: number;
  jti: string;
}

const b64u = (buf: Buffer) => buf.toString('base64url');

/** A grant for one login of `sub` at the server `aud`. */
export function mintLoginGrant(secret: string, grant: { aud: string; sub: string; pri: string }, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const claims: LoginGrantClaims = {
    aud: normalizeUrl(grant.aud),
    sub: grant.sub.trim().toLowerCase(),
    pri: grant.pri,
    iat,
    exp: iat + LOGIN_GRANT_LIFETIME_SEC,
    jti: b64u(randomBytes(16)),
  };
  const body = `bwg1.${b64u(Buffer.from(JSON.stringify(claims), 'utf8'))}`;
  return `${body}.${b64u(createHmac('sha256', Buffer.from(secret, 'utf8')).update(body).digest())}`;
}

/** The configured entry for `serverUrl` when it is only an extra account. */
export function extraAccountOnlyServer(serverUrl: string, servers: JmapServerEntry[]): JmapServerEntry | undefined {
  const entry = findServerByUrl(servers, serverUrl);
  return entry?.extraAccountOnly ? entry : undefined;
}

/**
 * An account this browser is signed in to on a configured server that isn't
 * extra-only, checked with that server now: its credential must still work.
 * Null when there is none.
 */
export async function primarySignIn(servers: JmapServerEntry[]): Promise<{ serverUrl: string; account: string } | null> {
  const cookieStore = await cookies();
  for (let slot = 0; slot < MAX_ACCOUNT_SLOTS; slot++) {
    const context = await readCurrentStalwartAuthContext(cookieStore, slot);
    if (!context) continue;
    if (extraAccountOnlyServer(context.serverUrl, servers)) continue;
    if (!(await isTrustedJmapServerUrl(context.serverUrl))) continue;
    try {
      const identity = await fetchJmapSessionIdentity(context.serverUrl, context.authHeader, { trusted: true });
      return { serverUrl: identity.serverUrl, account: context.accountName ?? identity.addresses[0] ?? context.username };
    } catch {
      // Signed out there, or the server is down: not a sign-in to count on.
    }
  }
  return null;
}

export type ExtraAccountCheck =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; response: NextResponse };

/**
 * What a sign-in to `serverUrl` as `username` needs: nothing for an ordinary
 * server; for an extra-only one, a primary sign-in in this browser (else a
 * 403 `primary_sign_in_required`), and, with `withGrant` and a secret set,
 * the grant header for the request that checks the credential.
 */
export async function checkExtraAccountSignIn(
  serverUrl: string,
  username: string,
  options: { withGrant?: boolean } = {},
): Promise<ExtraAccountCheck> {
  await configManager.ensureLoaded();
  const servers = parseJmapServers(configManager.get<unknown>('jmapServers', []));
  const entry = extraAccountOnlyServer(serverUrl, servers);
  if (!entry) return { ok: true, headers: {} };
  const primary = await primarySignIn(servers);
  if (!primary) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'primary_sign_in_required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } }),
    };
  }
  const secret = (configManager.get<string>('loginGrantSecret', '') || '').trim();
  if (!options.withGrant || !secret) return { ok: true, headers: {} };
  if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
    logger.warn('LOGIN_GRANT_SECRET is shorter than 32 characters; no login grant is sent');
    return { ok: true, headers: {} };
  }
  return {
    ok: true,
    headers: { [LOGIN_GRANT_HEADER]: mintLoginGrant(secret, { aud: entry.url, sub: username, pri: primary.account }) },
  };
}
