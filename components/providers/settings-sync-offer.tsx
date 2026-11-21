"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { startSettingsMetadataSync, useSettingsMetadataSyncStore } from "@/stores/settings-metadata-sync";
import { toast } from "@/stores/toast-store";

/**
 * Starts syncing the settings the mobile app shares through the account's
 * metadata (stores/settings-metadata-sync), and offers back settings chosen
 * in this browser before it kept change times that the first sync with the
 * account replaced: one toast with the way back.
 */
export function SettingsSyncOffer() {
  const t = useTranslations("settings.advanced.settings_sync");
  const replaced = useSettingsMetadataSyncStore((s) => s.replaced);
  const shown = useRef<string | null>(null);

  useEffect(() => {
    startSettingsMetadataSync();
  }, []);

  useEffect(() => {
    if (!replaced) {
      shown.current = null;
      return;
    }
    const names = Object.keys(replaced).sort().join(",");
    if (shown.current === names) return;
    shown.current = names;
    const count = Object.keys(replaced).length;
    toast.info(t("label"), {
      message: t("replaced", { count }),
      duration: 0,
      action: { label: t("keep_mine"), onClick: () => useSettingsMetadataSyncStore.getState().keepReplaced() },
    });
  }, [replaced, t]);

  return null;
}
