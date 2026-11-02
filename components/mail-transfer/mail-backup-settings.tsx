"use client";

import { useTranslations } from "next-intl";
import { SettingItem, SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { openMailExport, openMailImport } from "@/stores/mail-transfer-store";
import { useDevicePolicy } from "@/hooks/use-device-policy";

/** Settings > Backup & reset > Mail files: bring mail in from files, and save all of it as one file. */
export function MailBackupSettings() {
  const tImport = useTranslations("mail_import");
  const tExport = useTranslations("mail_export");
  // Organisation > Devices > No export: shown as set by the organisation.
  const exportOff = useDevicePolicy().noExport;
  return (
    <SettingsSection id="mail-files" title={tImport("section_title")} description={tImport("section_description")}>
      <SettingItem label={tImport("settings_label")} description={tImport("settings_description")}>
        <Button variant="outline" size="sm" onClick={() => openMailImport()} data-testid="settings-mail-import">
          {tImport("settings_button")}
        </Button>
      </SettingItem>
      <SettingItem label={tExport("settings_label")} description={tExport("settings_description")} locked={exportOff}>
        <Button variant="outline" size="sm" onClick={() => openMailExport()} disabled={exportOff} data-testid="settings-mail-export">
          {tExport("settings_button")}
        </Button>
      </SettingItem>
    </SettingsSection>
  );
}
