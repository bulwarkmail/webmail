import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { refreshTokenCookieName, refreshTokenServerCookieName } from '@/lib/oauth/tokens';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { readFileEnv } from '@/lib/read-file-env';
import { configManager } from '@/lib/admin/config-manager';
import { isPublicHttpUrl } from '@/lib/security/url-guard';
import { recordLogin } from '@/lib/telemetry/login-tracker';
import { parseJmapServers, findServerByUrl, findServerById } from '@/lib/admin/jmap-servers';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { generateCodeVerifier, generateCodeChallenge } from '@/lib/oauth/pkce';

/**
 * Exchange a password + (optional) TOTP code for OAuth tokens.
 *
 * Stalwart 0.16+ no longer accepts the legacy `password$totp` convention over
 * HTTP Basic auth: its Basic decoder hardcodes `mfa_token: None` and never
 * splits the secret on `$`, so any TOTP appended to the password is verified
 * verbatim against the password hash and fails. The MFA token must instead be
 * supplied as a distinct field through the structured login endpoint.
 *
 * This route drives that flow server-side (avoiding browser CORS against the
 * mail server, same as OAuth discovery):
 *   1. POST {serverUrl}/api/auth  -> authenticate with a separate `mfaToken`,
 *      receiving a short-lived authorization `clientCode`.
 *   2. POST {serverUrl}/auth/token (grant_type=authorization_code) -> exchange
 *      the code (with PKCE) for access/refresh tokens.
 *
 * Token-based auth also survives TOTP rotation, unlike basic auth which embeds
 * the (≈30s) code in every request.
 */

// Fallback OAuth client id used when no client is configured. Stalwart accepts
// any client id unless `require_client_registration` is enabled (default off);
// when it is enabled the admin must configure `oauthClientId` with this
// redirect URI registered.
const DEFAULT_CLIENT_ID = 'bulwark-webmail';

interface LoginResult {
  type?: string;
  // The response keeps snake_case: only the LoginResponse variant *tags* are
  // camelCased server-side, not the struct fields (the request fields are).
  client_code?: string;
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

async function attemptLogin(
  upstreamUrl: string,
  username: string,
  password: string,
  totp: string | undefined,
  redirectUri: string,
  slot: number,
  serverId: string | null,
): Promise<NextResponse> {
  const base = trimUrl(upstreamUrl);

  // Per-server OAuth credentials override the global ones when the requested
  // server entry has its own oauth block configured.
  const serverList = parseJmapServers(configManager.get<unknown>('jmapServers', []));
  const entry = findServerById(serverList, serverId);
  const clientId = entry?.oauth?.clientId
    || configManager.get<string>('oauthClientId', '')
    || process.env.OAUTH_CLIENT_ID
    || DEFAULT_CLIENT_ID;
  const clientSecret = entry?.oauth?.clientSecret
    || configManager.get<string>('oauthClientSecret', '')
    || process.env.OAUTH_CLIENT_SECRET
    || readFileEnv(process.env.OAUTH_CLIENT_SECRET_FILE)
    || '';

  // PKCE proves the token exchange originates from the same client that
  // initiated the login, so no client secret is required for public clients.
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);

