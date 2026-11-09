import { evictAll } from '@/lib/account-state-manager';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { apiFetch, getLocaleFromPath, getPathPrefix, replaceWindowLocation } from '@/lib/browser-navigation';
import { IS_LITE } from '@/lib/lite';
import { useAccountStore, type AccountEntry } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarNotificationStore } from '@/stores/calendar-notification-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useContactStore } from '@/stores/contact-store';
import { useIdentityStore } from '@/stores/identity-store';

/**
 * The browser side of "Return to my account" after an impersonation handoff
 * (#1538). The server holds the session to return to
 * (lib/impersonation/restore.ts); the page only ever sees the account list,
 * which holds no credentials.
 */
const RETURN_URL = '/api/auth/impersonate/return';

/** The stores that hold one account's state across reloads. */
const PERSISTED_STORES = [
  useAccountStore,
  useAuthStore,
  useIdentityStore,
  useContactStore,
  useCalendarStore,
  useCalendarNotificationStore,
];

const DISCARD = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

/**
 * Drop the persisted account and auth state (and the server-derived caches)
 * before a reload, so the app comes back empty and derives its accounts from
 * the session cookies. The stores are still live until the reload and write
 * themselves back on their next change, so their storage is swapped for one
 * that keeps nothing before it is cleared.
 */
export function dropPersistedAccountState(): void {
  try {
    evictAll();
  } catch {
    /* in-memory snapshots are best-effort */
  }
  for (const store of PERSISTED_STORES) {
    try {
      store.persist.clearStorage();
      store.persist.setOptions({ storage: DISCARD });
    } catch {
      /* ignore storage access errors */
    }
  }
}

export interface AccountRegistrySnapshot {
  accounts: AccountEntry[];
  activeAccountId: string | null;
  defaultAccountId: string | null;
}

/**
 * Hand the account list to the server before the handoff's reconcile drops
 * it, so returning can bring it back. Not when it is an impersonation's own
 * list: the server keeps the first one it got, and this one is not the
 * user's. Sent with keepalive, as the page reloads right after.
 */
export function sendAccountRegistry(): void {
  if (IS_LITE) return;
  const { accounts, activeAccountId, defaultAccountId } = useAccountStore.getState();
  if (accounts.length === 0 || accounts.some((account) => account.impersonated)) return;
  const snapshot: AccountRegistrySnapshot = { accounts, activeAccountId, defaultAccountId };
  try {
    void apiFetch(RETURN_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* without the list, returning falls back to the restored session alone */
  }
}

/** The account list the server handed back, keeping only entries that are well formed. */
export function parseAccountRegistry(value: unknown): AccountRegistrySnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<Record<keyof AccountRegistrySnapshot, unknown>>;
  if (!Array.isArray(raw.accounts)) return null;
  const accounts = raw.accounts.filter((entry): entry is AccountEntry => {
    const a = entry as Partial<AccountEntry> | null;
    return !!a && typeof a === 'object'
      && typeof a.id === 'string' && typeof a.serverUrl === 'string' && typeof a.username === 'string'
      && Number.isInteger(a.cookieSlot) && (a.cookieSlot as number) >= 0 && (a.cookieSlot as number) < MAX_ACCOUNT_SLOTS
      && (a.authMode === 'basic' || a.authMode === 'oauth' || a.authMode === 'token');
  }).map((a) => ({ ...a, isConnected: false, hasError: false, errorMessage: undefined, impersonated: undefined }));
  if (accounts.length === 0) return null;
  const known = (id: unknown) => (typeof id === 'string' && accounts.some((a) => a.id === id) ? id : null);
  return { accounts, activeAccountId: known(raw.activeAccountId), defaultAccountId: known(raw.defaultAccountId) };
}

/** Whether this browser can go back to the account that started the impersonation. */
export async function canReturnToOwnAccount(): Promise<boolean> {
  if (IS_LITE) return false;
  try {
    const res = await apiFetch(RETURN_URL, { cache: 'no-store' });
    if (!res.ok) return false;
    const body = await res.json() as { available?: unknown };
    return body.available === true;
  } catch {
    return false;
  }
}

/**
 * End the impersonation and go back to the account that started it: the
 * server revokes the target's app password, puts the parked session back
 * and returns the account list, which replaces the target's before a
 * reload. When the server has nothing to return to, this signs out, as
 * there was no other way back before.
 */
export async function returnToOwnAccount(): Promise<void> {
  let res: Response | null = null;
  try {
    res = await apiFetch(RETURN_URL, { method: 'POST' });
  } catch {
    res = null;
  }
  if (!res?.ok) {
    await useAuthStore.getState().logout();
    return;
  }
  const body = await res.json().catch(() => null) as { registry?: unknown } | null;
  const registry = parseAccountRegistry(body?.registry);
  dropPersistedAccountState();
  if (registry) {
    // Written to storage only: the live store still shows the target until
    // the reload, and its writes go nowhere now.
    try {
      const { name, version } = useAccountStore.persist.getOptions();
      if (name) localStorage.setItem(name, JSON.stringify({ state: registry, version: version ?? 0 }));
    } catch {
      /* the restored session alone signs back in (orphan cookie adoption) */
    }
  }
  replaceWindowLocation(`${getPathPrefix()}/${getLocaleFromPath()}`);
}
