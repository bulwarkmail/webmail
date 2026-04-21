import { NextRequest, NextResponse } from 'next/server';
import { initAdminPassword, verifyAdminPassword, updateLastLogin, isAdminEnabled, getAdminMeta } from '@/lib/admin/password';
import { setAdminSessionCookie, clearAdminSessionCookie, requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { checkRateLimit } from '@/lib/admin/rate-limit';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';

/**
 * Permissions that indicate Stalwart admin privileges.
 * If the authenticated user has at least one of these, they can manage
 * system-level resources and are considered an admin.
 */
const ADMIN_PERMISSIONS = [
  'sysAccountQuery',
  'sysTenantQuery',
  'sysSystemSettingsGet',
];

/**
 * Check if the current user is a Stalwart admin by inspecting the
 * permissions list returned by Stalwart's /api/account endpoint.
 */
async function checkStalwartAdmin(request: NextRequest): Promise<boolean> {
  try {
    const creds = await getStalwartCredentials(request);
    if (!creds) return false;

    const response = await fetch(`${creds.serverUrl}/api/account`, {
      method: 'GET',
      headers: { 'Authorization': creds.authHeader },
    });

    if (!response.ok) {
      logger.info('Stalwart admin check (auth)', { username: creds.username, status: response.status, isAdmin: false });
      return false;
    }

    const data = await response.json() as { permissions?: string[] };
    const permissions = Array.isArray(data.permissions) ? data.permissions : [];
    const isAdmin = ADMIN_PERMISSIONS.some(p => permissions.includes(p));
    logger.info('Stalwart admin check (auth)', { username: creds.username, status: response.status, isAdmin });
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
    const ip = getClientIP(request);
    const body = await request.json();

    // Stalwart-based admin authentication
    if (body.stalwartAuth === true) {
      const isStalwartAdmin = await checkStalwartAdmin(request);
      if (!isStalwartAdmin) {
        await auditLog('admin.login_failed', { method: 'stalwart' }, ip);
        return NextResponse.json({ error: 'Not a Stalwart admin' }, { status: 403 });
      }

      await setAdminSessionCookie();
      await auditLog('admin.login', { method: 'stalwart' }, ip);
      return NextResponse.json({ ok: true });
    }

    // Password-based admin authentication
    await initAdminPassword();
    if (!isAdminEnabled()) {
      return NextResponse.json({ error: 'Admin dashboard is not configured' }, { status: 404 });
    }

    // Rate limit check
    const limit = checkRateLimit(ip);
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

    await setAdminSessionCookie();
    await updateLastLogin();
    await auditLog('admin.login', {}, ip);

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Admin login error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * GET /api/admin/auth - Check session status
 * Also checks if the user is a Stalwart admin (admin panel enabled even without password).
 */
export async function GET(request: NextRequest) {
  try {
    await initAdminPassword();
    const adminEnabled = isAdminEnabled();
    const isStalwartAdmin = await checkStalwartAdmin(request);

    // If neither password-based admin nor Stalwart admin, admin is disabled
    if (!adminEnabled && !isStalwartAdmin) {
      return NextResponse.json({ enabled: false, authenticated: false, stalwartAdmin: false }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const result = await requireAdminAuth();
    if ('error' in result) {
      return NextResponse.json({
        enabled: adminEnabled,
        authenticated: false,
        stalwartAdmin: isStalwartAdmin,
      }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const meta = getAdminMeta();
    return NextResponse.json({
      enabled: adminEnabled,
      authenticated: true,
      stalwartAdmin: isStalwartAdmin,
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
    const ip = getClientIP(request);
    await clearAdminSessionCookie();
    await auditLog('admin.logout', {}, ip);
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Admin logout error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
