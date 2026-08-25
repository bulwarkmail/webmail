"use client";

import { useEffect, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import {
  PullToRefreshIndicator,
  createPullToRefreshStore,
} from "@/components/ui/pull-to-refresh-indicator";

export interface UseRefreshGestureOptions {
  onRefresh: () => void | Promise<void>;
  enabled?: boolean;
}

export interface UseRefreshGestureResult {
  /**
   * The pull-to-refresh indicator, portalled to `document.body`. Render it
   * anywhere in the app shell; `null` until a gesture starts.
   */
  indicator: React.ReactNode;
}

/** Pull distance at which releasing triggers a refresh. */
export const PULL_THRESHOLD = 72;
/** The indicator stops following the finger past this distance. */
const MAX_PULL = 120;
/** Vertical travel before the gesture is claimed as a pull rather than a scroll. */
const ACTIVATION_SLOP = 10;
/** Keep the spinner up at least this long so a fast refresh does not flash. */
const MIN_SPINNER_MS = 500;
/** Matches the indicator's snap-back transition. */
const SETTLE_MS = 200;

/**
 * Dampen the pull past the threshold so it feels elastic instead of running
 * off the screen.
 */
function resist(dy: number): number {
  if (dy <= PULL_THRESHOLD) return dy;
  return Math.min(MAX_PULL, PULL_THRESHOLD + (dy - PULL_THRESHOLD) * 0.35);
}

/**
 * The nearest ancestor that actually scrolls vertically, or `null` when the
 * document itself is the scroller.
 *
 * The app shells scroll inner panes (the virtualised email list, the file
 * grid, …) rather than the document, so `window.scrollY` alone would report
 * "at the top" no matter how far down the list the user is.
 */
function findScrollableAncestor(start: EventTarget | null): Element | null {
  let node = start instanceof Element ? start : null;
  while (node && node !== document.body && node !== document.documentElement) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
      node.scrollHeight > node.clientHeight + 1
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Dialogs and sheets own their own downward drags (scroll-to-top, dismiss), so
 * a pull that starts inside one must not be hijacked. `data-no-pull-refresh`
 * is the escape hatch for anything else that needs the same.
 */
function isRefreshableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return !target.closest('[role="dialog"], [data-no-pull-refresh]');
}

function isAtTop(target: EventTarget | null): boolean {
  const scroller = findScrollableAncestor(target);
  if (scroller) return scroller.scrollTop <= 0;
  return window.scrollY <= 0 && document.documentElement.scrollTop <= 0;
}

/**
 * Capture browser refresh gestures (F5, Ctrl/Cmd+R, pull-to-refresh) and run
 * a JMAP-level refresh instead of reloading the full page.
 *
 * Pull-to-refresh is only active when the scroll container under the finger is
 * already at the top, so normal touch scrolling is unaffected. While pulling,
 * an indicator follows the finger down from the top edge and keeps spinning
 * until the refresh resolves.
 */
export function useRefreshGesture({ onRefresh, enabled = true }: UseRefreshGestureOptions): UseRefreshGestureResult {
  const t = useTranslations("common");
  const onRefreshRef = useRef(onRefresh);
  const runningRef = useRef(false);
  const store = useMemo(() => createPullToRefreshStore(), []);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    if (!enabled) {
      store.set({ phase: "idle", distance: 0 });
      return;
    }

    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, ms);
      timers.add(timer);
    };

    const trigger = () => {
      if (runningRef.current) return;
      runningRef.current = true;
      store.set({ phase: "refreshing", distance: PULL_THRESHOLD });
      const startedAt = Date.now();

      void (async () => {
        try {
          await onRefreshRef.current();
        } catch {
          // Refresh failures are reported by the caller; the indicator just
          // needs to stop spinning.
        } finally {
          later(() => {
            runningRef.current = false;
            store.set({ phase: "finishing", distance: 0 });
            later(() => store.set({ phase: "idle", distance: 0 }), SETTLE_MS);
          }, Math.max(0, MIN_SPINNER_MS - (Date.now() - startedAt)));
        }
      })();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const isReloadKey =
        event.key === "F5" ||
        ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "r");
      if (!isReloadKey) return;

      event.preventDefault();
      event.stopPropagation();
      trigger();
    };

    let startY = 0;
    let startX = 0;
    let tracking = false;
    // Set once the drag is unambiguously a downward pull: from then on the
    // gesture belongs to us and the browser must not rubber-band the page.
    let owned = false;

    const reset = () => {
      tracking = false;
      owned = false;
    };

    const handleTouchStart = (event: TouchEvent) => {
      reset();
      if (event.touches.length !== 1) return;
      if (runningRef.current) return;
      if (!isRefreshableTarget(event.target)) return;
      if (!isAtTop(event.target)) return;

      startY = event.touches[0].clientY;
      startX = event.touches[0].clientX;
      tracking = true;
    };

    const settleBack = () => {
      store.set({ phase: "cancelling", distance: 0 });
      later(() => {
        if (!runningRef.current) store.set({ phase: "idle", distance: 0 });
      }, SETTLE_MS);
    };

    const cancelPull = () => {
      const wasOwned = owned;
      reset();
      if (wasOwned) settleBack();
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!tracking) return;
      if (event.touches.length !== 1) {
        cancelPull();
        return;
      }

      const dy = event.touches[0].clientY - startY;
      const dx = event.touches[0].clientX - startX;

      if (!owned) {
        // Upward drags are ordinary scrolling; horizontal ones belong to the
        // list swipe actions. Either way, stop watching this touch.
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
          tracking = false;
          return;
        }
        if (dy < ACTIVATION_SLOP) return;
        owned = true;
      }

      // Suppress the native overscroll bounce now that the pull is ours. This
      // needs a non-passive listener, hence the explicit registration below.
      if (event.cancelable) event.preventDefault();

      const distance = resist(dy - ACTIVATION_SLOP);
      store.set({ phase: distance >= PULL_THRESHOLD ? "ready" : "pulling", distance });
    };

    const handleTouchEnd = () => {
      const wasOwned = owned;
      const released = store.getSnapshot();
      reset();
      if (!wasOwned) return;
      if (released.phase === "ready") {
        trigger();
      } else {
        settleBack();
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: false });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });
    window.addEventListener("touchcancel", cancelPull, { passive: true });

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
      window.removeEventListener("touchcancel", cancelPull);
      timers.forEach(clearTimeout);
      timers.clear();
      store.set({ phase: "idle", distance: 0 });
    };
  }, [enabled, store]);

  const indicator = (
    <PullToRefreshIndicator
      store={store}
      threshold={PULL_THRESHOLD}
      labels={{
        pull: t("pull_to_refresh"),
        release: t("release_to_refresh"),
        refreshing: t("refreshing"),
      }}
    />
  );

  return { indicator };
}
