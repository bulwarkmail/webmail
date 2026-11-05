/**
 * Whether offline mode may run here and for an account. Its own module, so
 * the first page load can ask without loading offline mode itself
 * (lib/offline/offline-mode.ts), which comes when it's in use.
 */

import { IS_LITE } from '@/lib/lite';
import { devicesForAccount } from '@/lib/device-policy';
import { desktopOfflinePolicy } from '@/lib/desktop/policy';
import { accountSubjectPending } from '@/lib/org/account-subjects';
import { getStore } from '@/lib/store/client/api';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { isEvicted, useOfflineStore } from './state';

export function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/** Offline mode is possible here at all: not in Lite, with what the store needs. */
export function offlineSupported(): boolean {
  if (IS_LITE || !hasIndexedDb()) return false;
  if (useOfflineStore.getState().storageBlocked) return false;
  try {
    return typeof crypto !== 'undefined' && !!crypto.subtle && getStore().supported();
  } catch {
    return false;
  }
}

/** The organisation allows this account to keep mail on the device. */
export function offlineAllowed(account: string | null | undefined): boolean {
  return offlineSupported() && !devicesForAccount(account ?? null).noOffline && !desktopOfflinePolicy().invalid;
}

/** "Keep mail on this device" is on for this account here, and allowed. */
export function offlineActive(account: string | null | undefined): boolean {
  return !!account && useOfflineStore.getState().enabled.includes(account) && offlineAllowed(account);
}

/** The organisation's word on this account, from the server or the last fetch. Defaults aren't its word. */
export function scopeDecided(account: string): boolean {
  const { loaded, source, partial } = usePolicyStore.getState();
  // The public part a page gets before it's signed in has no caps and no scopes in it.
  return loaded && !partial && (source === 'server' || source === 'cache') && policyDecided(account);
}

/** Whether the policy of an account is known well enough to decide on it. */
export function policyDecided(account: string): boolean {
  // Dropped, with no groups to wait for: what applies to everyone reaches it.
  if (isEvicted(account)) return true;
  const auth = useAuthStore.getState();
  if (account === auth.activeAccountId || !auth.activeAccountId) {
    const { subject, subjectPending } = usePolicyStore.getState();
    if (subjectPending) return false;
    // The active account's id is kept across a reload and its subject isn't: until
    // it's there only Everyone's values show, and a group scope may say otherwise.
    return !auth.activeAccountId || subject !== null || !(auth.isLoading || auth.client);
  }
  // Another signed-in account: its groups have to be known first (a group
  // scope may forbid it); a signed-out one is wiped with its sign-out.
  if (!auth.getClientForAccount?.(account)) return false;
  return !accountSubjectPending(account);
}
