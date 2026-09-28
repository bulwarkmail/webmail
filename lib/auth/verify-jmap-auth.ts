import {
  DisallowedUrlError,
  fetchPublicUrl,
  isPublicHttpUrl,
  type PublicFetchResponse,
} from '@/lib/security/url-guard';

const VERIFY_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;

export class JmapAuthVerificationError extends Error {
  status: number;
  /**
   * HTTP status the JMAP server itself answered with, when the failure came
   * from an upstream response rather than URL validation, a timeout or a
   * network error. Lets callers tell a definitive credential rejection (401)
   * apart from everything else that happens to map to the same `status`.
   */
  upstreamStatus?: number;
  /**
   * Node network/TLS error code when the server could not be reached at all
   * (`DEPTH_ZERO_SELF_SIGNED_CERT`, `ENOTFOUND`, ...). The browser may reach
   * the mail server fine while this process cannot, so this is the only
   * trace of why the identity cookie was not minted (#1073).
   */
  code?: string;

  constructor(message: string, status: number, upstreamStatus?: number, code?: string) {
    super(message);
    this.name = 'JmapAuthVerificationError';
    this.status = status;
    this.upstreamStatus = upstreamStatus;
    this.code = code;
  }
}

/** Error code behind a failed fetch; undici wraps the socket error in `cause`. */
export function networkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const UNTRUSTED_CERT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
]);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Operator-facing explanation for a {@link networkErrorCode}, if it is a known one. */
export function upstreamFailureHint(code: string | undefined): string | undefined {
  if (!code) return undefined;
  if (UNTRUSTED_CERT_CODES.has(code)) {
    return 'The webmail server does not trust the mail server\'s TLS certificate (self-signed or private CA). '
      + 'Set NODE_EXTRA_CA_CERTS in the webmail container to a file holding that certificate or its CA.';
  }
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return 'The mail server\'s TLS certificate does not cover the host name in the configured JMAP server URL.';
  }
  if (code === 'CERT_HAS_EXPIRED') {
    return 'The mail server\'s TLS certificate has expired.';
  }
  if (DNS_CODES.has(code)) {
    return 'The webmail server cannot resolve the mail server\'s host name. The configured JMAP server URL '
      + 'must resolve from the webmail server (e.g. inside its container), not only from the browser.';
  }
  if (CONNECT_CODES.has(code)) {
    return 'The webmail server cannot connect to the mail server at the configured JMAP server URL.';
  }
  return undefined;
}

function isSupportedProtocol(protocol: string): boolean {
  return protocol === 'http:' || protocol === 'https:';
}

export function normalizeJmapServerUrl(serverUrl: string): string {
  // App-relative URLs (the dev mock JMAP server, e.g. /api/dev-jmap) have no
  // host or protocol to validate; they can only ever target this app itself.
  // Protocol-relative URLs (//host/...) are NOT app-relative and fall through
  // to the absolute-URL parse below, which rejects them.
  if (serverUrl.startsWith('/') && !serverUrl.startsWith('//')) {
    const url = new URL(serverUrl, 'http://relative.invalid');
    return url.pathname.replace(/\/+$/, '');
  }

  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new JmapAuthVerificationError('Invalid server URL', 400);
  }

  if (!isSupportedProtocol(url.protocol)) {
    throw new JmapAuthVerificationError('Unsupported server URL protocol', 400);
  }

  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

export function validateProxyAuthHeader(authHeader: string): void {
  if (!/^(?:Basic|Bearer)\s+\S+$/i.test(authHeader)) {
    throw new JmapAuthVerificationError('Invalid Authorization header', 400);
  }
}

/**
 * For a `Basic` Authorization header, assert that the user portion of the
 * credentials matches `claimedUsername`. Prevents callers of routes that
 * accept independent `username` + `authHeader` fields from binding a cookie
 * to one identity while authenticating as another. No-op for Bearer.
 */
