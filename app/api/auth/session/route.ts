import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { encryptSession, decryptSession, sessionAuthHeader, type SessionCredentials } from '@/lib/auth/crypto';
import { SESSION_COOKIE_MAX_AGE, sessionCookieName } from '@/lib/auth/session-cookie';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { JmapAuthVerificationError, resolveJmapIdentity } from '@/lib/auth/verify-jmap-auth';
import {
  clearStalwartAuthContextInStore,
  setStalwartAuthContextInStore,
} from '@/lib/stalwart/auth-context';
import { configManager } from '@/lib/admin/config-manager';
import { isPublicHttpUrl } from '@/lib/security/url-guard';
import { recordLogin } from '@/lib/telemetry/login-tracker';
import { parseJmapServers, resolveTrustedJmapUrl } from '@/lib/admin/jmap-servers';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { insecureCookieHint, verificationFailureBody } from '@/lib/auth/verification-failure';
import { readImpersonationConfig } from '@/lib/impersonation/master-config';
import { revokeImpersonationCredential } from '@/lib/impersonation/app-password';
import { IMPERSONATION_GRANT_COOKIE, openImpersonationGrant } from '@/lib/impersonation/grant-cookie';
import { revokeWopiTokens } from '@/lib/wopi/revocation';
import { clearPairReauthInStore } from '@/lib/auth/pair-reauth';
import { loginClientAddress } from '@/lib/auth/client-address';
import { LOGIN_BUDGET_RETRY_AFTER_SECONDS, reserveLoginAttempt } from '@/lib/auth/verify-budget';
import { isStoreUnavailable, storeUnavailableResponse } from '@/lib/auth/store-unavailable';
import { isPastMaxAge, limitsEnforcedSince, maxSessionHoursFor, SESSION_TOO_OLD } from '@/lib/auth/session-age';

function sessionCookieOptions() {
  return {
    ...getCookieOptions(),
    maxAge: SESSION_COOKIE_MAX_AGE,
  };
}

/**
 * A session sealed around the impersonation master password. Handoffs made
 * before impersonation switched to per-mailbox app passwords stored it in
 * the session cookie; it opens every mailbox, so it is never handed back to
 * a browser, whichever path stored it.
 */
function holdsMasterPassword(credentials: SessionCredentials): boolean {
  const config = readImpersonationConfig();
  return !!config && credentials.password === config.masterPassword;
}

