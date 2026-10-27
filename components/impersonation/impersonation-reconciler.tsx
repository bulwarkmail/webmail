'use client';

import { useEffect } from 'react';

import { evictAll } from '@/lib/account-state-manager';
import { replaceWindowLocation } from '@/lib/browser-navigation';
import { IMPERSONATION_MARKER_COOKIE } from '@/lib/impersonation/marker-cookie';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarNotificationStore } from '@/stores/calendar-notification-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useContactStore } from '@/stores/contact-store';
import { useIdentityStore } from '@/stores/identity-store';

/**
 * After a master-user impersonation handoff (`GET /api/auth/impersonate`), the
 * server swaps the slot-0 session cookie but the client's *persisted* account
 * registry still lists the PREVIOUS account — so the top-left account chip keeps
 * showing the old mailbox even though the message list is correctly the new one.
 * Only a manual sign-out (which clears `account-registry` / `auth-storage`) fixes
 * it, because that state lives in localStorage and the impersonation redirect
 * never reconciles it. (Reported downstream: jabali-panel #646.)
 *
 * The impersonate route now redirects to `/?impersonated=1`. Here we drop the
 * stale persisted account + auth state (and the server-derived caches) and
 * reload to a clean URL, so the app rehydrates empty and re-derives the single
 * account from the fresh session cookie — the same result as the manual
 * sign-out-then-reopen, done automatically. Cookies are untouched, so the
 * just-granted impersonation session survives the reload.
 *
 * The stores are still live until the reload and write themselves back on
 * their next change (checkAuth runs at the same time), so their storage is
 * swapped for one that keeps nothing before it is cleared. The marker only
 * counts together with the short-lived cookie the impersonate route sets, so a
 * link to `?impersonated=1` from anywhere else does nothing.
 */
const PERSISTED_STORES = [
  useAccountStore,
  useAuthStore,
  useIdentityStore,
  useContactStore,
  useCalendarStore,
  useCalendarNotificationStore,
];

const DISCARD = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

/** Reads and expires the marker cookie; true when it was there. */
function takeMarkerCookie(): boolean {
  const present = document.cookie.split(';').some((c) => c.trim().startsWith(`${IMPERSONATION_MARKER_COOKIE}=`));
  if (present) document.cookie = `${IMPERSONATION_MARKER_COOKIE}=; Max-Age=0; path=/`;
  return present;
}

export function ImpersonationReconciler() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('impersonated') !== '1') return;
    if (!takeMarkerCookie()) return;

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

    // Reload to a clean URL (drop the marker) so the now-empty persisted stores
    // rehydrate and the app reconnects + re-derives the impersonated account
    // from the session cookie. The marker is gone on the second load, so this
    // runs exactly once.
    params.delete('impersonated');
    const query = params.toString();
    replaceWindowLocation(window.location.pathname + (query ? `?${query}` : ''));
  }, []);

  return null;
}
