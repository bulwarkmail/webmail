"use client";

import { useIsDesktop } from "@/hooks/use-media-query";
import { useSettingsStore } from "@/stores/settings-store";

/**
 * Whether a surface draws Mountain View's desktop chrome: the top bar with the
 * app grid and the account avatar, in place of the left navigation rail.
 *
 * Mail, calendar, contacts, files and settings all ask the same question, so
 * moving between them under Mountain View keeps the same frame. Phones and
 * tablets keep their own navigation, and so does a surface embedded in a Pro
 * pane, whose shell owns the chrome.
 */
export function useMountainViewShell(isEmbedded: boolean): boolean {
  const mountainView = useSettingsStore((s) => s.interfaceLayout === "mountain-view");
  const isDesktop = useIsDesktop();
  return mountainView && isDesktop && !isEmbedded;
}
