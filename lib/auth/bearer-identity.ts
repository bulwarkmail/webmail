import { createHash } from 'crypto';
import { configManager } from '@/lib/admin/config-manager';
import { parseJmapServers, resolveTrustedJmapUrl } from '@/lib/admin/jmap-servers';
import { loginClientAddress } from '@/lib/auth/client-address';
import { LOGIN_BUDGET_RETRY_AFTER_SECONDS, createFailureBudget } from '@/lib/auth/verify-budget';
import { JmapAuthVerificationError, fetchJmapSessionIdentity } from '@/lib/auth/verify-jmap-auth';
import { logger } from '@/lib/logger';

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
}

interface CacheEntry {
  result: Promise<Verified>;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
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
    }
    return { identity: null };
  }
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
  return verified.unchecked
    ? { identity: null, retryAfterSeconds: LOGIN_BUDGET_RETRY_AFTER_SECONDS }
    : { identity: verified.identity };
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

/** Test hook: forget cached checks. */
export function resetBearerIdentityCacheForTests(): void {
  cache.clear();
}
