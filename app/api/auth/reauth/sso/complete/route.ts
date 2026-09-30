import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { decryptPayload } from '@/lib/auth/crypto';
import { exchangeCodeForTokens, getRequiredConfig, getTokenEndpoint, hasClientSecret } from '@/lib/oauth/token-exchange';
import { pairingOwner, setPairReauthInStore } from '@/lib/auth/pair-reauth';
import { stashGrant } from '@/lib/auth/pairing-store';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';
import { isTrustedJmapServerUrl } from '@/lib/stalwart/server-fetch';
import { JmapAuthVerificationError, verifyJmapIdentity } from '@/lib/auth/verify-jmap-auth';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';

// Completes the step-up re-authentication for device pairing. The user was
// sent to the IdP with prompt=login (see /api/auth/sso/start with
// purpose=reauth); here we verify the returned code against the pending state
// and exchange it. That fresh login becomes the paired phone's own grant: it
// is kept server-side (see pairing-store) until a code for it is redeemed, and
// the short-lived pairing proof cookie remembers which grant. We deliberately
// do NOT issue a login session or touch the desktop's refresh-token cookies -
// the user is already signed in, and the phone must not share that session.

const SSO_PENDING_COOKIE = 'sso_pending';
const SSO_PENDING_MAX_AGE_MS = 5 * 60 * 1000;
/** Clock skew allowed between this server and the identity provider. */
const AUTH_TIME_SKEW_MS = 2 * 60 * 1000;

/**
 * The `auth_time` claim of an ID token received straight from the token
 * endpoint (so its signature need not be checked here), or null.
 */
function idTokenAuthTime(idToken: string | undefined): number | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof payload?.auth_time === 'number' ? payload.auth_time : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  // CSRF gate (GHSA-qvr9-m8cq-7wvg): cookies written here are SameSite=Lax,
  // so a cross-site top-level POST would otherwise reach this handler.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  const cookieStore = await cookies();
  try {
    const { code, state } = await request.json();
    if (!code || !state) {
      return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
    }

    const pendingCookie = cookieStore.get(SSO_PENDING_COOKIE)?.value;
    if (!pendingCookie) {
      return NextResponse.json({ error: 'No pending re-auth session' }, { status: 400 });
    }

    const pending = decryptPayload(pendingCookie, 'sso-pending');
    cookieStore.delete(SSO_PENDING_COOKIE);
    if (!pending) {
      return NextResponse.json({ error: 'Invalid re-auth session' }, { status: 400 });
    }

    // Only honor pending sessions that were started for the reauth purpose, so
    // a normal login code can't be redirected into setting a pairing proof.
    if (pending.purpose !== 'reauth') {
      return NextResponse.json({ error: 'Not a re-auth session' }, { status: 400 });
    }
    if (pending.state !== state) {
      return NextResponse.json({ error: 'State mismatch' }, { status: 400 });
    }
    const createdAt = pending.created_at as number;
    if (!createdAt || Date.now() - createdAt > SSO_PENDING_MAX_AGE_MS) {
      return NextResponse.json({ error: 'Re-auth session expired' }, { status: 400 });
    }

    const codeVerifier = pending.code_verifier as string;
    const redirectUri = pending.redirect_uri as string;
    const pendingServerId = typeof pending.server_id === 'string' ? pending.server_id : null;
    const slot = typeof pending.slot === 'number' && Number.isInteger(pending.slot)
      && pending.slot >= 0 && pending.slot < MAX_ACCOUNT_SLOTS ? pending.slot : 0;
    if (!codeVerifier || !redirectUri) {
      return NextResponse.json({ error: 'Invalid re-auth session data' }, { status: 400 });
    }

    const context = readStalwartAuthContextFromStore(cookieStore, slot);
    if (!context) {
      return NextResponse.json({ error: 'not_signed_in' }, { status: 401 });
    }

    // A successful exchange proves the user just authenticated at the IdP (the
    // freshness is asked for with prompt=login on the authorize request).
    const tokens = await exchangeCodeForTokens(code, codeVerifier, redirectUri, pendingServerId);

    // An IdP that ignores prompt=login answers from its existing session;
    // when its ID token says the login is older than this step-up, it was
    // no step-up at all. (No auth_time: nothing to check.)
    const authTime = idTokenAuthTime(tokens.id_token);
    if (authTime !== null && authTime * 1000 < createdAt - AUTH_TIME_SKEW_MS) {
      logger.warn('Reauth complete: the provider did not ask for a fresh login');
      return NextResponse.json({ error: 'reauth_not_fresh' }, { status: 401 });
    }

    // ...but not as whom. The phone must get the account being paired, not
    // whichever account the IdP prompt was answered with.
    const serverUrl = context.serverUrl.replace(/\/+$/, '');
    try {
      await verifyJmapIdentity(serverUrl, `Bearer ${tokens.access_token}`, context.username, {
        trusted: await isTrustedJmapServerUrl(serverUrl),
      });
    } catch (error) {
      if (error instanceof JmapAuthVerificationError && (error.status === 401 || error.status === 403)) {
        logger.warn('Reauth complete: fresh login is a different account');
        return NextResponse.json({ error: 'account_mismatch' }, { status: 403 });
      }
      throw error;
    }

    // Without a refresh token the phone would be signed out at the first
    // access-token expiry; better to say so now.
    if (!tokens.refresh_token) {
      logger.warn('Reauth complete: provider issued no refresh token');
      return NextResponse.json({ error: 'no_refresh_token' }, { status: 502 });
    }

    const owner = pairingOwner(slot, context.username);
    const grantId = stashGrant({
      flow: 'oauth',
      serverUrl,
      serverId: pendingServerId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      issuedAt: Date.now(),
      tokenEndpoint: await getTokenEndpoint(pendingServerId),
      clientId: getRequiredConfig(pendingServerId).clientId,
      confidential: hasClientSecret(pendingServerId),
      trusted: true,
    }, owner);
    setPairReauthInStore(cookieStore, { grantId, owner });
    logger.info('Pair step-up succeeded', { flow: 'oauth', method: 'sso' });
    return NextResponse.json({ ok: true });
  } catch (error) {
    cookieStore.delete(SSO_PENDING_COOKIE);
    logger.error('Reauth complete error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Re-authentication failed' }, { status: 401 });
  }
}
