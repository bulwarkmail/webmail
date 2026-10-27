import { logger } from '@/lib/logger';
import { DisallowedUrlError, fetchPublicUrl } from '@/lib/security/url-guard';
import { generateCodeVerifier, generateCodeChallenge, generateState } from '@/lib/oauth/pkce';
import { forwardedClientHeaders } from '@/lib/auth/client-address';
import {
  STALWART_LOOPBACK_REDIRECT_URI,
  readStalwartLoginResponse,
  stalwartClientRegistration,
  stalwartLoginBody,
} from '@/lib/auth/stalwart-login-request';

export { STALWART_LOOPBACK_REDIRECT_URI };

/**
 * Exchange a password + (optional) TOTP code for OAuth tokens at Stalwart.
 *
 * Stalwart 0.16+ no longer accepts the legacy `password$totp` convention over
 * HTTP Basic auth: its Basic decoder hardcodes `mfa_token: None` and never
 * splits the secret on `$`, so any TOTP appended to the password is verified
 * verbatim against the password hash and fails. The MFA token must instead be
 * supplied as a distinct field through the structured login endpoint:
 *   1. POST {serverUrl}/api/auth  -> authenticate with a separate `mfaToken`,
 *      receiving a short-lived authorization `clientCode`.
 *   2. POST {serverUrl}/auth/token (grant_type=authorization_code) -> exchange
 *      the code (with PKCE) for access/refresh tokens.
 *
 * Used by the password+TOTP login (/api/auth/totp-token-exchange) and by the
 * password step-up that mints a paired phone's own grant (/api/auth/pair).
 * The request and answer differ between Stalwart 0.16 and 1.0, see
 * lib/auth/stalwart-login-request.ts.
 */

export interface StalwartPasswordLoginOptions {
  serverUrl: string;
  username: string;
  password: string;
  totp?: string;
  clientId: string;
  /** Sent at the token endpoint when set; harmless for public clients. */
  clientSecret?: string;
  redirectUri: string;
  /**
   * Whether `serverUrl` is admin-configured. A user-supplied endpoint
   * (allowCustomJmapEndpoint) must connect through the rebinding-safe fetch;
   * admin-configured servers may live on private addresses.
   */
  trusted: boolean;
  /**
   * Address of the signing-in client, forwarded as `X-Forwarded-For` so a
   * mail server that trusts this host counts a wrong password against that
   * client rather than against the webmail (see lib/auth/client-address.ts).
   */
  clientIp?: string;
  /**
   * `clientId` is the built-in default, not one the admin registered. Stalwart
   * 1.0 knows no such client, so the login registers its own (see
   * {@link stalwartDefaultClient}) and signs in with that.
   */
  registerUnknownClient?: boolean;
}

export interface StalwartTokens {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
}

export type StalwartPasswordLoginResult =
  /** `clientId`: the client the tokens belong to; refreshes must present it. */
  | { ok: true; tokens: StalwartTokens; tokenEndpoint: string; clientId: string }
  | {
      ok: false;
      /**
       * - `login_endpoint_missing`: no structured login (404) - older server.
       * - `login_rejected`: /api/auth refused the request itself: an
       *   unregistered client or redirect, a scope the client may not have,
       *   bad PKCE (0.16 answers an HTTP error and does not say which).
       * - `totp_required` / `invalid_credentials`: the credential verdict.
       */
      error:
        | 'login_endpoint_missing'
        | 'login_rejected'
        | 'login_unreachable'
        | 'invalid_server_url'
        | 'totp_required'
        | 'invalid_credentials'
        | 'login_failed'
        | 'token_exchange_failed';
      /** Upstream HTTP status of the failing step, when there was one. */
      status?: number;
      /** Start of the upstream error body - only from a trusted server. */
      detail?: string;
    };

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * The start of an upstream error body, for the login screen. Only from a
 * server the admin configured: a user-chosen server URL makes this a way to
 * read what any public address answers, and together with a gap in the
 * address guard, internal ones too.
 */
async function upstreamDetail(response: Response, trusted: boolean): Promise<string | undefined> {
  if (!trusted) return undefined;
  return (await response.text()).substring(0, 500);
}

/** A redirect that stays on the same origin, or upgrades the same host to https. */
export function isAllowedLoginRedirect(from: string, to: string): boolean {
  const a = new URL(from);
  const b = new URL(to);
  if (a.origin === b.origin) return true;
  return a.hostname === b.hostname && a.protocol === 'http:' && b.protocol === 'https:';
}

/**
 * fetch for an admin-configured server. The requests carry the password, the
 * authorization code, the PKCE verifier and the client secret, so a redirect
 * is followed once and only within the same host; anywhere else is an error.
 */
