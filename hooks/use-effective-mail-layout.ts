"use client";

import { effectiveMailLayout, useSettingsStore, type MailLayout } from "@/stores/settings-store";
import { useSplitPanesFit } from "@/hooks/use-split-panes-fit";

/** The mail layout in force: the saved one, or `focus` under Mountain View. */
export function useEffectiveMailLayout(): MailLayout {
  return useSettingsStore((state) => effectiveMailLayout(state.mailLayout, state.interfaceLayout, state.simpleMode));
}

/**
 * The layout the mail screen draws now: the one in force, except that a
 * window (or Pro pane) too narrow for the list and the reading pane side by
 * side opens a message in the list's place, as the focused layout does. The
 * list keeps its rows as the chosen layout draws them (useListRowShape).
 */
export function drawnMailLayout(layout: MailLayout, splitPanesFit: boolean): MailLayout {
  return layout === 'split' && !splitPanesFit ? 'focus' : layout;
}

export function useDrawnMailLayout(): MailLayout {
  return drawnMailLayout(useEffectiveMailLayout(), useSplitPanesFit());
}
