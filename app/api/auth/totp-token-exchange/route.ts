import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { refreshTokenCookieName, refreshTokenServerCookieName } from '@/lib/oauth/tokens';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { readFileEnv } from '@/lib/read-file-env';
import { configManager } from '@/lib/admin/config-manager';
import { isPublicHttpUrl } from '@/lib/security/url-guard';
import { recordLogin } from '@/lib/telemetry/login-tracker';
import { parseJmapServers, findServerByUrl, findServerById, resolveTrustedJmapUrl } from '@/lib/admin/jmap-servers';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { DEFAULT_CLIENT_ID } from '@/lib/oauth/token-exchange';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { stalwartPasswordLogin } from '@/lib/auth/stalwart-password-login';
import { loginClientAddress } from '@/lib/auth/client-address';
import { LOGIN_BUDGET_RETRY_AFTER_SECONDS, reserveLoginAttempt } from '@/lib/auth/verify-budget';

/**
 * Exchange a password + (optional) TOTP code for OAuth tokens.
 *
 * Stalwart 0.16+ rejects TOTP over HTTP Basic, so a TOTP login goes through
 * its structured login endpoint instead (see stalwartPasswordLogin). This
 * route drives that flow server-side (avoiding browser CORS against the mail
 * server, same as OAuth discovery) and keeps the refresh token in the slot's
 * httpOnly cookie.
 *
 * Token-based auth also survives TOTP rotation, unlike basic auth which embeds
 * the (≈30s) code in every request.
 */

