import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { initAdminPassword, verifyAdminPassword, updateLastLogin, isAdminEnabled, getAdminMeta } from '@/lib/admin/password';
import { setAdminSessionCookie, clearAdminSessionCookie, requireAdminAuth, getClientIP, isSameOriginRequest, getAdminDeviceId, setAdminDeviceCookie } from '@/lib/admin/session';
import { checkRateLimit, checkDeviceRateLimit } from '@/lib/admin/rate-limit';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { configManager } from '@/lib/admin/config-manager';
import { getStalwartAdminAccessMode, type StalwartAdminAccessMode } from '@/lib/admin/stalwart-admin-access';
import { isStoreUnavailable } from '@/lib/admin/admin-store';

/**
 * The shared store (#1066) can't be reached: the login limits can't be
 * checked, so no password is tried.
 */
function signInUnavailable(): NextResponse {
  return NextResponse.json(
    { error: 'Sign-in is temporarily unavailable' },
    { status: 503, headers: { 'Retry-After': '10' } },
  );
}

/**
 * Check if the current user is a Stalwart admin by attempting an
 * admin-only JMAP method call. Stalwart v0.16 removed the REST management
 * API (including the /api/account permissions endpoint) and exposes all
 * administration through JMAP under the `urn:stalwart:jmap` capability.
 *
 * `x:Tenant/query` requires `sysTenantQuery`, which Stalwart's default roles
 * grant to the server-wide superuser only. The dashboard configures the
 * whole instance, and Bulwark has no notion of tenants, so an admin of one
 * tenant must not pass: `x:Account/query` (the probe this replaced) also
 * answers for tenant admins, whose role carries `sysAccount*`
 * (GHSA-v6hr). A result means superuser; a method error (typically
 * `forbidden`) means anyone else.
 *
 * Results are cached briefly per (server, user) — the admin panel's
 * layout and dashboard page between them trigger this three times on
 * every navigation, and admin status does not change on that timescale.
 * Per instance (#1066): a demoted Stalwart admin keeps auto-login for up to
 * 60 s on each. At most ADMIN_CHECK_CACHE_MAX entries, so one entry per
 * credential that ever asked can't grow it without bound.
 */
const ADMIN_CHECK_CACHE_MS = 60_000;
const ADMIN_CHECK_CACHE_MAX = 1000;
const ADMIN_CHECK_TIMEOUT_MS = 10_000;
const adminCheckCache = new Map<string, { value: boolean; expires: number }>();

function rememberAdminCheck(key: string, value: boolean): void {
  const now = Date.now();
  adminCheckCache.delete(key);
  if (adminCheckCache.size >= ADMIN_CHECK_CACHE_MAX) {
    for (const [k, entry] of adminCheckCache) if (entry.expires <= now) adminCheckCache.delete(k);
  }
  // Still full: the oldest entries go first.
  while (adminCheckCache.size >= ADMIN_CHECK_CACHE_MAX) adminCheckCache.delete(adminCheckCache.keys().next().value!);
  adminCheckCache.set(key, { value, expires: now + ADMIN_CHECK_CACHE_MS });
}