  // Step 1: structured login with a separate MFA token.
  let login: LoginResult;
  try {
    const loginResponse = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'authCode',
        accountName: username,
        accountSecret: password,
        ...(totp ? { mfaToken: totp } : {}),
        clientId,
        redirectUri,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
      }),
    });

    if (!loginResponse.ok) {
      const detail = (await loginResponse.text()).substring(0, 500);
      logger.warn('TOTP login: /api/auth rejected request', { status: loginResponse.status });
      // A 404 means the server predates the structured login endpoint; let the
      // caller fall back to the legacy basic-auth path.
      return NextResponse.json(
        { error: loginResponse.status === 404 ? 'login_endpoint_missing' : 'login_failed', detail },
        { status: loginResponse.status === 404 ? 404 : 502 },
      );
    }

    login = await loginResponse.json();
  } catch (err) {
    logger.warn('TOTP login: /api/auth request failed', { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'login_unreachable' }, { status: 502 });
  }

  switch (login.type) {
    case 'authenticated':
      break;
    case 'mfaRequired':
      return NextResponse.json({ error: 'totp_required' }, { status: 401 });
    case 'failure':
    default:
      return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  if (!login.client_code) {
    logger.warn('TOTP login: authenticated response missing client_code');
    return NextResponse.json({ error: 'login_failed' }, { status: 502 });
  }

  // Step 2: exchange the authorization code for tokens.
  const tokenParams = new URLSearchParams({
    grant_type: 'authorization_code',
    code: login.client_code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  // Confidential clients still send their secret; harmless for public clients.
  if (clientSecret) tokenParams.set('client_secret', clientSecret);

  let tokens: { access_token?: string; expires_in?: number; refresh_token?: string };
  try {
    const tokenResponse = await fetch(`${base}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    });

    if (!tokenResponse.ok) {
      const detail = (await tokenResponse.text()).substring(0, 500);
      logger.warn('TOTP login: token exchange failed', { status: tokenResponse.status, detail });
      return NextResponse.json({ error: 'token_exchange_failed', detail }, { status: 502 });
    }

    tokens = await tokenResponse.json();
  } catch (err) {
    logger.warn('TOTP login: token endpoint failed', { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'token_exchange_failed' }, { status: 502 });
  }

  if (!tokens.access_token) {
    return NextResponse.json({ error: 'token_exchange_failed', detail: 'Response missing access_token' }, { status: 502 });
  }

  logger.info('TOTP login succeeded');
  void recordLogin(username, base);
  return await storeAndRespond(
    { access_token: tokens.access_token, expires_in: tokens.expires_in, refresh_token: tokens.refresh_token },
    slot,
    serverId,
  );
}

export async function POST(request: NextRequest) {
  try {
    const { serverUrl, username, password, totp, slot: bodySlot, server_id: bodyServerId, redirectUri: bodyRedirectUri } =
      await request.json();

    if (!serverUrl || !username || !password) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    const slot = typeof bodySlot === 'number' && bodySlot >= 0 && bodySlot < MAX_ACCOUNT_SLOTS ? bodySlot : 0;
    const requestedServerId = typeof bodyServerId === 'string' && bodyServerId ? bodyServerId : null;
    const totpCode = typeof totp === 'string' && totp ? totp : undefined;

    // Pin the upstream URL to a configured JMAP server. The list of allowed
    // servers is `jmapServerUrl` plus any entry from `jmapServers`. Only when
    // no server is configured (and the deployment explicitly allows custom
    // JMAP endpoints) do we fall back to the user-supplied URL - and even then
    // it must resolve to a public address.
    await configManager.ensureLoaded();
    const configuredServerUrl =
      configManager.get<string>('jmapServerUrl', '') ||
      process.env.JMAP_SERVER_URL ||
      process.env.NEXT_PUBLIC_JMAP_SERVER_URL ||
      '';
    const allowCustomEndpoint = configManager.get<boolean>('allowCustomJmapEndpoint', false);
    const serverList = parseJmapServers(configManager.get<unknown>('jmapServers', []));

    let upstreamUrl: string;
    let resolvedServerId: string | null = null;
    const requestedEntry = findServerById(serverList, requestedServerId);
    const matchedEntry = requestedEntry || findServerByUrl(serverList, serverUrl);

    if (matchedEntry) {
      upstreamUrl = matchedEntry.url;
      resolvedServerId = matchedEntry.id;
    } else if (configuredServerUrl) {
      upstreamUrl = configuredServerUrl;
    } else if (allowCustomEndpoint) {
      if (!(await isPublicHttpUrl(serverUrl))) {
        logger.warn('TOTP login: rejected non-public server URL');
        return NextResponse.json({ error: 'invalid_server_url' }, { status: 400 });
      }
      upstreamUrl = serverUrl;
    } else {
      return NextResponse.json({ error: 'jmap_server_not_configured' }, { status: 500 });
    }

    // The redirect URI must be identical in the login and token-exchange steps,
    // and (when require_client_registration is on) registered for the client.
    // Prefer the browser-supplied callback URL the OAuth client already uses;
    // fall back to the upstream URL so the two steps still agree.
    const redirectUri =
      typeof bodyRedirectUri === 'string' && /^https?:\/\//.test(bodyRedirectUri)
        ? bodyRedirectUri
        : trimUrl(upstreamUrl);

    return await attemptLogin(upstreamUrl, username, password, totpCode, redirectUri, slot, resolvedServerId);
  } catch (error) {
    logger.error('TOTP login error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function storeAndRespond(
  tokens: { access_token: string; expires_in?: number; refresh_token?: string },
  slot: number,
  serverId: string | null,
): Promise<NextResponse> {
  const cookieStore = await cookies();
  if (tokens.refresh_token) {
    const cookieName = refreshTokenCookieName(slot);
    cookieStore.set(cookieName, tokens.refresh_token, getCookieOptions());
  }
  const serverCookieName = refreshTokenServerCookieName(slot);
  if (serverId) {
    cookieStore.set(serverCookieName, serverId, getCookieOptions());
  } else {
    cookieStore.delete(serverCookieName);
  }

  return NextResponse.json({
    access_token: tokens.access_token,
    expires_in: tokens.expires_in || 3600,
    has_refresh_token: !!tokens.refresh_token,
  });
}
