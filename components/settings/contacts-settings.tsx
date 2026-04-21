"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Upload, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsSection, SettingItem, ToggleSwitch } from "./settings-section";
import { ContactImportDialog } from "@/components/contacts/contact-import-dialog";
import { exportContacts } from "@/components/contacts/contact-export";
import { useContactStore } from "@/stores/contact-store";
import { useAuthStore } from "@/stores/auth-store";
import { useSettingsStore } from "@/stores/settings-store";
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
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const [showImport, setShowImport] = useState(false);

  const individuals = contacts.filter(c => c.kind !== "group");

  const handleImport = useCallback(async (importedContacts: import("@/lib/jmap/types").ContactCard[]) => {
    return importContacts(
      supportsSync && client ? client : null,
      importedContacts
    );
  }, [supportsSync, client, importContacts]);

  const handleExport = () => {
    if (individuals.length > 0) {
      exportContacts(individuals);
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
        label={tSettings("import_label")}
        description={tSettings("import_description")}
      >
        <Button variant="outline" size="sm" onClick={() => setShowImport(true)}>
          <Upload className="w-4 h-4 mr-2" />
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
          disabled={individuals.length === 0}
        >
          <Download className="w-4 h-4 mr-2" />
          {t("export.title")}
        </Button>
      </SettingItem>
    </SettingsSection>
  );
}
