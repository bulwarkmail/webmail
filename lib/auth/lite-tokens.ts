import { generateCodeVerifier, generateCodeChallenge } from '@/lib/oauth/pkce';
import { IS_LITE_STALWART, getLiteInjectedClientId } from '@/lib/lite';

/**
 * Cookie-free sessions for the static Lite build.
 *
 * The regular build keeps refresh tokens and "remember me" passwords in
 * encrypted cookies written by /api/auth/*. Lite has no server, so it does
 * what Stalwart's own web admin does: authenticate against the mail server's
 * structured login endpoint straight from the browser
 *
 *   POST <server>/api/auth   (password + optional MFA token, PKCE challenge)
 *     -> authorization code
 *   POST <server>/auth/token (grant_type=authorization_code)
 *     -> access token (memory) + refresh token
 *
 * (or, for an account an external OpenID provider signs in, through that
 * provider's redirect flow: lib/auth/lite-oauth.ts)
 *
 * and renew with `grant_type=refresh_token`. The refresh token is the only
 * thing that persists: localStorage when the user ticked "remember me",
 * sessionStorage (this tab only) otherwise. Servers without /api/auth (older
 * Stalwart, other JMAP servers) fall back to Basic auth; those sessions can
 * only survive a reload inside the same tab.
 *
 * Trade-off, documented in LITE-README.md: a refresh token in web storage is
 * readable by any script on the origin. That is the standard SPA position,
 * and strictly better than storing the password.
 */

/**
 * OAuth client id registered with Stalwart. Mirrors DEFAULT_CLIENT_ID in
 * lib/oauth/token-exchange.ts, which cannot be imported here: that module
 * reads secrets from the filesystem and must stay out of the browser bundle.
 */
export const LITE_CLIENT_ID = 'bulwark-webmail';

/**
 * The client id Lite presents to Stalwart: the `oauthClientId` of the
 * Stalwart `Application` that serves the bundle (injected into the root
 * index.html, see lib/lite.ts) when there is one, else `LITE_CLIENT_ID`.
 */
export function getLiteClientId(): string {
  return getLiteInjectedClientId() || LITE_CLIENT_ID;
}

export type LiteLoginErrorCode =
  | 'endpoint_missing'
  | 'totp_required'
  | 'invalid_credentials'
  | 'login_failed'
  | 'token_exchange_failed'
  | 'refresh_rejected';

export class LiteLoginError extends Error {
  constructor(readonly code: LiteLoginErrorCode, readonly status?: number, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'LiteLoginError';
  }
}

export interface LiteTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string | null;
}

interface StoredRefreshToken {
  serverUrl: string;
  username: string;
  refreshToken: string;
  /** Client the token was issued to; refreshes must present the same one. */
  clientId?: string;
  /**
   * Where the token is renewed when that is not `<serverUrl>/auth/token`: an
   * OAuth sign-in through the external provider Stalwart delegates a domain
   * to (lib/auth/lite-oauth.ts) is refreshed at that provider.
   */
  tokenEndpoint?: string;
  /** RFC 7009 endpoint that revokes the token on sign-out, when discovery named one. */
  revocationEndpoint?: string;
}

interface StoredBasicSession {
  serverUrl: string;
  username: string;
  password: string;
}

