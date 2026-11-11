"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { hasDesktopWindows } from "@/lib/popout/support";
import { menuBarAvailable, useMenuBarPinned } from "@/lib/desktop/menu-bar";
import { setDesktopPref, useComposeInWindow, useDesktopPrefs } from "@/lib/desktop/preferences";
import { SettingItem, SettingsSection, ToggleSwitch } from "./settings-section";

/** How the desktop app's windows behave. Only there: a browser has nothing to set. */
export function DesktopWindowSettings() {
  const t = useTranslations("desktopUi.settings");
  const prefs = useDesktopPrefs();
  const composeInWindow = useComposeInWindow();
  const [shown, setShown] = useState(false);
  useEffect(() => setShown(hasDesktopWindows()), []);
  if (!shown) return null;
  return (
    <SettingsSection id="desktop-windows" title={t("title")}>
      <SettingItem label={t("double_click_label")} description={t("double_click_description")}>
        <ToggleSwitch checked={prefs.openOnDoubleClick} onChange={(checked) => setDesktopPref("openOnDoubleClick", checked)} />
      </SettingItem>
      <SettingItem label={t("compose_window_label")} description={t("compose_window_description")} locked={composeInWindow.locked}>
        <ToggleSwitch
          checked={composeInWindow.on}
          onChange={(checked) => setDesktopPref("composeInWindow", checked)}
          testId="desktop-compose-in-window"
        />
      </SettingItem>
      <SettingItem label={t("restore_label")} description={t("restore_description")}>
        <ToggleSwitch checked={prefs.restoreWindows} onChange={(checked) => setDesktopPref("restoreWindows", checked)} />
      </SettingItem>
      <MenuBarSetting />
    </SettingsSection>
  );
}

/** "Always show the menu bar", as in the View menu. Windows and Linux: macOS has the system's. */
function MenuBarSetting() {
  const t = useTranslations("desktopMenuBar");
  const [available, setAvailable] = useState(false);
  const [pinned, setPinned] = useMenuBarPinned();
  useEffect(() => setAvailable(menuBarAvailable()), []);
  if (!available) return null;
  return (
    <SettingItem label={t("always_show_label")} description={t("always_show_description")}>
      <ToggleSwitch checked={pinned} onChange={setPinned} />
    </SettingItem>
  );
}