async function fetchWithTimeout(url: string, init: Parameters<typeof fetch>[1]): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADMIN_CHECK_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkStalwartAdmin(request: NextRequest, mode: StalwartAdminAccessMode): Promise<boolean> {
  // Operators who keep Stalwart and Bulwark administration separate (#870)
  // turn the check off entirely: no shield, no auto-login, and nothing
  // about the Stalwart account influences the Bulwark admin dashboard.
  if (mode === 'off') return false;

  // When users may connect to arbitrary JMAP servers, the cookie-stored
  // serverUrl is attacker-controllable — trusting an admin-status response
  // from such a server would let anyone mint an admin session by standing
  // up a JMAP-shaped endpoint. Require the password login in that mode.
  await configManager.ensureLoaded();
  if (configManager.get<boolean>('allowCustomJmapEndpoint', false)) return false;

  const creds = await getStalwartCredentials(request);
  if (!creds) return false;
  // The switch above only reflects today's config. A context cookie minted
  // while custom endpoints were on keeps naming the server it was minted
  // for, so ask only a server the admin configured.
  if (!creds.trusted) return false;

  // Key on a hash of the actual authHeader, not the cookie-claimed username.
  // The username field is caller-supplied in /api/auth/stalwart-context and
  // can be spoofed independently of the credential; keying on it would let
  // any user ride an admin's recent cache entry by sending a cookie with
  // username="admin@host" plus their own authHeader.
  const credHash = createHash('sha256').update(creds.authHeader).digest('base64url');
  const cacheKey = `${creds.serverUrl}\0${credHash}`;
  const cached = adminCheckCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;

  const isAdmin = await runStalwartAdminCheck(creds);
  rememberAdminCheck(cacheKey, isAdmin);
  return isAdmin;
}

async function runStalwartAdminCheck(
  creds: { serverUrl: string; authHeader: string; username: string },
): Promise<boolean> {
  try {
    const sessionRes = await fetchWithTimeout(`${creds.serverUrl}/.well-known/jmap`, {
      method: 'GET',
      headers: { 'Authorization': creds.authHeader },
    });
    if (!sessionRes.ok) {
      logger.info('Stalwart admin check (session)', { username: creds.username, status: sessionRes.status, isAdmin: false });
      return false;
    }

    const session = await sessionRes.json() as {
      primaryAccounts?: Record<string, string>;
    };
    const accountId = session.primaryAccounts?.['urn:stalwart:jmap']
      ?? session.primaryAccounts?.['urn:ietf:params:jmap:mail']
      ?? (session.primaryAccounts ? Object.values(session.primaryAccounts)[0] : undefined);
    if (!accountId) {
      logger.info('Stalwart admin check (no account)', { username: creds.username, isAdmin: false });
      return false;
    }

    // Hit the externally-reachable URL, not session.apiUrl — Stalwart
    // advertises its internal bind address (e.g. http://host:8080/jmap/)
    // which may not be routable from this process.
    const jmapRes = await fetchWithTimeout(`${creds.serverUrl}/jmap/`, {
      method: 'POST',
      headers: {
        'Authorization': creds.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
        methodCalls: [['x:Tenant/query', { accountId, limit: 1 }, '0']],
      }),
    });

    if (!jmapRes.ok) {
      logger.info('Stalwart admin check (jmap)', { username: creds.username, status: jmapRes.status, isAdmin: false });
      return false;
    }

    const data = await jmapRes.json() as {
      methodResponses?: Array<[string, Record<string, unknown>, string]>;
    };
    const first = data.methodResponses?.[0];
    const isAdmin = !!first && first[0] === 'x:Tenant/query';
    logger.info('Stalwart admin check', { username: creds.username, isAdmin });
    return isAdmin;
  } catch (error) {
    logger.debug('Stalwart admin check error', { error: error instanceof Error ? error.message : 'Unknown' });
    return false;
  }
}

/**
 * POST /api/admin/auth - Login
 */
