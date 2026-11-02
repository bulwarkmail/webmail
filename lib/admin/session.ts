import { cookies } from 'next/headers';
import { secureCookieFlag } from '@/lib/security/request-protocol';
import { NextResponse } from 'next/server';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { getSessionSecret } from '@/lib/auth/session-secret';
import { isSameOriginRequest } from '@/lib/security/same-origin';
import { logger } from '@/lib/logger';
import { isStoreUnavailable } from './admin-store';
import { ADMIN_SESSION_COOKIE, DEFAULT_ADMIN_SESSION_TTL } from './types';
import type { AdminSessionPayload } from './types';
import { getAdminSessionGeneration, isAdminSessionRevoked, revokeAdminSession } from './password';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

const MIN_SECRET_LENGTH = 32;

/**
 * Bound into every admin token as GCM associated data. The mailbox session
 * cookies and the synced-settings files are sealed with the same key and
 * layout, and a user picks the content of their settings, so without it a
 * settings file holding {"role":"admin",...} would open the dashboard.
 */
const ADMIN_SESSION_AAD = Buffer.from('bulwark-admin-session', 'utf8');

function getKey(): Buffer {
  const secret = getSessionSecret();
  if (!secret) throw new Error('SESSION_SECRET not configured');
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters (got ${secret.length}). ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  return createHash('sha256').update(secret).digest();
}

function getSessionTTL(): number {
  const ttl = parseInt(process.env.ADMIN_SESSION_TTL || '', 10);
  return isNaN(ttl) || ttl <= 0 ? DEFAULT_ADMIN_SESSION_TTL : ttl;
}

/** Encrypt `payload` under the session key, bound to `aad`. */
function sealToken(payload: object, aad: Buffer): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad);

  const json = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/** Decrypt a token sealToken made with the same `aad`. Throws when it doesn't open. */
function openToken(token: string, aad: Buffer): unknown {
  const key = getKey();
  const data = Buffer.from(token, 'base64');
  if (data.length < IV_LENGTH + TAG_LENGTH) throw new Error('Token too short');

  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

/**
 * Create an encrypted admin session token, in session generation
 * `generation` (see getAdminSessionGeneration).
 */
export function createAdminSession(generation = 0): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: AdminSessionPayload = {
    role: 'admin',
    iat: now,
    exp: now + getSessionTTL(),
    sid: randomBytes(16).toString('base64url'),
    gen: generation,
  };
  return sealToken(payload, ADMIN_SESSION_AAD);
}

/**
 * Verify and decode an admin session token. Returns null if invalid or expired.
 */
export function verifyAdminSession(token: string): AdminSessionPayload | null {
  try {
    const payload = openToken(token, ADMIN_SESSION_AAD) as AdminSessionPayload;

    if (!payload || payload.role !== 'admin') return null;
    // Every token this version issues has both; ADMIN_SESSION_AAD already
    // signed the ones from before out.
    if (typeof payload.sid !== 'string' || typeof payload.gen !== 'number') return null;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * verifyAdminSession, and not signed out since it was issued: by a logout
 * of this token, or by a new admin password (which moves the generation on).
 * With a shared store both are checked against the store on every call, so
 * a sign-out on one replica counts on all of them at once; an unreachable
 * store throws StoreUnavailableError.
 */
export async function verifyCurrentAdminSession(token: string): Promise<AdminSessionPayload | null> {
  const payload = verifyAdminSession(token);
  if (!payload) return null;
  // Together, so a shared store is read once.
  const [generation, revoked] = await Promise.all([getAdminSessionGeneration(), isAdminSessionRevoked(payload.sid)]);
  if (payload.gen !== generation) return null;
  if (revoked) return null;
  return payload;
}

// The CSRF gate lives in lib/security/same-origin so the unauthenticated
// /api/auth/* routes share it (GHSA-qvr9-m8cq-7wvg). Re-exported here for
// the admin routes and their tests.
export { isSameOriginRequest };

/**
 * Validate the admin session from cookies. Returns the payload or a 401 response.
 *
 * Also rejects cross-origin state-changing requests with 403 to prevent CSRF
 * against cookie-authenticated admin actions.
 */
export async function requireAdminAuth(request: Request): Promise<{ payload: AdminSessionPayload } | { error: NextResponse }> {
  if (!isSameOriginRequest(request)) {
    return { error: NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 }) };
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_SESSION_COOKIE)?.value;

  if (!token) {
    return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  }

  let payload: AdminSessionPayload | null;
  try {
    payload = await verifyCurrentAdminSession(token);
  } catch (error) {
    // Sign-outs can't be checked: no admin request goes through.
    if (isStoreUnavailable(error)) {
      return {
        error: NextResponse.json(
          { error: 'The admin dashboard is temporarily unavailable' },
          { status: 503, headers: { 'Retry-After': '10' } },
        ),
      };
    }
    throw error;
  }
  if (!payload) {
    cookieStore.delete(ADMIN_SESSION_COOKIE);
    return { error: NextResponse.json({ error: 'Session expired' }, { status: 401 }) };
  }

  return { payload };
}

