import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { initAdminPassword, verifyAdminPassword, updateLastLogin, isAdminEnabled, getAdminMeta } from '@/lib/admin/password';
import { setAdminSessionCookie, clearAdminSessionCookie, requireAdminAuth, getClientIP, isSameOriginRequest, getAdminDeviceId, setAdminDeviceCookie } from '@/lib/admin/session';
import { checkRateLimit, checkDeviceRateLimit, claimBlockedAuditLine } from '@/lib/admin/rate-limit';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import { getStalwartCredentials, type StalwartCredentials } from '@/lib/stalwart/credentials';
import { configManager } from '@/lib/admin/config-manager';
import { grantsAdminAccess, normalizeUrl, parseJmapServers } from '@/lib/admin/jmap-servers';
import { getStalwartAdminAccessMode, type StalwartAdminAccessMode } from '@/lib/admin/stalwart-admin-access';
import { isStoreUnavailable } from '@/lib/admin/admin-store';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import { isBudgetRefusal, isStoredCredentialRefused, storedCredentialWorkedLately } from '@/lib/stalwart/stored-credential-budget';
import { forwardedClientHeaders, loginClientAddress } from '@/lib/auth/client-address';
import { configuredServerUrls, isListedAdminAccount, readAdminAccounts } from '@/lib/admin/admin-accounts';

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
 * An account the admin listed in `adminAccounts` for this server passes too.
 * It is matched on the names the JMAP session reports for the credential,
 * never on the username the caller put in the sign-in context.
 *
 * What the server said is cached briefly per (server, credential): the
 * admin panel's layout and dashboard page between them trigger this three
 * times on every navigation, and admin status does not change on that
 * timescale. Per instance (#1066): a demoted Stalwart admin keeps
 * auto-login for up to 60 s on each. A credential the mail server refused
 * (401) is answered "not an admin" for ADMIN_CHECK_REFUSED_CACHE_MS instead.
 * The list is checked against the current config on every call, so removing
 * an entry takes effect at once. At most ADMIN_CHECK_CACHE_MAX entries, so
 * one entry per credential that ever asked can't grow it without bound.
 *
 * The probe replays the stored credential like every other cookie-authed
 * route, so it goes through the same failure budget (fetchJmapServer, see
 * lib/stalwart/stored-credential-budget.ts) and names the client's address
 * upstream: a credential the mail server refused is not sent again, and past
 * the ceiling of refusals across all credentials only credentials that
 * worked recently are. Each refusal is a failed login at the mail server,
 * counted against the address it comes from.
 */
const ADMIN_CHECK_CACHE_MS = 60_000;
const ADMIN_CHECK_REFUSED_CACHE_MS = 15 * 60_000;
const ADMIN_CHECK_CACHE_MAX = 1000;
const ADMIN_CHECK_TIMEOUT_MS = 10_000;

/** What the mail server said about one credential. */
interface StalwartSessionFacts {
  superuser: boolean;
  /** The JMAP session's `username`. */
  username?: string;
  /** The `name` of the session's primary mail account. */
  accountName?: string;
}

/** `refused`: the mail server refused the credential (the 15-minute entries). */
const adminCheckCache = new Map<string, { value: StalwartSessionFacts; expires: number; refused: boolean }>();

function rememberAdminCheck(key: string, value: StalwartSessionFacts, ttlMs: number): void {
  const now = Date.now();
  adminCheckCache.delete(key);
  if (adminCheckCache.size >= ADMIN_CHECK_CACHE_MAX) {
    for (const [k, entry] of adminCheckCache) if (entry.expires <= now) adminCheckCache.delete(k);
  }
  // Still full: the oldest entries go first.
  while (adminCheckCache.size >= ADMIN_CHECK_CACHE_MAX) adminCheckCache.delete(adminCheckCache.keys().next().value!);
  adminCheckCache.set(key, { value, expires: now + ttlMs, refused: ttlMs === ADMIN_CHECK_REFUSED_CACHE_MS });
}

async function fetchWithTimeout(url: string, init: RequestInit, trusted: boolean): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADMIN_CHECK_TIMEOUT_MS);
  try {
    return await fetchJmapServer(url, { ...init, signal: controller.signal }, trusted);
  } finally {
    clearTimeout(timer);
  }
}

