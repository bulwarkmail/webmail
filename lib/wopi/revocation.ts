import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import type { cookies } from 'next/headers';
import { ensureStateDir, getStatePath } from '@/lib/admin/paths';
import { logger } from '@/lib/logger';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { WOPI_TOKEN_TTL_MS, type WopiTokenPayload } from '@/lib/wopi/token';

/**
 * Signing out ends the office editor sessions opened from that browser.
 *
 * A WOPI token is handed to the editor server and carries the user's
 * credentials, so it used to stay usable for its whole six-hour lifetime
 * after the user signed out. Each token now records which browser minted it
 * (a random id in an HttpOnly cookie, hashed) and for which account slot;
 * signing out records a revocation time for that browser and slot, and any
 * token minted before it is refused. Signing out on another device does not
 * touch this browser's editors.
 *
 * Revocations are kept in the state directory so they survive a restart and
 * reach every replica sharing the state volume; each one is dropped once
 * every token it could refuse has expired anyway.
 */

type CookieStore = Awaited<ReturnType<typeof cookies>>;

export const WOPI_BROWSER_COOKIE = 'bulwark_wopi';
const REVOCATIONS_FILE = 'wopi-revocations.json';

function browserBinding(browserId: string): string {
  return createHash('sha256').update(browserId).digest('base64url').slice(0, 22);
}

/** This browser's binding for new tokens, creating its cookie on first use. */
export function wopiBrowserBinding(cookieStore: CookieStore): string {
  let id = cookieStore.get(WOPI_BROWSER_COOKIE)?.value;
  if (!id) {
    id = randomBytes(16).toString('base64url');
    cookieStore.set(WOPI_BROWSER_COOKIE, id, getCookieOptions());
  }
  return browserBinding(id);
}

let revocations = new Map<string, number>();
let loadedMtimeMs: number | null = null;

async function reload(): Promise<void> {
  const path = getStatePath(REVOCATIONS_FILE);
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    return; // Nothing revoked yet (or unreadable): keep what memory has.
  }
  if (mtimeMs === loadedMtimeMs) return;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
    const next = new Map<string, number>();
    for (const [key, at] of Object.entries(parsed)) {
      if (typeof at === 'number') next.set(key, Math.max(at, revocations.get(key) ?? 0));
    }
    for (const [key, at] of revocations) if (!next.has(key)) next.set(key, at);
    revocations = next;
    loadedMtimeMs = mtimeMs;
  } catch (error) {
    logger.warn('Could not read WOPI revocations', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Refuse every token this browser minted for `slot` (or for every slot)
 * until now. Call before the browser's cookies are cleared.
 */
export async function revokeWopiTokens(
  cookieStore: CookieStore,
  slot: number | 'all',
  nowMs: number = Date.now(),
): Promise<void> {
  const id = cookieStore.get(WOPI_BROWSER_COOKIE)?.value;
  if (!id) return; // This browser never opened an editor.
  if (slot === 'all') cookieStore.delete(WOPI_BROWSER_COOKIE);

  await reload();
  revocations.set(`${browserBinding(id)}:${slot}`, nowMs);
  for (const [key, at] of revocations) {
    if (nowMs - at > WOPI_TOKEN_TTL_MS) revocations.delete(key);
  }

  try {
    await ensureStateDir();
    const path = getStatePath(REVOCATIONS_FILE);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(revocations)), 'utf-8');
    await rename(tmp, path);
    loadedMtimeMs = (await stat(path)).mtimeMs;
  } catch (error) {
    // Still refused by this process until it restarts.
    logger.warn('Could not persist WOPI revocation', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/** Whether signing out has revoked this token since it was minted. */
export async function isWopiTokenRevoked(payload: WopiTokenPayload): Promise<boolean> {
  // Tokens minted before tokens were bound to a browser simply expire.
  if (!payload.bid || typeof payload.slot !== 'number') return false;
  await reload();
  const mintedAt = payload.exp - WOPI_TOKEN_TTL_MS;
  const revokedAt = Math.max(
    revocations.get(`${payload.bid}:all`) ?? -Infinity,
    revocations.get(`${payload.bid}:${payload.slot}`) ?? -Infinity,
  );
  return revokedAt >= mintedAt;
}
