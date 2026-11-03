"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useConfig } from "@/hooks/use-config";
import { useAuthStore, SHARED_SESSION_ENDED_EVENT } from "@/stores/auth-store";
import { toast } from "@/stores/toast-store";
import { withBasePath } from "@/lib/browser-navigation";
import { flushComposers } from "@/lib/compose-flush-registry";
import { openPopoutChannel } from "@/lib/popout/channel";
import { closePopoutWindow } from "@/lib/popout/window-role";

/** How long a closing pop-out waits for its composer to save, when the account went away elsewhere. */
const CLOSE_FLUSH_MS = 3000;

/** The session gate and page frame of a pop-out window. Takes the session from the main window (lib/popout). */
export function PopoutShell({ kind, accountId, children }: {
  kind: "message" | "compose";
  /** The login to open; left out, the main window's active one. */
  accountId?: string;
  children: React.ReactNode;
}) {
  const t = useTranslations("pwaWindows");
  // Fetches the organisation's policy, which device policies and send rules read.
  useConfig();
  const [status, setStatus] = useState<"loading" | "ready" | "no-session">("loading");

  useEffect(() => {
    let cancelled = false;
    void useAuthStore.getState().startSharedSession({ accountId }).then((result) => {
      if (!cancelled) setStatus(result);
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // The account was signed out in the main window: save what can be saved, and go.
  useEffect(() => {
    const channel = openPopoutChannel((message) => {
      if (message.type !== "account-removed" || message.accountId !== useAuthStore.getState().activeAccountId) return;
      void flushComposers(CLOSE_FLUSH_MS).finally(closePopoutWindow);
    });
    return () => channel?.close();
  }, []);

  // Stays on screen: the text in a composer is still worth copying.
  useEffect(() => {
    const onEnded = () => toast.error(t("session_ended_title"), t("session_ended_body"));
    window.addEventListener(SHARED_SESSION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SHARED_SESSION_ENDED_EVENT, onEnded);
  }, [t]);

  return (
    <div data-popout-window={kind} data-popout-status={status} className="flex h-dvh flex-col overflow-hidden bg-background pt-[var(--app-top-inset)]">
      {status === "ready" ? children : status === "loading" ? (
        <PopoutSkeleton label={t("opening")} />
      ) : (
        <PopoutNotice title={t("session_ended_title")} body={t("session_ended_body")}>
          <Button onClick={() => window.location.replace(withBasePath("/"))}>{t("open_app")}</Button>
          <Button variant="ghost" onClick={closePopoutWindow}>{t("close_window")}</Button>
        </PopoutNotice>
      )}
    </div>
  );
}

export function PopoutSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-1 flex-col gap-4 p-6" data-popout-skeleton="">
      <div className="h-6 w-2/3 rounded bg-muted" />
      <div className="h-4 w-1/3 rounded bg-muted" />
      <div className="mt-4 h-4 w-full rounded bg-muted" />
      <div className="h-4 w-5/6 rounded bg-muted" />
      <div className="h-4 w-4/6 rounded bg-muted" />
    </div>
  );
}

export function PopoutNotice({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-popout-notice="">
      <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      {children && <div className="mt-2 flex items-center gap-2">{children}</div>}
    </div>
  );
}
