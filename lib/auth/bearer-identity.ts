import { createHash, createHmac, hkdfSync } from 'crypto';
import { configManager } from '@/lib/admin/config-manager';
import { parseJmapServers, resolveTrustedJmapUrl } from '@/lib/admin/jmap-servers';
import { loginClientAddress } from '@/lib/auth/client-address';
import { LOGIN_BUDGET_RETRY_AFTER_SECONDS, createFailureBudget } from '@/lib/auth/verify-budget';
import { JmapAuthVerificationError, fetchJmapSessionIdentity } from '@/lib/auth/verify-jmap-auth';
import { logger } from '@/lib/logger';
import { getSessionSecret } from '@/lib/auth/session-secret';

/**
 * Who a request signs in as through `Authorization: Bearer <JMAP access
 * token>`, for clients without a webmail session: the mobile app reading the
 * organisation policy (GET /api/admin/policy).
 *
 * The token is checked by fetching the JMAP session with it from the mail
 * server this webmail is configured for, never from a URL the request names:
 * `X-JMAP-Server-Url` may pick one of the configured servers when there are
 * several, and is ignored unless it matches one. The identity is the
 * session's username and the name of its primary mail account.
 *
 * Results are cached briefly under a hash of the server and token (the token
 * itself is not kept), so a client polling the policy doesn't cost a session
 * fetch each time. A token the mail server refuses may count there as a
 * failed login from this server's address, and enough of them get the
 * webmail's address banned for every user. So a client gets 10 refused
 * tokens per 15 minutes, and all clients together 20, the same ceiling as
 * the stored credentials (lib/stalwart/stored-credential-budget.ts): client
 * addresses can be made up or rotated. Past either, tokens are not checked
 * until the window ends; a valid token is never counted. The client's
 * address is forwarded upstream like the sign-in routes do.
 *
 * A token that checked out is remembered, by an HMAC keyed from the session
 * secret, for the rest of its lifetime when it names one (a JWT's `exp`) and
 * at most an hour, so past the ceiling it is still answered in full without
 * asking the mail server. Below the ceiling it is checked again every minute
 * as before, so a revoked token stops counting within a minute then.
 *
 * A value that can't be a token is not checked at all: shorter than
 * MIN_TOKEN_LENGTH (an OAuth access token carries at least 128 bits, RFC 6749
 * section 10.10, which takes 22 characters or more) or with a character
 * outside the RFC 6750 token alphabet.
 */

const VALID_TTL_MS = 60 * 1000;
const INVALID_TTL_MS = 30 * 1000;
const MAX_CACHED = 1000;
const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 8192;
/** RFC 6750 `b64token`. */
const TOKEN_ALPHABET = /^[A-Za-z0-9\-._~+/]+=*$/;
const REFUSED_PER_CLIENT = 10;
/** The longest a token that checked out is remembered (its lifetime when shorter). */
const GOOD_TOKEN_MAX_MS = 60 * 60 * 1000;
const MAX_GOOD_TOKENS = 5000;
const REFUSED_ACROSS_CLIENTS = 20;
export const SERVER_URL_HEADER = 'x-jmap-server-url';

export interface BearerIdentity {
  /** Lowercased addresses the token's session names. */
  addresses: string[];
}

/**
 * What a Bearer token check came to. `identity` is null when there is no
 * token, nothing to check it against, or the server refused it;
 * `retryAfterSeconds` is set when the token was not checked because the
 * refused-token budget is spent.
 */
export interface BearerCheck {
  identity: BearerIdentity | null;
  retryAfterSeconds?: number;
}

interface Verified {
  identity: BearerIdentity | null;
  /** The budget was spent: nothing was asked. */
  unchecked?: true;
  /** The mail server refused the token. */
  refused?: true;
}

interface CacheEntry {
  result: Promise<Verified>;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
/** Tokens that checked out, by goodTokenId(), until their lifetime ends or an hour passes. */
const goodTokens = new Map<string, { identity: BearerIdentity; expiresAt: number }>();
/** The HMAC key for goodTokenId and the session secret it comes from. */
const goodTokenKey: { secret: string; key: Buffer } = { secret: '', key: Buffer.alloc(0) };
const refusedBudget = createFailureBudget({
  name: 'bearer-refused',
  clientMax: REFUSED_PER_CLIENT,
  globalMax: REFUSED_ACROSS_CLIENTS,
});

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return null;
  const token = match[1];
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH || !TOKEN_ALPHABET.test(token)) return null;
  return token;
}

/** The configured server the token is checked against, or null. */
async function configuredServerUrl(request: Request): Promise<string | null> {
  await configManager.ensureLoaded();
  const globalUrl =
    configManager.get<string>('jmapServerUrl', '') ||
    process.env.JMAP_SERVER_URL ||
    process.env.NEXT_PUBLIC_JMAP_SERVER_URL ||
    '';
  const servers = parseJmapServers(configManager.get<unknown>('jmapServers', []));
  const requested = request.headers.get(SERVER_URL_HEADER)?.trim();
  if (requested) return resolveTrustedJmapUrl(requested, globalUrl, servers);
  if (globalUrl) return resolveTrustedJmapUrl(null, globalUrl, servers);
  // Several servers and no pick: sending the token to a server it wasn't
  // issued by would hand it to that server.
  return servers.length === 1 ? servers[0].url : null;
}

