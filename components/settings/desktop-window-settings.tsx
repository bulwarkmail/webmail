"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { hasDesktopWindows } from "@/lib/popout/support";
import { setDesktopPref, useDesktopPrefs } from "@/lib/desktop/preferences";
import { SettingItem, SettingsSection, ToggleSwitch } from "./settings-section";

/** How the desktop app's windows behave. Only there: a browser has nothing to set. */
export function DesktopWindowSettings() {
  const t = useTranslations("desktopUi.settings");
  const prefs = useDesktopPrefs();
  const [shown, setShown] = useState(false);
  useEffect(() => setShown(hasDesktopWindows()), []);
  if (!shown) return null;
  return (
    <SettingsSection id="desktop-windows" title={t("title")}>
      <SettingItem label={t("double_click_label")} description={t("double_click_description")}>
        <ToggleSwitch checked={prefs.openOnDoubleClick} onChange={(checked) => setDesktopPref("openOnDoubleClick", checked)} />
      </SettingItem>
      <SettingItem label={t("restore_label")} description={t("restore_description")}>
        <ToggleSwitch checked={prefs.restoreWindows} onChange={(checked) => setDesktopPref("restoreWindows", checked)} />
      </SettingItem>
    </SettingsSection>
  );
}