export async function POST(request: NextRequest) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
    }
    const ip = getClientIP(request);
    const body = await request.json();

    // Stalwart-based admin authentication. Only honoured in "auto" mode:
    // "password" keeps the shield but routes through the password form,
    // "off" ignores Stalwart admin status altogether (#870).
    if (body.stalwartAuth === true) {
      const mode = await getStalwartAdminAccessMode();
      if (mode !== 'auto') {
        await auditLog('admin.login_failed', { method: 'stalwart', reason: 'auto_login_disabled', mode }, ip);
        return NextResponse.json({ error: 'Stalwart admin sign-in is disabled; use the admin password' }, { status: 403 });
      }
      const isStalwartAdmin = await checkStalwartAdmin(request, mode);
      if (!isStalwartAdmin) {
        await auditLog('admin.login_failed', { method: 'stalwart' }, ip);
        return NextResponse.json({ error: 'Not a Stalwart admin' }, { status: 403 });
      }

      await setAdminSessionCookie(request);
      await setAdminDeviceCookie(request);
      await auditLog('admin.login', { method: 'stalwart' }, ip);
      return NextResponse.json({ ok: true });
    }

    // Password-based admin authentication
    await initAdminPassword();
    if (!isAdminEnabled()) {
      return NextResponse.json({ error: 'Admin dashboard is not configured' }, { status: 404 });
    }

    // Rate limit check. A browser an admin signed in from before is limited
    // on its own, so others using up the shared budget can't lock it out.
    const deviceId = await getAdminDeviceId();
    const limit = deviceId ? await checkDeviceRateLimit(deviceId) : await checkRateLimit(ip);
    if (!limit.allowed) {
      const retryAfter = Math.ceil(limit.retryAfterMs / 1000);
      await auditLog('admin.login_blocked', { reason: 'rate_limit' }, ip);
      return NextResponse.json(
        { error: 'Too many login attempts. Try again later.' },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } }
      );
    }

    const { password } = body;

    if (!password || typeof password !== 'string') {
      return NextResponse.json({ error: 'Password is required' }, { status: 400 });
    }

    const valid = await verifyAdminPassword(password);
    if (!valid) {
      await auditLog('admin.login_failed', {}, ip);
      logger.warn('Admin login failed', { ip });
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }

    await setAdminSessionCookie(request);
    await setAdminDeviceCookie(request);
    await updateLastLogin();
    await auditLog('admin.login', {}, ip);

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (isStoreUnavailable(error)) return signInUnavailable();
    logger.error('Admin login error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * GET /api/admin/auth - Check session status
 *
 * `stalwartAdmin` tells the client whether to show the admin shield;
 * `stalwartAutoLogin` whether clicking it may mint an admin session without
 * the password (only in "auto" mode). In "auto" mode a Stalwart admin keeps
 * the panel reachable even without a configured admin password.
 */
export async function GET(request: NextRequest) {
  try {
    await initAdminPassword();
    const adminEnabled = isAdminEnabled();
    const mode = await getStalwartAdminAccessMode();
    const isStalwartAdmin = await checkStalwartAdmin(request, mode);
    const stalwartAutoLogin = isStalwartAdmin && mode === 'auto';

    // If neither password-based admin nor Stalwart auto-login, admin is disabled
    if (!adminEnabled && !stalwartAutoLogin) {
      return NextResponse.json({ enabled: false, authenticated: false, stalwartAdmin: false, stalwartAutoLogin: false }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const result = await requireAdminAuth(request);
    if ('error' in result) {
      return NextResponse.json({
        enabled: adminEnabled,
        authenticated: false,
        stalwartAdmin: isStalwartAdmin,
        stalwartAutoLogin,
      }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const meta = getAdminMeta();
    return NextResponse.json({
      enabled: adminEnabled,
      authenticated: true,
      stalwartAdmin: isStalwartAdmin,
      stalwartAutoLogin,
      lastLogin: meta?.lastLogin,
      passwordChangedAt: meta?.passwordChangedAt,
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    logger.error('Admin status error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/auth - Logout
 */
export async function DELETE(request: NextRequest) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
    }
    const ip = getClientIP(request);
    try {
      await clearAdminSessionCookie();
    } catch (error) {
      if (!isStoreUnavailable(error)) throw error;
      // The cookie is gone from this browser, but the sign-out couldn't be
      // stored, so a copy of the cookie isn't refused yet.
      await auditLog('admin.logout', { stored: false }, ip);
      return NextResponse.json(
        { error: 'Signed out in this browser, but the sign-out could not be saved, so a copy of the session still works until it expires. Try signing out again in a moment.' },
        { status: 503, headers: { 'Retry-After': '10' } },
      );
    }
    await auditLog('admin.logout', {}, ip);
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Admin logout error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
