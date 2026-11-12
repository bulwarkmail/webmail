import { NextRequest, NextResponse } from 'next/server';
import { observeUpstream } from '@/lib/metrics/upstream';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import {
  refreshTokenCookieName,
  refreshTokenServerCookieName,
  accessTokenCookieName,
  decodeCachedAccessToken,
} from '@/lib/oauth/tokens';
import {
  exchangeCodeForTokens,
  buildOAuthParams,
  getMetadata,
  getRequiredConfig,
  defaultClientOptions,
  DEFAULT_CLIENT_ID,
} from '@/lib/oauth/token-exchange';
import { callbackIssuerAccepted, type OAuthMetadata } from '@/lib/oauth/discovery';
import { answerFields } from '@/lib/oauth/answer-summary';
import { getCookieOptions, getSignInCookieOptions } from '@/lib/oauth/cookie-config';
import {
  buildEndSessionUrl,
  clearIdToken,
  getPostLogoutRedirectUri,
  idTokenCookieName,
  isEndSessionEnabled,
  isRevokeOnSignOutEnabled,
  storeIdToken,
} from '@/lib/oauth/end-session';
import { cacheAccessToken, noteSignedOut, redeemRefreshToken, refreshTokenServer, storeRenewedTokens } from '@/lib/oauth/slot-renewal';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { rejectNonJsonBody } from '@/app/api/auth/json-request';
import {
  clearSignInStamp,
  isPastMaxAge,
  maxSessionHoursFor,
  SESSION_TOO_OLD,
  tokenSignedInAt,
  writeSignInStamp,
} from '@/lib/auth/session-age';
import { clearStalwartAuthContextInStore, readStalwartAuthContextFromStore, wopiSignInOf } from '@/lib/stalwart/auth-context';
import { accountSlotFromBody } from '@/lib/stalwart/credentials';
import { IS_DESKTOP_BUILD } from '@/lib/desktop/flag';
import { devicePolicyServerRefusal } from '@/lib/desktop/server-policy';
import { revokeWopiTokens } from '@/lib/wopi/revocation';
import {
  clearCustomUpstream,
  readCustomUpstream,
  resolveCustomUpstream,
  writeCustomUpstream,
  type CustomUpstream,
} from '@/lib/oauth/custom-upstream';

function parseSlot(raw: string | null): number | null {
  if (raw === null) return null;
  const slot = parseInt(raw, 10);
  if (isNaN(slot) || slot < 0 || slot >= MAX_ACCOUNT_SLOTS) return null;
  return slot;
}

function getSlot(request: NextRequest): number {
  return parseSlot(request.nextUrl.searchParams.get('slot')) ?? 0;
}

// Sign-out waits for this route, so an unresponsive revocation endpoint must
// not hold it up for long.
const REVOCATION_TIMEOUT_MS = 3000;

async function revokeRefreshToken(token: string, serverId: string | null, metadata: OAuthMetadata | null, upstream: CustomUpstream | null): Promise<void> {
  const revocationEndpoint = metadata?.revocation_endpoint;
  if (!revocationEndpoint) return;
  const params = buildOAuthParams({
    token,
    token_type_hint: 'refresh_token',
  }, serverId, await defaultClientOptions(serverId, upstream).catch(() => ({ fallbackClientId: DEFAULT_CLIENT_ID })));

  try {
    // Never follow a redirect with the refresh token and client secret in
    // the body: the endpoint was validated, its redirect target was not.
    const revocationResponse = await observeUpstream('oauth', () => fetch(revocationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(REVOCATION_TIMEOUT_MS),
      redirect: 'error',
    }));
    if (!revocationResponse.ok) {
      logger.warn('Token revocation returned error', { status: revocationResponse.status });
    }
  } catch (err) {
    logger.error('Token revocation network error', { error: err instanceof Error ? err.message : 'Unknown error' });
  }
}

