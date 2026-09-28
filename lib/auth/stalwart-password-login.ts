import { logger } from '@/lib/logger';
import { DisallowedUrlError, fetchPublicUrl } from '@/lib/security/url-guard';
import { generateCodeVerifier, generateCodeChallenge } from '@/lib/oauth/pkce';

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
 */

interface LoginResult {
  type?: string;
  // The response keeps snake_case: only the LoginResponse variant *tags* are
  // camelCased server-side, not the struct fields (the request fields are).
  client_code?: string;
}

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
}

export interface StalwartTokens {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
}

export type StalwartPasswordLoginResult =
  | { ok: true; tokens: StalwartTokens; tokenEndpoint: string }
  | {
      ok: false;
      /**
       * - `login_endpoint_missing`: no structured login (404) - older server.
       * - `login_rejected`: /api/auth refused the request itself (HTTP error):
       *   an unregistered client or redirect, bad PKCE; Stalwart does not say.
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

export async function stalwartPasswordLogin(
  opts: StalwartPasswordLoginOptions,
): Promise<StalwartPasswordLoginResult> {
  const base = trimUrl(opts.serverUrl);
  const upstreamFetch: typeof fetch = opts.trusted
    ? fetch
    : ((input, init) => fetchPublicUrl(String(input), init as Parameters<typeof fetchPublicUrl>[1]) as unknown as Promise<Response>);

  // PKCE proves the token exchange originates from the same client that
  // initiated the login, so no client secret is required for public clients.
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);

  // Step 1: structured login with a separate MFA token.
  let login: LoginResult;
  try {
    const loginResponse = await upstreamFetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'authCode',
        accountName: opts.username,
        accountSecret: opts.password,
        ...(opts.totp ? { mfaToken: opts.totp } : {}),
        clientId: opts.clientId,
        redirectUri: opts.redirectUri,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
      }),
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

    login = await loginResponse.json();
  } catch (err) {
    if (err instanceof DisallowedUrlError) {
      logger.warn('Stalwart password login: rejected non-public server URL at connect time');
      return { ok: false, error: 'invalid_server_url' };
    }
    logger.warn('Stalwart password login: /api/auth request failed', { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: 'login_unreachable' };
  }

  switch (login.type) {
    case 'authenticated':
      break;
    case 'mfaRequired':
      return { ok: false, error: 'totp_required' };
    case 'failure':
    default:
      return { ok: false, error: 'invalid_credentials' };
  }

  if (!login.client_code) {
    logger.warn('Stalwart password login: authenticated response missing client_code');
    return { ok: false, error: 'login_failed' };
  }

  // Step 2: exchange the authorization code for tokens.
  const tokenEndpoint = `${base}/auth/token`;
  const tokenParams = new URLSearchParams({
    grant_type: 'authorization_code',
    code: login.client_code,
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_verifier: verifier,
  });
  // Confidential clients still send their secret; harmless for public clients.
  // The secret is the admin's, for the admin's server: a user-chosen server
  // (allowCustomJmapEndpoint) never receives it.
  if (opts.clientSecret && opts.trusted) tokenParams.set('client_secret', opts.clientSecret);

  let tokens: { access_token?: string; expires_in?: number; refresh_token?: string };
  try {
    const tokenResponse = await upstreamFetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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
  };
}