function prune(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function verify(serverUrl: string, token: string, client: string): Promise<Verified> {
  // Store down: StoreUnavailableError reaches the caller, nothing is checked.
  const refund = await refusedBudget.reserve(client);
  if (!refund) return { identity: null, unchecked: true };
  try {
    const identity = await fetchJmapSessionIdentity(serverUrl, `Bearer ${token}`, {
      trusted: true,
      clientIp: client,
    });
    await refund();
    return { identity: { addresses: identity.addresses } };
  } catch (error) {
    const refused = error instanceof JmapAuthVerificationError && error.upstreamStatus !== undefined
      && (error.upstreamStatus === 401 || error.upstreamStatus === 403);
    // Only a token the server refused counts against the client.
    if (!refused) {
      await refund();
      logger.warn('Bearer identity check failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return { identity: null };
    }
    return { identity: null, refused: true };
  }
}

/** The key a good token is remembered by: an HMAC from the session secret; null without one. */
function goodTokenId(serverUrl: string, token: string): string | null {
  let secret: string;
  try {
    secret = getSessionSecret();
  } catch {
    return null;
  }
  if (!secret) return null;
  if (goodTokenKey.secret !== secret) {
    const root = createHash('sha256').update(secret).digest();
    goodTokenKey.key = Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), 'bearer-identity', 32));
    goodTokenKey.secret = secret;
  }
  return createHmac('sha256', goodTokenKey.key).update(`${serverUrl}\n${token}`).digest('base64url');
}

/** When a token says it ends: a JWT's `exp`, read without checking (only ever shortens). */
function tokenEnds(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const exp = (JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function rememberGoodToken(id: string, token: string, identity: BearerIdentity, now: number): void {
  const expiresAt = Math.min(now + GOOD_TOKEN_MAX_MS, tokenEnds(token) ?? Infinity);
  if (expiresAt <= now) return;
  goodTokens.delete(id);
  if (goodTokens.size >= MAX_GOOD_TOKENS) {
    for (const [key, entry] of goodTokens) if (entry.expiresAt <= now) goodTokens.delete(key);
    // Still full: the oldest go first (they are only checked again).
    while (goodTokens.size >= MAX_GOOD_TOKENS) {
      const oldest = goodTokens.keys().next().value;
      if (oldest === undefined) break;
      goodTokens.delete(oldest);
    }
  }
  goodTokens.set(id, { identity, expiresAt });
}

/**
 * The identity behind the request's Bearer token (see BearerCheck). Rejects
 * with StoreUnavailableError when the refused-token budget can't be counted
 * (shared store down).
 */
export async function bearerIdentity(request: Request, now = Date.now()): Promise<BearerCheck> {
  const token = bearerToken(request);
  if (!token) return { identity: null };
  const serverUrl = await configuredServerUrl(request);
  if (!serverUrl) return { identity: null };

  const key = createHash('sha256').update(`${serverUrl}\n${token}`).digest('hex');
  const cached = cache.get(key);
  const result = cached && cached.expiresAt > now ? cached.result : check(key, serverUrl, token, request, now);
  const verified = await result;
  const id = goodTokenId(serverUrl, token);
  if (verified.unchecked) {
    // Past the ceiling: a token that checked out before is still answered.
    const good = id ? goodTokens.get(id) : undefined;
    if (good && good.expiresAt > now) return { identity: good.identity };
    return { identity: null, retryAfterSeconds: LOGIN_BUDGET_RETRY_AFTER_SECONDS };
  }
  if (id && verified.identity) rememberGoodToken(id, token, verified.identity, now);
  else if (id && verified.refused) goodTokens.delete(id);
  return { identity: verified.identity };
}

function check(key: string, serverUrl: string, token: string, request: Request, now: number): Promise<Verified> {
  prune(now);
  const result = verify(serverUrl, token, loginClientAddress(request));
  const entry: CacheEntry = { result, expiresAt: now + VALID_TTL_MS };
  cache.set(key, entry);
  void result.then((verified) => {
    // Not asked (budget spent): ask again next time.
    if (verified.unchecked) {
      if (cache.get(key) === entry) cache.delete(key);
      return;
    }
    // A refused token is checked again sooner than a good one.
    if (!verified.identity) entry.expiresAt = Math.min(entry.expiresAt, now + INVALID_TTL_MS);
  }, () => {
    // Not checked at all (the shared store is down): ask again next time.
    if (cache.get(key) === entry) cache.delete(key);
  });
  return result;
}

/** Test hook: forget cached checks and remembered tokens. */
export function resetBearerIdentityCacheForTests(): void {
  goodTokens.clear();
  cache.clear();
}