async function fetchConfiguredServer(input: string, init: RequestInit): Promise<Response> {
  const first = await fetch(input, { ...init, redirect: 'manual' });
  if (first.status < 300 || first.status >= 400) return first;
  const location = first.headers.get('location');
  const next = location ? new URL(location, input).toString() : null;
  if (!next || !isAllowedLoginRedirect(input, next)) {
    throw new Error(`${input} redirects to another host`);
  }
  return fetch(next, { ...init, redirect: 'error' });
}

function upstreamFetchFor(trusted: boolean): typeof fetch {
  return trusted
    ? ((input, init) => fetchConfiguredServer(String(input), init ?? {}))
    : ((input, init) => fetchPublicUrl(String(input), init as Parameters<typeof fetchPublicUrl>[1]) as unknown as Promise<Response>);
}

interface LoginClient {
  clientId: string;
  /** Set for the registered client, which may only use this one. */
  redirectUri?: string;
}

const DEFAULT_CLIENT_TTL_MS = 10 * 60 * 1000;
// Sign-out waits for the client check, so it must not hang.
const CLIENT_CHECK_TIMEOUT_MS = 5000;
const DEFAULT_CLIENT_CACHE_MAX = 64;
const defaultClients = new Map<string, { client: LoginClient; expiresAt: number }>();

function cachedDefaultClient(base: string): LoginClient | null {
  const entry = defaultClients.get(base);
  if (!entry) return null;
  if (entry.expiresAt > Date.now()) return entry.client;
  defaultClients.delete(base);
  return null;
}

function rememberDefaultClient(base: string, client: LoginClient): void {
  if (!defaultClients.has(base) && defaultClients.size >= DEFAULT_CLIENT_CACHE_MAX) {
    const oldest = defaultClients.keys().next().value;
    if (oldest !== undefined) defaultClients.delete(oldest);
  }
  defaultClients.set(base, { client, expiresAt: Date.now() + DEFAULT_CLIENT_TTL_MS });
}

/** Test hook. */
export function resetStalwartDefaultClients(): void {
  defaultClients.clear();
}

/** Registers Bulwark as a public client at Stalwart 1.0 (see stalwartClientRegistration). */
async function registerPublicClient(base: string, upstreamFetch: typeof fetch): Promise<LoginClient | null> {
  try {
    const response = await upstreamFetch(`${base}/auth/register`, {
      method: 'POST',
      signal: AbortSignal.timeout(CLIENT_CHECK_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stalwartClientRegistration()),
    });
    if (!response.ok) {
      logger.warn('Stalwart password login: client registration refused', { status: response.status });
      return null;
    }
    const body = (await response.json()) as { client_id?: unknown };
    if (typeof body.client_id !== 'string' || !body.client_id) return null;
    const client = { clientId: body.client_id, redirectUri: STALWART_LOOPBACK_REDIRECT_URI };
    rememberDefaultClient(base, client);
    return client;
  } catch (err) {
    logger.warn('Stalwart password login: client registration failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * The client that tokens from a login with the built-in default client id
 * belong to. Stalwart 0.16 accepts any client id; 1.0 only one it knows, so
 * there the login registers its own (see {@link stalwartPasswordLogin}).
 * Refreshing and revoking those tokens must present the same id: this asks
 * 1.0's client check (GET /api/auth/client, which 0.16 doesn't have) whether
 * the server knows `defaultClientId`, and registers when it doesn't.
 */
export async function stalwartDefaultClientId(
  serverUrl: string,
  defaultClientId: string,
  trusted: boolean,
): Promise<string> {
  const base = trimUrl(serverUrl);
  const cached = cachedDefaultClient(base);
  if (cached) return cached.clientId;
  const upstreamFetch = upstreamFetchFor(trusted);
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: defaultClientId,
    redirect_uri: STALWART_LOOPBACK_REDIRECT_URI,
    state: 'probe',
    code_challenge: 'A'.repeat(43),
    code_challenge_method: 'S256',
  });
  let unknown: boolean;
  try {
    const response = await upstreamFetch(`${base}/api/auth/client?${query}`, {
      method: 'GET',
      signal: AbortSignal.timeout(CLIENT_CHECK_TIMEOUT_MS),
    });
    const body = response.ok ? ((await response.json().catch(() => null)) as { error?: unknown } | null) : null;
    unknown = body?.error === 'invalid_client';
  } catch {
    // Unreachable: the request that asked fails on its own.
    return defaultClientId;
  }
  if (unknown) {
    const registered = await registerPublicClient(base, upstreamFetch);
    return registered?.clientId ?? defaultClientId;
  }
  rememberDefaultClient(base, { clientId: defaultClientId });
  return defaultClientId;
}

type LoginStep =
  | { ok: true; code: string }
  | (Extract<StalwartPasswordLoginResult, { ok: false }> & { rejection?: string });

