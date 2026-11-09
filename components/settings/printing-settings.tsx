"use client";

import { useTranslations } from "next-intl";
import { useSettingsStore } from "@/stores/settings-store";
import { STANDARD_PRINT_THEME, usePrintThemes } from "@/lib/plugin-sandbox/print-themes";
import { SettingsSection, SettingItem, Select } from "./settings-section";

/**
 * Settings > Appearance > Printing: the print style for printouts. Standard,
 * or one an add-on registered (api.ui.registerPrintTheme). A style whose
 * add-on isn't running shows as Standard and prints that way, but stays
 * picked for when the add-on is back.
 */
export function PrintingSection() {
  const t = useTranslations("print_styles");
  const value = useSettingsStore((s) => s.printTheme);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const themes = usePrintThemes();
  const current = themes.some((theme) => theme.key === value) ? value : STANDARD_PRINT_THEME;

  return (
    <SettingsSection id="printing" title={t("title")} description={t("description")}>
      <SettingItem label={t("style_label")} description={t("style_description")}>
        <Select
          value={current}
          onChange={(next) => updateSetting("printTheme", next)}
          options={[
            { value: STANDARD_PRINT_THEME, label: t("standard") },
            ...themes.map((theme) => ({ value: theme.key, label: t("from_plugin", { name: theme.label, plugin: theme.pluginName }) })),
          ]}
        />
      </SettingItem>
    </SettingsSection>
  );
}
