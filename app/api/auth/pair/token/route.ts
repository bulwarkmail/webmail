import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { openPhoneRefreshToken, sealPhoneRefreshToken, type SealedRefresh } from '@/lib/auth/pair-bundle';
import { DEFAULT_CLIENT_ID, getClientSecret, getTokenEndpoint } from '@/lib/oauth/token-exchange';
import { isTrustedJmapServerUrl } from '@/lib/stalwart/server-fetch';
import { fetchPublicUrl } from '@/lib/security/url-guard';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';

// Token endpoint for paired phones whose grant the phone cannot renew itself:
// the client is confidential (its secret stays on this server), or the
// provider's host is one current app builds refuse to talk to. The app posts
// the standard refresh grant here; we renew at the provider that minted the
// grant, with the secret, and hand back a re-sealed refresh token.
//
// Only refresh tokens this webmail sealed for a phone are accepted (see
// lib/auth/pair-bundle.ts), so the route cannot be used to renew arbitrary
// tokens with our client secret. No cookies are involved.

const UPSTREAM_TIMEOUT_MS = 10_000;
const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

/**
 * Whether the sealed endpoint is still one this webmail is configured for:
 * the discovered token endpoint of its server entry (SSO grants), or the
 * structured-login endpoint of an admin-configured JMAP server (password
 * grants).
 */
async function stillTrusted(sealed: SealedRefresh): Promise<boolean> {
  try {
    if (await getTokenEndpoint(sealed.serverId, { fallbackClientId: DEFAULT_CLIENT_ID }) === sealed.tokenEndpoint) {
      return true;
    }
  } catch {
    // No OAuth configured for it (any more): try the JMAP server below.
  }
  const base = sealed.tokenEndpoint.replace(/\/auth\/token$/, '');
  return base !== sealed.tokenEndpoint && await isTrustedJmapServerUrl(base);
}

function oauthError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(await request.text());
  } catch {
    return oauthError('invalid_request', 400);
  }
  if (params.get('grant_type') !== 'refresh_token') {
    return oauthError('unsupported_grant_type', 400);
  }
  const sealed = openPhoneRefreshToken(params.get('refresh_token') ?? '');
  if (!sealed) {
    return oauthError('invalid_grant', 400);
  }

  const upstreamParams = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: sealed.refreshToken,
    client_id: sealed.clientId,
  });
  // The secret is the admin's, for the admin's servers only - as configured
  // now, not when the token was sealed: a server removed or moved since then
  // gets neither the secret nor the unguarded fetch.
  const trusted = sealed.trusted && await stillTrusted(sealed);
  const secret = trusted ? getClientSecret(sealed.serverId) : '';
  if (secret) upstreamParams.set('client_secret', secret);

  let upstream: Response;
  try {
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: upstreamParams.toString(),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    };
    // The body carries the refresh token and the client secret: never follow
    // a redirect with it. A user-chosen server goes through the
    // rebinding-safe fetch (which never follows redirects either).
    upstream = trusted
      ? await fetch(sealed.tokenEndpoint, { ...init, redirect: 'error' })
      : (await fetchPublicUrl(sealed.tokenEndpoint, init)) as unknown as Response;
  } catch (error) {
    logger.warn('Pair token proxy: provider unreachable', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return oauthError('temporarily_unavailable', 503);
  }

  if (!upstream.ok) {
    // 400/401/403: the grant is dead (expired, revoked, password changed) and
    // the app signs the account out. Anything else is an outage it waits out.
    const dead = upstream.status === 400 || upstream.status === 401 || upstream.status === 403;
    logger.warn('Pair token proxy: refresh rejected', { status: upstream.status });
    return oauthError(dead ? 'invalid_grant' : 'temporarily_unavailable', dead ? 400 : 503);
  }

  let tokens: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; token_type?: unknown };
  try {
    tokens = await upstream.json();
  } catch {
    return oauthError('temporarily_unavailable', 503);
  }
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
    return oauthError('temporarily_unavailable', 503);
  }

  const refreshToken = typeof tokens.refresh_token === 'string' && tokens.refresh_token
    ? tokens.refresh_token
    : sealed.refreshToken;
  return NextResponse.json(
    {
      access_token: tokens.access_token,
      token_type: typeof tokens.token_type === 'string' ? tokens.token_type : 'Bearer',
      ...(typeof tokens.expires_in === 'number' ? { expires_in: tokens.expires_in } : {}),
      refresh_token: sealPhoneRefreshToken({ ...sealed, refreshToken }),
    },
    { headers: NO_STORE },
  );
}
