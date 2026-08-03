'use client';

import { useEffect } from 'react';
import { useAuthStore } from '@/stores/auth-store';

/**
 * When the tab becomes visible again or the browser reports that the network
 * came back, force an immediate connectivity check on the active JMAP client
 * (bypassing the keep-alive backoff).
 *
 * Without this hook the keep-alive loop backs off to ~5 minutes between
 * pings after a few consecutive failures. That is fine while the tab is
 * dormant, but it means a user who suspends their laptop / switches Wi-Fi /
 * returns from lunch can watch the "Attempting to reconnect…" banner sit
 * for minutes on end even though the server is reachable again.
 *
 * The hook is a no-op when there is no active client (login screen, demo
 * bootstrap in flight) or when the connection is already healthy — the
 * client's `resumeConnectivity()` short-circuits both of those.
 */
export function useResumeConnectivity() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const client = useAuthStore((s) => s.client);

  useEffect(() => {
    if (!isAuthenticated || !client) return;

    const attempt = () => {
      // Fire-and-forget: the client handles its own retry/backoff internally,
      // and the connectionChange callback drives the banner state.
      void client.resumeConnectivity();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') attempt();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', attempt);
    window.addEventListener('focus', attempt);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', attempt);
      window.removeEventListener('focus', attempt);
    };
  }, [isAuthenticated, client]);
}