async function attemptLogin(
  upstreamUrl: string,
  username: string,
  password: string,
  totp: string | undefined,
  redirectUri: string,
  slot: number,
  serverId: string | null,
  upstreamTrusted: boolean,
  clientIp: string,
  rememberMe: boolean,
): Promise<NextResponse> {
  const base = upstreamUrl.replace(/\/+$/, '');

  // Per-server OAuth credentials override the global ones when the requested
  // server entry has its own oauth block configured.
  const serverList = parseJmapServers(configManager.get<unknown>('jmapServers', []));
  const entry = findServerById(serverList, serverId);
  const configuredClientId = entry?.oauth?.clientId
    || configManager.get<string>('oauthClientId', '')
    || process.env.OAUTH_CLIENT_ID;
  const clientId = configuredClientId || DEFAULT_CLIENT_ID;
  const clientSecret = entry?.oauth?.clientSecret
    || configManager.get<string>('oauthClientSecret', '')
    || process.env.OAUTH_CLIENT_SECRET
    || readFileEnv(process.env.OAUTH_CLIENT_SECRET_FILE)
    || '';

  // Wrong passwords tried from here count against this server's address
  // upstream, so each client gets a failure budget (lib/auth/verify-budget.ts).
  const refund = reserveLoginAttempt(clientIp);
  if (!refund) {
    return NextResponse.json(
      { error: 'too_many_attempts' },
      { status: 429, headers: { 'Retry-After': String(LOGIN_BUDGET_RETRY_AFTER_SECONDS) } },
    );
  }
  const result = await stalwartPasswordLogin({
    serverUrl: base,
    username,
    password,
    totp,
    clientId,
    clientSecret,
    redirectUri,
    trusted: upstreamTrusted,
    clientIp,
    // Stalwart 1.0 knows no client by the default name.
    registerUnknownClient: !configuredClientId,
  });
  // Only a rejected password spends the budget. `totp_required` means the
  // password was right and the code is still missing, which every TOTP login
  // goes through once; outages say nothing about the password.
  if (result.ok || result.error !== 'invalid_credentials') refund();

  if (!result.ok) {
    switch (result.error) {
      // A 404 means the server predates the structured login endpoint; let the
      // caller fall back to the legacy basic-auth path.
      case 'login_endpoint_missing':
        return NextResponse.json({ error: 'login_endpoint_missing', detail: result.detail }, { status: 404 });
      case 'login_rejected':
        return NextResponse.json({ error: 'login_failed', detail: result.detail }, { status: 502 });
      case 'invalid_server_url':
        return NextResponse.json({ error: 'invalid_server_url' }, { status: 400 });
      case 'login_unreachable':
        return NextResponse.json({ error: 'login_unreachable' }, { status: 502 });
      case 'totp_required':
        return NextResponse.json({ error: 'totp_required' }, { status: 401 });
      case 'invalid_credentials':
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
      case 'login_failed':
        return NextResponse.json({ error: 'login_failed' }, { status: 502 });
      case 'token_exchange_failed':
        return NextResponse.json(
          result.detail !== undefined ? { error: 'token_exchange_failed', detail: result.detail } : { error: 'token_exchange_failed' },
          { status: 502 },
        );
    }
  }

  logger.info('TOTP login succeeded');
  void recordLogin(username, base);
  return await storeAndRespond(result.tokens, slot, serverId, rememberMe);
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export async function POST(request: NextRequest) {
  // CSRF gate (GHSA-qvr9-m8cq-7wvg): cookies written here are SameSite=Lax,
  // so a cross-site top-level POST would otherwise reach this handler.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const { serverUrl, username, password, totp, slot: bodySlot, server_id: bodyServerId, redirectUri: bodyRedirectUri, rememberMe } =
      await request.json();

    if (!serverUrl || !username || !password) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    const slot = typeof bodySlot === 'number' && bodySlot >= 0 && bodySlot < MAX_ACCOUNT_SLOTS ? bodySlot : 0;
    const requestedServerId = typeof bodyServerId === 'string' && bodyServerId ? bodyServerId : null;
    const totpCode = typeof totp === 'string' && totp ? totp : undefined;

    // Pin the upstream URL to a configured JMAP server. The list of allowed
    // servers is `jmapServerUrl` plus any entry from `jmapServers`. Only when
    // the user named none of them (and the deployment explicitly allows custom
    // JMAP endpoints) do we use the user-supplied URL - and even then it must
    // resolve to a public address. Their password belongs to that server, and
    // the browser goes on to use the token there.
    await configManager.ensureLoaded();
    const configuredServerUrl =
      configManager.get<string>('jmapServerUrl', '') ||
      process.env.JMAP_SERVER_URL ||
      process.env.NEXT_PUBLIC_JMAP_SERVER_URL ||
      '';
    const allowCustomEndpoint = configManager.get<boolean>('allowCustomJmapEndpoint', false);
    const serverList = parseJmapServers(configManager.get<unknown>('jmapServers', []));

    let upstreamUrl: string;
    let upstreamTrusted = true;
    let resolvedServerId: string | null = null;
    const requestedEntry = findServerById(serverList, requestedServerId);
    const matchedEntry = requestedEntry || findServerByUrl(serverList, serverUrl);
    const customRequested = allowCustomEndpoint && !resolveTrustedJmapUrl(serverUrl, configuredServerUrl, serverList);

    if (matchedEntry) {
      upstreamUrl = matchedEntry.url;
      resolvedServerId = matchedEntry.id;
    } else if (configuredServerUrl && !customRequested) {
      upstreamUrl = configuredServerUrl;
    } else if (allowCustomEndpoint) {
      if (!(await isPublicHttpUrl(serverUrl))) {
        logger.warn('TOTP login: rejected non-public server URL');
        return NextResponse.json({ error: 'invalid_server_url' }, { status: 400 });
      }
      upstreamUrl = serverUrl;
      upstreamTrusted = false;
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

    return await attemptLogin(
      upstreamUrl,
      username,
      password,
      totpCode,
      redirectUri,
      slot,
      resolvedServerId,
      upstreamTrusted,
      loginClientAddress(request),
      // Clients from before the flag remembered every sign-in.
      rememberMe !== false,
    );
  } catch (error) {
    logger.error('TOTP login error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function storeAndRespond(
  tokens: { access_token: string; expires_in?: number; refresh_token?: string },
  slot: number,
  serverId: string | null,
  rememberMe: boolean,
): Promise<NextResponse> {
  const cookieStore = await cookies();
  if (tokens.refresh_token) {
    const cookieName = refreshTokenCookieName(slot);
    // Without "Remember me" the sign-in ends with the browser session.
    const { maxAge: _maxAge, ...sessionOptions } = getCookieOptions();
    cookieStore.set(cookieName, tokens.refresh_token, rememberMe ? getCookieOptions() : sessionOptions);
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