/**
 * The provider logout URL for a slot being signed out, or null when there is
 * none to visit. A logout URL the admin configured (#1279) goes before the
 * discovered one: it is there for providers that advertise none, such as
 * Stalwart, and for a logout page shared with other apps, which must keep
 * working once the provider starts advertising its own.
 */
function endSessionUrlFor(metadata: OAuthMetadata | null, serverId: string | null, idToken: string | undefined, upstream: CustomUpstream | null): string | null {
  if (!isEndSessionEnabled()) return null;
  let clientId: string;
  let configuredEndpoint: string | undefined;
  try {
    ({ clientId, endSessionUrl: configuredEndpoint } = upstream ? getRequiredConfig(serverId, { upstream }) : getRequiredConfig(serverId));
  } catch {
    return null;
  }
  const endpoint = configuredEndpoint || metadata?.end_session_endpoint;
  if (!endpoint) return null;
  return buildEndSessionUrl({
    endpoint,
    clientId,
    idToken,
    postLogoutRedirectUri: getPostLogoutRedirectUri(),
  });
}

type CookieStore = Awaited<ReturnType<typeof cookies>>;

export async function POST(request: NextRequest) {
  // CSRF gate (GHSA-qvr9-m8cq-7wvg): cookies written here are SameSite=Lax,
  // so a cross-site top-level POST would otherwise reach this handler.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  const notJson = rejectNonJsonBody(request);
  if (notJson) return notJson;
  try {
    const { code, code_verifier, redirect_uri, slot: bodySlot, server_id: bodyServerId, remember: bodyRemember, custom_server_url: customServerUrl, client_id: bodyClientId, iss } = await request.json();
    // "Remember me" left unticked: the cookies end with the browser session.
    // Clients from before the choice remembered every sign-in.
    const remember = bodyRemember !== false;

    if (!code || !code_verifier || !redirect_uri) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    const slot = accountSlotFromBody(bodySlot) ?? getSlot(request);
    const serverId = typeof bodyServerId === 'string' && bodyServerId ? bodyServerId : null;

    // The desktop app signs in to a server the user typed, with a client it
    // registered there. Nothing configured here knows about either.
    const customUpstream = IS_DESKTOP_BUILD && !serverId ? await resolveCustomUpstream(customServerUrl, bodyClientId) : null;
    if (IS_DESKTOP_BUILD && !serverId && !customUpstream) {
      return NextResponse.json({ error: 'invalid_server_url' }, { status: 400 });
    }

    // RFC 9207: a code answered by another issuer than the server this sign-in
    // names is refused before the code or the verifier goes anywhere, and so
    // is one without `iss` from a provider that says it always sends it. The
    // desktop app's own sign-in to a server it typed (lib/desktop/browser-sign-in.ts)
    // checks `iss` itself before it gets here and sends none.
    const metadata = await getMetadata(serverId, customUpstream ? { upstream: customUpstream } : undefined);
    const issRequired = !customUpstream && metadata?.authorization_response_iss_parameter_supported === true;
    if (!callbackIssuerAccepted(iss, metadata?.issuer, issRequired)) {
      logger.warn('Token exchange: the answer came from another issuer than the one asked');
      return NextResponse.json({ error: 'Issuer mismatch' }, { status: 400 });
    }

    const tokens = await exchangeCodeForTokens(code, code_verifier, redirect_uri, serverId, customUpstream ? { upstream: customUpstream } : undefined);
    // A sign-in: the maximum session length counts from here, on the server
    // and, from this answer, in the browser.
    const signedInAt = Date.now();

    const response = NextResponse.json({
      access_token: tokens.access_token,
      expires_in: tokens.expires_in,
      signed_in_at: signedInAt,
    });

    const cookieStore = await cookies();
    if (tokens.refresh_token) {
      const cookieName = refreshTokenCookieName(slot);
      const options = getSignInCookieOptions(remember);
      cookieStore.set(cookieName, tokens.refresh_token, options);
      // The stamp also names the server that issued the token, which is
      // where it is renewed and revoked (lib/oauth/slot-renewal.ts).
      writeSignInStamp(cookieStore, slot, {
        signedInAt,
        refreshToken: tokens.refresh_token,
        serverId,
        ...(customUpstream ? { customServer: customUpstream.serverUrl } : {}),
      }, options);
    }
    const cachedAccessToken = cacheAccessToken(cookieStore, slot, tokens.access_token, tokens.expires_in || 3600, [tokens.refresh_token, serverId], remember);
    storeIdToken(cookieStore, slot, tokens.id_token, request.nextUrl.basePath, [tokens.refresh_token, cachedAccessToken, serverId], remember);
    // Persist which server entry minted this refresh token so the PUT/DELETE
    // handlers can route the refresh/revocation calls to the right token
    // endpoint without the client having to track it across page loads.
    const serverCookieName = refreshTokenServerCookieName(slot);
    if (serverId) {
      cookieStore.set(serverCookieName, serverId, getCookieOptions());
    } else if (cookieStore.get(serverCookieName)) {
      cookieStore.delete(serverCookieName);
    }
    if (customUpstream) writeCustomUpstream(cookieStore, slot, customUpstream, remember);

    return response;
  } catch (error) {
    logger.error('Token exchange error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  // CSRF gate (GHSA-qvr9-m8cq-7wvg): cookies written here are SameSite=Lax,
  // so a cross-site top-level POST would otherwise reach this handler.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const slot = getSlot(request);
    const cookieName = refreshTokenCookieName(slot);
    const cookieStore = await cookies();
    const refreshToken = cookieStore.get(cookieName)?.value;
    // A sign-in without "Remember me": the rotated token keeps ending with
    // the browser session instead of turning into a 30-day cookie.
    const remember = request.nextUrl.searchParams.get('remember') !== 'false';

    if (!refreshToken) {
      cookieStore.delete(accessTokenCookieName(slot));
      return NextResponse.json({ error: 'No refresh token' }, { status: 401 });
    }

    // The token only ever goes back to the server that issued it. When the
    // cookies can't say which one that was, the sign-in ends here and the
    // token goes nowhere.
    const bound = await refreshTokenServer(cookieStore, slot, refreshToken);
    if (!bound) {
      logger.warn('Token refresh: the refresh token is not bound to the server named for it; signing the slot out', { slot });
      await signOutSlot(cookieStore, slot, request.nextUrl.basePath, false);
      clearStalwartAuthContextInStore(cookieStore, slot);
      return NextResponse.json({ error: 'invalid_grant' }, { status: 401 });
    }
    const { serverId, upstream } = bound;

    // The organisation's maximum session length (lib/auth/session-age.ts).
    // A refresh token without a matching stamp (from before stamps, or one
    // whose stamp was deleted) counts from the fixed time the server first
    // enforced the limits, never from now.
    const age = await tokenSignedInAt(cookieStore, slot, refreshToken);
    if (age) {
      const context = readStalwartAuthContextFromStore(cookieStore, slot);
      const account = age.stamp?.account ?? context?.accountName ?? context?.username ?? null;
      const maxHours = await maxSessionHoursFor(account);
      if (isPastMaxAge(age.signedInAt, maxHours)) {
        await signOutSlot(cookieStore, slot, request.nextUrl.basePath, false);
        // Office editors this session opened end with it.
        const signIn = await wopiSignInOf(cookieStore, slot);
        await revokeWopiTokens(cookieStore, slot, signIn ? [signIn] : []);
        clearStalwartAuthContextInStore(cookieStore, slot);
        return NextResponse.json({ error: SESSION_TOO_OLD, maxHours }, { status: 401 });
      }
      // Bind the time to this token from now on, and record whether the
      // sign-in is remembered (#1509) and which server issued the token
      // where a stamp from before doesn't say.
      if (!age.stamp || age.stamp.remember === undefined || age.stamp.serverId === undefined) {
        writeSignInStamp(cookieStore, slot, {
          signedInAt: age.signedInAt,
          refreshToken,
          ...(account ? { account } : {}),
          ...(age.stamp?.remember !== undefined ? { remember: age.stamp.remember } : {}),
          serverId,
          ...(upstream ? { customServer: upstream.serverUrl } : {}),
        }, getSignInCookieOptions(age.stamp?.remember ?? remember));
      }
    }
    const signedIn = age ? { signed_in_at: age.signedInAt } : {};

    // A session restore calls this to get its token back, not because the
    // current one expired. Serving the cached token avoids spending a refresh
    // the IdP may legitimately reject: Rauthy stamps refresh tokens with
    // nbf = iat + access_token_lifetime - 60, so refreshing early fails with
    // "Token is not valid yet" for most of the access token's life (#552).
    //
    // `force=true` means the caller was told the current token is no good (a
    // 401 from JMAP, or a scheduled renewal), so the cache must be skipped.
    const force = request.nextUrl.searchParams.get('force') === 'true';
    if (!force) {
      const cached = decodeCachedAccessToken(cookieStore.get(accessTokenCookieName(slot))?.value);
      if (cached) {
        return NextResponse.json({
          access_token: cached.accessToken,
          expires_in: cached.expiresIn,
          ...signedIn,
        });
      }
    }

    // Discovery or the token endpoint out of reach is an outage: the client
    // waits it out. A 500 here would count toward signing the user out.
    // The device's OS policy refuses this server for now. The cookies stay, so the
    // account comes back with no sign-in if the policy does.
    const refusedByDevice = upstream ? devicePolicyServerRefusal(upstream.serverUrl) : null;
    if (refusedByDevice) return refusedByDevice;
    const redemption = await redeemRefreshToken(refreshToken, serverId, upstream);
    if (redemption.kind === 'unreachable') {
      logger.warn('Token refresh: provider unreachable', { error: redemption.message });
      return NextResponse.json({ error: 'Token endpoint unavailable' }, { status: 503 });
    }

    if (redemption.kind === 'refused') {
      const { status, error } = redemption;
      // The OAuth error code only: the body can repeat what was sent.
      logger.error('Token refresh failed', { status, ...(error ? { error } : {}) });
      // Drop the refresh token only when the server definitively rejected it
      // (invalid/expired/revoked grant). A 5xx or 429 is an outage - keeping
      // the cookie lets the session resume once the server is back.
      if (status === 400 || status === 401 || status === 403) {
        cookieStore.delete(cookieName);
        cookieStore.delete(refreshTokenServerCookieName(slot));
        cookieStore.delete(accessTokenCookieName(slot));
        clearCustomUpstream(cookieStore, slot);
        clearIdToken(cookieStore, slot, request.nextUrl.basePath);
        // Only invalid_grant says the login itself is over. invalid_client, or
        // a provider refusing an early refresh (#552), says nothing about it,
        // and the client keeps the account's local data for those.
        return NextResponse.json({ error: error === 'invalid_grant' ? 'invalid_grant' : 'Refresh failed' }, { status: 401 });
      }
      return NextResponse.json({ error: 'Token endpoint unavailable' }, { status: 503 });
    }

    const { tokens } = redemption;
    if (!tokens.access_token) {
      // Which fields came, not their values: the answer may still hold tokens.
      logger.error('Refresh response missing access_token', { fields: answerFields(tokens) });
      return NextResponse.json({ error: 'Invalid token response' }, { status: 502 });
    }

    const { expiresIn } = storeRenewedTokens(cookieStore, slot, { ...tokens, access_token: tokens.access_token }, {
      remember,
      age,
      basePath: request.nextUrl.basePath,
      server: bound,
    });

    return NextResponse.json({
      access_token: tokens.access_token,
      expires_in: expiresIn,
      ...signedIn,
    });
  } catch (error) {
    logger.error('Token refresh error', { error: error instanceof Error ? error.message : 'Unknown error' });
    // On the desktop this route runs on the user's machine, so an unreachable
    // mail server lands here. The client signs out after repeated 500s; a 503
    // tells it to keep the session and try again.
    if (IS_DESKTOP_BUILD) return NextResponse.json({ error: 'Token endpoint unavailable' }, { status: 503 });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Revoke a slot's refresh token and clear its token cookies. With
 * `endSession`, also returns the URL that ends the provider's session, or null
 * when there is no usable logout URL.
 */
async function signOutSlot(
  cookieStore: CookieStore,
  slot: number,
  basePath: string | undefined,
  endSession: boolean,
): Promise<string | null> {
  const cookieName = refreshTokenCookieName(slot);
  const refreshToken = cookieStore.get(cookieName)?.value;
  // A push preview renewing with this token right now must not write the
  // rotated one back after this answer cleared it (#1509).
  if (refreshToken) noteSignedOut(refreshToken);
  // A refresh token is revoked only at the server that issued it. When the
  // cookies can't say which one that was, nothing is sent anywhere and the
  // cookies are just cleared.
  const bound = refreshToken
    ? await refreshTokenServer(cookieStore, slot, refreshToken)
    : { serverId: cookieStore.get(refreshTokenServerCookieName(slot))?.value || null, upstream: await readCustomUpstream(cookieStore, slot) };
  const serverId = bound?.serverId ?? null;
  const upstream = bound?.upstream ?? null;
  const idToken =cookieStore.get(idTokenCookieName(slot))?.value;

  // With revocation off (#1388) the token is only dropped from the browser.
  const tokenToRevoke = refreshToken && isRevokeOnSignOutEnabled() ? refreshToken : undefined;
  let endSessionUrl: string | null = null;
  if (bound && (tokenToRevoke || endSession)) {
    const metadata = await getMetadata(serverId, upstream ? { upstream } : { fallbackClientId: DEFAULT_CLIENT_ID }).catch((err) => {
      logger.warn('Failed to discover OAuth metadata during logout', {
        error: err instanceof Error ? err.message : 'Unknown error',
      });
      return null;
    });
    if (tokenToRevoke) await revokeRefreshToken(tokenToRevoke, serverId, metadata, upstream);
    if (endSession) endSessionUrl = endSessionUrlFor(metadata, serverId, idToken, upstream);
  }

  // Cleared whether or not revocation worked: the browser must not be able
  // to resume a session the user ended. Only cookies the browser sent are
  // cleared - signing out of every slot would otherwise answer with a
  // Set-Cookie header per slot and cookie, too large for some proxies.
  for (const name of [cookieName, refreshTokenServerCookieName(slot), accessTokenCookieName(slot)]) {
    if (cookieStore.get(name)) cookieStore.delete(name);
  }
  clearSignInStamp(cookieStore, slot);
  clearCustomUpstream(cookieStore, slot);
  if (idToken !== undefined) clearIdToken(cookieStore, slot, basePath);
  return endSessionUrl;
}

export async function DELETE(request: NextRequest) {
  // CSRF gate (GHSA-qvr9-m8cq-7wvg): cookies written here are SameSite=Lax,
  // so a cross-site top-level POST would otherwise reach this handler.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const params = request.nextUrl.searchParams;
    const basePath = request.nextUrl.basePath;
    const cookieStore = await cookies();

    if (params.get('all') === 'true') {
      // One top-level navigation can end only one provider session, so the
      // caller names the slot whose provider should be signed out, if any.
      const endSessionSlot = parseSlot(params.get('end_session_slot'));
      const slots = Array.from({ length: MAX_ACCOUNT_SLOTS }, (_, i) => i);
      const urls = await Promise.all(
        slots.map((i) => signOutSlot(cookieStore, i, basePath, i === endSessionSlot)),
      );
      const endSessionUrl = endSessionSlot === null ? null : urls[endSessionSlot];
      return NextResponse.json({ ok: true, ...(endSessionUrl && { end_session_url: endSessionUrl }) });
    }

    const endSessionUrl = await signOutSlot(cookieStore, getSlot(request), basePath, params.get('end_session') === 'true');
    return NextResponse.json({ ok: true, ...(endSessionUrl && { end_session_url: endSessionUrl }) });
  } catch (error) {
    logger.error('Token revocation error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
