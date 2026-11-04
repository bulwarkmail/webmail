"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import type { DesktopDevToolsState } from "@/lib/desktop/types";
import { SettingItem, SettingsSection, ToggleSwitch } from "./settings-section";

/**
 * Troubleshooting in the desktop app: Chromium's developer tools on a key, off until the
 * user turns them on. Main keeps the switch and asks with a native warning, so a page or
 * plugin can't turn it on by itself. A browser never shows this.
 */
export function DesktopDevToolsSettings() {
  const t = useTranslations("desktopDevTools");
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

  return (
    <SettingsSection id="desktop-troubleshooting" title={t("section_title")}>
      <SettingItem label={t("label", { shortcut })} description={description} locked={state.forcedOff}>
        <ToggleSwitch
          checked={state.on}
          disabled={state.forcedOff || state.locked}
          testId="desktop-devtools-toggle"
          onChange={(on) => void devTools.set(on).then(setState, () => {})}
        />
      </SettingItem>
    </SettingsSection>
  );
}
