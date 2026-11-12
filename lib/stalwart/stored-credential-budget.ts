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
 *    within the window still go upstream until the window ends;
 *  - requests that overlap are held to the same rules: see
 *    acquireStoredCredential, which callers ask before each request.
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
  /** Credential key -> the answer of the request that decides for it, while that request is out. */
  deciding: Map<string, Promise<Decision>>;
  /** Deciding requests out right now: each holds a place under the ceiling until its answer comes. */
  reserved: number;
  /** Requests waiting for a place, woken when one is given back. */
  placeWaiters: Array<() => void>;
  /** The shared failure count as last read (shared mode). */
  sharedFailures: number;
}

/** What a deciding request came to: the mail server's status, or null for no answer. */
type Decision = number | null;

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
    deciding: new Map(),
    reserved: 0,
    placeWaiters: [],
    sharedFailures: 0,
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
  s.sharedFailures = window?.count ?? 0;
  if (s.sharedFailures < GLOBAL_MAX_FAILURES) return false;
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

/**
 * Whether `authHeader` got a successful answer within the window: in this
 * process, or with a shared store on any replica. A refusal clears it, so a
 * yes after a refusal means the credential worked again since (a new
 * sign-in with it). Never for an access token (they aren't tracked).
 */
export async function storedCredentialWorkedLately(authHeader: string, now: number = Date.now()): Promise<boolean> {
  const credential = keyOf(authHeader);
  if (!credential) return false;
  const local = state().succeeded.get(credential.key);
  if (local !== undefined && now - local <= WINDOW_MS) return true;
  if (!isSharedMode() || !credential.shareable) return false;
  try {
    const shared = Number(await withDeadline(getStore().kv.get(succeededKey(credential.key)), CHECK_DEADLINE_MS));
    return shared > 0 && now - shared <= WINDOW_MS;
  } catch (error) {
    if (!isStoreUnavailableError(error)) throw error;
    return false;
  }
}

// ─── requests in flight ────────────────────────────────────────────────────

/**
 * A request with a stored credential that may go to the mail server. Exactly
 * one of the two is called once it is done.
 */
export interface StoredCredentialPass {
  /** The mail server answered with `status`. */
  answered(status: number): void;
  /** No answer (a network error, a timeout). */
  failed(): void;
}

function recordAnswer(authHeader: string, status: number): void {
  // This process's copy is updated before the first await; the shared write follows.
  void recordStoredCredentialStatus(authHeader, status).catch((error) => {
    logger.warn('Stored credential status not recorded', { error: error instanceof Error ? error.message : 'Unknown error' });
  });
}

/** A pass that only records the answer: the request goes out now, beside any others. */
function sideBySide(authHeader: string): StoredCredentialPass {
  return { answered: (status) => recordAnswer(authHeader, status), failed: () => {} };
}

const NOT_BUDGETED: StoredCredentialPass = { answered: () => {}, failed: () => {} };

/**
 * Ask whether a request with `authHeader` may go to the mail server now;
 * null when it must not (answer it with refusedCredentialResponse()).
 *
 * Checking first and recording the answer afterwards would let requests that
 * overlap all through: Stalwart takes 50-500 ms to refuse a login, and 25
 * requests at once with one stale credential would be 25 failed logins. So:
 *
 *  - a credential that worked within the window (in this process) goes out
 *    side by side, as many requests at once as the page sends;
 *  - otherwise one request decides for the credential. The others wait for
 *    its answer: a refusal is theirs too (nothing sent), any other answer, or
 *    none, lets them go at once;
 *  - a deciding request holds a place under the ceiling across credentials
 *    until its answer comes, so 40 new credentials at once can't pass a
 *    ceiling of 20. A refusal turns its place into a counted failure; any
 *    other answer gives it back.
 *
 * Both are per process. With a shared store, refusals and the failure count
 * are shared as before; requests in flight on other replicas are not.
 */
export async function acquireStoredCredential(authHeader: string): Promise<StoredCredentialPass | null> {
  const credential = keyOf(authHeader);
  if (!credential) return NOT_BUDGETED;
  const s = state();
  for (;;) {
    if (await isStoredCredentialRefused(authHeader)) return null;
    // From here to the end of the loop nothing awaits, so two requests
    // can't both become the deciding one.
    const now = Date.now();
    const lastSuccess = s.succeeded.get(credential.key);
    if (lastSuccess !== undefined && now - lastSuccess <= WINDOW_MS) return sideBySide(authHeader);

    const deciding = s.deciding.get(credential.key);
    if (deciding) {
      const decision = await deciding;
      if (decision === 401) return null;
      // It worked (the next round finds the success), or there was another
      // answer or none: go now, without queueing behind each other.
      if (decision !== null && decision >= 200 && decision < 400) continue;
      return sideBySide(authHeader);
    }

    const failures = Math.max(currentWindow(now).failures, isSharedMode() ? s.sharedFailures : 0);
    if (failures >= GLOBAL_MAX_FAILURES) return null;
    if (failures + s.reserved >= GLOBAL_MAX_FAILURES) {
      // Every place left is held by a request still out: wait for one to
      // come back (an answer that isn't a refusal frees it), then ask again.
      await new Promise<void>((resolve) => s.placeWaiters.push(resolve));
      continue;
    }
    s.reserved++;
    let settle!: (decision: Decision) => void;
    s.deciding.set(credential.key, new Promise<Decision>((resolve) => { settle = resolve; }));
    let done = false;
    const finish = (decision: Decision) => {
      if (done) return;
      done = true;
      s.reserved = Math.max(0, s.reserved - 1);
      s.deciding.delete(credential.key);
      settle(decision);
      for (const wake of s.placeWaiters.splice(0)) wake();
    };
    return {
      answered(status) {
        // Recorded (a refusal counted) before the place is given back.
        recordAnswer(authHeader, status);
        finish(status);
      },
      failed() {
        finish(null);
      },
    };
  }
}

/** Marks the answers refusedCredentialResponse() makes; Symbol.for, so every bundle copy agrees. */
const BUDGET_REFUSAL = Symbol.for('bulwark.storedCredentialRefused');

/** The answer a refused credential gets instead of an upstream request. */
export function refusedCredentialResponse(): Response {
  const response = Response.json({ error: 'Authentication failed', reason: 'credential_refused' }, { status: 401 });
  Object.defineProperty(response, BUDGET_REFUSAL, { value: true });
  return response;
}

/** Whether `response` is the budget's own refusal, not the mail server's answer. */
export function isBudgetRefusal(response: Response): boolean {
  return (response as unknown as Record<symbol, unknown>)[BUDGET_REFUSAL] === true;
}

export function resetStoredCredentialBudgetForTests(): void {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: BudgetState };
  delete g[STATE_KEY];
}
