"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Lock } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { useConfig } from "@/hooks/use-config";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { NewPinFields, newPinReady } from "./pin-fields";
import { enableAppLock, forgetEverything, unlockWithOs, unlockWithPasskey, unlockWithPin, type AppLockPhase } from "@/lib/app-lock/controller";
import { passkeysPossible } from "@/lib/app-lock/passkey";
import { APP_LOCK_CHANNEL, postAppLockMessage, type AppLockMessage } from "@/lib/app-lock/state";
import { pinBlockedUntil, readVault } from "@/lib/app-lock/vault";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import type { DesktopOsUnlockKind } from "@/lib/desktop/types";
import { isPopoutWindow } from "@/lib/popout/window-role";
import { productName } from "@/lib/product-name";

/** How long a pop-out waits to hear from a main window before it asks for the PIN itself. */
const MAIN_ANSWER_MS = 500;

function secondsLeft(until: number): number {
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

function useBlockedUntil(): [number, (until: number) => void] {
  const [until, setUntil] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => {
    void pinBlockedUntil().then(setUntil).catch(() => {});
  }, []);
  useEffect(() => {
    if (until <= Date.now()) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return [until > Date.now() ? until : 0, setUntil];
}

/**
 * Whether a main window is there. The tab that unlocks keeps the key for as long as it lives,
 * and a pop-out is about to close: so a pop-out sends people to the main window.
 */
function useMainWindowThere(): boolean {
  const [there, setThere] = useState(false);
  useEffect(() => {
    if (!isPopoutWindow() || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(APP_LOCK_CHANNEL);
    channel.onmessage = (event: MessageEvent<AppLockMessage>) => {
      if (event.data.type === "main-pong") setThere(true);
    };
    postAppLockMessage({ type: "main-ping" });
    const timer = setTimeout(() => postAppLockMessage({ type: "main-ping" }), MAIN_ANSWER_MS);
    return () => {
      clearTimeout(timer);
      channel.close();
    };
  }, []);
  return there;
}

function Frame({ title, body, children }: { title: string; body?: string; children: React.ReactNode }) {
  const titleId = useId();
  return (
    <div
      data-app-lock-overlay=""
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[100001] flex items-center justify-center overflow-y-auto bg-background p-6 pt-[calc(var(--titlebar-inset,0px)+1.5rem)]"
    >
      <div className="w-full max-w-sm space-y-5">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-foreground">
            <Lock className="h-6 w-6" aria-hidden="true" />
          </span>
          <h1 id={titleId} className="text-lg font-semibold text-foreground">{title}</h1>
          {body && <p className="text-sm text-muted-foreground">{body}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}

function SetupForm() {
  const t = useTranslations("appLock");
  const appName = productName(useConfig().appName);
  const [pin, setPin] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!newPinReady(pin, repeat) || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await enableAppLock(pin);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  return (
    <Frame title={t("setup_required_title")} body={t("setup_required_body", { app: appName })}>
      <form onSubmit={submit} className="space-y-4" data-testid="app-lock-setup">
        <NewPinFields pin={pin} repeat={repeat} onPin={setPin} onRepeat={setRepeat} />
        {failed && <p role="alert" className="text-sm text-destructive">{t("save_failed")}</p>}
        <Button type="submit" className="w-full" disabled={busy || !newPinReady(pin, repeat)}>{t("save")}</Button>
      </form>
    </Frame>
  );
}

function UnlockForm() {
  const t = useTranslations("appLock");
  const appName = productName(useConfig().appName);
  const { dialogProps, confirm } = useConfirmDialog();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [blockedUntil, setBlockedUntil] = useBlockedUntil();
  const [hasPasskey, setHasPasskey] = useState(false);
  const [osKind, setOsKind] = useState<DesktopOsUnlockKind | null>(null);
  const mainThere = useMainWindowThere();
  const inputRef = useRef<HTMLInputElement>(null);
  const pinId = useId();

  useEffect(() => {
    void readVault().then((vault) => setHasPasskey(Boolean(vault?.prf) && passkeysPossible())).catch(() => {});
    void getDesktopBridge()?.appLock?.status().then((status) => setOsKind(status.osEnrolled ? status.os : null)).catch(() => {});
  }, []);

  const blocked = blockedUntil > 0;
  const left = secondsLeft(blockedUntil);

  const submit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!pin || busy || blocked) return;
    setBusy(true);
    setMessage(null);
    try {
      await unlockWithPin(pin);
    } catch (error) {
      const name = (error as Error)?.name;
      setBusy(false);
      setPin("");
      inputRef.current?.focus();
      if (name === "PinBlockedError") setBlockedUntil((error as Error & { until: number }).until);
      else if (name === "WrongPinError") {
        setMessage(t("wrong_pin"));
        void pinBlockedUntil().then(setBlockedUntil).catch(() => {});
      } else setMessage(t("unlock_failed"));
    }
  }, [blocked, busy, pin, setBlockedUntil, t]);

  const withOs = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (await unlockWithOs()) return;
    } catch {
      // The PIN below still works.
    }
    setBusy(false);
    setMessage(t("os_failed"));
  };

  const withPasskey = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await unlockWithPasskey();
    } catch {
      setBusy(false);
      setMessage(t("passkey_failed"));
    }
  };

  const forgot = async () => {
    const ok = await confirm({
      title: t("forgot_title"),
      message: t("forgot_body"),
      confirmText: t("forgot_confirm"),
      variant: "destructive",
    });
    if (ok) await forgetEverything();
  };

  if (mainThere) {
    return (
      <Frame title={t("lock_title", { app: appName })} body={t("unlock_in_main")}>
        <Button
          className="w-full"
          onClick={() => {
            const windows = getDesktopBridge()?.windows;
            if (windows?.focus) windows.focus();
            else postAppLockMessage({ type: "focus-main" });
          }}
        >
          {t("open_main")}
        </Button>
      </Frame>
    );
  }

  return (
    <Frame title={t("lock_title", { app: appName })} body={t("pin_prompt")}>
      <form onSubmit={submit} className="space-y-3" data-testid="app-lock-form">
        <label htmlFor={pinId} className="sr-only">{t("pin_label")}</label>
        <Input
          id={pinId}
          ref={inputRef}
          data-testid="app-lock-pin"
          type="password"
          autoComplete="off"
          autoFocus
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          placeholder={t("pin_label")}
          disabled={blocked}
        />
        <div role="status" aria-live="polite" className="min-h-5 text-sm text-destructive" data-testid="app-lock-message">
          {blocked
            ? (left >= 60 ? t("blocked_minutes", { count: Math.ceil(left / 60) }) : t("blocked_seconds", { count: left }))
            : message}
        </div>
        <Button type="submit" className="w-full" disabled={!pin || busy || blocked} data-testid="app-lock-unlock">
          {busy ? t("unlocking") : t("unlock")}
        </Button>
        {osKind && (
          <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={withOs} data-testid="app-lock-os">
            {osKind === "hello" ? t("use_hello") : t("use_touchid")}
          </Button>
        )}
        {hasPasskey && (
          <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={withPasskey} data-testid="app-lock-passkey">
            {t("use_passkey")}
          </Button>
        )}
        <Button type="button" variant="ghost" className="w-full" onClick={forgot} data-testid="app-lock-forgot">
          {t("forgot")}
        </Button>
      </form>
      <ConfirmDialog {...dialogProps} />
    </Frame>
  );
}

/** What covers a window while the app is locked. Reads nothing but the lock's own records. */
export function LockScreen({ phase }: { phase: AppLockPhase }) {
  const t = useTranslations("appLock");
  const appName = productName(useConfig().appName);
  if (phase === "setup") return <SetupForm />;
  if (phase === "locking") {
    return (
      <Frame title={t("lock_title", { app: appName })} body={t("locking")}>
        <span />
      </Frame>
    );
  }
  return <UnlockForm />;
}
