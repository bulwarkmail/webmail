import { createHash } from 'crypto';
import { configManager } from '@/lib/admin/config-manager';
import { parseJmapServers, resolveTrustedJmapUrl } from '@/lib/admin/jmap-servers';
import { loginClientAddress } from '@/lib/auth/client-address';
import { createFailureBudget } from '@/lib/auth/verify-budget';
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
 * fetch each time. Every token Stalwart refuses counts as a failed login
 * against the address it came from, so a client gets 10 refused tokens per
 * 15 minutes before its tokens stop being checked; the client's address is
 * forwarded upstream like the sign-in routes do.
 */

const VALID_TTL_MS = 60 * 1000;
const INVALID_TTL_MS = 30 * 1000;
const MAX_CACHED = 1000;
const MAX_TOKEN_LENGTH = 8192;
export const SERVER_URL_HEADER = 'x-jmap-server-url';

export interface BearerIdentity {
  /** Lowercased addresses the token's session names. */
  addresses: string[];
}

interface CacheEntry {
  result: Promise<BearerIdentity | null>;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const refusedBudget = createFailureBudget({ name: 'bearer-refused', clientMax: 10, globalMax: Infinity });

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match || match[1].length > MAX_TOKEN_LENGTH) return null;
  return match[1];
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

async function verify(serverUrl: string, token: string, client: string): Promise<BearerIdentity | null> {
  // Store down: StoreUnavailableError reaches the caller, nothing is checked.
  const refund = await refusedBudget.reserve(client);
  if (!refund) return null;
  try {
    const identity = await fetchJmapSessionIdentity(serverUrl, `Bearer ${token}`, {
      trusted: true,
      clientIp: client,
    });
    await refund();
    return { addresses: identity.addresses };
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
    return null;
  }
}

/**
 * The identity behind the request's Bearer token, or null when there is no
 * token, no configured server to check it against, or the server refused it.
 * Rejects with StoreUnavailableError when the refused-token budget can't be
 * counted (shared store down).
 */
export async function bearerIdentity(request: Request, now = Date.now()): Promise<BearerIdentity | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const serverUrl = await configuredServerUrl(request);
  if (!serverUrl) return null;

  const key = createHash('sha256').update(`${serverUrl}\n${token}`).digest('hex');
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.result;

  prune(now);
  const result = verify(serverUrl, token, loginClientAddress(request));
  const entry: CacheEntry = { result, expiresAt: now + VALID_TTL_MS };
  cache.set(key, entry);
  // A refused token is checked again sooner than a good one.
  void result.then((identity) => {
    if (!identity) entry.expiresAt = Math.min(entry.expiresAt, now + INVALID_TTL_MS);
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
