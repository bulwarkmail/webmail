"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import type { DesktopOsDefaultAppStatus, DesktopOsSettings as Settings, DesktopOsStatus } from "@/lib/desktop/types";
import { describeAccelerator, showShortcutDefault } from "@/lib/desktop/shortcut-keys";
import { DesktopQuickComposeSetting } from "./desktop-quick-compose-setting";
import { DesktopWindowSettings } from "./desktop-window-settings";
import { SettingItem, SettingsSection, ToggleSwitch } from "./settings-section";
import { goToSettings, SettingsLinkRow } from "./privacy-settings";
import { productName } from "@/lib/product-name";
import { useConfig } from "@/hooks/use-config";

/**
 * The desktop app's own settings: only where there's an app to set. A browser never sees
 * them, and they render nothing until the bridge has answered. The Desktop app page has
 * how the app runs; the Notifications page has the taskbar flash and, under Do not
 * disturb, quiet hours, next to the rest of what notifies.
 */
export function DesktopOsSettings({ part = "app" }: { part?: "app" | "notifications" | "quietHours" } = {}) {
  const t = useTranslations("desktopOs");
  const tP2 = useTranslations("uxp2_settings.desktop_notifications");
  const tReorg = useTranslations("settings_reorg.sections");
  const appName = productName(useConfig().appName);
  const [status, setStatus] = useState<DesktopOsStatus | null>(null);
  const [defaultApp, setDefaultApp] = useState<DesktopOsDefaultAppStatus | null>(null);
  const bridge = getDesktopBridge();
  const os = bridge?.os;

  useEffect(() => {
    if (!os) return;
    let stale = false;
    void os.getStatus().then((next) => {
      if (!stale) setStatus(next);
    });
    void os.defaultAppStatus().then((next) => {
      if (!stale) setDefaultApp(next);
    });
    const stop = os.onStatusChange(setStatus);
    return () => {
      stale = true;
      stop();
    };
  }, [os]);

  if (!os || !status) return null;
  const { settings } = status;
  const platform = bridge?.platform;
  const showKeys = describeAccelerator(settings.showShortcut ?? showShortcutDefault(platform), platform);
  const change = (patch: Partial<Settings>) => {
    void os.setSettings(patch).then(setStatus);
  };

  // Quiet hours sit under "Pause notifications": one place for both ways of keeping
  // notifications quiet (settings-p3-6). Rows only: the Notifications page draws the section.
  if (part === "quietHours") {
    return (
      <>
        <SettingItem label={t("quiet_hours_label")} description={t("quiet_hours_description")}>
          <ToggleSwitch checked={settings.quietHoursEnabled} onChange={(quietHoursEnabled) => change({ quietHoursEnabled })} />
        </SettingItem>
        {settings.quietHoursEnabled && (
          <SettingItem nested label={t("quiet_hours_from")}>
            <div className="flex items-center gap-2">
              <input
                type="time"
                aria-label={t("quiet_hours_from")}
                value={settings.quietHoursStart}
                onChange={(event) => change({ quietHoursStart: event.target.value })}
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
              <span className="text-sm text-muted-foreground">{t("quiet_hours_to")}</span>
              <input
                type="time"
                aria-label={t("quiet_hours_to")}
                value={settings.quietHoursEnd}
                onChange={(event) => change({ quietHoursEnd: event.target.value })}
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
            </div>
          </SettingItem>
        )}
      </>
    );
  }

  if (part === "notifications") {
    return (
      <SettingsSection id="desktop-notifications" title={tP2("title")}>
        {/* The app tells about new mail as long as it runs; a browser's push section has nothing to add (settings-p2-4). */}
        <SettingsLinkRow
          label={tP2("closed_label")}
          description={tP2("closed_description", { appName, page: t("section_title") })}
          button={t("section_title")}
          onClick={() => goToSettings("desktop", "desktop-app")}
        />
        <SettingItem
          label={bridge?.platform === "darwin" ? t("attention_mac_label") : t("attention_label")}
          description={t("attention_description")}
        >
          <ToggleSwitch checked={settings.attentionOnNewMail} onChange={(attentionOnNewMail) => change({ attentionOnNewMail })} />
        </SettingItem>
      </SettingsSection>
    );
  }

  // The Desktop app page (settings reorg 2026-11-05): how the app starts and closes, its
  // windows, its keys from anywhere, and the mail links and files it opens.
  return (
    <>
    <SettingsSection id="desktop-app" title={tReorg("start")}>
      <SettingItem label={t("start_at_login_label")} description={t("start_at_login_description")}>
        <ToggleSwitch checked={settings.startAtLogin} onChange={(startAtLogin) => change({ startAtLogin })} />
      </SettingItem>
      {settings.startAtLogin && (
        <SettingItem nested label={t("start_minimized_label")} description={t("start_minimized_description")}>
          <ToggleSwitch checked={settings.startMinimized} onChange={(startMinimized) => change({ startMinimized })} />
        </SettingItem>
      )}
      <SettingItem label={t("close_to_tray_label")} description={t("close_to_tray_description")}>
        <ToggleSwitch checked={settings.closeToTray} onChange={(closeToTray) => change({ closeToTray })} />
      </SettingItem>
    </SettingsSection>
    <DesktopWindowSettings />
    <SettingsSection id="desktop-shortcuts" title={tReorg("shortcuts")}>
      <SettingItem
        label={t("show_shortcut_label")}
        description={settings.showShortcut && !status.shortcutActive
          ? t("show_shortcut_taken", { keys: showKeys })
          : t("show_shortcut_description", { keys: showKeys })}
      >
        <ToggleSwitch
          checked={!!settings.showShortcut}
          onChange={(on) => change({ showShortcut: on ? showShortcutDefault(platform) : null })}
        />
      </SettingItem>
      {status.quickCompose && (
        <DesktopQuickComposeSetting
          status={status.quickCompose}
          platform={bridge?.platform}
          onChange={(quickComposeShortcut) => change({ quickComposeShortcut })}
        />
      )}
    </SettingsSection>
    <SettingsSection id="desktop-mail-links" title={tReorg("mail_links")}>
      <SettingItem
        label={t("default_app_label")}
        description={defaultApp?.mailto ? t("default_app_is_default") : t("default_app_description")}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => void os.openDefaultAppSettings().then(setDefaultApp)}
          className="text-xs h-7"
        >
          {t("default_app_button")}
        </Button>
      </SettingItem>
    </SettingsSection>
    </>
  );
}