async function revokeImpersonationGrant(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
): Promise<void> {
  const grant = openImpersonationGrant(cookieStore.get(IMPERSONATION_GRANT_COOKIE)?.value);
  cookieStore.delete(IMPERSONATION_GRANT_COOKIE);
  const config = readImpersonationConfig();
  if (!grant || !config) return;
  try {
    await revokeImpersonationCredential({
      serverUrl: grant.serverUrl,
      mailbox: grant.mailbox,
      masterUser: config.masterUser,
      masterPassword: config.masterPassword,
      id: grant.credentialId,
    });
  } catch (error) {
    // The app password still expires on its own; sign-out must not fail.
    logger.warn('Impersonation credential revocation failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * True when this slot's session is the one an impersonation handoff opened
 * (GET /api/auth/impersonate). Its username is the plain target mailbox, so
 * nothing in the session itself tells the two apart; the grant cookie does.
 */
function isImpersonationSession(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  slot: number,
  credentials: SessionCredentials,
): boolean {
  if (slot !== 0) return false;
  const grant = openImpersonationGrant(cookieStore.get(IMPERSONATION_GRANT_COOKIE)?.value);
  return !!grant && grant.mailbox === credentials.username && grant.serverUrl === credentials.serverUrl;
}

function getSlot(request: NextRequest): number {
  const raw = request.nextUrl.searchParams.get('slot');
  if (raw === null) return 0;
  const slot = parseInt(raw, 10);
  if (isNaN(slot) || slot < 0 || slot >= MAX_ACCOUNT_SLOTS) return 0;
  return slot;
}

/**
 * The organisation's maximum session length for a remembered session
 * (lib/auth/session-age.ts). A cookie from before sign-in times were
 * recorded counts as signed in when the server first enforced the limits,
 * a fixed time, so a kept copy of it runs out like any other. Returns the
 * sign-in time, or the limit when the session is too old: its cookies are
 * cleared then.
 */
async function checkSessionAge(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  slot: number,
  credentials: SessionCredentials,
): Promise<{ signedInAt: number } | { maxHours: number }> {
  const signedInAt = credentials.signedInAt ?? await limitsEnforcedSince();
  // An impersonation login is `target%master`; the policy is the target's.
  const maxHours = await maxSessionHoursFor(credentials.username.split('%', 1)[0]);
  if (isPastMaxAge(signedInAt, maxHours)) {
    cookieStore.delete(sessionCookieName(slot));
    clearStalwartAuthContextInStore(cookieStore, slot);
    return { maxHours };
  }
  return { signedInAt };
}

function sessionTooOld(maxHours: number) {
  return NextResponse.json(
    { error: SESSION_TOO_OLD, maxHours },
    { status: 401, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}

export async function POST(request: NextRequest) {
  // CSRF gate (GHSA-qvr9-m8cq-7wvg): cookies written here are SameSite=Lax,
  // so a cross-site top-level POST would otherwise reach this handler.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  let upstreamUrl = '';
  let upstreamTrusted = false;
  try {
    const oauthEnabled = configManager.get<boolean>('oauthEnabled', false);
    const oauthOnly = configManager.get<boolean>('oauthOnly', false);
    if (oauthEnabled && oauthOnly) {
      return NextResponse.json({ error: 'Basic authentication is disabled' }, { status: 403 });
    }

    // A password signs in with Basic auth, an access token (token login) with
    // Bearer: exactly one of them.
    const { serverUrl, username, password, token: accessToken, slot: bodySlot } = await request.json();
    if (!serverUrl || !username || typeof (password || accessToken) !== 'string' || !!password === !!accessToken) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Pin the upstream URL to a configured JMAP server so an unauthenticated
    // caller cannot point this route at internal hosts. We accept the global
    // `jmapServerUrl` and any entry from `jmapServers`. When neither matches,
    // we fall back to the request URL only if `allowCustomJmapEndpoint` is on
    // - and even then the URL must resolve to a public address.
    await configManager.ensureLoaded();
    const configuredServerUrl =
      configManager.get<string>('jmapServerUrl', '') ||
      process.env.JMAP_SERVER_URL ||
      process.env.NEXT_PUBLIC_JMAP_SERVER_URL ||
      '';
    const allowCustomEndpoint = configManager.get<boolean>('allowCustomJmapEndpoint', false);
    const serverList = parseJmapServers(configManager.get<unknown>('jmapServers', []));
    const trustedUrl = resolveTrustedJmapUrl(serverUrl, configuredServerUrl, serverList);

    if (trustedUrl) {
      upstreamUrl = trustedUrl;
      upstreamTrusted = true;
    } else if (allowCustomEndpoint) {
      if (!(await isPublicHttpUrl(serverUrl))) {
        return NextResponse.json({ error: 'Server URL is not allowed' }, { status: 400 });
      }
      upstreamUrl = serverUrl;
      upstreamTrusted = false;
    } else {
      return NextResponse.json({ error: 'JMAP server not configured' }, { status: 500 });
    }

    const slot = typeof bodySlot === 'number' && bodySlot >= 0 && bodySlot < MAX_ACCOUNT_SLOTS ? bodySlot : getSlot(request);
    const cookieName = sessionCookieName(slot);
    const authHeader = accessToken
      ? `Bearer ${accessToken}`
      : `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    // Always verify the credential upstream (GHSA-wxcm-j4jc-9fxq). The cookies
    // written here are not only replayed as credentials (where a bogus
    // password would just 401 downstream): the encrypted auth context is also
    // accepted as proof of identity by routes that never contact the mail
    // server, such as settings sync. Skipping the check for admin-configured
    // servers let anyone mint a cookie for any username with a made-up
    // password. `trusted` only relaxes the public-address requirement.
    // Wrong credentials tried from here count against this server's address
    // upstream, so each client gets a failure budget (lib/auth/verify-budget.ts).
    const clientIp = loginClientAddress(request);
    const refund = await reserveLoginAttempt(clientIp);
    if (!refund) {
      return NextResponse.json(
        { error: 'too_many_attempts', hint: 'Too many failed sign-in attempts. Try again later.' },
        { status: 429, headers: { 'Retry-After': String(LOGIN_BUDGET_RETRY_AFTER_SECONDS) } },
      );
    }
    // The context cookie also records which account the credential belongs
    // to: a Bearer login may claim a bare local part (`john`) that several
    // accounts on a multi-domain server answer to, and per-user data such as
    // synced settings must be keyed on the account, not on the claim.
    let normalizedServerUrl: string;
    let accountName: string;
    try {
      ({ serverUrl: normalizedServerUrl, accountName } = await resolveJmapIdentity(upstreamUrl, authHeader, username, {
        trusted: upstreamTrusted,
        clientIp,
      }));
    } catch (error) {
      // Only a credential the server rejected spends the budget; an outage
      // or a mismatched claim says nothing about the password.
      if (!(error instanceof JmapAuthVerificationError && error.status === 401)) await refund();
      throw error;
    }
    await refund();
    // A remembered sign-in starts the maximum session length.
    const signedInAt = Date.now();
    const token = encryptSession(normalizedServerUrl, username, accessToken ? { token: accessToken } : password, signedInAt);
    const cookieStore = await cookies();
    cookieStore.set(cookieName, token, sessionCookieOptions());
    setStalwartAuthContextInStore(cookieStore, slot, {
      serverUrl: normalizedServerUrl,
      username,
      authHeader,
      ...(accountName !== username ? { accountName } : {}),
    });

    void recordLogin(username, normalizedServerUrl);

    const warning = insecureCookieHint(request);
    if (warning) logger.warn(`session: ${warning}`);
    // The browser counts the maximum session length from the server's time.
    return NextResponse.json(warning ? { ok: true, warning, signedInAt } : { ok: true, signedInAt });
  } catch (error) {
    // The sign-in limit can't be counted without the shared store: refused.
    if (isStoreUnavailable(error)) return storeUnavailableResponse();
    if (error instanceof JmapAuthVerificationError) {
      return NextResponse.json(
        verificationFailureBody('session', error, upstreamUrl, upstreamTrusted),
        { status: error.status },
      );
    }

    logger.error('Session store error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const slot = getSlot(request);
    const cookieName = sessionCookieName(slot);
    const cookieStore = await cookies();
    const token = cookieStore.get(cookieName)?.value;

    if (!token) {
      return NextResponse.json({ error: 'No session' }, { status: 401 });
    }

    const credentials = decryptSession(token);
    if (!credentials || holdsMasterPassword(credentials)) {
      cookieStore.delete(cookieName);
      clearStalwartAuthContextInStore(cookieStore, slot);
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    const age = await checkSessionAge(cookieStore, slot, credentials);
    if ('maxHours' in age) return sessionTooOld(age.maxHours);

    setStalwartAuthContextInStore(cookieStore, slot, {
      serverUrl: credentials.serverUrl,
      username: credentials.username,
      authHeader: sessionAuthHeader(credentials),
    });

    // Only return non-sensitive fields. Use PUT to retrieve full credentials.
    const { serverUrl, username } = credentials;
    const impersonated = isImpersonationSession(cookieStore, slot, credentials);
    return NextResponse.json(
      { serverUrl, username, signedInAt: age.signedInAt, ...(impersonated ? { impersonated } : {}) },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (error) {
    logger.error('Session read error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PUT - retrieve full credentials (password or access token) for session restoration.
 * Protected by multiple Sec-Fetch-* headers to ensure only same-origin
 * browser fetch() requests succeed. Non-browser clients cannot forge these.
 */
export async function PUT(request: NextRequest) {
  try {
    // Require all Sec-Fetch-* headers to match a same-origin fetch() call.
    // Browsers set these automatically and they cannot be overridden by JS.
    const secFetchSite = request.headers.get('sec-fetch-site');
    const secFetchMode = request.headers.get('sec-fetch-mode');
    const secFetchDest = request.headers.get('sec-fetch-dest');
    if (secFetchSite !== 'same-origin' || secFetchMode !== 'cors' || secFetchDest !== 'empty') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const slot = getSlot(request);
    const cookieName = sessionCookieName(slot);
    const cookieStore = await cookies();
    const token = cookieStore.get(cookieName)?.value;

    if (!token) {
      return NextResponse.json({ error: 'No session' }, { status: 401 });
    }

    const credentials = decryptSession(token);
    if (!credentials || holdsMasterPassword(credentials)) {
      cookieStore.delete(cookieName);
      clearStalwartAuthContextInStore(cookieStore, slot);
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    const age = await checkSessionAge(cookieStore, slot, credentials);
    if ('maxHours' in age) return sessionTooOld(age.maxHours);

    setStalwartAuthContextInStore(cookieStore, slot, {
      serverUrl: credentials.serverUrl,
      username: credentials.username,
      authHeader: sessionAuthHeader(credentials),
    });

    // The browser counts the maximum session length from the server's time.
    const impersonated = isImpersonationSession(cookieStore, slot, credentials);
    return NextResponse.json({ ...credentials, signedInAt: age.signedInAt, ...(impersonated ? { impersonated } : {}) }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (error) {
    logger.error('Session read error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  // CSRF gate (GHSA-qvr9-m8cq-7wvg): cookies written here are SameSite=Lax,
  // so a cross-site top-level POST would otherwise reach this handler.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const cookieStore = await cookies();
    const all = request.nextUrl.searchParams.get('all') === 'true';
    // Office editors opened from here stop working with the session.
    await revokeWopiTokens(cookieStore, all ? 'all' : getSlot(request));

    if (all) {
      // Delete all session cookies across every slot.
      for (let i = 0; i < MAX_ACCOUNT_SLOTS; i++) {
        cookieStore.delete(sessionCookieName(i));
        clearStalwartAuthContextInStore(cookieStore, i);
      }
      await revokeImpersonationGrant(cookieStore);
      // A phone that already paired keeps its own sign-in; a QR still on
      // screen stops working.
      await clearPairReauthInStore(cookieStore);
    } else {
      const slot = getSlot(request);
      cookieStore.delete(sessionCookieName(slot));
      clearStalwartAuthContextInStore(cookieStore, slot);
      if (slot === 0) await revokeImpersonationGrant(cookieStore);
      await clearPairReauthInStore(cookieStore, slot);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Session clear error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
