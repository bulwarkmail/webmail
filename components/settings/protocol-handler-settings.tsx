"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useConfig } from "@/hooks/use-config";
import { getPathPrefix } from "@/lib/browser-navigation";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { productName } from "@/lib/product-name";
import { useSettingsStore } from "@/stores/settings-store";
import type { ProtocolOpenMode } from "@/stores/settings-store";
import { toast } from "@/stores/toast-store";
import { SettingsSection, SettingItem, Select } from "./settings-section";

type Protocol = "mailto" | "webcal";

function canRegisterProtocolHandler(): boolean {
  return typeof navigator !== "undefined"
    && "registerProtocolHandler" in navigator
    && typeof window !== "undefined"
    && window.isSecureContext;
}

function getProtocolHandlerUrl(protocol: Protocol) {
  return `${window.location.origin}${getPathPrefix()}/protocol/${protocol}?url=%s`;
}

function registerProtocolHandler(protocol: Protocol) {
  navigator.registerProtocolHandler(
    protocol,
    getProtocolHandlerUrl(protocol),
  );
}

interface ProtocolHandlerSettingsProps {
  supportsCalendar: boolean;
}

export function ProtocolHandlerSettings({ supportsCalendar }: ProtocolHandlerSettingsProps) {
  const t = useTranslations("protocol_handlers");
  const appName = productName(useConfig().appName);
  const protocolOpenMode = useSettingsStore((state) => state.protocolOpenMode);
  const updateSetting = useSettingsStore((state) => state.updateSetting);
  const [supported, setSupported] = useState(false);
  // The desktop app is a mail app of its own: its "Default mail app" row (Desktop app
  // section) is the one that counts, and a browser's handler means nothing there.
  const [desktop, setDesktop] = useState(false);

  useEffect(() => {
    setSupported(canRegisterProtocolHandler());
    setDesktop(!!getDesktopBridge());
  }, []);

  const handleOpenModeChange = async (value: string) => {
    const openMode = value as ProtocolOpenMode;

    if (openMode === "active-session"
      && typeof window !== "undefined"
      && "Notification" in window
      && Notification.permission === "default") {
      await Notification.requestPermission();
    }

    updateSetting("protocolOpenMode", openMode);
  };

  const handleRegister = (protocol: Protocol) => {
    try {
      registerProtocolHandler(protocol);
      toast.success(protocol === "mailto" ? t("mailto_registered") : t("webcal_registered"));
    } catch {
      toast.error(t("registration_failed"));
    }
  };

  const renderRegistrationControl = (protocol: Protocol) => {
    return (
      <Button size="sm" onClick={() => handleRegister(protocol)} disabled={!supported}>
        {protocol === "mailto" ? t("register_mailto", { appName }) : t("register_webcal", { appName })}
      </Button>
    );
  };

  if (desktop) return null;

  return (
    <SettingsSection id="links" title={t("title")} description={t("description", { appName })}>
      {!supported && (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t("unsupported")}
        </div>
      )}

      <SettingItem label={t("mailto_label", { appName })} description={t("mailto_description", { appName })}>
        {renderRegistrationControl("mailto")}
      </SettingItem>

      {supportsCalendar && (
        <SettingItem label={t("webcal_label", { appName })} description={t("webcal_description", { appName })}>
          {renderRegistrationControl("webcal")}
        </SettingItem>
      )}

      <SettingItem advanced label={t("protocol_open_mode_label")} description={t("protocol_open_mode_description", { appName })}>
        <Select
          value={protocolOpenMode}
          onChange={handleOpenModeChange}
          options={[
            { value: "new-tab", label: t("protocol_open_mode_new_tab") },
            { value: "active-session", label: t("protocol_open_mode_active_session") },
          ]}
        />
      </SettingItem>

      <p className="text-xs text-muted-foreground">{t("browser_note", { appName })}</p>
    </SettingsSection>
  );
}
