"use client";

import { createContext, useContext } from "react";
import type { ProPaneId } from "@/stores/pro-tab-store";

/**
 * Which Pro pane hosts the current subtree. `null` means "not inside a Pro
 * pane" (standard shell). Set by the Pro shell's Pane component so that
 * pane-hosted apps can know which side of the split they live on (e.g. the
 * mail app routing a double-clicked email to the opposite pane) and so that
 * overlay chrome can scope itself to the pane.
 */
export const PaneIdContext = createContext<ProPaneId | null>(null);

export function usePaneId(): ProPaneId | null {
  return useContext(PaneIdContext);
}

/**
 * True when the current subtree is the *focused* Pro tab: the active tab of
 * the focused pane. Exactly one tab body sees `true` at any time, which is
 * what lets that tab own shared, single-instance concerns - currently the
 * address bar, where the focused tab's permalink is reflected. Always false
 * outside the Pro shell.
 */
export const ProTabFocusContext = createContext<boolean>(false);

export function useIsFocusedProTab(): boolean {
  return useContext(ProTabFocusContext);
}

/**
 * True when the current subtree renders inside a Pro pane.
 *
 * Overlays that go `fixed inset-0` in a mobile layout must switch to
 * `absolute` positioning when this is true: inside a pane, "mobile" means
 * the *pane* is phone-sized while the viewport is desktop-sized, so a
 * viewport-fixed overlay would escape the pane and cover the whole app -
 * and viewport CSS breakpoints (`sm:hidden` etc.) must not be trusted for
 * the same reason. Each Pro tab body is an `absolute inset-0` wrapper and
 * the email viewer root is `relative`, so pane-filling absolute overlays
 * resolve to the pane without needing portals (and stay hidden with their
 * tab when it's inactive).
 */
export function useIsPaneScoped(): boolean {
  return useContext(PaneIdContext) !== null;
}
