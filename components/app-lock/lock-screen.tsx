"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Lock } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfig } from "@/hooks/use-config";
import { LockBackdrop } from "./lock-backdrop";
import { NewPinFields, newPinReady } from "./pin-fields";
import { cancelHello, enableAppLock, forgetEverything, helloState, unlockWithHello, unlockWithOs, unlockWithPasskey, unlockWithPin, type AppLockPhase } from "@/lib/app-lock/controller";
import { passkeysPossible } from "@/lib/app-lock/passkey";
import { APP_LOCK_CHANNEL, postAppLockMessage, type AppLockMessage } from "@/lib/app-lock/state";
import { pinBlockedUntil, readVault } from "@/lib/app-lock/vault";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import type { DesktopOsUnlockKind } from "@/lib/desktop/types";
import { isPopoutWindow } from "@/lib/popout/window-role";
import { productName } from "@/lib/product-name";

/** How often a pop-out asks whether a main window is there, and how long a silence means it's gone. */
const MAIN_PING_MS = 1_000;
const MAIN_GONE_MS = 2_500;

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
 * and a pop-out is about to close: so a pop-out sends people to the main window. It keeps
 * asking, because a main window that closes or crashes says nothing, and with none left the
 * pop-out has to take the PIN itself or nobody can get in.
 */
function useMainWindowThere(): boolean {
  const [there, setThere] = useState(false);
  useEffect(() => {
    if (!isPopoutWindow() || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(APP_LOCK_CHANNEL);
    let heardAt = 0;
    channel.onmessage = (event: MessageEvent<AppLockMessage>) => {
      if (event.data.type !== "main-pong") return;
      heardAt = Date.now();
      setThere(true);
    };
    postAppLockMessage({ type: "main-ping" });
    const timer = setInterval(() => {
      if (Date.now() - heardAt > MAIN_GONE_MS) setThere(false);
      postAppLockMessage({ type: "main-ping" });
    }, MAIN_PING_MS);
    return () => {
      clearInterval(timer);
      channel.close();
    };
  }, []);
  return there;
}

/**
 * The whole window: the app's skeleton behind (not in a pop-out, which isn't the mail
 * page), the window's drag band over the top row, and the card. The band comes before
 * the card, so the card's fields and buttons cut themselves out of it. It needs its own
 * element: this overlay, fixed and a dialog, cuts the page's band (body::before) out
 * everywhere. See app/globals.css.
 */
function Frame({ title, body, children }: { title: string; body?: string; children: React.ReactNode }) {
  const titleId = useId();
  return (
    <div
      data-app-lock-overlay=""
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[100001] bg-background"
    >
      {!isPopoutWindow() && <LockBackdrop />}
      <div aria-hidden="true" data-window-drag-band="" />
      <div className="absolute inset-0 flex overflow-y-auto p-6 pt-[calc(var(--titlebar-inset,0px)+1.5rem)]">
        <div data-app-lock-card="" className="relative m-auto w-full max-w-sm space-y-5 rounded-xl border border-border bg-background p-6 shadow-xl">
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
  const tHello = useTranslations("appLockHello");
  const appName = productName(useConfig().appName);
  const [forgetting, setForgetting] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [blockedUntil, setBlockedUntil] = useBlockedUntil();
  const [hasPasskey, setHasPasskey] = useState(false);
  const [osKind, setOsKind] = useState<DesktopOsUnlockKind | null>(null);
  // Windows Hello comes first where it's on, with the PIN a click away.
  const [helloReady, setHelloReady] = useState(false);
  const [asking, setAsking] = useState<"hello" | "pin">("pin");
  /** Which Hello try is the current one: a late answer to one the user left for the PIN changes nothing. */
  const helloTry = useRef(0);
  const helloAsked = useRef(false);
  const mainThere = useMainWindowThere();
  const inputRef = useRef<HTMLInputElement>(null);
  const pinId = useId();

  useEffect(() => {
    void readVault().then((vault) => setHasPasskey(Boolean(vault?.prf) && passkeysPossible())).catch(() => {});
    void getDesktopBridge()?.appLock?.status().then((status) => setOsKind(status.osEnrolled ? status.os : null)).catch(() => {});
    void helloState().then((state) => {
      if (!state.on) return;
      setHelloReady(true);
      setAsking("hello");
    }).catch(() => {});
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

  const withHello = useCallback(async () => {
    const attempt = ++helloTry.current;
    setAsking("hello");
    setBusy(true);
    setMessage(null);
    try {
      await unlockWithHello();
    } catch (error) {
      if (attempt !== helloTry.current) return;
      const reason = (error as Error & { reason?: string })?.reason;
      setBusy(false);
      setAsking("pin");
      if (reason === "missing" || reason === "policy") setHelloReady(false);
      setMessage(reason === "cancelled" ? null : reason === "missing" ? tHello("gone") : tHello("failed"));
    }
  }, [tHello]);

  const usePin = () => {
    helloTry.current += 1;
    cancelHello();
    setBusy(false);
    setMessage(null);
    setAsking("pin");
  };

  // Once, when the window has the focus: a prompt nobody is there to see would only time out.
  // Not in a pop-out, which may yet send people to the main window.
  useEffect(() => {
    if (!helloReady || helloAsked.current || isPopoutWindow()) return;
    const ask = () => {
      if (helloAsked.current) return;
      helloAsked.current = true;
      void withHello();
    };
    if (document.hasFocus()) {
      ask();
      return;
    }
    window.addEventListener("focus", ask);
    return () => window.removeEventListener("focus", ask);
  }, [helloReady, withHello]);

  // The PIN field wasn't there while Hello asked.
  useEffect(() => {
    if (asking === "pin" && helloReady) inputRef.current?.focus();
  }, [asking, helloReady]);

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

  // Here and not in a dialog: a dialog is a portal on <body>, which the lock keeps hidden.
  if (forgetting) {
    return (
      <Frame title={t("forgot_title")} body={t("forgot_body")}>
        <p className="text-center text-sm text-muted-foreground">{t("forgot_provider")}</p>
        <div className="flex flex-col gap-2" data-testid="app-lock-forget">
          <Button
            variant="destructive"
            className="w-full"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void forgetEverything().catch(() => false).then((gone) => {
                if (gone) return;
                setBusy(false);
                setForgetting(false);
              });
            }}
          >
            {t("forgot_confirm")}
          </Button>
          <Button variant="ghost" className="w-full" disabled={busy} onClick={() => setForgetting(false)}>{t("cancel")}</Button>
        </div>
      </Frame>
    );
  }

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

  if (asking === "hello" && helloReady) {
    return (
      <Frame title={t("lock_title", { app: appName })} body={busy ? tHello("waiting") : tHello("prompt")}>
        <div className="space-y-3" data-testid="app-lock-hello">
          <div role="status" aria-live="polite" className="min-h-5 text-sm text-destructive" data-testid="app-lock-message">{message}</div>
          <Button className="w-full" disabled={busy} onClick={() => void withHello()} data-testid="app-lock-hello-again">
            {tHello("use_hello")}
          </Button>
          <Button variant="outline" className="w-full" onClick={usePin} data-testid="app-lock-use-pin">
            {tHello("use_pin")}
          </Button>
        </div>
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
        {helloReady && (
          <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={() => void withHello()} data-testid="app-lock-hello-button">
            {tHello("use_hello")}
          </Button>
        )}
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
        <Button type="button" variant="ghost" className="w-full" onClick={() => setForgetting(true)} data-testid="app-lock-forgot">
          {t("forgot")}
        </Button>
      </form>
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
