'use client';

import { useEffect } from 'react';
import { usePolicyStore } from '@/stores/policy-store';

/** How often an open, visible tab fetches the policy again. */
export const POLICY_REFRESH_MS = 15 * 60 * 1000;
/** Focus and tab switches fetch at most this often. */
const FOCUS_THROTTLE_MS = 60 * 1000;

let lastRefresh = 0;
let mounted = 0;
let interval: ReturnType<typeof setInterval> | null = null;

function refresh(force = false): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const now = Date.now();
  if (!force && now - lastRefresh < FOCUS_THROTTLE_MS) return;
  const state = usePolicyStore.getState();
  // Nothing to refresh before the first fetch has answered.
  if (!state.loaded || state.fetching) return;
  lastRefresh = now;
  void state.fetchPolicy();
}

const onVisible = () => refresh();

/**
 * Fetches the policy again when the tab comes back into view and every 15
 * minutes while it is visible, so an announcement (or any other change the
 * admin saves) reaches tabs that stay open. One timer for the page however
 * many components use it.
 */
export function usePolicyRefresh(): void {
  useEffect(() => {
    mounted += 1;
    if (mounted === 1) {
      lastRefresh = Date.now();
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('focus', onVisible);
      interval = setInterval(() => refresh(true), POLICY_REFRESH_MS);
    }
    return () => {
      mounted -= 1;
      if (mounted === 0) {
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('focus', onVisible);
        if (interval) clearInterval(interval);
        interval = null;
      }
    };
  }, []);
}

/** For tests. */
export function resetPolicyRefresh(): void {
  lastRefresh = 0;
}
