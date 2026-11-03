"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import type { DesktopUpdateChannel, DesktopUpdateState } from "@/lib/desktop/types";
import { Select, SettingItem, SettingsSection } from "./settings-section";

/**
 * The desktop app's updates: version, what's going on, and stable or beta. Only there,
 * and only in a copy that can get updates: a browser has nothing to show.
 */
export function DesktopUpdateSettings() {
  const t = useTranslations("desktop_updates");
  const [state, setState] = useState<DesktopUpdateState | null>(null);

  useEffect(() => {
    const updates = getDesktopBridge()?.updates;
    if (!updates) return;
    let live = true;
    void updates.state().then((value) => {
      if (live) setState(value);
    });
    const stop = updates.onChanged(setState);
    return () => {
      live = false;
      stop();
    };
  }, []);

  const updates = getDesktopBridge()?.updates;
  if (!state || !updates || state.ability === "none") return null;

  const version = state.target ?? state.version;
  const busy = state.status === "checking" || state.status === "downloading";
  const statusText = (() => {
    switch (state.status) {
      case "checking":
        return t("status_checking");
      case "up-to-date":
        return t("status_up_to_date");
      case "downloading":
        return t("status_downloading", { version });
      case "ready":
        return t("status_ready", { version });
      case "available":
        return state.perMachine ? t("status_available_per_machine", { version }) : t("status_available", { version });
      case "older-available":
        return t("status_older", { version });
      case "error":
        return t("status_error");
      case "off":
        return t("status_off");
      default:
        return t("status_idle");
    }
  })();

  return (
    <SettingsSection id="desktop-updates" title={t("title")}>
      <SettingItem label={t("version_label", { version: state.version })} description={statusText} locked={!state.allowed}>
        {state.status === "ready" ? (
          <Button size="sm" onClick={() => updates.restart()}>
            {t("restart")}
          </Button>
        ) : state.status === "available" && !state.perMachine ? (
          <Button variant="outline" size="sm" onClick={() => updates.openDownload()}>
            {t("download")}
          </Button>
        ) : state.status === "older-available" && state.ability === "install" ? (
          <Button variant="outline" size="sm" onClick={() => void updates.installOlder().then(setState)}>
            {t("install_older")}
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void updates.check().then(setState)}>
            {t("check")}
          </Button>
        )}
      </SettingItem>
      <SettingItem label={t("channel_label")} description={t("channel_description")} locked={state.channelLocked || !state.allowed}>
        <Select
          value={state.channel}
          onChange={(value) => void updates.setChannel(value as DesktopUpdateChannel).then(setState)}
          options={[
            { value: "stable", label: t("channel_stable") },
            { value: "beta", label: t("channel_beta") },
          ]}
        />
      </SettingItem>
    </SettingsSection>
  );
}
