import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { cookies } from 'next/headers';
import { getStateDir, getStatePath } from '@/lib/admin/paths';
import { logger } from '@/lib/logger';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { getStore, isSharedMode, type CollectionOptions } from '@/lib/shared-store';
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
 * every token it could refuse has expired anyway. With a shared store
 * (#1066) they are one document there, merged on every write, and read on
 * every check; a check that can't reach the store refuses the token.
 */

type CookieStore = Awaited<ReturnType<typeof cookies>>;

export const WOPI_BROWSER_COOKIE = 'bulwark_wopi';
const REVOCATIONS_FILE = 'wopi-revocations.json';
export const WOPI_COLLECTION = 'wopi';
export const REVOCATIONS_ID = 'revocations.json';

/** The revocations document; locally today's file in the state dir. */
export const wopiRevocationsLayout: CollectionOptions = {
  local: {
    dir: () => getStateDir(),
    file: () => REVOCATIONS_FILE,
    idOf: (file) => (file === REVOCATIONS_FILE ? REVOCATIONS_ID : null),
    tmpName: (target) => `${target}.${process.pid}.tmp`,
  },
};

function wopiRevocationsCollection() {
  return getStore().collection(WOPI_COLLECTION, wopiRevocationsLayout);
}

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

interface RevocationState {
  revocations: Map<string, number>;
  loadedMtimeMs: number | null;
  /** Shared mode: revocations the store didn't take (it was down), written as soon as it answers. */
  pending: Map<string, number>;
  retryTimer?: ReturnType<typeof setInterval>;
}

/** How often a replica holding unwritten revocations tries the store again. */
const RETRY_EVERY_MS = 15 * 1000;

// One copy per process, not one per bundle.
const STATE_KEY = Symbol.for('bulwark.wopiRevocations');

function state(): RevocationState {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: RevocationState };
  g[STATE_KEY] ??= { revocations: new Map(), loadedMtimeMs: null, pending: new Map() };
  return g[STATE_KEY];
}

/** Merge revocations read from disk or the store into memory, keeping the later time. */
function merge(text: string): void {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const s = state();
  const next = new Map<string, number>();
  for (const [key, at] of Object.entries(parsed)) {
    if (typeof at === 'number') next.set(key, Math.max(at, s.revocations.get(key) ?? 0));
  }
  for (const [key, at] of s.revocations) if (!next.has(key)) next.set(key, at);
  s.revocations = next;
}

/** One process: re-read the file when it changed. */
async function reloadLocal(): Promise<void> {
  const path = getStatePath(REVOCATIONS_FILE);
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    return; // Nothing revoked yet (or unreadable): keep what memory has.
  }
  if (mtimeMs === state().loadedMtimeMs) return;
  try {
    merge(await readFile(path, 'utf-8'));
    state().loadedMtimeMs = mtimeMs;
  } catch (error) {
    logger.warn('Could not read WOPI revocations', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/** Shared store: write what an outage held back, then read the document; throws when the store is down. */
async function reloadShared(): Promise<void> {
  if (state().pending.size > 0) await persist(Date.now());
  const doc = await wopiRevocationsCollection().get(REVOCATIONS_ID);
  if (!doc) return;
  try {
    merge(doc.data.toString('utf-8'));
  } catch (error) {
    logger.warn('Could not read WOPI revocations', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

function prune(revocations: Map<string, number>, nowMs: number): void {
  for (const [key, at] of revocations) {
    if (nowMs - at > WOPI_TOKEN_TTL_MS) revocations.delete(key);
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

  const key = `${browserBinding(id)}:${slot}`;
  const shared = isSharedMode();
  if (!shared) await reloadLocal();
  const s = state();
  s.revocations.set(key, nowMs);
  prune(s.revocations, nowMs);

  try {
    await persist(nowMs);
    if (!shared) s.loadedMtimeMs = (await stat(getStatePath(REVOCATIONS_FILE))).mtimeMs;
  } catch (error) {
    // Still refused by this process; with a shared store it is written as
    // soon as the store answers again, so other replicas refuse it too.
    if (shared) {
      s.pending.set(key, nowMs);
      startRetry();
    }
    logger.warn('Could not persist WOPI revocation', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Write this process's revocations, merged with what is stored now, so a
 * revocation written meanwhile (another tab, another replica) is kept.
 */
async function persist(nowMs: number): Promise<void> {
  const s = state();
  const pendingNow = new Map(s.pending);
  const written = await wopiRevocationsCollection().update(REVOCATIONS_ID, (current) => {
    const merged = new Map(s.revocations);
    if (current) {
      try {
        for (const [k, at] of Object.entries(JSON.parse(current.toString('utf-8')) as Record<string, unknown>)) {
          if (typeof at === 'number') merged.set(k, Math.max(at, merged.get(k) ?? 0));
        }
      } catch {
        // Unreadable: replaced by what this process knows.
      }
    }
    prune(merged, nowMs);
    return JSON.stringify(Object.fromEntries(merged));
  });
  if (written.data) merge(written.data.toString('utf-8'));
  for (const [key, at] of pendingNow) if (s.pending.get(key) === at) s.pending.delete(key);
  if (s.pending.size === 0 && s.retryTimer) {
    clearInterval(s.retryTimer);
    s.retryTimer = undefined;
  }
}

function startRetry(): void {
  const s = state();
  if (s.retryTimer) return;
  s.retryTimer = setInterval(() => {
    if (!isSharedMode() || state().pending.size === 0) return;
    persist(Date.now()).catch(() => {
      // Still down; tried again on the next tick, check or sign-out.
    });
  }, RETRY_EVERY_MS);
  s.retryTimer.unref?.();
}

/** Whether signing out has revoked this token since it was minted. */
export async function isWopiTokenRevoked(payload: WopiTokenPayload): Promise<boolean> {
  // Tokens minted before tokens were bound to a browser simply expire.
  if (!payload.bid || typeof payload.slot !== 'number') return false;
  if (isSharedMode()) {
    try {
      await reloadShared();
    } catch (error) {
      // A sign-out on another replica can't be ruled out: refused.
      logger.warn('WOPI token refused: revocations unavailable', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return true;
    }
  } else {
    await reloadLocal();
  }
  const { revocations } = state();
  const mintedAt = payload.exp - WOPI_TOKEN_TTL_MS;
  const revokedAt = Math.max(
    revocations.get(`${payload.bid}:all`) ?? -Infinity,
    revocations.get(`${payload.bid}:${payload.slot}`) ?? -Infinity,
  );
  return revokedAt >= mintedAt;
}