const REFRESH_KEY_PREFIX = 'bulwark-lite:refresh:';
const BASIC_KEY_PREFIX = 'bulwark-lite:basic:';

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function readJson<T>(store: Storage | null, key: string): T | null {
  try {
    const raw = store?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(store: Storage | null, key: string, value: unknown): void {
  try {
    store?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the session simply won't survive a reload.
  }
}

function remove(store: Storage | null, key: string): void {
  try {
    store?.removeItem(key);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Persists a refresh token for an account slot. `persistent` (remember me)
 * survives browser restarts; otherwise the token lives with the tab.
 */
export function saveLiteRefreshToken(
  slot: number,
  entry: StoredRefreshToken,
  persistent: boolean,
): void {
  const key = `${REFRESH_KEY_PREFIX}${slot}`;
  remove(storage('local'), key);
  remove(storage('session'), key);
  writeJson(storage(persistent ? 'local' : 'session'), key, { ...entry, serverUrl: trimUrl(entry.serverUrl) });
}

export function readLiteRefreshToken(slot: number): StoredRefreshToken | null {
  const key = `${REFRESH_KEY_PREFIX}${slot}`;
  const entry = readJson<StoredRefreshToken>(storage('local'), key) ?? readJson<StoredRefreshToken>(storage('session'), key);
  return entry && typeof entry.refreshToken === 'string' && entry.refreshToken ? entry : null;
}

/** Where the slot's refresh token currently lives, so a rotation stays put. */
function refreshTokenIsPersistent(slot: number): boolean {
  return readJson<StoredRefreshToken>(storage('local'), `${REFRESH_KEY_PREFIX}${slot}`) !== null;
}

/**
 * Records whose refresh token the slot holds. An OAuth sign-in stores the
 * token before it knows the account: only the JMAP session names it.
 */
export function nameLiteRefreshToken(slot: number, username: string): void {
  const stored = readLiteRefreshToken(slot);
  if (!stored || stored.username === username) return;
  saveLiteRefreshToken(slot, { ...stored, username }, refreshTokenIsPersistent(slot));
}

export function clearLiteRefreshToken(slot: number): void {
  const key = `${REFRESH_KEY_PREFIX}${slot}`;
  remove(storage('local'), key);
  remove(storage('session'), key);
}

/**
 * Basic-auth fallback for servers without token login: the credentials stay
 * with this tab (sessionStorage) so a reload does not end the session.
 */
export function saveLiteBasicSession(slot: number, entry: StoredBasicSession): void {
  writeJson(storage('session'), `${BASIC_KEY_PREFIX}${slot}`, { ...entry, serverUrl: trimUrl(entry.serverUrl) });
}

export function readLiteBasicSession(slot: number): StoredBasicSession | null {
  const entry = readJson<StoredBasicSession>(storage('session'), `${BASIC_KEY_PREFIX}${slot}`);
  return entry && typeof entry.password === 'string' ? entry : null;
}

export function clearLiteBasicSession(slot: number): void {
  remove(storage('session'), `${BASIC_KEY_PREFIX}${slot}`);
}

export function clearLiteSlot(slot: number): void {
  clearLiteRefreshToken(slot);
  clearLiteBasicSession(slot);
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

// Sign-out waits for this, so an unresponsive endpoint must not hold it up.
const REVOCATION_TIMEOUT_MS = 3000;

/** The revocation endpoint a Stalwart server advertises, if any. */
async function discoverRevocationEndpoint(serverUrl: string): Promise<string | null> {
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    try {
      const response = await fetch(`${serverUrl}${path}`, { signal: AbortSignal.timeout(REVOCATION_TIMEOUT_MS) });
      if (!response.ok) continue;
      const endpoint = ((await response.json()) as { revocation_endpoint?: unknown }).revocation_endpoint;
      return typeof endpoint === 'string' && /^https?:\/\//.test(endpoint) ? endpoint : null;
    } catch {
      // Try the next document.
    }
  }
  return null;
}

async function revokeRefreshToken(entry: StoredRefreshToken): Promise<void> {
  // A token from an external provider is only revoked where its own
  // discovery said; Stalwart's own tokens can be looked up.
  const endpoint = entry.revocationEndpoint
    ?? (entry.tokenEndpoint ? null : await discoverRevocationEndpoint(trimUrl(entry.serverUrl)));
  if (!endpoint) return;
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: entry.refreshToken,
        token_type_hint: 'refresh_token',
        client_id: entry.clientId || getLiteClientId(),
      }).toString(),
      signal: AbortSignal.timeout(REVOCATION_TIMEOUT_MS),
      // Finishes even when sign-out navigates away first.
      keepalive: true,
      redirect: 'error',
    });
  } catch {
    // Best effort: the token is gone from this browser either way.
  }
}

/**
 * Sign a slot out: forget its credentials at once, then revoke its refresh
 * token so a copy taken from this browser's storage stops working too.
 */
export async function revokeLiteSlot(slot: number): Promise<void> {
  const entry = readLiteRefreshToken(slot);
  clearLiteSlot(slot);
  if (entry) await revokeRefreshToken(entry);
}

/** {@link revokeLiteSlot} for every slot. */
export async function revokeAllLiteSessions(): Promise<void> {
  const entries: StoredRefreshToken[] = [];
  for (const kind of ['local', 'session'] as const) {
    const store = storage(kind);
    if (!store) continue;
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (!key?.startsWith(REFRESH_KEY_PREFIX)) continue;
        const entry = readJson<StoredRefreshToken>(store, key);
        if (entry && typeof entry.refreshToken === 'string' && entry.refreshToken) entries.push(entry);
      }
    } catch {
      continue;
    }
  }
  clearAllLiteSessions();
  await Promise.all(entries.map(revokeRefreshToken));
}

export function clearAllLiteSessions(): void {
  for (const kind of ['local', 'session'] as const) {
    const store = storage(kind);
    if (!store) continue;
    const keys: string[] = [];
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key && (key.startsWith(REFRESH_KEY_PREFIX) || key.startsWith(BASIC_KEY_PREFIX))) keys.push(key);
      }
    } catch {
      continue;
    }
    keys.forEach((key) => remove(store, key));
  }
}

// ---------------------------------------------------------------------------
// Stalwart endpoints
// ---------------------------------------------------------------------------

interface LoginResponse {
  type?: string;
  client_code?: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
}

/**
 * Password (+ optional TOTP) login against Stalwart's structured endpoint.
 * Mirrors app/api/auth/totp-token-exchange/route.ts, minus the server hop.
 */
