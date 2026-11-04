"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import type { DesktopOsDefaultAppStatus, DesktopOsSettings as Settings, DesktopOsStatus } from "@/lib/desktop/types";
import { DesktopQuickComposeSetting } from "./desktop-quick-compose-setting";
import { SettingItem, SettingsSection, ToggleSwitch } from "./settings-section";

/** On Windows and Linux this is what a press of the keys shows; macOS maps it to Cmd. */
const SHOW_SHORTCUT = "CommandOrControl+Shift+B";

function shortcutLabel(platform: string | undefined): string {
  return platform === "darwin" ? "⇧⌘B" : "Ctrl+Shift+B";
}

/** The desktop app's OS settings and a way to change them; null status until the bridge answered. */
function useDesktopOs() {
  const [status, setStatus] = useState<DesktopOsStatus | null>(null);
  const bridge = getDesktopBridge();
  const os = bridge?.os;

  useEffect(() => {
    if (!os) return;
    let stale = false;
    void os.getStatus().then((next) => {
      if (!stale) setStatus(next);
    });
    const stop = os.onStatusChange(setStatus);
    return () => {
      stale = true;
      stop();
    };
  }, [os]);

  const change = (patch: Partial<Settings>) => {
    if (os) void os.setSettings(patch).then(setStatus);
  };
  return { bridge, os, status, change };
}

/**
 * The desktop app's own settings, on the General page: only where there's an app to
 * set. A browser never sees it, and it renders nothing until the bridge has answered.
 * Flashing the taskbar and quiet hours are on the Notifications page
 * (DesktopNotificationOsSettings), with the other ways the app gets attention.
 */
export function DesktopOsSettings() {
  const t = useTranslations("desktopOs");
  const { bridge, os, status, change } = useDesktopOs();
  const [defaultApp, setDefaultApp] = useState<DesktopOsDefaultAppStatus | null>(null);

  useEffect(() => {
    if (!os) return;
    let stale = false;
    void os.defaultAppStatus().then((next) => {
      if (!stale) setDefaultApp(next);
    });
    return () => {
      stale = true;
    };
  }, [os]);

  if (!os || !status) return null;
  const { settings } = status;

  return (
    <SettingsSection id="desktop-app" title={t("section_title")} description={t("section_description")}>
      <SettingItem label={t("close_to_tray_label")} description={t("close_to_tray_description")}>
        <ToggleSwitch checked={settings.closeToTray} onChange={(closeToTray) => change({ closeToTray })} />
      </SettingItem>
      <SettingItem label={t("start_at_login_label")} description={t("start_at_login_description")}>
        <ToggleSwitch checked={settings.startAtLogin} onChange={(startAtLogin) => change({ startAtLogin })} />
      </SettingItem>
      {settings.startAtLogin && (
        <SettingItem nested label={t("start_minimized_label")} description={t("start_minimized_description")}>
          <ToggleSwitch checked={settings.startMinimized} onChange={(startMinimized) => change({ startMinimized })} />
        </SettingItem>
      )}
      <SettingItem
        label={t("show_shortcut_label")}
        description={settings.showShortcut && !status.shortcutActive
          ? t("show_shortcut_taken", { keys: shortcutLabel(bridge?.platform) })
          : t("show_shortcut_description", { keys: shortcutLabel(bridge?.platform) })}
      >
        <ToggleSwitch
          checked={!!settings.showShortcut}
          onChange={(on) => change({ showShortcut: on ? SHOW_SHORTCUT : null })}
        />
      </SettingItem>
      {status.quickCompose && (
        <DesktopQuickComposeSetting
          status={status.quickCompose}
          platform={bridge?.platform}
          onChange={(quickComposeShortcut) => change({ quickComposeShortcut })}
        />
      )}
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
  );
}

/**
 * How the desktop app gets attention for new mail, on the Notifications page:
 * flashing the taskbar (bouncing the Dock) and quiet hours. Desktop app only.
 */
export function DesktopNotificationOsSettings() {
  const t = useTranslations("desktopOs");
  const tGeneral = useTranslations("uxs_general");
  const { bridge, os, status, change } = useDesktopOs();
  if (!os || !status) return null;
  const { settings } = status;

  return (
    <SettingsSection id="desktop-attention" title={tGeneral("desktop_attention_title")}>
      <SettingItem
        label={bridge?.platform === "darwin" ? t("attention_mac_label") : t("attention_label")}
        description={t("attention_description")}
      >
        <ToggleSwitch checked={settings.attentionOnNewMail} onChange={(attentionOnNewMail) => change({ attentionOnNewMail })} />
      </SettingItem>
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
    </SettingsSection>
  );
}
