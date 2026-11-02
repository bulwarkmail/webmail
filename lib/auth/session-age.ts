/**
 * The organisation's maximum session length (policy.json
 * `organisation.session.maxHours`) on the server side.
 *
 * JMAP goes from the browser straight to Stalwart, so the client's timer
 * signs users out on time (components/session/session-timeout-guard.tsx).
 * The server's part is to stop a session older than the maximum from coming
 * back: the routes that restore a remembered sign-in (/api/auth/session) or
 * renew a provider token (/api/auth/token) refuse it and clear its cookies.
 *
 * The sign-in time travels in the remembered-session cookie (`signedInAt` in
 * lib/auth/crypto.ts) and, for token sign-ins, in a stamp cookie of its own
 * that is bound to the refresh token by a hash and rewritten with it on
 * every rotation. A cookie or token without a sign-in time (one written
 * before this existed, or a stamp that was deleted or doesn't match the
 * token) counts as signed in at one fixed time: when the server first
 * enforced the limits (limitsEnforcedSince). Deleting the stamp therefore
 * never makes a session younger.
 *
 * The server knows an account's address, not its groups, so only Everyone
 * and the domain scopes count here; a group scope's value is enforced by the
 * client alone.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { cookies } from 'next/headers';
import { configManager } from '@/lib/admin/config-manager';
import { ensureStateDir, getStateDir, getStatePath } from '@/lib/admin/paths';
import { resolvePolicy } from '@/lib/admin/policy-scopes';
import { decryptPayload, encryptPayload } from '@/lib/auth/crypto';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { logger } from '@/lib/logger';
import { getStore, isSharedMode, type CollectionOptions } from '@/lib/shared-store';

export { SESSION_TOO_OLD } from '@/lib/session-policy/constants';

type CookieStore = Awaited<ReturnType<typeof cookies>>;

const HOUR_MS = 60 * 60 * 1000;

const positiveHours = (value: unknown): number => (typeof value === 'number' && value > 0 ? value : 0);

/**
 * The maximum session length (hours, 0 = none) for an account's address.
 * Without an address (a token sign-in whose stamp names no account, which
 * includes one whose stamp was deleted) the strictest value of Everyone and
 * every domain entry applies, so losing the account never loosens the limit.
 */
export async function maxSessionHoursFor(account: string | null | undefined): Promise<number> {
  try {
    await configManager.ensureLoaded?.();
    const raw = configManager.getPolicy();
    const email = account?.trim().toLowerCase() ?? '';
    if (email) return positiveHours(resolvePolicy(raw, { email, groups: [] }).policy.organisation?.session?.maxHours);
    const values = [
      positiveHours(resolvePolicy(raw, null).policy.organisation?.session?.maxHours),
      ...(raw.scopes ?? [])
        .filter((scope) => (scope.match?.domains?.length ?? 0) > 0)
        .map((scope) => positiveHours(scope.policy?.organisation?.session?.maxHours)),
    ].filter((hours) => hours > 0);
    return values.length > 0 ? Math.min(...values) : 0;
  } catch (error) {
    logger.warn('Could not read the maximum session length', { error: error instanceof Error ? error.message : 'Unknown error' });
    return 0;
  }
}

/** Whether a session signed in at `signedInAt` has outlived `maxHours`. */
export function isPastMaxAge(signedInAt: number, maxHours: number, now = Date.now()): boolean {
  if (!maxHours) return false;
  return now - signedInAt >= maxHours * HOUR_MS;
}

// ── The fixed time for sessions without a sign-in time ─────────────────────

const ENFORCED_SINCE_FILE = 'session-limits-since';
const PROCESS_START = Date.now() - Math.round(process.uptime() * 1000);
// One memo per process, not one per bundle: every bundle must agree.
const MEMO_KEY = Symbol.for('bulwark.sessionLimitsSince');

function memo(): { since: Promise<number> | null } {
  const g = globalThis as typeof globalThis & { [MEMO_KEY]?: { since: Promise<number> | null } };
  g[MEMO_KEY] ??= { since: null };
  return g[MEMO_KEY];
}

/**
 * The time in the shared store (#1066). Its local layout is today's file in
 * the state dir, which local mode keeps writing itself (with O_EXCL).
 */
export const SESSION_LIMITS_COLLECTION = 'session-limits';
export const SESSION_LIMITS_ID = ENFORCED_SINCE_FILE;
export const sessionLimitsLayout: CollectionOptions = { local: { dir: () => getStateDir() } };

function sessionLimitsCollection() {
  return getStore().collection(SESSION_LIMITS_COLLECTION, sessionLimitsLayout);
}

