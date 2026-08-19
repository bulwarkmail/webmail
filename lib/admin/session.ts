import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { getSessionSecret } from '@/lib/auth/session-secret';
import { ADMIN_SESSION_COOKIE, DEFAULT_ADMIN_SESSION_TTL } from './types';
import type { AdminSessionPayload } from './types';

type AdminSessionAuthMethod = Exclude<AdminSessionPayload['authMethod'], 'legacy'>;

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
export function createAdminSession(
  authMethod: AdminSessionAuthMethod,
  options: { stalwartSystemAdmin?: boolean } = {},
): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const now = Math.floor(Date.now() / 1000);
  const payload: AdminSessionPayload = {
    role: 'admin',
    authMethod,
    ...(authMethod === 'stalwart' ? { stalwartSystemAdmin: options.stalwartSystemAdmin === true } : {}),
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
    const parsed = JSON.parse(decrypted.toString('utf8')) as Partial<AdminSessionPayload>;

    if (parsed.role !== 'admin') return null;

    const authMethod =
      parsed.authMethod === 'password' || parsed.authMethod === 'stalwart'
        ? parsed.authMethod
        : 'legacy';
    if (typeof parsed.iat !== 'number' || typeof parsed.exp !== 'number') return null;

    const payload: AdminSessionPayload = {
      role: 'admin',
      authMethod,
      ...(typeof parsed.stalwartSystemAdmin === 'boolean'
        ? { stalwartSystemAdmin: parsed.stalwartSystemAdmin }
        : {}),
      iat: parsed.iat,
      exp: parsed.exp,
    };

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * CSRF gate for cookie-authed admin requests.
 *
 * The admin session cookie is `SameSite=Lax`, which still allows top-level
 * cross-site POST navigations (e.g. a form auto-submitted by an attacker
 * page the admin is tricked into visiting). Without a CSRF check, any such
 * page can trigger arbitrary state changes carrying the admin cookie.
 *
 * Strategy: state-changing requests must come from the same origin. Modern
 * browsers (since 2020) always send `Sec-Fetch-Site` and that header
 * cannot be set by JS, so it is the authoritative signal. Older browsers
 * fall back to `Origin`. Non-browser clients (curl, scripts) send neither
 * header and cannot ride a victim's cookie cross-origin, so the absence
 * of both headers is allowed.
 */
export function isSameOriginRequest(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null) {
    return fetchSite === 'same-origin';
  }

  const origin = request.headers.get('origin');
  if (!origin) return true;

  try {
    const originHost = new URL(origin).host;
    const requestHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
    return !!requestHost && originHost === requestHost;
  } catch {
    return false;
  }
}

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
export async function setAdminSessionCookie(
  authMethod: AdminSessionAuthMethod,
  options: { stalwartSystemAdmin?: boolean } = {},
): Promise<void> {
  const token = createAdminSession(authMethod, options);
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
    const parts = forwarded.split(',').map(s => s.trim()).filter(Boolean);
    const depth = Math.max(1, parseInt(process.env.TRUSTED_PROXY_DEPTH || '1', 10));
    // Take the entry at position (length - depth), clamped to 0
    const index = Math.max(0, parts.length - depth);
    return parts[index] || '0.0.0.0';
  }
  return request.headers.get('x-real-ip') || '0.0.0.0';
}
