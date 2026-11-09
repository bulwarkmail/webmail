import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { getStore, isSharedMode, isStoreUnavailableError } from '@/lib/shared-store';
import { getSessionSecret } from '@/lib/auth/session-secret';
import { logger } from '@/lib/logger';

/**
 * Failure budget for the credentials the context cookies hold (extends
 * GHSA-g6c7).
 *
 * The cookie-authed routes (JMAP passthrough, WebDAV, calendar agenda, push
 * previews, WOPI, ...) replay the stored credential to the mail server on
 * every call. Once it is stale (password changed, app password revoked) each
 * call is a failed login from this server's address, and enough of them get
 * the webmail banned by Stalwart's fail2ban, locking out every user. So:
 *
 *  - a credential the mail server refused is refused here for an hour,
 *    without asking the server again;
 *  - past GLOBAL_MAX_FAILURES refusals in a window (several stale app
 *    passwords would each get their own hour), only credentials that worked
 *    within the window still go upstream until the window ends.
 *
 * Only Basic credentials count: Stalwart does not count an expired or unknown
 * access token as a failed login, and access tokens expire all the time.
 *
 * Credentials are known by an HMAC keyed from the session secret, never by a
 * plain hash: a plain hash of a Basic header in the store (or a backup of it)
 * could be tried against a password list offline.
 *
 * With a shared store (#1066) refusals and the failure window are kept there,
 * so a credential one replica saw refused isn't tried again by the others.
 * Successes are remembered in this process and written to the store at most
 * once a minute per credential: this check runs on every server-side JMAP
 * call. The check waits at most CHECK_DEADLINE_MS for the store; if the store
 * is slow or down, this process's own copy decides, as a single instance
 * does: refusing every call would take files, push previews and calendar sync
 * down with the store. Without a session secret nothing goes to the store.
 */

const REFUSE_MS = 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_MAX_FAILURES = 20;
const MAX_TRACKED = 10_000;
/** How often one process writes a credential's success to the shared store. */
const SHARED_SUCCESS_EVERY_MS = 60 * 1000;
/** Shared keys outlive their window a little, so clock skew can't drop them early. */
const SHARED_GRACE_MS = 60 * 1000;
/** How long a request waits for the shared refusal check before this process decides. */
export const CHECK_DEADLINE_MS = 200;
const FAILURES_KEY = 'stored-credential:failures';

interface BudgetState {
  /** Credential key -> time until which it is refused. */
  refused: Map<string, number>;
  /** Credential key -> time it last got a successful answer. */
  succeeded: Map<string, number>;
  failureWindow: { failures: number; resetAt: number };
  /** Credential key -> when this process last wrote its success to the shared store. */
  sharedSuccess: Map<string, number>;
  /** Refusals seen here that the shared store didn't take (it was down): honoured and written later. */
  unsynced: Map<string, number>;
  /** The HMAC key and the secret it was derived from. */
  hmac?: { secret: string; key: Buffer };
}

// On globalThis: one copy per process, not one per bundle.
const STATE_KEY = Symbol.for('bulwark.storedCredentialBudget');

function state(): BudgetState {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: BudgetState };
  g[STATE_KEY] ??= {
    refused: new Map(),
    succeeded: new Map(),
    failureWindow: { failures: 0, resetAt: 0 },
    sharedSuccess: new Map(),
    unsynced: new Map(),
  };
  return g[STATE_KEY];
}

function sessionSecret(): string {
  try {
    return getSessionSecret();
  } catch {
    return '';
  }
}

interface CredentialKey {
  key: string;
  /** Keyed from the session secret, so it may go to the shared store. */
  shareable: boolean;
}

function keyOf(authHeader: string): CredentialKey | null {
  if (!/^basic /i.test(authHeader)) return null;
  const secret = sessionSecret();
  if (!secret) {
    // Kept in this process's memory only.
    return { key: createHash('sha256').update(authHeader).digest('base64url'), shareable: false };
  }
  const s = state();
  if (s.hmac?.secret !== secret) {
    const root = createHash('sha256').update(secret).digest();
    s.hmac = { secret, key: Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), 'stored-credential', 32)) };
  }
  return { key: createHmac('sha256', s.hmac.key).update(authHeader).digest('base64url'), shareable: true };
}

const refusedKey = (key: string) => `stored-credential:refused:${key}`;
const succeededKey = (key: string) => `stored-credential:ok:${key}`;

function currentWindow(now: number) {
  const s = state();
  if (s.failureWindow.resetAt <= now) s.failureWindow = { failures: 0, resetAt: now + WINDOW_MS };
  return s.failureWindow;
}