/** The instance's own mail server, as lib/stalwart/server-fetch.ts reads it. */
function configuredServerUrl(): string {
  return configManager.get<string>('jmapServerUrl', '')
    || process.env.JMAP_SERVER_URL
    || process.env.NEXT_PUBLIC_JMAP_SERVER_URL
    || '';
}

/** Why the request counts as a Stalwart admin, or null when it doesn't. */
type StalwartAdminVia = 'superuser' | 'account_list' | null;

async function checkStalwartAdmin(
  request: NextRequest,
  mode: StalwartAdminAccessMode,
  knownCreds?: StalwartCredentials | null,
): Promise<StalwartAdminVia> {
  // Operators who keep Stalwart and Bulwark administration separate (#870)
  // turn the check off entirely: no shield, no auto-login, and nothing
  // about the Stalwart account influences the Bulwark admin dashboard.
  if (mode === 'off') return null;

  // When users may connect to arbitrary JMAP servers, the cookie-stored
  // serverUrl is attacker-controllable — trusting an admin-status response
  // from such a server would let anyone mint an admin session by standing
  // up a JMAP-shaped endpoint. Require the password login in that mode.
  await configManager.ensureLoaded();
  if (configManager.get<boolean>('allowCustomJmapEndpoint', false)) return null;

  const creds = knownCreds === undefined ? await getStalwartCredentials(request) : knownCreds;
  if (!creds) return null;
  // The switch above only reflects today's config. A context cookie minted
  // while custom endpoints were on keeps naming the server it was minted
  // for, so ask only a server the admin configured.
  if (!creds.trusted) return null;
  // Of those, only the instance's own server, or one the admin marked with
  // `adminAccess`, makes its superusers admins here: another listed server
  // may be run by someone else, whose superuser would get this whole console.
  const superuserCounts = grantsAdminAccess(creds.serverUrl, configuredServerUrl(), parseJmapServers(configManager.get<unknown>('jmapServers', [])));
  // An account the admin listed counts on the server its entry names.
  const entries = readAdminAccounts(
    configManager.get<unknown>('adminAccounts', []),
    configuredServerUrls(configManager.get<unknown>('jmapServerUrl', ''), configManager.get<unknown>('jmapServers', [])),
  );
  const server = normalizeUrl(creds.serverUrl);
  // A server that can make no one an admin here is not asked at all.
  if (!superuserCounts && !entries.some((e) => normalizeUrl(e.serverUrl) === server)) return null;

  // Key on a hash of the actual authHeader, not the cookie-claimed username.
  // The username field is caller-supplied in /api/auth/stalwart-context and
  // can be spoofed independently of the credential; keying on it would let
  // any user ride an admin's recent cache entry by sending a cookie with
  // username="admin@host" plus their own authHeader.
  const credHash = createHash('sha256').update(creds.authHeader).digest('base64url');
  const cacheKey = `${creds.serverUrl}\0${credHash}`;
  const cached = adminCheckCache.get(cacheKey);
  let facts: StalwartSessionFacts | undefined;
  if (cached && cached.expires > Date.now()) {
    // A refusal is kept 15 minutes, but not past a new sign-in with the same
    // credential that worked (the sign-in records it with the budget).
    if (!cached.refused || !(await storedCredentialWorkedLately(creds.authHeader))) facts = cached.value;
    else adminCheckCache.delete(cacheKey);
  }

  if (!facts) {
    // Refused recently (here or by any other route), or the ceiling across
    // all credentials is reached: not asked, and not cached, so the answer
    // follows the budget once it lets the credential through again.
    if (await isStoredCredentialRefused(creds.authHeader)) return null;

    const result = await runStalwartAdminCheck(creds, forwardedClientHeaders(loginClientAddress(request)));
    if (result.ttlMs !== null) rememberAdminCheck(cacheKey, result.facts, result.ttlMs);
    facts = result.facts;
  }
  if (facts.superuser && superuserCounts) return 'superuser';

  // For the same reason, only the names the server reported count here.
  if (!isListedAdminAccount(entries, creds.serverUrl, [facts.username, facts.accountName])) return null;
  logger.info('Stalwart admin check (account list)', { username: facts.username, isAdmin: true });
  return 'account_list';
}

