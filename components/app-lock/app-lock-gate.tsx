"use client";

import { Activity, use, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { LockScreen } from "./lock-screen";
import { appLockHold, bootAppLock, getAppLockPhase, recheckAppLockSetup, startAppLock, subscribeAppLockPhase, takeDraftsSavedNotice, type AppLockPhase } from "@/lib/app-lock/controller";
import { IS_LITE } from "@/lib/lite";
import { useAccountStore } from "@/stores/account-store";
import { toast } from "@/stores/toast-store";
import { useTranslations } from "next-intl";

const serverPhase = (): AppLockPhase => "open";
const neverChanges = () => () => {};
const onClient = () => true;
const inServerMarkup = () => false;

/**
 * The app below the gate. While the lock holds, the first render suspends, and that keeps
 * the server's markup inert: nothing below hydrates, so no effect runs, no store fills and
 * no plugin frame starts, until someone unlocks in this same document. The server's markup
 * is the empty skeleton, never mail.
 *
 * Once it has hydrated there's no boundary left to suspend into, and suspending would stop
 * the lock screen from showing too. A hold that comes that late takes the app away instead.
 */
function Held({ children }: { children: React.ReactNode }) {
  const phase = useSyncExternalStore(subscribeAppLockPhase, getAppLockPhase, serverPhase);
  const hydrated = useSyncExternalStore(neverChanges, onClient, inServerMarkup);
  if (typeof window !== "undefined") {
    bootAppLock();
    const hold = appLockHold();
    if (hold) {
      if (!hydrated) use(hold);
      return null;
    }
  }
  return phase === "locked-stay" ? null : children;
}

/**
 * Above everything that touches mail, and in every window: main, pop-outs, composers.
 *
 * Activity and not Suspense around the app: both can stay dehydrated while something
 * inside suspends, but React moves a big Suspense boundary out of the shell, even a
 * finished one. The whole app would come as a hidden segment that a script reveals, a
 * frame or up to 300 ms later, and the page has no skeleton until then. For everyone,
 * lock or no lock. An Activity's markup stays where it is
 * (scripts/boot-skeleton-guard checks the bytes).
 *
 * The phase lives in the two components below this one and not here: new props on a
 * dehydrated boundary would make React give up on it and throw the server's markup away.
 */
export function AppLockGate({ children }: { children: React.ReactNode }) {
  if (IS_LITE) return <>{children}</>;

  return (
    <>
      <Activity mode="visible">
        <Held>{children}</Held>
      </Activity>
      <LockLayer />
    </>
  );
}

/** The lock's life in this tab, and its screen. Hydrates with the page's shell, whatever Held does. */
function LockLayer() {
  const phase = useSyncExternalStore(subscribeAppLockPhase, getAppLockPhase, serverPhase);
  const t = useTranslations("appLock");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return startAppLock();
  }, []);

  // Signing in while an organisation requires the lock: it's due now.
  useEffect(() => {
    recheckAppLockSetup();
    return useAccountStore.subscribe(recheckAppLockSetup);
  }, []);

  useEffect(() => {
    if (phase === "open" && takeDraftsSavedNotice()) toast.info(t("draft_saved_notice"));
  }, [phase, t]);

  if (!mounted || phase === "open" || phase === "checking") return null;
  return createPortal(<LockScreen phase={phase} />, document.body);
}
