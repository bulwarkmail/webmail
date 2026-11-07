import { createHash, randomBytes } from 'node:crypto';
import type { cookies } from 'next/headers';
import { decryptPayload, decryptSession, encryptPayload } from '@/lib/auth/crypto';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { refreshTokenCookieName } from '@/lib/oauth/tokens';
import { getStore } from '@/lib/shared-store';
import { IMPERSONATION_SESSION_TTL_SEC } from './app-password';
import { IMPERSONATION_GRANT_COOKIE, openImpersonationGrant, type ImpersonationGrant } from './grant-cookie';

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/**
 * "Return to my account" after an impersonation handoff (#1538).
 *
 * The handoff signs the browser in to the target mailbox in slot 0, which
 * overwrites the slot-0 session cookie of whoever was signed in before, and
 * the client then drops its account list (ImpersonationReconciler). Before
 * that happens, the handoff parks what it would destroy here, on the server:
 * the slot-0 session cookie as it was (already sealed with the session key)
 * and, sent by the page right after the redirect, the account list. The
 * other slots' cookies and a slot-0 refresh token are not touched by the
 * handoff, so they stay where they are.
 *
 * The browser gets only a random handle, in an httpOnly session cookie. The
 * record sits under the handle's hash, sealed with the session key, and is:
 * - bound to the impersonation grant it was parked for: it only opens while
 *   the same browser still holds that grant, so a copied handle is worthless
 *   anywhere else, and it stops working once the impersonation ends another
 *   way (sign-out discards it);
 * - single-use: returning takes the record out of the store, whatever the
 *   outcome;
 * - short-lived: it expires with the impersonation's app password
 *   (IMPERSONATION_SESSION_TTL_SEC), after which there is no session left
 *   to end.
 * Nothing of it reaches page scripts, plugins or browser storage. In local
 * mode the store is this process's memory, so a restart forgets it and the
 * user signs in again as before.
 */
export const IMPERSONATION_RESTORE_COOKIE = 'jmap_impersonation_restore';
export const IMPERSONATION_RESTORE_TTL_MS = IMPERSONATION_SESSION_TTL_SEC * 1000;
/** The account list a page may attach, at most. */
export const MAX_RESTORE_REGISTRY_BYTES = 64 * 1024;

const HANDLE_RE = /^[0-9a-f]{64}$/;

export interface RestoreRecord {
  /** The app password of the impersonation this record returns from. */
  credentialId: string;
  /** The slot-0 session cookie before the handoff, sealed as it was; null when there was none. */
  session: string | null;
  /** The account list the page had before the handoff, attached once by the page. */
  registry: unknown;
  expiresAt: number;
}

const storeKey = (handle: string) => `imp-restore:${createHash('sha256').update(handle).digest('hex')}`;

function seal(record: RestoreRecord): string {
  return encryptPayload({ r: record }, 'impersonation-restore');
}

function open(sealed: string | null, now: number): RestoreRecord | null {
  if (!sealed) return null;
  const payload = decryptPayload(sealed, 'impersonation-restore');
  const record = payload?.r as RestoreRecord | undefined;
  if (!record || typeof record.credentialId !== 'string' || typeof record.expiresAt !== 'number') return null;
  return record.expiresAt > now ? record : null;
}

function handleFrom(cookieStore: CookieStore): string | null {
  const value = cookieStore.get(IMPERSONATION_RESTORE_COOKIE)?.value;
  return value && HANDLE_RE.test(value) ? value : null;
}

/**
 * The grant of the impersonation this browser is signed in to right now in
 * slot 0, or null when slot 0 holds anything else (or nothing).
 */
export function activeImpersonationGrant(cookieStore: CookieStore): ImpersonationGrant | null {
  const grant = openImpersonationGrant(cookieStore.get(IMPERSONATION_GRANT_COOKIE)?.value);
  if (!grant) return null;
  const token = cookieStore.get(sessionCookieName(0))?.value;
  const session = token ? decryptSession(token) : null;
  if (!session || session.username !== grant.mailbox || session.serverUrl !== grant.serverUrl) return null;
  return grant;
}

/** Whether the browser keeps a sign-in of its own in any slot: a remembered session or a refresh token. */
function hasOwnSignIn(cookieStore: CookieStore): boolean {
  for (let slot = 0; slot < MAX_ACCOUNT_SLOTS; slot++) {
    if (cookieStore.get(sessionCookieName(slot))?.value || cookieStore.get(refreshTokenCookieName(slot))?.value) return true;
  }
  return false;
}