/**
 * Set the admin session cookie.
 *
 * `Secure` follows the request the way the setup wizard's cookie does: the
 * browser drops Secure cookies on plain HTTP, so setting it unconditionally in
 * production made admin sign-in fail silently on an HTTP deployment while the
 * wizard right next to it worked. Without a request (older callers) the
 * previous production default stands. An explicit COOKIE_SECURE wins over
 * both, as it does for the mailbox cookies: a TLS proxy that does not send
 * X-Forwarded-Proto would otherwise make the request look like plain HTTP.
 */
export async function setAdminSessionCookie(request?: Request): Promise<void> {
  const token = createAdminSession(await getAdminSessionGeneration());
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookieFlag(request),
    sameSite: 'lax',
    path: '/',
    maxAge: getSessionTTL(),
  });
}

/**
 * A browser that has signed in to the admin dashboard before (OWASP's
 * "device cookie"). Password attempts from it are limited per device instead
 * of by the budget every other client shares (lib/admin/rate-limit.ts), so
 * wrong passwords sent from anywhere else can't lock an admin's own browser
 * out. It grants nothing else. Sealed like the session token, under its own
 * associated data, so neither passes for the other.
 */
export const ADMIN_DEVICE_COOKIE = 'admin_device';
const ADMIN_DEVICE_AAD = Buffer.from('bulwark-admin-device', 'utf8');
const ADMIN_DEVICE_TTL = 180 * 24 * 60 * 60;

interface AdminDevicePayload {
  typ: 'admin-device';
  id: string;
  exp: number;
}

export function createAdminDeviceToken(): string {
  const payload: AdminDevicePayload = {
    typ: 'admin-device',
    id: randomBytes(16).toString('base64url'),
    exp: Math.floor(Date.now() / 1000) + ADMIN_DEVICE_TTL,
  };
  return sealToken(payload, ADMIN_DEVICE_AAD);
}

/** The device id in an admin device token, or null if it's invalid or expired. */
export function verifyAdminDeviceToken(token: string): string | null {
  try {
    const payload = openToken(token, ADMIN_DEVICE_AAD) as AdminDevicePayload;
    if (!payload || payload.typ !== 'admin-device' || typeof payload.id !== 'string' || !payload.id) return null;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.id;
  } catch {
    return null;
  }
}

/** The id of this browser's admin device cookie, if it has a valid one. */
export async function getAdminDeviceId(): Promise<string | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_DEVICE_COOKIE)?.value;
  return token ? verifyAdminDeviceToken(token) : null;
}

/** Mark this browser as one an admin signed in from. Kept across sign-outs. */
export async function setAdminDeviceCookie(request?: Request): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_DEVICE_COOKIE, createAdminDeviceToken(), {
    httpOnly: true,
    secure: secureCookieFlag(request),
    sameSite: 'strict',
    path: '/',
    maxAge: ADMIN_DEVICE_TTL,
  });
}

/**
 * Clear the admin session cookie and sign its token out, so a copy of the
 * cookie stops working too.
 */
export async function clearAdminSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  const payload = verifyAdminSession(cookieStore.get(ADMIN_SESSION_COOKIE)?.value ?? '');
  cookieStore.delete(ADMIN_SESSION_COOKIE);
  if (!payload) return;
  try {
    await revokeAdminSession(payload.sid, payload.exp);
  } catch (error) {
    logger.warn('Failed to save the admin session sign-out', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    // Local mode keeps it in memory regardless; only a restart forgets it.
    // With a shared store nothing kept it: once the store is back a copy of
    // the cookie would work again until it expires, so the caller is told.
    if (isStoreUnavailable(error)) throw error;
  }
}

/**
 * Get the client IP from the request headers.
 *
 * Proxies typically *append* to X-Forwarded-For, so the last entry
 * before our trusted proxy is the most reliable client IP. When a
 * single reverse proxy sits in front of the app the rightmost entry
 * is the one added by that proxy. We take the rightmost entry to
 * avoid trusting attacker-controlled values prepended to the header.
 *
 * If you run behind multiple trusted proxies, set TRUSTED_PROXY_DEPTH
 * to the number of trusted proxies (default 1).
 */
export function getClientIP(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const parts = forwarded.split(',').map(s => s.trim()).filter(Boolean);
    const depth = Math.max(1, parseInt(process.env.TRUSTED_PROXY_DEPTH || '1', 10));
    // Take the entry at position (length - depth), clamped to 0
    const index = Math.max(0, parts.length - depth);
    return parts[index] || '0.0.0.0';
  }
  return request.headers.get('x-real-ip') || '0.0.0.0';
}
