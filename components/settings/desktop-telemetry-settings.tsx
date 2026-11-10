"use client";

import { useCallback, useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import type { DesktopCrashFile, DesktopCrashSendResult, DesktopPrivacyState } from "@/lib/desktop/types";
import { toast } from "@/stores/toast-store";
import { useSettingsStore } from "@/stores/settings-store";
import { SettingItem, SettingsSection, ToggleSwitch } from "./settings-section";

const SEND_ERROR: Record<Exclude<DesktopCrashSendResult, { ok: true }>["reason"], string | null> = {
  "no-consent": "send_no_consent",
  "no-url": "send_no_url",
  "not-found": "send_failed",
  failed: "send_failed",
  // The user said no in the dialog: nothing to tell them.
  cancelled: null,
};

/**
 * Usage info and crash reports in the desktop app: each with its own switch, both off
 * until the user says yes, and only where there's an app. A browser never sees this, and
 * it renders nothing until the bridge has answered. The shell does the deciding, the
 * asking and the sending.
 */
export function DesktopTelemetrySettings() {
  const t = useTranslations("desktopTelemetry");
  const format = useFormatter();
  const hour12 = useSettingsStore((s) => s.timeFormat) === "12h";
  const bridge = getDesktopBridge();
  const privacy = bridge?.privacy;
  const [state, setState] = useState<DesktopPrivacyState | null>(null);
  const [crashes, setCrashes] = useState<DesktopCrashFile[]>([]);
  const [url, setUrl] = useState("");
  const [urlInvalid, setUrlInvalid] = useState(false);
  const [sending, setSending] = useState<string | null>(null);

  const refreshCrashes = useCallback(() => {
    void privacy?.listCrashes().then(setCrashes, () => {});
  }, [privacy]);

  useEffect(() => {
    if (!privacy) return;
    let stale = false;
    const apply = (next: DesktopPrivacyState) => {
      if (stale) return;
      setState(next);
      setUrl(next.crashReports.uploadUrl);
    };
    void privacy.get().then(apply, () => {});
    refreshCrashes();
    const stop = privacy.onChange((next) => {
      apply(next);
      refreshCrashes();
    });
    return () => {
      stale = true;
      stop();
    };
  }, [privacy, refreshCrashes]);

  if (!privacy || !state) return null;
  const { telemetry, crashReports } = state;

  const saveUrl = async () => {
    const result = await privacy.setCrashUploadUrl(url.trim());
    setUrlInvalid(!result.ok);
    if (result.ok) setState(result.state);
  };

  const send = async (id: string) => {
    setSending(id);
    try {
      const result = await privacy.sendCrash(id);
      if (result.ok) toast.success(t("sent"));
      else if (SEND_ERROR[result.reason]) toast.error(t(SEND_ERROR[result.reason]!));
    } finally {
      setSending(null);
    }
  };

  const showCrashFiles = crashReports.on || crashes.length > 0;

  return (
    <SettingsSection id="desktop-privacy" title={t("section_title")} description={t("section_description")}>
      <SettingItem
        label={t("telemetry_label")}
        description={telemetry.forcedOff ? t("forced_off") : t("telemetry_description")}
        locked={telemetry.forcedOff}
      >
        <ToggleSwitch
          checked={telemetry.on}
          disabled={telemetry.forcedOff}
          testId="desktop-telemetry-toggle"
          onChange={(on) => void privacy.setTelemetry(on).then(setState)}
        />
      </SettingItem>
      <SettingItem
        label={t("crash_label")}
        description={crashReports.forcedOff ? t("forced_off") : t("crash_description")}
        locked={crashReports.forcedOff}
      >
        <ToggleSwitch
          checked={crashReports.on}
          disabled={crashReports.forcedOff}
          testId="desktop-crash-toggle"
          onChange={(on) => void privacy.setCrashReports(on).then((next) => {
            setState(next);
            refreshCrashes();
          })}
        />
      </SettingItem>
      {!crashReports.forcedOff && (
        <p className="py-2 text-xs text-muted-foreground">
          {t("crash_memory")}
          {bridge?.mode === "instance" && ` ${t("instance_note")}`}
        </p>
      )}
      {crashReports.on && (
        <SettingItem nested label={t("url_label")} description={urlInvalid ? t("url_invalid") : t("url_description")}>
          <div className="flex items-center gap-2">
            <Input
              type="url"
              value={url}
              placeholder="https://crash.example.org/upload"
              data-testid="desktop-crash-url"
              onChange={(event) => {
                setUrl(event.target.value);
                setUrlInvalid(false);
              }}
              className="w-64"
            />
            <Button variant="outline" size="sm" onClick={() => void saveUrl()}>{t("url_save")}</Button>
          </div>
        </SettingItem>
      )}
      {showCrashFiles && (
        <SettingItem nested label={t("files_label")} description={t("files_description")}>
          {crashes.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void privacy.deleteCrashes().then(refreshCrashes)}
            >
              {t("delete_all")}
            </Button>
          )}
        </SettingItem>
      )}
      {showCrashFiles && crashes.length === 0 && (
        <p className="ms-4 ps-3 py-2 text-xs text-muted-foreground">{t("files_empty")}</p>
      )}
      {crashes.map((crash) => (
        <SettingItem
          key={crash.id}
          nested
          label={format.dateTime(new Date(crash.createdAt), { dateStyle: "medium", timeStyle: "short", hour12 })}
          description={t("file_size", { size: Math.max(1, Math.round(crash.bytes / 1024)) })}
        >
          <Button
            variant="outline"
            size="sm"
            disabled={sending !== null}
            data-testid="desktop-crash-send"
            onClick={() => void send(crash.id)}
          >
            {t("send")}
          </Button>
        </SettingItem>
      ))}
    </SettingsSection>
  );
}