async function put(record: RestoreRecord, now: number): Promise<string> {
  const handle = randomBytes(32).toString('hex');
  await getStore().kv.set(storeKey(handle), seal(record), { ttlMs: Math.max(record.expiresAt - now, 1) });
  return handle;
}

/**
 * Called by the handoff before it writes the target's cookies. Parks the
 * browser's own slot-0 session for `credentialId`, the app password the
 * handoff just minted, and returns the handle for the restore cookie; null
 * when there is nothing to return to.
 *
 * A handoff that starts inside another impersonation keeps the record of
 * the first one, bound to the new grant under a new handle: returning still
 * leads back to the account that started it all. The target session itself
 * is never parked.
 */
export async function parkOwnSession(
  cookieStore: CookieStore,
  credentialId: string,
  now = Date.now(),
): Promise<string | null> {
  const kv = getStore().kv;
  const handle = handleFrom(cookieStore);
  const current = activeImpersonationGrant(cookieStore);
  const expiresAt = now + IMPERSONATION_RESTORE_TTL_MS;

  if (current) {
    if (!handle) return null;
    const previous = open(await kv.take(storeKey(handle)), now);
    if (!previous || previous.credentialId !== current.credentialId) return null;
    return put({ ...previous, credentialId, expiresAt }, now);
  }

  if (handle) await kv.del(storeKey(handle));
  if (!hasOwnSignIn(cookieStore)) return null;
  return put({
    credentialId,
    session: cookieStore.get(sessionCookieName(0))?.value ?? null,
    registry: null,
    expiresAt,
  }, now);
}

/** The live record behind this browser's restore cookie, without spending it; null unless it is bound to the current impersonation. */
export async function peekRestore(cookieStore: CookieStore, now = Date.now()): Promise<RestoreRecord | null> {
  const handle = handleFrom(cookieStore);
  const grant = activeImpersonationGrant(cookieStore);
  if (!handle || !grant) return null;
  const record = open(await getStore().kv.get(storeKey(handle)), now);
  return record && record.credentialId === grant.credentialId ? record : null;
}

/**
 * Attach the account list the page had before the handoff. Only once, and
 * only to a record bound to the current impersonation.
 */
export async function attachRestoreRegistry(
  cookieStore: CookieStore,
  registry: unknown,
  now = Date.now(),
): Promise<'attached' | 'missing' | 'taken'> {
  const handle = handleFrom(cookieStore);
  const grant = activeImpersonationGrant(cookieStore);
  if (!handle || !grant) return 'missing';
  let outcome: 'attached' | 'missing' | 'taken' = 'missing';
  await getStore().kv.update(storeKey(handle), (sealed) => {
    outcome = 'missing';
    const record = open(sealed, now);
    if (!record || record.credentialId !== grant.credentialId) return undefined;
    if (record.registry !== null) {
      outcome = 'taken';
      return undefined;
    }
    outcome = 'attached';
    return seal({ ...record, registry });
  });
  return outcome;
}

/**
 * Spend this browser's restore handle. Returns the record, and removes it in
 * the same step, only when it is live and bound to the impersonation the
 * browser is in now. Anything else leaves it alone: a copy of the handle
 * tried in another browser must not use up the admin's way back.
 */
export async function takeRestore(cookieStore: CookieStore, now = Date.now()): Promise<RestoreRecord | null> {
  const handle = handleFrom(cookieStore);
  const grant = activeImpersonationGrant(cookieStore);
  if (!handle || !grant) return null;
  let taken: RestoreRecord | null = null;
  await getStore().kv.update(storeKey(handle), (sealed) => {
    taken = null;
    const record = open(sealed, now);
    if (!record || record.credentialId !== grant.credentialId) return undefined;
    taken = record;
    return null;
  });
  return taken;
}

/** Forget this browser's restore handle and what it points to (sign-out). Best effort. */
export async function discardRestore(cookieStore: CookieStore): Promise<void> {
  const handle = handleFrom(cookieStore);
  cookieStore.delete(IMPERSONATION_RESTORE_COOKIE);
  if (!handle) return;
  await getStore().kv.del(storeKey(handle)).catch(() => {});
}