export function assertBasicAuthMatchesUsername(authHeader: string, claimedUsername: string): void {
  const match = /^Basic\s+(\S+)$/i.exec(authHeader);
  if (!match) return;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    throw new JmapAuthVerificationError('Invalid Authorization header', 400);
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) {
    throw new JmapAuthVerificationError('Invalid Authorization header', 400);
  }
  const credUser = decoded.slice(0, colon);
  if (credUser !== claimedUsername) {
    throw new JmapAuthVerificationError('Username does not match credentials', 400);
  }
}

export interface VerifiedJmapSession {
  apiUrl: string;
  /** Canonical login name the server reports for the credential (RFC 8620 §2). */
  username?: string;
  primaryAccounts?: Record<string, string>;
  accounts: Record<string, unknown>;
}

export interface VerifyJmapAuthOptions {
  trusted?: boolean;
}

/**
 * Verify `authHeader` against `serverUrl` and return the normalized URL.
 * Callers that need to bind a username claim to the credential must use
 * {@link verifyJmapIdentity} instead: a valid credential alone says nothing
 * about *which* user it belongs to.
 */
export async function verifyJmapAuth(
  serverUrl: string,
  authHeader: string,
  options: VerifyJmapAuthOptions = {},
): Promise<string> {
  const { serverUrl: normalizedServerUrl } = await fetchVerifiedSession(serverUrl, authHeader, options);
  return normalizedServerUrl;
}