export async function liteTokenLogin(params: {
  serverUrl: string;
  username: string;
  password: string;
  totp?: string;
  redirectUri: string;
  clientId?: string;
}): Promise<LiteTokens> {
  const base = trimUrl(params.serverUrl);
  const clientId = params.clientId || getLiteClientId();
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);

  const loginResponse = await fetch(`${base}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'authCode',
      accountName: params.username,
      accountSecret: params.password,
      ...(params.totp ? { mfaToken: params.totp } : {}),
      clientId,
      redirectUri: params.redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    }),
  });

  if (!loginResponse.ok) {
    if (loginResponse.status === 404 || loginResponse.status === 405 || loginResponse.status === 501) {
      throw new LiteLoginError('endpoint_missing', loginResponse.status);
    }
    const detail = (await loginResponse.text().catch(() => '')).slice(0, 200);
    throw new LiteLoginError('login_failed', loginResponse.status, detail);
  }

  const login = (await loginResponse.json().catch(() => ({}))) as LoginResponse;
  switch (login.type) {
    case 'authenticated':
      break;
    case 'mfaRequired':
      throw new LiteLoginError('totp_required', 401);
    default:
      throw new LiteLoginError('invalid_credentials', 401);
  }
  if (!login.client_code) throw new LiteLoginError('login_failed', 502, 'missing client_code');

  const tokenResponse = await fetch(`${base}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: login.client_code,
      client_id: clientId,
      redirect_uri: params.redirectUri,
      code_verifier: verifier,
    }).toString(),
  });
  const tokens = (await tokenResponse.json().catch(() => ({}))) as TokenResponse;
  if (!tokenResponse.ok || !tokens.access_token) {
    throw new LiteLoginError('token_exchange_failed', tokenResponse.status, tokens.error);
  }
  return {
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in || 3600,
    refreshToken: tokens.refresh_token ?? null,
  };
}

/**
 * Second half of the OAuth redirect flow (lib/auth/lite-oauth.ts): trades the
 * authorization code for tokens at the endpoint discovery named, which is
 * Stalwart's own `/auth/token` or the external provider's. Mirrors the POST
 * branch of app/api/auth/token/route.ts, minus the server hop; a public
 * client, so PKCE stands in for the secret.
 */
export async function liteExchangeAuthorizationCode(params: {
  tokenEndpoint: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
}): Promise<LiteTokens> {
  const response = await fetch(params.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    }).toString(),
  });
  const tokens = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !tokens.access_token) {
    throw new LiteLoginError('token_exchange_failed', response.status, tokens.error);
  }
  return {
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in || 3600,
    refreshToken: tokens.refresh_token ?? null,
  };
}

/**
 * Renews the slot's access token. A rejected refresh token clears the slot and
 * throws `refresh_rejected`; a network failure or 5xx propagates untouched so
 * callers treat it as an outage, not a sign-out.
 */
export async function liteRefreshTokens(slot: number, clientIdOverride?: string): Promise<LiteTokens> {
  const stored = readLiteRefreshToken(slot);
  if (!stored) throw new LiteLoginError('refresh_rejected', 401, 'no refresh token');
  const clientId = clientIdOverride || stored.clientId || getLiteClientId();

  const response = await fetch(stored.tokenEndpoint || `${stored.serverUrl}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
      client_id: clientId,
    }).toString(),
  });

  // Only a definitive refusal (400/401/403) ends the session, as in the
  // server build. A rate limit (429), a request timeout (408) or a 5xx is an
  // outage: the refresh token stays, so the session resumes once the server
  // answers again.
  const refused = response.status === 400 || response.status === 401 || response.status === 403;
  if (!response.ok && !refused) {
    throw new LiteLoginError('token_exchange_failed', response.status);
  }
  const tokens = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !tokens.access_token) {
    clearLiteRefreshToken(slot);
    throw new LiteLoginError('refresh_rejected', response.status || 401, tokens.error);
  }
  if (tokens.refresh_token && tokens.refresh_token !== stored.refreshToken) {
    saveLiteRefreshToken(slot, { ...stored, refreshToken: tokens.refresh_token }, refreshTokenIsPersistent(slot));
  }
  return {
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in || 3600,
    refreshToken: tokens.refresh_token ?? stored.refreshToken,
  };
}

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

const probeCache = new Map<string, Promise<boolean | null>>();

/**
 * Whether `serverUrl` exposes Stalwart's structured login (and therefore
 * "remember me" across browser restarts). `null` means the probe could not
 * tell (unreachable, CORS blocked) - callers then attempt token login anyway
 * and fall back on `endpoint_missing`.
 */
export function probeLiteTokenLogin(serverUrl: string): Promise<boolean | null> {
  const base = trimUrl(serverUrl);
  if (!/^https?:\/\//.test(base)) return Promise.resolve(false);
  // Served by Stalwart itself (an Application bundle, 0.16+): the page's own
  // origin has /api/auth. Probing would only log a 400 for the empty body.
  if (IS_LITE_STALWART && typeof window !== 'undefined' && base === window.location.origin) return Promise.resolve(true);
  let pending = probeCache.get(base);
  if (!pending) {
    pending = fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
      .then((res) => !(res.status === 404 || res.status === 405 || res.status === 501))
      .catch(() => null);
    probeCache.set(base, pending);
  }
  return pending;
}

/** Test hook. */
export function resetLiteProbeCache(): void {
  probeCache.clear();
}