async function runStalwartAdminCheck(
  creds: { serverUrl: string; authHeader: string; username: string; trusted: boolean },
  clientHeaders: Record<string, string>,
): Promise<{ facts: StalwartSessionFacts; ttlMs: number | null }> {
  const facts: StalwartSessionFacts = { superuser: false };
  // The budget's own refusal (another request with this credential was just
  // refused, or the ceiling is reached) is not cached, like the check above.
  // A credential the mail server refused carries no names: it signs no one
  // in through the account list either.
  const notAdmin = (response?: Response) => {
    const refused = response?.status === 401;
    return {
      facts: refused ? { superuser: false } : facts,
      ttlMs: response && isBudgetRefusal(response) ? null : refused ? ADMIN_CHECK_REFUSED_CACHE_MS : ADMIN_CHECK_CACHE_MS,
    };
  };
  try {
    const sessionRes = await fetchWithTimeout(`${creds.serverUrl}/.well-known/jmap`, {
      method: 'GET',
      headers: { ...clientHeaders, 'Authorization': creds.authHeader },
    }, creds.trusted);
    if (!sessionRes.ok) {
      logger.info('Stalwart admin check (session)', { username: creds.username, status: sessionRes.status, tokenCanAdmin: false });
      return notAdmin(sessionRes);
    }

    const session = await sessionRes.json() as {
      username?: unknown;
      primaryAccounts?: Record<string, string>;
      accounts?: Record<string, { name?: unknown } | undefined>;
    };
    if (typeof session.username === 'string') facts.username = session.username;
    const mailAccountId = session.primaryAccounts?.['urn:ietf:params:jmap:mail'];
    const mailAccountName = mailAccountId ? session.accounts?.[mailAccountId]?.name : undefined;
    if (typeof mailAccountName === 'string') facts.accountName = mailAccountName;

    const accountId = session.primaryAccounts?.['urn:stalwart:jmap']
      ?? mailAccountId
      ?? (session.primaryAccounts ? Object.values(session.primaryAccounts)[0] : undefined);
    if (!accountId) {
      logger.info('Stalwart admin check (no account)', { username: creds.username, tokenCanAdmin: false });
      return notAdmin();
    }

    // Hit the externally-reachable URL, not session.apiUrl — Stalwart
    // advertises its internal bind address (e.g. http://host:8080/jmap/)
    // which may not be routable from this process.
    const jmapRes = await fetchWithTimeout(`${creds.serverUrl}/jmap/`, {
      method: 'POST',
      headers: {
        ...clientHeaders,
        'Authorization': creds.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
        methodCalls: [['x:Tenant/query', { accountId, limit: 1 }, '0']],
      }),
    }, creds.trusted);

    if (!jmapRes.ok) {
      logger.info('Stalwart admin check (jmap)', { username: creds.username, status: jmapRes.status, tokenCanAdmin: false });
      return notAdmin(jmapRes);
    }

    const data = await jmapRes.json() as {
      methodResponses?: Array<[string, Record<string, unknown>, string]>;
    };
    const first = data.methodResponses?.[0];
    facts.superuser = !!first && first[0] === 'x:Tenant/query';
    // Says what this sign-in's token may do, not what the account is: since
    // Stalwart 1.0.3 a superuser's webmail token carries only the data
    // scopes and is refused here too (#1611).
    logger.info('Stalwart admin check', { username: creds.username, tokenCanAdmin: facts.superuser });
    return { facts, ttlMs: ADMIN_CHECK_CACHE_MS };
  } catch (error) {
    logger.debug('Stalwart admin check error', { error: error instanceof Error ? error.message : 'Unknown' });
    return notAdmin();
  }
}