function usernamesEqual(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

/**
 * Does the claimed login name denote the server-reported one? Stalwart
 * canonicalizes the login it echoes in `Session.username` (`UserA@x` and the
 * bare local part `usera` both come back as `usera@x`), so besides a
 * case-insensitive match we accept a bare local part on either side.
 */
export function usernameMatchesSession(claimed: string, sessionUsername: string | undefined): boolean {
  if (!sessionUsername) return false;
  if (usernamesEqual(claimed, sessionUsername)) return true;
  const claimedAt = claimed.indexOf('@');
  const sessionAt = sessionUsername.indexOf('@');
  if (claimedAt < 0 && sessionAt > 0) {
    return usernamesEqual(claimed, sessionUsername.slice(0, sessionAt));
  }
  if (sessionAt < 0 && claimedAt > 0) {
    return usernamesEqual(claimed.slice(0, claimedAt), sessionUsername);
  }
  return false;
}

/**
 * Verify `authHeader` upstream AND prove that `claimedUsername` is the user
 * that credential authenticates (GHSA-wxcm-j4jc-9fxq). The identity cookies
 * minted from this result are consumed by routes that trust the cookie's
 * username claim without contacting the mail server (settings sync, plugin
 * approval attribution), so an unbound claim is a cross-user forgery.
 *
 *  - Basic: the credential's user part must equal the claim; the upstream
 *    session fetch then proves that user's password is right.
 *  - Bearer: the token is opaque, so the claim is checked against the
 *    server's `Session.username`, and failing that against the e-mail
 *    addresses of the account's sending identities (OAuth/SSO logins register
 *    under the primary identity's e-mail, which may differ from the login).
 *
 * Returns the normalized server URL.
 */
export async function verifyJmapIdentity(
  serverUrl: string,
  authHeader: string,
  claimedUsername: string,
  options: VerifyJmapAuthOptions = {},
): Promise<string> {
  return (await resolveJmapIdentity(serverUrl, authHeader, claimedUsername, options)).serverUrl;
}

export interface ResolvedJmapIdentity {
  /** Normalized server URL. */
  serverUrl: string;
  /**
   * The account the credential belongs to. Equal to the claim, except for a
   * Bearer credential claimed with a bare local part: that claim names no
   * domain, so two users (`john@a.example`, `john@b.example`) would share it,
   * and the server's canonical `Session.username` is used instead. Anything
   * keyed per user (synced settings) must key on this, not on the claim.
   */
  accountName: string;
}

/** {@link verifyJmapIdentity}, also returning the account name to key per-user data on. */
export async function resolveJmapIdentity(
  serverUrl: string,
  authHeader: string,
  claimedUsername: string,
  options: VerifyJmapAuthOptions = {},
): Promise<ResolvedJmapIdentity> {
  if (!claimedUsername) {
    throw new JmapAuthVerificationError('Missing username', 400);
  }
  validateProxyAuthHeader(authHeader);
  const isBasic = /^Basic\s/i.test(authHeader);
  if (isBasic) {
    assertBasicAuthMatchesUsername(authHeader, claimedUsername);
  }

  const { serverUrl: normalizedServerUrl, session } = await fetchVerifiedSession(serverUrl, authHeader, options);
  if (isBasic) {
    // The server just accepted exactly this user:password, and a bare name
    // resolves to one account on it.
    return { serverUrl: normalizedServerUrl, accountName: claimedUsername };
  }

  if (usernameMatchesSession(claimedUsername, session.username)) {
    const bareClaim = !claimedUsername.includes('@') && session.username!.includes('@');
    return { serverUrl: normalizedServerUrl, accountName: bareClaim ? session.username! : claimedUsername };
  }

  const identityEmails = await fetchIdentityEmails(normalizedServerUrl, authHeader, session, options);
  if (identityEmails.some((email) => usernamesEqual(email, claimedUsername))) {
    return { serverUrl: normalizedServerUrl, accountName: claimedUsername };
  }

  throw new JmapAuthVerificationError('Username does not match credentials', 403);
}

/**
 * Rebase the session's advertised `apiUrl` onto the origin we verified
 * against: the advertised public hostname may not resolve from this process
 * (mirrors `rebaseApiUrl` in `@/lib/stalwart/jmap-api`).
 */
function rebaseApiUrl(apiUrl: string, normalizedServerUrl: string): string {
  const base = new URL(normalizedServerUrl);
  const api = new URL(apiUrl, `${normalizedServerUrl}/`);
  return new URL(api.pathname + api.search, base.origin).toString();
}

async function fetchIdentityEmails(
  normalizedServerUrl: string,
  authHeader: string,
  session: VerifiedJmapSession,
  options: VerifyJmapAuthOptions,
): Promise<string[]> {
  const accountId = session.primaryAccounts?.['urn:ietf:params:jmap:mail'];
  if (typeof accountId !== 'string' || !accountId) return [];

  let apiUrl: string;
  try {
    apiUrl = rebaseApiUrl(session.apiUrl, normalizedServerUrl);
  } catch {
    throw new JmapAuthVerificationError('Invalid JMAP session response', 502);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    if (!options.trusted && !(await isPublicHttpUrl(apiUrl))) {
      throw new JmapAuthVerificationError('Server URL is not allowed', 400);
    }
    const requestInit = {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
        methodCalls: [['Identity/get', { accountId, ids: null }, '0']],
      }),
      signal: controller.signal,
    };
    // No redirect handling here: a redirect on the POST would downgrade it to
    // a GET and can only come from a misconfigured proxy - treat as failure.
    const response = options.trusted
      ? await fetch(apiUrl, { ...requestInit, redirect: 'manual' })
      : await fetchPublicUrl(apiUrl, requestInit);
    if (!response.ok) {
      throw new JmapAuthVerificationError(
        response.status === 401 || response.status === 403
          ? 'Authentication failed'
          : 'Failed to verify JMAP identity',
        response.status === 401 || response.status === 403 ? 401 : 502,
        response.status,
      );
    }
    const body = await response.json().catch(() => null) as { methodResponses?: unknown } | null;
    const responses = Array.isArray(body?.methodResponses) ? body.methodResponses : null;
    if (!responses) {
      throw new JmapAuthVerificationError('Invalid JMAP response', 502);
    }
    const emails: string[] = [];
    for (const entry of responses) {
      if (!Array.isArray(entry) || entry[0] !== 'Identity/get') continue;
      const list = (entry[1] as { list?: unknown })?.list;
      if (!Array.isArray(list)) continue;
      for (const identity of list) {
        const email = (identity as { email?: unknown })?.email;
        if (typeof email === 'string' && email) emails.push(email);
      }
    }
    return emails;
  } catch (error) {
    if (error instanceof JmapAuthVerificationError) throw error;
    if (error instanceof DisallowedUrlError) {
      throw new JmapAuthVerificationError('Server URL is not allowed', 400);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new JmapAuthVerificationError('JMAP identity verification timed out', 504);
    }
    throw new JmapAuthVerificationError('Failed to verify JMAP identity', 502, undefined, networkErrorCode(error));
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchVerifiedSession(
  serverUrl: string,
  authHeader: string,
  options: VerifyJmapAuthOptions,
): Promise<{ serverUrl: string; session: VerifiedJmapSession }> {
  const normalizedServerUrl = normalizeJmapServerUrl(serverUrl);
  validateProxyAuthHeader(authHeader);

  if (!options.trusted && !(await isPublicHttpUrl(normalizedServerUrl))) {
    throw new JmapAuthVerificationError('Server URL is not allowed', 400);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    let currentUrl = `${normalizedServerUrl}/.well-known/jmap`;
    let response: Response | PublicFetchResponse | undefined;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      if (!options.trusted && !(await isPublicHttpUrl(currentUrl))) {
        throw new JmapAuthVerificationError('Server URL is not allowed', 400);
      }

      const requestInit = {
        method: 'GET',
        headers: { Authorization: authHeader },
        signal: controller.signal,
      };
      // Untrusted (user-supplied) endpoints connect through the rebinding-safe
      // fetch so the address validated above is the one the socket uses.
      // Admin-configured servers may legitimately live on private addresses.
      response = options.trusted
        ? await fetch(currentUrl, { ...requestInit, redirect: 'manual' })
        : await fetchPublicUrl(currentUrl, requestInit);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new JmapAuthVerificationError('Failed to verify JMAP session', 502);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      break;
    }

    if (!response) {
      throw new JmapAuthVerificationError('Failed to verify JMAP session', 502);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new JmapAuthVerificationError('Too many redirects verifying JMAP session', 502);
    }

    if (!response.ok) {
      throw new JmapAuthVerificationError(
        response.status === 401 || response.status === 403
          ? 'Authentication failed'
          : 'Failed to verify JMAP session',
        response.status === 401 || response.status === 403 ? 401 : 502,
        response.status,
      );
    }

    const session = await response.json().catch(() => null) as
      { apiUrl?: unknown; accounts?: unknown; username?: unknown; primaryAccounts?: unknown } | null;
    if (!session || typeof session.apiUrl !== 'string' || typeof session.accounts !== 'object' || session.accounts === null) {
      throw new JmapAuthVerificationError('Invalid JMAP session response', 502);
    }

    return {
      serverUrl: normalizedServerUrl,
      session: {
        apiUrl: session.apiUrl,
        username: typeof session.username === 'string' ? session.username : undefined,
        primaryAccounts:
          session.primaryAccounts && typeof session.primaryAccounts === 'object'
            ? (session.primaryAccounts as Record<string, string>)
            : undefined,
        accounts: session.accounts as Record<string, unknown>,
      },
    };
  } catch (error) {
    if (error instanceof JmapAuthVerificationError) {
      throw error;
    }
    if (error instanceof DisallowedUrlError) {
      throw new JmapAuthVerificationError('Server URL is not allowed', 400);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new JmapAuthVerificationError('JMAP session verification timed out', 504);
    }
    throw new JmapAuthVerificationError('Failed to verify JMAP session', 502, undefined, networkErrorCode(error));
  } finally {
    clearTimeout(timeout);
  }
}