function parseTime(text: string): number | null {
  const value = Number(text.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function readRecorded(path: string): Promise<number | null> {
  try {
    return parseTime(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * When this server first enforced the session limits, recorded once in the
 * admin state dir. Falls back to the process start when the file can't be
 * written (a read-only state dir), which restarts the count on a restart.
 *
 * With a shared store it is recorded there once, by whichever replica asks
 * first, and every replica uses that time. When the store can't be reached
 * this call counts from the process start and the next one asks again.
 */
export function limitsEnforcedSince(): Promise<number> {
  const m = memo();
  m.since ??= isSharedMode() ? sharedEnforcedSince() : localEnforcedSince();
  return m.since;
}

async function sharedEnforcedSince(): Promise<number> {
  const docs = sessionLimitsCollection();
  try {
    const recorded = await docs.get(ENFORCED_SINCE_FILE);
    const known = recorded ? parseTime(recorded.data.toString('utf8')) : null;
    if (known) return known;
    const now = Date.now();
    // Created only if missing: replicas starting together keep the first one's time.
    const written = await docs.put(ENFORCED_SINCE_FILE, String(now), { ifVersion: null });
    if (written.ok) return now;
    const other = written.current ? parseTime(written.current.data.toString('utf8')) : null;
    if (other) return other;
    throw new Error('The recorded time is unreadable');
  } catch (error) {
    memo().since = null;
    logger.warn('Could not read when the session limits were first enforced; counting from the process start for now', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return PROCESS_START;
  }
}

function localEnforcedSince(): Promise<number> {
  return (async () => {
    const path = getStatePath(ENFORCED_SINCE_FILE);
    const recorded = await readRecorded(path);
    if (recorded) return recorded;
    const now = Date.now();
    try {
      await ensureStateDir();
      // 'wx': a second process starting at the same moment keeps the first one's time.
      await writeFile(path, String(now), { flag: 'wx' });
      return now;
    } catch {
      const other = await readRecorded(path);
      if (other) return other;
      logger.warn('Could not record when the session limits were first enforced; counting from the process start');
      return PROCESS_START;
    }
  })();
}

/** Test helper. */
export function resetLimitsEnforcedSince(): void {
  memo().since = null;
}

// ── The sign-in stamp of a token sign-in ───────────────────────────────────

/**
 * The sign-in time of a token sign-in, bound to the refresh token it was
 * written with. `account` is filled in once the auth context names it.
 */
export interface SignInStamp {
  signedInAt: number;
  tokenHash: string;
  account?: string;
}

export function refreshTokenHash(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('base64url');
}

export function signInStampCookieName(slot: number): string {
  return slot === 0 ? 'jmap_signed_in' : `jmap_signed_in_${slot}`;
}

/** The slot's stamp, or null when it is missing, unreadable, or written for another refresh token. */
export function readSignInStamp(cookieStore: CookieStore, slot: number, refreshToken: string): SignInStamp | null {
  const value = cookieStore.get(signInStampCookieName(slot))?.value;
  if (!value) return null;
  try {
    const payload = decryptPayload(value, 'session-age');
    const signedInAt = payload?.signedInAt;
    if (typeof signedInAt !== 'number' || !Number.isFinite(signedInAt)) return null;
    if (payload?.tokenHash !== refreshTokenHash(refreshToken)) return null;
    const account = typeof payload.account === 'string' ? payload.account : undefined;
    return { signedInAt, tokenHash: payload.tokenHash, ...(account ? { account } : {}) };
  } catch {
    return null;
  }
}

let missingSecretLogged = false;

/**
 * Written whenever the refresh token cookie is, with that cookie's options.
 * Without a session secret nothing can be sealed; the client's timer still applies.
 */
export function writeSignInStamp(
  cookieStore: CookieStore,
  slot: number,
  stamp: { signedInAt: number; refreshToken: string; account?: string },
  options: Record<string, unknown> = getCookieOptions(),
): void {
  if (!hasSessionSecret()) {
    if (!missingSecretLogged) {
      missingSecretLogged = true;
      logger.warn('No session secret: the maximum session length is enforced by the browser only');
    }
    return;
  }
  try {
    const payload: Record<string, unknown> = { signedInAt: stamp.signedInAt, tokenHash: refreshTokenHash(stamp.refreshToken) };
    if (stamp.account) payload.account = stamp.account;
    cookieStore.set(signInStampCookieName(slot), encryptPayload(payload, 'session-age'), options);
  } catch (error) {
    logger.warn('Could not record the sign-in time', { error: error instanceof Error ? error.message : 'Unknown error' });
  }
}

export function clearSignInStamp(cookieStore: CookieStore, slot: number): void {
  const name = signInStampCookieName(slot);
  if (cookieStore.get(name)) cookieStore.delete(name);
}

/**
 * When a token sign-in happened: its stamp's time, or the fixed time when
 * there is no stamp for this refresh token. Null without a session secret,
 * when the server can't keep sign-in times at all.
 */
export async function tokenSignedInAt(
  cookieStore: CookieStore,
  slot: number,
  refreshToken: string,
): Promise<{ signedInAt: number; stamp: SignInStamp | null } | null> {
  if (!hasSessionSecret()) return null;
  const stamp = readSignInStamp(cookieStore, slot, refreshToken);
  return { signedInAt: stamp?.signedInAt ?? await limitsEnforcedSince(), stamp };
}
