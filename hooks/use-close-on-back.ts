"use client";

import { useEffect, useRef, useState } from "react";
import { generateUUID } from "@/lib/utils";

const STATE_KEY = "__closeOnBack";

// Closing one layer can leave an asynchronous Back traversal in flight. The
// next layer must not push its entry until that completes, or the traversal
// would pop it and close the layer at once.
let pendingHistoryBack: Promise<void> | null = null;

/**
 * Resolves once the Back a closed layer took to remove its history entry has
 * landed. A navigation started before then would be undone by it.
 */
export function historySettled(): Promise<void> {
  return pendingHistoryBack ?? Promise.resolve();
}

const currentEntry = () => (window.history.state as Record<string, unknown> | null)?.[STATE_KEY];

interface UseCloseOnBackOptions {
  /** Called when browser Back (or the phone's back gesture) leaves the entry. */
  onBack: () => void;
  /** Whether the layer is open: it holds a history entry while it is. */
  active?: boolean;
  /**
   * Whether Back should stay on the layer for now, e.g. an editor with
   * unsaved changes that asks first. Checked as Back lands: the entry is put
   * back at once, so another Back while `onBack` asks is caught too, and
   * `onBack` decides whether to close.
   */
  shouldHold?: () => boolean;
}

export interface CloseOnBack {
  /** Holds an entry again after `onBack` decided to stay open. */
  rearm: () => void;
  /** Whether the entry is there now, e.g. before a `router.back()` that must leave for real. */
  armed: () => boolean;
}

/**
 * Lets the browser's Back close an overlay, panel or editor instead of
 * leaving the page (R5). While `active`, the layer holds a history entry of
 * its own and Back calls `onBack`. Closed any other way, the entry is taken
 * back off, so no stray steps are left for Back to walk through:
 * - not when a navigation in the same commit (leaving through the rail)
 *   has pushed its own entry by then, which must not be undone;
 * - and once the clean-up Back has landed, the address bar shows the URL
 *   the page wrote for the closed state, not the older one of the entry
 *   below.
 * The entry copies the current state, Next's router state included.
 */
export function useCloseOnBack({ onBack, active = true, shouldHold }: UseCloseOnBackOptions): CloseOnBack {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const shouldHoldRef = useRef(shouldHold);
  shouldHoldRef.current = shouldHold;
  const rearmRef = useRef<() => void>(() => {});
  const armedRef = useRef(false);

  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    let cancelled = false;
    let entryId: string | null = null;

    const onPop = (event: PopStateEvent) => {
      // Forward into our own entry is not a Back.
      if (!entryId || (event.state as Record<string, unknown> | null)?.[STATE_KEY] === entryId) return;
      entryId = null;
      armedRef.current = false;
      window.removeEventListener("popstate", onPop);
      if (shouldHoldRef.current?.()) push();
      onBackRef.current();
    };
    function push() {
      if (cancelled || entryId) return;
      entryId = generateUUID();
      armedRef.current = true;
      window.history.pushState({ ...window.history.state, [STATE_KEY]: entryId }, "");
      window.addEventListener("popstate", onPop);
    }
    rearmRef.current = push;

    // Deferred, so Strict Mode's setup/cleanup/setup replay can cancel the
    // first setup without scheduling a browser Back traversal.
    const timer = window.setTimeout(async () => {
      if (pendingHistoryBack) await pendingHistoryBack;
      push();
    }, 0);

    return () => {
      cancelled = true;
      rearmRef.current = () => {};
      armedRef.current = false;
      window.clearTimeout(timer);
      window.removeEventListener("popstate", onPop);
      const ours = entryId;
      if (!ours || currentEntry() !== ours) return;
      // After this commit's effects: by then a navigation in the same commit
      // has pushed its entry, and the page has written the URL for the
      // closed state.
      queueMicrotask(() => {
        if (currentEntry() !== ours) return;
        const url = window.location.href;
        pendingHistoryBack = new Promise<void>((resolve) => {
          // Tidying up, not a navigation, so Next.js must not hear of it. To
          // its router this Back is a route change when the page has written
          // the URL by hand: under the Pro shell, whose one route is /pro, it
          // sent the whole shell through its takeover whenever a dialog closed.
          window.addEventListener("popstate", (event) => {
            event.stopImmediatePropagation();
            if (window.location.href !== url) window.history.replaceState(window.history.state, "", url);
            pendingHistoryBack = null;
            resolve();
          }, { once: true, capture: true });
        });
        window.history.back();
      });
    };
  }, [active]);

  // The same object every render, so callers can list it as a dependency.
  const [api] = useState<CloseOnBack>(() => ({ rearm: () => rearmRef.current(), armed: () => armedRef.current }));
  return api;
}