function remember(map: Map<string, number>, key: string, value: number): void {
  map.delete(key);
  // Insertion order is age order: drop the oldest when full.
  if (map.size >= MAX_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

// ─── this process ──────────────────────────────────────────────────────────

function isRefusedLocally(key: string, now: number): boolean {
  const { refused, succeeded } = state();
  const until = refused.get(key);
  if (until !== undefined) {
    if (until > now) return true;
    refused.delete(key);
  }
  if (currentWindow(now).failures < GLOBAL_MAX_FAILURES) return false;
  const lastSuccess = succeeded.get(key);
  return lastSuccess === undefined || now - lastSuccess > WINDOW_MS;
}

function recordLocally(key: string, status: number, now: number): void {
  const { refused, succeeded, unsynced } = state();
  if (status === 401) {
    succeeded.delete(key);
    remember(refused, key, now + REFUSE_MS);
    currentWindow(now).failures++;
  } else if (status >= 200 && status < 400) {
    refused.delete(key);
    unsynced.delete(key);
    remember(succeeded, key, now);
  }
}

// ─── shared store ──────────────────────────────────────────────────────────

/** Refusals this process couldn't write while the store was down, written now. */
async function flushUnsynced(now: number): Promise<void> {
  const { unsynced } = state();
  for (const [key, until] of [...unsynced]) {
    if (until <= now) {
      unsynced.delete(key);
      continue;
    }
    await getStore().kv.set(refusedKey(key), String(until), { ttlMs: until - now + SHARED_GRACE_MS });
    unsynced.delete(key);
  }
}

async function isRefusedShared(key: string, now: number): Promise<boolean> {
  const store = getStore();
  const s = state();
  const [until, window] = await Promise.all([store.kv.get(refusedKey(key)), store.counters.get(FAILURES_KEY, now)]);
  const refusedUntil = Number(until);
  if (until !== null && refusedUntil > now) {
    // Kept here too, for when the store is down.
    remember(s.refused, key, refusedUntil);
    return true;
  }
  // Refused here while the store was down, and not written there yet.
  const pending = s.unsynced.get(key);
  if (pending !== undefined && pending > now) return true;
  if ((window?.count ?? 0) < GLOBAL_MAX_FAILURES) return false;
  const local = s.succeeded.get(key);
  if (local !== undefined && now - local <= WINDOW_MS) return false;
  const shared = Number(await store.kv.get(succeededKey(key)));
  return !(shared > 0 && now - shared <= WINDOW_MS);
}

async function recordShared(key: string, status: number, now: number): Promise<void> {
  const store = getStore();
  const s = state();
  if (status === 401) {
    s.sharedSuccess.delete(key);
    remember(s.unsynced, key, now + REFUSE_MS);
    await Promise.all([
      store.kv.set(refusedKey(key), String(now + REFUSE_MS), { ttlMs: REFUSE_MS + SHARED_GRACE_MS }),
      store.kv.del(succeededKey(key)),
      store.counters.hit(FAILURES_KEY, WINDOW_MS, now),
    ]);
    s.unsynced.delete(key);
  } else if (status >= 200 && status < 400) {
    // A success always lifts a refusal, wherever it was recorded.
    const writes: Promise<unknown>[] = [store.kv.del(refusedKey(key))];
    const last = s.sharedSuccess.get(key);
    // Only the "worked recently" mark is written at most once a minute.
    if (last === undefined || now - last < 0 || now - last >= SHARED_SUCCESS_EVERY_MS) {
      remember(s.sharedSuccess, key, now);
      writes.push(store.kv.set(succeededKey(key), String(now), { ttlMs: WINDOW_MS + SHARED_GRACE_MS }));
    }
    await Promise.all(writes);
  }
  if (s.unsynced.size > 0) await flushUnsynced(now);
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('The shared store did not answer in time');
      error.name = 'StoreUnavailableError';
      reject(error);
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// ─── API ───────────────────────────────────────────────────────────────────

/** True when `authHeader` must not be sent to the mail server right now. */
export async function isStoredCredentialRefused(authHeader: string, now: number = Date.now()): Promise<boolean> {
  const credential = keyOf(authHeader);
  if (!credential) return false;
  if (!isSharedMode() || !credential.shareable) return isRefusedLocally(credential.key, now);
  try {
    return await withDeadline(isRefusedShared(credential.key, now), CHECK_DEADLINE_MS);
  } catch (error) {
    if (!isStoreUnavailableError(error)) throw error;
    return isRefusedLocally(credential.key, now);
  }
}

/**
 * Record the mail server's answer to a request that carried `authHeader`.
 * This process's copy is updated before the first await, so a caller that
 * doesn't wait for the shared write still sees it on its next check.
 */
export async function recordStoredCredentialStatus(authHeader: string, status: number, now: number = Date.now()): Promise<void> {
  const credential = keyOf(authHeader);
  if (!credential) return;
  // Always kept here: it is what decides while the shared store is down.
  recordLocally(credential.key, status, now);
  if (!isSharedMode() || !credential.shareable) return;
  try {
    await recordShared(credential.key, status, now);
  } catch (error) {
    if (!isStoreUnavailableError(error)) throw error;
    logger.debug('Stored credential status kept in this process only: the shared store is unavailable');
  }
}

/** The answer a refused credential gets instead of an upstream request. */
export function refusedCredentialResponse(): Response {
  return Response.json({ error: 'Authentication failed', reason: 'credential_refused' }, { status: 401 });
}

export function resetStoredCredentialBudgetForTests(): void {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: BudgetState };
  delete g[STATE_KEY];
}
