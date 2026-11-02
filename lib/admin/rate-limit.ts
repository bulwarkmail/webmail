import { createHash } from 'node:crypto';
import { getStore } from '@/lib/shared-store';

/**
 * Rate limiter for admin login.
 * Max 5 attempts per IP per 15 minutes, and 50 across all clients. A browser
 * with the admin device cookie (lib/admin/session.ts) gets 5 per device
 * instead and stays out of the shared ceiling, which anyone can use up.
 *
 * The counters live in the store (#1066): memory in this process by
 * default, shared by every replica with a shared store, so the limits hold
 * for the whole deployment. Refused attempts aren't counted. With a shared
 * store that can't be reached the checks throw StoreUnavailableError and
 * the login is refused.
 */

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Ceiling across all clients. The per-IP key comes from X-Forwarded-For
 * (getClientIP), which a client can write itself when the app is reachable
 * without a reverse proxy in front: Next fills the header from the socket
 * only when the request carries none. Rotating forged addresses would
 * otherwise buy unlimited guesses. 50 per window still leaves room for a
 * few admins mistyping at once.
 */
const GLOBAL_MAX_ATTEMPTS = 50;

const GLOBAL_KEY = 'admin-login:all';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

/** A counter key for a client-supplied value: as is when it is short and plain, hashed otherwise. */
function keyPart(value: string): string {
  return /^[\x21-\x7e]{1,128}$/.test(value) ? value : `h:${createHash('sha256').update(value).digest('base64url')}`;
}

/**
 * Check if the IP is rate limited, and count the attempt when it isn't.
 * Returns remaining attempts, or 0 if blocked.
 */
export async function checkRateLimit(ip: string): Promise<RateLimitResult> {
  const result = await getStore().counters.reserve([
    { key: `admin-login:ip:${keyPart(ip)}`, max: MAX_ATTEMPTS, windowMs: WINDOW_MS },
    { key: GLOBAL_KEY, max: GLOBAL_MAX_ATTEMPTS, windowMs: WINDOW_MS },
  ], Date.now());
  if (!result.ok) return { allowed: false, remaining: 0, retryAfterMs: result.retryAfterMs };
  return { allowed: true, remaining: MAX_ATTEMPTS - result.counts[0], retryAfterMs: 0 };
}

/**
 * Check a browser with a valid admin device cookie, by its device id: 5
 * attempts per 15 minutes, not counted against or stopped by the shared
 * ceiling.
 */
export async function checkDeviceRateLimit(deviceId: string): Promise<RateLimitResult> {
  const result = await getStore().counters.reserve([
    { key: `admin-login:device:${keyPart(deviceId)}`, max: MAX_ATTEMPTS, windowMs: WINDOW_MS },
  ], Date.now());
  if (!result.ok) return { allowed: false, remaining: 0, retryAfterMs: result.retryAfterMs };
  return { allowed: true, remaining: MAX_ATTEMPTS - result.counts[0], retryAfterMs: 0 };
}
