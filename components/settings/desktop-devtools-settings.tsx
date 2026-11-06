"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import type { DesktopDevToolsState } from "@/lib/desktop/types";
import { SettingItem, SettingsSection, ToggleSwitch } from "./settings-section";

/**
 * Troubleshooting in the desktop app: Chromium's developer tools on a key, off until the
 * user turns them on. Main keeps the switch and asks with a native warning, so a page or
 * plugin can't turn it on by itself. A browser never shows this. `bare` draws the row
 * alone, for the Troubleshooting page's debugging section (settings reorg 2026-11-05).
 */
export function DesktopDevToolsSettings({ bare = false }: { bare?: boolean } = {}) {
  const t = useTranslations("desktopDevTools");
  const tSearch = useTranslations("ux_p3_search");
  const bridge = getDesktopBridge();
  const devTools = bridge?.devTools;
  const [state, setState] = useState<DesktopDevToolsState | null>(null);

  useEffect(() => {
    if (!devTools) return;
    let stale = false;
    void devTools.get().then((next) => {
      if (!stale) setState(next);
    }, () => {});
    const stop = devTools.onChange((next) => {
      if (!stale) setState(next);
    });
    return () => {
      stale = true;
      stop();
    };
  }, [devTools]);

  if (!devTools || !state) return null;
  const shortcut = bridge?.platform === "darwin" ? "Cmd+Option+I" : "Ctrl+Shift+I";
  const description = state.forcedOff ? t("forced_off") : state.locked ? t("locked") : t("description", { shortcut });

  // Named plainly, as settings search lists it; the keys are in the description.
  const row = (
    <SettingItem label={tSearch("devtools_label")} description={description} locked={state.forcedOff}>
      <ToggleSwitch
        checked={state.on}
        disabled={state.forcedOff || state.locked}
        testId="desktop-devtools-toggle"
        onChange={(on) => void devTools.set(on).then(setState, () => {})}
      />
    </SettingItem>
  );
  if (bare) return row;
  return (
    // Only with "Show advanced settings" on: nobody needs it to read mail (settings-p2-9).
    <SettingsSection id="desktop-troubleshooting" advanced title={t("section_title")}>
      {row}
    </SettingsSection>
  );
}
