"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { CurrentPinField, NewPinFields, newPinReady } from "@/components/app-lock/pin-fields";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useConfig } from "@/hooks/use-config";
import {
  addOsUnlock,
  addPasskey,
  changeAppLockPin,
  disableAppLock,
  enableAppLock,
  hasPasskey,
  lockEverywhere,
  removePasskey,
  setAppLockTimeout,
} from "@/lib/app-lock/controller";
import { passkeysPossible } from "@/lib/app-lock/passkey";
import { appLockRequired, effectiveTimeout, onLockPolicyChange } from "@/lib/app-lock/policy";
import { readAppLockFile, TIMEOUT_CHOICES } from "@/lib/app-lock/state";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import type { DesktopOsUnlockKind } from "@/lib/desktop/types";
import { IS_LITE } from "@/lib/lite";
import { toast } from "@/stores/toast-store";
import { KeyProtectionNotes } from "@/components/offline/key-protection-notes";
import { SettingItem, SettingsSection, ToggleSwitch } from "./settings-section";

type Pending = "enable" | "disable" | "change" | "passkey" | "os" | null;

function useLockFacts() {
  const [, refresh] = useState(0);
  const update = useCallback(() => refresh((n) => n + 1), []);
  useEffect(() => onLockPolicyChange(update), [update]);
  const file = readAppLockFile();
  return { on: file.on, required: appLockRequired(), timeout: effectiveTimeout(file.timeoutMinutes), update };
}

/** The app lock's section on the General page: it has to exist on any server. */
export function AppLockSettings() {
  const t = useTranslations("appLock");
  const tKey = useTranslations("keyProtection");
  const { appName } = useConfig();
  const { on, required, timeout, update } = useLockFacts();
  const [pending, setPending] = useState<Pending>(null);
  const [pin, setPin] = useState("");
  const [repeat, setRepeat] = useState("");
  const [current, setCurrent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkey, setPasskey] = useState(false);
  const [os, setOs] = useState<{ kind: DesktopOsUnlockKind; enrolled: boolean } | null>(null);

  const refreshMethods = useCallback(() => {
    void hasPasskey().then(setPasskey).catch(() => {});
    void getDesktopBridge()?.appLock?.status()
      .then((status) => setOs(status.os ? { kind: status.os, enrolled: status.osEnrolled } : null))
      .catch(() => {});
  }, []);
  useEffect(refreshMethods, [refreshMethods, on]);

  const close = () => {
    setPending(null);
    setPin("");
    setRepeat("");
    setCurrent("");
    setError(null);
    setBusy(false);
  };

  const describeFailure = (failure: unknown): string => {
    const name = (failure as Error)?.name;
    if (name === "WrongPinError") return t("wrong_pin");
    if (name === "PinBlockedError") return t("blocked_later");
    if (name === "PasskeyNoPrfError") return t("passkey_no_prf");
    if (name === "ObviousPinError") return t("pin_obvious");
    return t("save_failed");
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      close();
      update();
      refreshMethods();
    } catch (failure) {
      setBusy(false);
      setError(describeFailure(failure));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (pending === "enable" && newPinReady(pin, repeat)) void run(() => enableAppLock(pin));
    if (pending === "change" && current && newPinReady(pin, repeat)) {
      void run(async () => {
        const { reenroll } = await changeAppLockPin(current, pin);
        if (reenroll) toast.info(tKey("reenroll_note"), { duration: 0 });
      });
    }
    if (pending === "disable" && current) void run(() => disableAppLock(current));
    if (pending === "passkey" && current) {
      void run(async () => {
        await addPasskey(current, appName);
        toast.success(t("passkey_added"));
      });
    }
    if (pending === "os" && current) {
      void run(async () => {
        if (!(await addOsUnlock(current))) throw new Error("Not set up");
      });
    }
  };

  if (IS_LITE) return null;

  const osName = os?.kind === "touchid" ? t("use_touchid_name") : t("use_hello_name");
  const asksNew = pending === "enable" || pending === "change";
  const asksCurrent = pending === "disable" || pending === "change" || pending === "passkey" || pending === "os";
  const ready = (!asksNew || newPinReady(pin, repeat)) && (!asksCurrent || current.length > 0);
  const titles: Record<Exclude<Pending, null>, string> = {
    enable: t("set_pin_title"),
    change: t("change_pin_title"),
    disable: t("disable_title"),
    passkey: t("passkey_add_title"),
    os: t("os_add_title", { method: osName }),
  };

  return (
    <SettingsSection id="app-lock" title={t("section_title")} description={t("section_desc")}>
      <SettingItem label={t("enable_label")} description={t("enable_desc")} locked={required}>
        <ToggleSwitch checked={on || required} onChange={(next) => setPending(next ? "enable" : "disable")} testId="app-lock-switch" />
      </SettingItem>
      <p className="text-xs text-muted-foreground" data-testid="app-lock-protects">{t("protects_desc")}</p>
      <KeyProtectionNotes />

      {on && (
        <>
          <SettingItem label={t("timeout_label")} description={t("timeout_desc")} locked={timeout.locked}>
            <select
              data-testid="app-lock-timeout"
              className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={timeout.minutes}
              onChange={(event) => {
                setAppLockTimeout(Number(event.target.value));
                update();
              }}
            >
              {[...new Set([...TIMEOUT_CHOICES, timeout.minutes])].sort((a, b) => a - b).map((minutes) => (
                <option key={minutes} value={minutes}>{t("timeout_option", { count: minutes })}</option>
              ))}
            </select>
          </SettingItem>

          <SettingItem label={t("lock_now")} description={t("lock_now_desc")}>
            <Button variant="outline" size="sm" className="text-xs h-7" onClick={lockEverywhere} data-testid="app-lock-now">{t("lock_now")}</Button>
          </SettingItem>

          <SettingItem label={t("pin_label")} description={t("pin_recovery")}>
            <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => setPending("change")}>{t("change_pin")}</Button>
          </SettingItem>

          {passkeysPossible() && (
            <SettingItem label={t("passkey_label")} description={t("passkey_desc")}>
              {passkey ? (
                <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => void removePasskey().then(refreshMethods)}>{t("passkey_remove")}</Button>
              ) : (
                <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => setPending("passkey")} data-testid="app-lock-add-passkey">{t("passkey_add")}</Button>
              )}
            </SettingItem>
          )}

          {os && (
            <SettingItem label={osName} description={t("os_desc", { method: osName })}>
              {os.enrolled ? (
                <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => void getDesktopBridge()?.appLock?.osRemove().then(refreshMethods)}>{t("os_remove")}</Button>
              ) : (
                <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => setPending("os")}>{t("os_add")}</Button>
              )}
            </SettingItem>
          )}
        </>
      )}

      <Dialog
        isOpen={pending !== null}
        onClose={close}
        title={pending ? titles[pending] : ""}
        description={pending === "disable" ? t("disable_body") : pending === "enable" ? t("enable_body") : undefined}
        onSubmit={submit}
        dirty={pin.length > 0 || current.length > 0}
        testId="app-lock-dialog"
        footer={(
          <>
            <Button type="button" variant="outline" onClick={close}>{t("cancel")}</Button>
            <Button type="submit" disabled={busy || !ready} data-testid="app-lock-dialog-save">
              {pending === "disable" ? t("disable_confirm") : t("save")}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          {asksCurrent && <CurrentPinField value={current} onChange={setCurrent} error={error} />}
          {asksNew && <NewPinFields pin={pin} repeat={repeat} onPin={setPin} onRepeat={setRepeat} />}
          {!asksCurrent && error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
      </Dialog>
    </SettingsSection>
  );
}
