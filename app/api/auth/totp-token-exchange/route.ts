import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { getPasswordLoginScope, refreshTokenCookieName, refreshTokenServerCookieName } from '@/lib/oauth/tokens';
import { getCookieOptions, getSignInCookieOptions } from '@/lib/oauth/cookie-config';
import { readFileEnv } from '@/lib/read-file-env';
import { configManager } from '@/lib/admin/config-manager';
import { isPublicHttpUrl } from '@/lib/security/url-guard';
import { recordLogin } from '@/lib/telemetry/login-tracker';
import { parseJmapServers, findServerByUrl, findServerById, resolveTrustedJmapUrl } from '@/lib/admin/jmap-servers';
import { DEFAULT_CLIENT_ID } from '@/lib/oauth/token-exchange';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { rejectNonJsonBody } from '@/app/api/auth/json-request';
import { stalwartPasswordLogin } from '@/lib/auth/stalwart-password-login';
import { loginClientAddress } from '@/lib/auth/client-address';
import { LOGIN_BUDGET_RETRY_AFTER_SECONDS, reserveLoginAttempt } from '@/lib/auth/verify-budget';
import { isStoreUnavailable, storeUnavailableResponse } from '@/lib/auth/store-unavailable';
import { writeSignInStamp } from '@/lib/auth/session-age';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { IS_DESKTOP_BUILD } from '@/lib/desktop/flag';
import { isDesktopTrustedServer } from '@/lib/desktop/trusted-servers';
import { devicePolicyServerRefusal } from '@/lib/desktop/server-policy';
import { stalwartDefaultClientId } from '@/lib/auth/stalwart-password-login';
import { writeCustomUpstream } from '@/lib/oauth/custom-upstream';
import { accountSlotFromBody } from '@/lib/stalwart/credentials';

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
  typedServer: boolean,
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
  const refund = await reserveLoginAttempt(clientIp);
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
    scope: configuredClientId ? getPasswordLoginScope() : undefined,
  });
  // Only a rejected password spends the budget. `totp_required` means the
  // password was right and the code is still missing, which every TOTP login
  // goes through once; outages say nothing about the password.
  if (result.ok || result.error !== 'invalid_credentials') await refund();

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
  // A server the user typed (and every server of the desktop app) is in no
  // configured list, so the refresh has to be told where this token belongs
  // and which client it was issued to (lib/oauth/custom-upstream.ts). That
  // record is sealed: without a session secret the refresh token isn't kept,
  // or its renewal would go to the configured server.
  const typed = (IS_DESKTOP_BUILD && !serverId) || typedServer;
  const tokens = typed && !hasSessionSecret() ? { ...result.tokens, refresh_token: undefined } : result.tokens;
  const upstream = typed && tokens.refresh_token
    ? { serverUrl: base, clientId: await stalwartDefaultClientId(base, clientId, upstreamTrusted) }
    : null;
  return await storeAndRespond(tokens, slot, serverId, rememberMe, upstream);
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export async function POST(request: NextRequest) {
  // CSRF gate (GHSA-qvr9-m8cq-7wvg): cookies written here are SameSite=Lax,
  // so a cross-site top-level POST would otherwise reach this handler.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  const notJson = rejectNonJsonBody(request);
  if (notJson) return notJson;
  try {
    const { serverUrl, username, password, totp, slot: bodySlot, server_id: bodyServerId, redirectUri: bodyRedirectUri, rememberMe } =
      await request.json();

    if (!serverUrl || !username || !password) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    const slot = accountSlotFromBody(bodySlot) ?? 0;
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
    const refusedByDevice = devicePolicyServerRefusal(serverUrl);
    if (refusedByDevice) return refusedByDevice;

    let upstreamTrusted = true;
    // A server the user typed rather than one configured here.
    let typedServer = false;
    let resolvedServerId: string | null = null;
    const requestedEntry = findServerById(serverList, requestedServerId);
    const matchedEntry = requestedEntry || findServerByUrl(serverList, serverUrl);
    const customRequested = allowCustomEndpoint && !resolveTrustedJmapUrl(serverUrl, configuredServerUrl, serverList);

    if (matchedEntry) {
      upstreamUrl = matchedEntry.url;
      resolvedServerId = matchedEntry.id;
    } else if (configuredServerUrl && !customRequested) {
      upstreamUrl = configuredServerUrl;
    // Spelled out as in lib/admin/jmap-servers.ts, so other builds don't hold it.
    } else if (process.env.NEXT_PUBLIC_BULWARK_DESKTOP === '1' && isDesktopTrustedServer(serverUrl)) {
      upstreamUrl = serverUrl;
      typedServer = true;
    } else if (allowCustomEndpoint) {
      if (!(await isPublicHttpUrl(serverUrl))) {
        logger.warn('TOTP login: rejected non-public server URL');
        return NextResponse.json({ error: 'invalid_server_url' }, { status: 400 });
      }
      upstreamUrl = serverUrl;
      upstreamTrusted = false;
      typedServer = true;
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
      loginClientAddress(request, upstreamUrl),
      // Clients from before the flag remembered every sign-in.
      rememberMe !== false,
      typedServer,
    );
  } catch (error) {
    // The sign-in limit can't be counted without the shared store: refused.
    if (isStoreUnavailable(error)) return storeUnavailableResponse();
    logger.error('TOTP login error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function storeAndRespond(
  tokens: { access_token: string; expires_in?: number; refresh_token?: string },
  slot: number,
  serverId: string | null,
  rememberMe: boolean,
  upstream: { serverUrl: string; clientId: string } | null,
): Promise<NextResponse> {
  const cookieStore = await cookies();
  // A sign-in: the maximum session length counts from here (lib/auth/session-age.ts).
  const signedInAt = Date.now();
  if (tokens.refresh_token) {
    const cookieName = refreshTokenCookieName(slot);
    // Without "Remember me" the sign-in ends with the browser session.
    const options = getSignInCookieOptions(rememberMe);
    cookieStore.set(cookieName, tokens.refresh_token, options);
    // The token is renewed and revoked only at the server that issued it.
    writeSignInStamp(cookieStore, slot, {
      signedInAt,
      refreshToken: tokens.refresh_token,
      serverId,
      ...(upstream ? { customServer: upstream.serverUrl } : {}),
    }, options);
  }
  const serverCookieName = refreshTokenServerCookieName(slot);
  if (serverId) {
    cookieStore.set(serverCookieName, serverId, getCookieOptions());
  } else {
    cookieStore.delete(serverCookieName);
  }
  if (upstream && tokens.refresh_token) writeCustomUpstream(cookieStore, slot, upstream, rememberMe);

  return NextResponse.json({
    access_token: tokens.access_token,
    expires_in: tokens.expires_in || 3600,
    has_refresh_token: !!tokens.refresh_token,
    signed_in_at: signedInAt,
  });
}
