/**
 * Request and answer of Stalwart's structured login endpoint (POST /api/auth),
 * shared by the server-side password+TOTP login and the Lite build. Kept free
 * of server imports so the browser bundle can use it.
 *
 * The two server lines speak different dialects:
 * - 0.16 takes the authorization parameters as fields (`clientId`,
 *   `redirectUri`, `codeChallenge`, ...) and answers
 *   `{ type: "authenticated", client_code }`.
 * - 1.0 takes the authorization request as a query string (`query`), wants
 *   `consent: true` for any client it doesn't host itself, and answers
 *   `{ type: "authenticated", location }`, the redirect URI carrying the code.
 *   It refuses a body without `query` ("JSON deserialization failed").
 * Neither rejects fields it doesn't know, so one body serves both.
 */

/**
 * The data scopes Stalwart 1.0 grants per client. A token issued to a client
 * Stalwart doesn't treat as first-party reaches only what these name (no
 * scope: nothing but the session); 0.16 ignores them.
 */
export const STALWART_LOGIN_SCOPE = [
  'openid',
  'offline_access',
  'urn:ietf:params:oauth:scope:mail',
  'urn:ietf:params:oauth:scope:contacts',
  'urn:ietf:params:oauth:scope:calendars',
  'urn:ietf:params:oauth:scope:files',
].join(' ');

export interface StalwartLoginRequest {
  username: string;
  password: string;
  totp?: string;
  clientId: string;
  redirectUri: string;
  /** S256 PKCE challenge. */
  codeChallenge: string;
  /** Echoed back in 1.0's redirect location. */
  state: string;
}

export function stalwartLoginBody(req: StalwartLoginRequest): Record<string, unknown> {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: req.clientId,
    redirect_uri: req.redirectUri,
    state: req.state,
    scope: STALWART_LOGIN_SCOPE,
    code_challenge: req.codeChallenge,
    code_challenge_method: 'S256',
  });
  return {
    type: 'authCode',
    accountName: req.username,
    accountSecret: req.password,
    ...(req.totp ? { mfaToken: req.totp } : {}),
    // Stalwart 0.16
    clientId: req.clientId,
    redirectUri: req.redirectUri,
    codeChallenge: req.codeChallenge,
    codeChallengeMethod: 'S256',
    // Stalwart 1.0. The user typed their password into this client's own
    // sign-in form, which is the consent the server would otherwise ask for.
    query: query.toString(),
    consent: true,
  };
}

export type StalwartLoginOutcome =
  | { kind: 'code'; code: string }
  | { kind: 'mfa_required' }
  | { kind: 'invalid_credentials' }
  /**
   * The server refused the authorization request itself (1.0: unknown
   * client, redirect URI not registered, scope not allowed), before looking
   * at the credentials.
   */
  | { kind: 'rejected'; error: string; description?: string };

function locationParams(location: string): URLSearchParams | null {
  try {
    return new URL(location).searchParams;
  } catch {
    return null;
  }
}

/** Reads the JSON answer of POST /api/auth (HTTP 200) of either server line. */
export function readStalwartLoginResponse(body: unknown, state: string): StalwartLoginOutcome {
  const res = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  switch (res.type) {
    case 'authenticated': {
      if (typeof res.client_code === 'string' && res.client_code) {
        return { kind: 'code', code: res.client_code };
      }
      const params = typeof res.location === 'string' ? locationParams(res.location) : null;
      const code = params?.get('code');
      if (!code) return { kind: 'rejected', error: 'missing_code' };
      if (params?.get('state') !== state) return { kind: 'rejected', error: 'state_mismatch' };
      return { kind: 'code', code };
    }
    case 'mfaRequired':
      return { kind: 'mfa_required' };
    case 'invalid':
      return {
        kind: 'rejected',
        error: typeof res.error === 'string' ? res.error : 'invalid_request',
        ...(typeof res.description === 'string' ? { description: res.description } : {}),
      };
    case 'redirect': {
      // 1.0 sends errors it may show the client to the redirect URI.
      const params = typeof res.location === 'string' ? locationParams(res.location) : null;
      const description = params?.get('error_description');
      return {
        kind: 'rejected',
        error: params?.get('error') || 'access_denied',
        ...(description ? { description } : {}),
      };
    }
    default:
      return { kind: 'invalid_credentials' };
  }
}

/**
 * Redirect URI of the client Bulwark registers at a Stalwart 1.0 that knows
 * none of its own (see {@link stalwartClientRegistration}). No browser is ever
 * sent there: /api/auth hands the redirect location back in its answer and
 * the code is read from it. 1.0 lets a public client register only a loopback
 * or private-use redirect URI.
 */
export const STALWART_LOOPBACK_REDIRECT_URI = 'http://127.0.0.1/bulwark-webmail/callback';

/**
 * Body of the RFC 7591 registration (POST /auth/register) of Bulwark as a
 * public client, which Stalwart 1.0 accepts without credentials. Its client
 * ids are stateless, sealed with the server's key: the same metadata registers
 * to the same id again, so nothing has to be stored or cleaned up. Tokens for
 * it reach mail, contacts, calendars and files (the scopes it registers), but
 * not the account's Stalwart settings (password, TOTP, app passwords): only a
 * first-party client gets those.
 */
export function stalwartClientRegistration(): Record<string, unknown> {
  return {
    client_name: 'Bulwark Webmail',
    redirect_uris: [STALWART_LOOPBACK_REDIRECT_URI],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: STALWART_LOGIN_SCOPE,
  };
}
