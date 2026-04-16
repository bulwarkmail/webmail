"use client";

import { useEffect, useRef } from "react";

export interface NavSnapshot {
  mailboxId: string | null;
  emailId: string | null;
  threadId: string | null;
  composerOpen: boolean;
  sidebarOpen: boolean;
}

interface StoredNavState extends NavSnapshot {
  navId: number;
}

interface UseBrowserNavigationOptions extends NavSnapshot {
  onRestore: (state: NavSnapshot) => void | Promise<void>;
  enabled?: boolean;
}

const STATE_KEY = "__mailNav";
let navIdCounter = 0;

function snapshotsEqual(
  a: NavSnapshot | undefined | null,
  b: NavSnapshot,
): boolean {
  if (!a) return false;
  return (
    a.mailboxId === b.mailboxId &&
    a.emailId === b.emailId &&
    a.threadId === b.threadId &&
    a.composerOpen === b.composerOpen &&
    a.sidebarOpen === b.sidebarOpen
  );
}

function readStoredState(): StoredNavState | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = window.history.state as Record<string, unknown> | null;
  if (!raw) return undefined;
  return raw[STATE_KEY] as StoredNavState | undefined;
}

/**
 * Syncs in-app navigation state to the browser history stack so the browser
 * back / forward buttons (mouse buttons on desktop, gesture / hardware button
 * on mobile) navigate within the mail UI.
 *
 * - Pushes a new history entry whenever the captured snapshot changes from
 *   user action.
 * - Listens for popstate and calls onRestore so the page can apply the
 *   previous snapshot (mailbox, email, view, sidebar, conversation thread).
 *
 * The URL is left untouched so Next.js routes (e.g. /calendar, /settings)
 * continue to behave normally.
 */
export function useBrowserNavigation({
  mailboxId,
  emailId,
  threadId,
  composerOpen,
  sidebarOpen,
  onRestore,
  enabled = true,
}: UseBrowserNavigationOptions) {
  // Counter so overlapping restores don't accidentally clear the flag
  // belonging to a later restore.
  const popDepthRef = useRef(0);
  const isApplyingPopRef = useRef(false);
  const restoreRef = useRef(onRestore);
  const initializedRef = useRef(false);

  // Always keep the latest restore callback in a ref so the popstate
  // listener never sees a stale closure.
  restoreRef.current = onRestore;

  // Install the popstate listener once.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handlePop = (event: PopStateEvent) => {
      const raw = event.state as Record<string, unknown> | null;
      const state = raw ? (raw[STATE_KEY] as StoredNavState | undefined) : undefined;
      if (!state) return;

      // Hold the "applying pop" flag for the entire restore - including any
      // async work like fetching email content - so the resulting state
      // updates don't trigger a fresh history push that would undo the
      // user's back / forward navigation.
      popDepthRef.current += 1;
      isApplyingPopRef.current = true;

      const settle = () => {
        popDepthRef.current -= 1;
        if (popDepthRef.current === 0) {
          // One extra macrotask so React has flushed any state updates
          // dispatched at the very end of the restore.
          setTimeout(() => {
            if (popDepthRef.current === 0) {
              isApplyingPopRef.current = false;
            }
          }, 0);
        }
      };

      let result: void | Promise<void>;
      try {
        result = restoreRef.current(state);
      } catch (error) {
        settle();
        throw error;
      }

      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).finally(settle);
      } else {
        settle();
      }
    };

    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, []);

  // Push a new history entry whenever the navigation snapshot changes.
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;
    if (isApplyingPopRef.current) return;

    const snapshot: NavSnapshot = {
      mailboxId,
      emailId,
      threadId,
      composerOpen,
      sidebarOpen,
    };

    const existing = readStoredState();
    if (snapshotsEqual(existing, snapshot)) return;

    const stored: StoredNavState = { ...snapshot, navId: ++navIdCounter };
    const baseState = (window.history.state ?? {}) as Record<string, unknown>;
    const newState = { ...baseState, [STATE_KEY]: stored };

    if (!initializedRef.current) {
      initializedRef.current = true;

      if (emailId || threadId) {
        // The app is initializing directly on an email/thread view (e.g. the
        // user navigated here from /settings or an external link).  Seed a
        // "list" history entry first so that the toolbar back button returns
        // to the list instead of leaving the app entirely.
        const listSnapshot: NavSnapshot = {
          mailboxId,
          emailId: null,
          threadId: null,
          composerOpen: false,
          sidebarOpen,
        };
        const listStored: StoredNavState = {
          ...listSnapshot,
          navId: ++navIdCounter,
        };
        const baseState = (window.history.state ?? {}) as Record<
          string,
          unknown
        >;
        window.history.replaceState(
          { ...baseState, [STATE_KEY]: listStored },
          "",
        );
        // Now push the actual email state on top of the synthetic list entry.
        window.history.pushState(newState, "");
      } else {
        // Replace the current entry on the very first run so we don't
        // create an extra step the user has to back through to leave the app.
        window.history.replaceState(newState, "");
      }
    } else {
      window.history.pushState(newState, "");
    }
  }, [enabled, mailboxId, emailId, threadId, composerOpen, sidebarOpen]);
}
