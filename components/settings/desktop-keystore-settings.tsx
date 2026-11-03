"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { toast } from "@/stores/toast-store";
import { SettingsSection, SettingItem } from "./settings-section";

/**
 * In the desktop app on an instance: the user's yes to this server using certificates on
 * this computer, stored in the shell, and the way to take it back. Nothing shows in a
 * browser, in standalone, or when an organisation's policy set it.
 */
export function DesktopKeystoreSettings() {
  const t = useTranslations("desktop_keystore");
  const [stored, setStored] = useState(false);

  useEffect(() => {
    let live = true;
    window.bulwarkDesktop?.keystore?.accessState?.().then(
      (state) => { if (live) setStored(state === "stored"); },
      () => {},
    );
    return () => { live = false; };
  }, []);

  if (!stored) return null;

  const revoke = async () => {
    await window.bulwarkDesktop?.keystore?.revokeAccess();
    setStored(false);
    toast.success(t("revoked"));
  };

  return (
    <SettingsSection id="desktop-keystore" title={t("title")} description={t("description")}>
      <SettingItem label={t("label")} description={t("label_description")}>
        <Button variant="outline" onClick={() => void revoke()}>{t("revoke")}</Button>
      </SettingItem>
    </SettingsSection>
  );
}