/** POST /api/auth: the credentials for an authorization code. */
async function requestLoginCode(
  base: string,
  upstreamFetch: typeof fetch,
  opts: StalwartPasswordLoginOptions,
  client: LoginClient,
  challenge: string,
): Promise<LoginStep> {
  const state = generateState();
  let body: unknown;
  try {
    const loginResponse = await upstreamFetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...forwardedClientHeaders(opts.clientIp) },
      body: JSON.stringify(stalwartLoginBody({
        username: opts.username,
        password: opts.password,
        totp: opts.totp,
        clientId: client.clientId,
        redirectUri: client.redirectUri ?? opts.redirectUri,
        codeChallenge: challenge,
        state,
      })),
    });

    if (!loginResponse.ok) {
      const detail = await upstreamDetail(loginResponse, opts.trusted);
      logger.warn('Stalwart password login: /api/auth rejected request', { status: loginResponse.status });
      return {
        ok: false,
        error: loginResponse.status === 404 ? 'login_endpoint_missing' : 'login_rejected',
        status: loginResponse.status,
        detail,
      };
    }

    body = await loginResponse.json();
  } catch (err) {
    if (err instanceof DisallowedUrlError) {
      logger.warn('Stalwart password login: rejected non-public server URL at connect time');
      return { ok: false, error: 'invalid_server_url' };
    }
    logger.warn('Stalwart password login: /api/auth request failed', { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: 'login_unreachable' };
  }

  const outcome = readStalwartLoginResponse(body, state);
  switch (outcome.kind) {
    case 'code':
      return { ok: true, code: outcome.code };
    case 'mfa_required':
      return { ok: false, error: 'totp_required' };
    case 'invalid_credentials':
      return { ok: false, error: 'invalid_credentials' };
    case 'rejected':
      logger.warn('Stalwart password login: authorization refused', { error: outcome.error });
      return {
        ok: false,
        error: 'login_rejected',
        rejection: outcome.error,
        ...(opts.trusted ? { detail: [outcome.error, outcome.description].filter(Boolean).join(': ') } : {}),
      };
  }
}

export async function stalwartPasswordLogin(
  opts: StalwartPasswordLoginOptions,
): Promise<StalwartPasswordLoginResult> {
  const base = trimUrl(opts.serverUrl);
  const upstreamFetch = upstreamFetchFor(opts.trusted);

  // PKCE proves the token exchange originates from the same client that
  // initiated the login, so no client secret is required for public clients.
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);

  // Step 1: structured login with a separate MFA token.
  let client: LoginClient = (opts.registerUnknownClient && cachedDefaultClient(base)) || { clientId: opts.clientId };
  let login = await requestLoginCode(base, upstreamFetch, opts, client, challenge);
  // Stalwart 1.0 checks the client before the credentials, so the first
  // attempt costs no failed sign-in.
  if (!login.ok && login.rejection === 'invalid_client' && opts.registerUnknownClient && !client.redirectUri) {
    const registered = await registerPublicClient(base, upstreamFetch);
    if (registered) {
      client = registered;
      login = await requestLoginCode(base, upstreamFetch, opts, client, challenge);
    }
  }
  if (!login.ok) {
    const { rejection: _rejection, ...failure } = login;
    return failure;
  }

  // Step 2: exchange the authorization code for tokens.
  const tokenEndpoint = `${base}/auth/token`;
  const tokenParams = new URLSearchParams({
    grant_type: 'authorization_code',
    code: login.code,
    client_id: client.clientId,
    redirect_uri: client.redirectUri ?? opts.redirectUri,
    code_verifier: verifier,
  });
  // Confidential clients still send their secret; harmless for public clients.
  // The secret is the admin's, for the admin's server: a user-chosen server
  // (allowCustomJmapEndpoint) never receives it. The client registered above
  // has none.
  if (opts.clientSecret && opts.trusted && !client.redirectUri) tokenParams.set('client_secret', opts.clientSecret);

  let tokens: { access_token?: string; expires_in?: number; refresh_token?: string };
  try {
    const tokenResponse = await upstreamFetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...forwardedClientHeaders(opts.clientIp) },
      body: tokenParams.toString(),
    });

    if (!tokenResponse.ok) {
      const detail = await upstreamDetail(tokenResponse, opts.trusted);
      logger.warn('Stalwart password login: token exchange failed', { status: tokenResponse.status, detail });
      return { ok: false, error: 'token_exchange_failed', status: tokenResponse.status, detail };
    }

    tokens = await tokenResponse.json();
  } catch (err) {
    if (err instanceof DisallowedUrlError) {
      logger.warn('Stalwart password login: rejected non-public server URL at connect time');
      return { ok: false, error: 'invalid_server_url' };
    }
    logger.warn('Stalwart password login: token endpoint failed', { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: 'token_exchange_failed' };
  }

  if (!tokens.access_token) {
    return { ok: false, error: 'token_exchange_failed', detail: 'Response missing access_token' };
  }

  return {
    ok: true,
    tokens: { access_token: tokens.access_token, expires_in: tokens.expires_in, refresh_token: tokens.refresh_token },
    tokenEndpoint,
    clientId: client.clientId,
  };
}
