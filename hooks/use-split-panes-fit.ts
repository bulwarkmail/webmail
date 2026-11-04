"use client";

import { useCallback, useSyncExternalStore } from "react";
import { usePaneSize } from "@/hooks/use-pane-size";

/**
 * The narrowest window (or Pro pane) that puts the message list and the
 * reading pane side by side, in CSS pixels at the default text size. Narrower,
 * the split layout opens a message in the list's place, as the focused layout
 * does (useDrawnMailLayout). The page skeleton's `boot-onepane` variant
 * (app/boot-skeleton.css) uses the same width, 52.5rem.
 */
export const SPLIT_PANES_MIN = 840;

const QUERY = `(width < ${SPLIT_PANES_MIN / 16}rem)`;
const subscribe = (callback: () => void) => {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
};
const getServerSnapshot = () => false;

/**
 * Whether the message list and the reading pane fit side by side. Asks for
 * "too narrow", so a server render and the first hydration pass keep the
 * two panes a desktop draws.
 */
export function useSplitPanesFit(): boolean {
  const paneWidth = usePaneSize();
  const getSnapshot = useCallback(() => window.matchMedia(QUERY).matches, []);
  const tooNarrow = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return paneWidth !== null ? paneWidth >= SPLIT_PANES_MIN : !tooNarrow;
}