/**
 * Count one sign-in attempt against the admin login limits, and answer 429
 * when they are spent. A browser an admin signed in from before is limited
 * on its own, so others using up the shared budget can't lock it out. A
 * refusal is written to the audit log once per client and window, with a
 * ceiling across clients (claimBlockedAuditLine).
 */
async function refusedAttemptLimit(ip: string): Promise<NextResponse | null> {
  const deviceId = await getAdminDeviceId();
  const limit = deviceId ? await checkDeviceRateLimit(deviceId) : await checkRateLimit(ip);
  if (limit.allowed) return null;
  if (await claimBlockedAuditLine(deviceId ? `device:${deviceId}` : ip)) {
    await auditLog('admin.login_blocked', { reason: 'rate_limit' }, ip);
  }
  return NextResponse.json(
    { error: 'Too many login attempts. Try again later.' },
    { status: 429, headers: { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) } },
  );
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
      // Without a mailbox session there is nothing to try: no audit line, so
      // anonymous requests can't fill the log.
      const creds = await getStalwartCredentials(request);
      if (!creds) return NextResponse.json({ error: 'Not a Stalwart admin' }, { status: 403 });

      const mode = await getStalwartAdminAccessMode();
      if (mode !== 'auto') {
        const blocked = await refusedAttemptLimit(ip);
        if (blocked) return blocked;
        await auditLog('admin.login_failed', { method: 'stalwart', reason: 'auto_login_disabled', mode }, ip);
        return NextResponse.json({ error: 'Stalwart admin sign-in is disabled; use the admin password' }, { status: 403 });
      }
      const via = await checkStalwartAdmin(request, mode, creds);
      if (!via) {
        // A refused attempt counts like a wrong admin password; a Stalwart
        // admin's own sign-in doesn't, so others can't lock it out.
        const blocked = await refusedAttemptLimit(ip);
        if (blocked) return blocked;
        await auditLog('admin.login_failed', { method: 'stalwart' }, ip);
        return NextResponse.json({ error: 'Not a Stalwart admin' }, { status: 403 });
      }

      await setAdminSessionCookie(request);
      await setAdminDeviceCookie(request);
      await auditLog('admin.login', via === 'account_list' ? { method: 'stalwart', via } : { method: 'stalwart' }, ip);
      return NextResponse.json({ ok: true });
    }

    // Password-based admin authentication
    await initAdminPassword();
    if (!isAdminEnabled()) {
      return NextResponse.json({ error: 'Admin dashboard is not configured' }, { status: 404 });
    }

    const blocked = await refusedAttemptLimit(ip);
    if (blocked) return blocked;

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
    const isStalwartAdmin = (await checkStalwartAdmin(request, mode)) !== null;
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
    let signedOut: boolean;
    try {
      signedOut = await clearAdminSessionCookie();
    } catch (error) {
      if (!isStoreUnavailable(error)) throw error;
      // The cookie is gone from this browser, but the sign-out couldn't be
      // stored, so a copy of the cookie isn't refused yet. Only reached with
      // a real admin session token.
      await auditLog('admin.logout', { stored: false }, ip);
      return NextResponse.json(
        { error: 'Signed out in this browser, but the sign-out could not be saved, so a copy of the session still works until it expires. Try signing out again in a moment.' },
        { status: 503, headers: { 'Retry-After': '10' } },
      );
    }
    // A line only when an admin session was signed out: a request without
    // one (or with a copy of one that already was) leaves nothing to log.
    if (signedOut) await auditLog('admin.logout', {}, ip);
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Admin logout error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
