import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { getSessionSecret } from '@/lib/auth/session-secret';
import { isSameOriginRequest } from '@/lib/security/same-origin';
import { pickForwardedFor } from '@/lib/security/client-ip';
import { ADMIN_SESSION_COOKIE, DEFAULT_ADMIN_SESSION_TTL } from './types';
import type { AdminSessionPayload } from './types';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

const MIN_SECRET_LENGTH = 32;

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

/**
 * Create an encrypted admin session token.
 */
export function createAdminSession(): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const now = Math.floor(Date.now() / 1000);
  const payload: AdminSessionPayload = {
    role: 'admin',
    iat: now,
    exp: now + getSessionTTL(),
  };

  const json = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Verify and decode an admin session token. Returns null if invalid or expired.
 */
export function verifyAdminSession(token: string): AdminSessionPayload | null {
  try {
    const key = getKey();
    const data = Buffer.from(token, 'base64');
    if (data.length < IV_LENGTH + TAG_LENGTH) return null;

    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const payload = JSON.parse(decrypted.toString('utf8')) as AdminSessionPayload;

    if (payload.role !== 'admin') return null;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;

    return payload;
  } catch {
    return null;
  }
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

  const payload = verifyAdminSession(token);
  if (!payload) {
    cookieStore.delete(ADMIN_SESSION_COOKIE);
    return { error: NextResponse.json({ error: 'Session expired' }, { status: 401 }) };
  }

  return { payload };
}

/**
 * Set the admin session cookie.
 */
export async function setAdminSessionCookie(): Promise<void> {
  const token = createAdminSession();
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: getSessionTTL(),
  });
}

/**
 * Clear the admin session cookie.
 */
export async function clearAdminSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(ADMIN_SESSION_COOKIE);
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
    return pickForwardedFor(forwarded) || '0.0.0.0';
  }
  return request.headers.get('x-real-ip') || '0.0.0.0';
}
