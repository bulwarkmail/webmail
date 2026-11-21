"use client";

import { useEffect, useRef } from "react";

export interface NavSnapshot {
  mailboxId: string | null;
  emailId: string | null;
  threadId: string | null;
  composerOpen: boolean;
  sidebarOpen: boolean;
  /**
   * The login the snapshot was taken in. Folder, message and conversation
   * ids name other things in any other login, so the page restores them only
   * while that login is the one on screen. Absent in entries written before
   * snapshots named it.
   */
  login?: string | null;
  /**
   * The open message's key in the list: in a list that mixes accounts
   * several rows can share an id.
   */
  emailKey?: string | null;
}

interface StoredNavState extends NavSnapshot {
  navId: number;
}

interface UseBrowserNavigationOptions extends NavSnapshot {
  onRestore: (state: NavSnapshot) => void | Promise<void>;
  enabled?: boolean;
  /**
   * Permalink for a snapshot (#733). When supplied, the URL is rewritten
   * along with the history entry so the address bar is always a shareable
   * link to what the user is looking at. Return null to leave the URL alone
   * for that snapshot. Omit the option entirely for state-only history.
   */
  buildUrl?: (state: NavSnapshot) => string | null | undefined;
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
    a.sidebarOpen === b.sidebarOpen &&
    // The same ids in another login are another view.
    (a.login ?? null) === (b.login ?? null) &&
    (a.emailKey ?? null) === (b.emailKey ?? null)
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
 * Without `buildUrl` the URL is left untouched and only history state moves.
 * With it, each entry also carries a permalink, written through
 * history.push/replaceState - shallow routing that Next.js supports natively,
 * so the route tree is not re-rendered on every message the user opens.
 */
export function useBrowserNavigation({
  mailboxId,
  emailId,
  threadId,
  composerOpen,
  sidebarOpen,
  login,
  emailKey,
  onRestore,
  enabled = true,
  buildUrl,
}: UseBrowserNavigationOptions) {
  // Counter so overlapping restores don't accidentally clear the flag
  // belonging to a later restore.
  const popDepthRef = useRef(0);
  const isApplyingPopRef = useRef(false);
  const restoreRef = useRef(onRestore);
  const buildUrlRef = useRef(buildUrl);
  const initializedRef = useRef(false);

  // Always keep the latest restore callback in a ref so the popstate
  // listener never sees a stale closure.
  restoreRef.current = onRestore;
  // Same for the URL builder: it closes over the mailbox list, which arrives
  // after the first render, and the effect below must not re-run for it.
  buildUrlRef.current = buildUrl;

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
      // Only when the page names them: a page that does not keeps its entries as they were.
      ...(login !== undefined ? { login } : {}),
      ...(emailKey !== undefined ? { emailKey } : {}),
    };

    const existing = readStoredState();
    if (snapshotsEqual(existing, snapshot)) return;

    const stored: StoredNavState = { ...snapshot, navId: ++navIdCounter };
    const baseState = (window.history.state ?? {}) as Record<string, unknown>;
    const newState = { ...baseState, [STATE_KEY]: stored };
    // `history.pushState(state, "", undefined)` keeps the current URL, which is
    // exactly the old state-only behaviour when no builder is supplied.
    const newUrl = buildUrlRef.current?.(snapshot) ?? undefined;

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
          ...(login !== undefined ? { login } : {}),
          ...(emailKey !== undefined ? { emailKey: null } : {}),
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
          buildUrlRef.current?.(listSnapshot) ?? undefined,
        );
        // Now push the actual email state on top of the synthetic list entry.
        window.history.pushState(newState, "", newUrl);
      } else {
        // Replace the current entry on the very first run so we don't
        // create an extra step the user has to back through to leave the app.
        window.history.replaceState(newState, "", newUrl);
      }
    } else {
      window.history.pushState(newState, "", newUrl);
    }
  }, [enabled, mailboxId, emailId, threadId, composerOpen, sidebarOpen, login, emailKey]);
}
