"use client";

import { useEffect } from "react";

/**
 * Keeps the address bar in step with what a surface is showing (#733), so the
 * URL is always a permalink the user can copy, bookmark or hand to a dashboard.
 *
 * Always `replaceState`, never `pushState`: these surfaces have no popstate
 * handler, and pushing entries the back button can't actually restore is worse
 * than not pushing at all - the URL would change while the view sat still. Mail
 * is the exception and drives its own history through `useBrowserNavigation`.
 *
 * Pass `null` to leave the URL alone (an unfocused Pro tab, whose focused
 * sibling owns the address bar). Dedupe is against the *actual* location, not
 * a remembered last write: in the Pro shell several surfaces take turns
 * writing the URL, so what this hook wrote last says nothing about what the
 * bar currently shows.
 *
 * The existing history state is preserved so Next's router bookkeeping - which
 * lives in `window.history.state` - survives the rewrite.
 */
export function useDeepLinkUrl(path: string | null): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!path) return;
    if (`${window.location.pathname}${window.location.search}` === path) return;
    window.history.replaceState(window.history.state, "", path);
  }, [path]);
}
