"use client";

import { useEffect, useRef } from "react";

export interface UseRefreshGestureOptions {
  onRefresh: () => void | Promise<void>;
  enabled?: boolean;
}

/**
 * Capture browser refresh gestures (F5, Ctrl/Cmd+R, pull-to-refresh) and run
 * a JMAP-level refresh instead of reloading the full page.
 *
 * Pull-to-refresh is only active when the document is already scrolled to the
 * top, so normal touch scrolling is unaffected.
 */
export function useRefreshGesture({ onRefresh, enabled = true }: UseRefreshGestureOptions) {
  const onRefreshRef = useRef(onRefresh);
  const runningRef = useRef(false);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    if (!enabled) return;

    const trigger = () => {
      if (runningRef.current) return;
      runningRef.current = true;
      Promise.resolve(onRefreshRef.current()).finally(() => {
        runningRef.current = false;
      });
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

    let touchStartY = 0;
    let tracking = false;
    let triggered = false;

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const atTop = window.scrollY <= 0 && document.documentElement.scrollTop <= 0;
      if (!atTop) {
        tracking = false;
        return;
      }
      touchStartY = event.touches[0].clientY;
      tracking = true;
      triggered = false;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!tracking || triggered) return;
      const dy = event.touches[0].clientY - touchStartY;
      // Require a deliberate pull of ~80px from the very top of the page.
      if (dy > 80) {
        triggered = true;
        tracking = false;
        trigger();
      }
    };

    const handleTouchEnd = () => {
      tracking = false;
      triggered = false;
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });
    window.addEventListener("touchcancel", handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
      window.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [enabled]);
}
