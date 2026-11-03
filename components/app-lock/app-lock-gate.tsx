"use client";

import { Suspense, use, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { LockScreen } from "./lock-screen";
import { appLockHold, bootAppLock, getAppLockPhase, recheckAppLockSetup, startAppLock, subscribeAppLockPhase, takeDraftsSavedNotice, type AppLockPhase } from "@/lib/app-lock/controller";
import { IS_LITE } from "@/lib/lite";
import { useAccountStore } from "@/stores/account-store";
import { toast } from "@/stores/toast-store";
import { useTranslations } from "next-intl";

const serverPhase = (): AppLockPhase => "open";

/**
 * Suspends the app below while the lock holds. In the first render of a page that is
 * locked, that keeps the server's markup inert: nothing below hydrates, so no effect runs,
 * no store fills and no plugin frame starts, until someone unlocks in this same document.
 * The server's markup is the empty skeleton, never mail.
 */
function Hold() {
  if (typeof window === "undefined") return null;
  bootAppLock();
  const hold = appLockHold();
  if (hold) use(hold);
  return null;
}

/** Above everything that touches mail, and in every window: main, pop-outs, composers. */
export function AppLockGate({ children }: { children: React.ReactNode }) {
  const phase = useSyncExternalStore(subscribeAppLockPhase, getAppLockPhase, serverPhase);
  const t = useTranslations("appLock");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return startAppLock();
  }, []);

  // Signing in while an organisation requires the lock: it's due now.
  useEffect(() => {
    if (IS_LITE) return;
    recheckAppLockSetup();
    return useAccountStore.subscribe(recheckAppLockSetup);
  }, []);

  useEffect(() => {
    if (phase === "open" && takeDraftsSavedNotice()) toast.info(t("draft_saved_notice"));
  }, [phase, t]);

  if (IS_LITE) return <>{children}</>;

  return (
    <>
      <Suspense fallback={null}>
        <Hold />
        {phase === "locked-stay" ? null : children}
      </Suspense>
      {mounted && phase !== "open" && phase !== "checking" && createPortal(<LockScreen phase={phase} />, document.body)}
    </>
  );
}
