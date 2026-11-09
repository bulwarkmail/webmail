"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Upload, Download, Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { SettingsSection, SettingItem, ToggleSwitch } from "./settings-section";
import { ContactImportDialog } from "@/components/contacts/contact-import-dialog";
import { exportContacts, useContactExportBusy } from "@/components/contacts/contact-export";
import { useContactStore } from "@/stores/contact-store";
import { useAuthStore } from "@/stores/auth-store";
import { useSettingsStore } from "@/stores/settings-store";
import { usePolicyStore } from "@/stores/policy-store";
import { toast } from "@/stores/toast-store";

export function ContactsSettings() {
  const t = useTranslations("contacts");
  const tSettings = useTranslations("settings.contacts");
  const { client } = useAuthStore();
  const {
    contacts,
    supportsSync,
    importContacts,
  } = useContactStore();
  const groupContactsByLetter = useSettingsStore((s) => s.groupContactsByLetter);
  const sortContactsByLastName = useSettingsStore((s) => s.sortContactsByLastName);
  const showContactsDirectory = useSettingsStore((s) => s.showContactsDirectory);
  const directoryLocked = usePolicyStore((s) => s.isSettingLocked("showContactsDirectory"));
  const directoryHidden = usePolicyStore((s) => s.isSettingHidden("showContactsDirectory"));
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const [showImport, setShowImport] = useState(false);
  const exporting = useContactExportBusy();

  const individuals = contacts.filter(c => c.kind !== "group");

  const handleImport = useCallback(async (importedContacts: import("@/lib/jmap/types").ContactCard[]) => {
    return importContacts(
      supportsSync && client ? client : null,
      importedContacts
    );
  }, [supportsSync, client, importContacts]);

  const handleExport = async () => {
    if (individuals.length > 0 && await exportContacts(individuals)) {
      toast.success(t("export.success", { count: individuals.length }));
    }
  };

  if (showImport) {
    return (
      <div className="border border-border rounded-lg overflow-hidden" style={{ minHeight: 400 }}>
        <ContactImportDialog
          existingContacts={contacts}
          onImport={handleImport}
          onClose={() => setShowImport(false)}
        />
      </div>
    );
  }

  return (
    <SettingsSection
      id="contacts"
      title={tSettings("title")}
      description={tSettings("description")}
    >
      <SettingItem
        label={tSettings("group_by_letter_label")}
        description={tSettings("group_by_letter_description")}
      >
        <ToggleSwitch
          checked={groupContactsByLetter}
          onChange={(checked) => updateSetting("groupContactsByLetter", checked)}
        />
      </SettingItem>

      <SettingItem
        label={tSettings("sort_by_last_name_label")}
        description={tSettings("sort_by_last_name_description")}
      >
        <ToggleSwitch
          checked={sortContactsByLastName}
          onChange={(checked) => updateSetting("sortContactsByLastName", checked)}
        />
      </SettingItem>

      {!!client?.supportsPrincipals() && !directoryHidden && (
        <SettingItem
          label={tSettings("show_directory_label")}
          description={tSettings("show_directory_description")}
          locked={directoryLocked}
        >
          <ToggleSwitch
            checked={showContactsDirectory}
            onChange={(checked) => updateSetting("showContactsDirectory", checked)}
          />
        </SettingItem>
      )}

      <SettingItem
        label={tSettings("import_label")}
        description={tSettings("import_description")}
        term="vcard"
      >
        <Button variant="outline" size="sm" onClick={() => setShowImport(true)}>
          <Upload className="w-4 h-4 me-2" />
          {t("import.title")}
        </Button>
      </SettingItem>

      <SettingItem
        label={tSettings("export_label")}
        description={tSettings("export_description")}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={handleExport}
          disabled={individuals.length === 0 || exporting}
          aria-busy={exporting}
        >
          {exporting
            ? <Loader2 className="w-4 h-4 me-2 animate-spin" />
            : <Download className="w-4 h-4 me-2" />}
          {exporting ? t("export.exporting") : t("export.title")}
        </Button>
      </SettingItem>
    </SettingsSection>
  );
}
