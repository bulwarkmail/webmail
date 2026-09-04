"use client";

import { useEffect } from 'react';
import { debug } from '@/lib/debug';

/**
 * Badges the *installed* PWA's icon — the shortcut Chrome/Edge pin next to
 * the address bar, or the OS taskbar/dock/Home Screen icon once launched
 * standalone — with the inbox unread count, via the Badging API
 * (`navigator.setAppBadge`/`clearAppBadge`).
 *
 * This is a different surface from `useFaviconBadge`: that one repaints the
 * favicon *inside* the browser tab strip and works in any tab, installed or
 * not. This one calls a spec API that targets the installed app icon —
 * Chromium supports it there; WebKit supports it for iOS/iPadOS Home Screen
 * web apps (not plain Safari tabs). Either way it's a no-op wherever
 * unsupported: both methods are feature-detected per call, so a browser that
 * has one but not the other (or neither) never throws.
 *
 * No unmount cleanup: the badge is scoped to the installed app/origin, not
 * to this component or even this window — with several windows of the same
 * app open, whichever last called set/clear wins for all of them (that's the
 * API's own model, not a bug here). Clearing on every unmount would fight
 * that: window A closing would blank window B's still-accurate badge. A
 * `count` of zero (fully-read inbox) or `enabled: false` already clears it
 * through the effect below; unmounting without either of those (e.g. a
 * logout that doesn't first zero the store) can leave a stale number until
 * the app's next unread-count change — accepted as inherent to a
 * window/tab-agnostic API without adding cross-window coordination
 * (service worker, BroadcastChannel) for it.
 */
export function useAppBadge(count: number, enabled = true): void {
  useEffect(() => {
    if (typeof navigator === 'undefined') return;

    const effectiveCount = enabled ? count : 0;

    void (async () => {
      try {
        if (effectiveCount > 0) {
          if (typeof navigator.setAppBadge !== 'function') return;
          await navigator.setAppBadge(effectiveCount);
        } else {
          if (typeof navigator.clearAppBadge !== 'function') return;
          await navigator.clearAppBadge();
        }
      } catch (error) {
        debug.log('[app-badge] failed:', error);
      }
    })();
  }, [count, enabled]);
}
