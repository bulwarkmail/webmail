'use client';

import { useEffect } from 'react';

import { replaceWindowLocation } from '@/lib/browser-navigation';
import { IMPERSONATION_MARKER_COOKIE } from '@/lib/impersonation/marker-cookie';
import { dropPersistedAccountState, sendAccountRegistry } from '@/lib/impersonation/return-client';
import { useAccountStore } from '@/stores/account-store';

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
 *
 * The account list goes to the server first, which holds it with the session
 * the handoff parked, so "Return to my account" can bring both back (#1538).
 */

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

    sendAccountRegistry();
    dropPersistedAccountState();
    // The page's sign-in check runs on this same load, after this effect.
    // With the old list still in memory it would evict an account signed in
    // without "Remember me", and signing out of its slot 0 revokes the
    // impersonation that was just opened. With none, it picks up the
    // handoff's session cookie, as the reload will.
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });

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
