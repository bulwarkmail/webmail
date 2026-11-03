"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useConfig } from "@/hooks/use-config";
import { useAuthStore, SHARED_SESSION_ENDED_EVENT } from "@/stores/auth-store";
import { withBasePath } from "@/lib/browser-navigation";
import { flushComposers } from "@/lib/compose-flush-registry";
import { openPopoutChannel, requestWindowSession } from "@/lib/popout/channel";
import { closePopoutWindow } from "@/lib/popout/window-role";
import { onSignedOutElsewhere } from "@/lib/sign-out-cleanup";

/** How long a closing pop-out waits for its composer to save, when the account went away elsewhere. */
const CLOSE_FLUSH_MS = 3000;
/** How long it waits to hear that another window still holds the login. */
const STILL_HELD_MS = 800;

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

  // The session ended elsewhere: save what can be saved, and go. A composer
  // whose text didn't make it stays, as the only place that text still is.
  const endSession = useCallback(async () => {
    const flushed = await flushComposers(CLOSE_FLUSH_MS);
    if (kind === "compose" && (flushed.failed > 0 || flushed.timedOut)) setStatus("no-session");
    else closePopoutWindow();
  }, [kind]);

  useEffect(() => {
    const channel = openPopoutChannel((message) => {
      const active = useAuthStore.getState().activeAccountId;
      if (message.type !== "account-removed" || message.accountId !== active) return;
      // One tab dropping a login it couldn't restore says nothing about the
      // tab that is signed in with it.
      void requestWindowSession({ accountId: active }, STILL_HELD_MS).then((held) => {
        if (!held?.sessions.some((session) => session.accountId === active)) void endSession();
      });
    });
    const stopSignOut = onSignedOutElsewhere(() => void endSession());
    return () => {
      channel?.close();
      stopSignOut();
    };
  }, [endSession]);

  // The session can't be renewed and no main window is left to do it. A
  // message stops showing; a composer stays, its text still worth copying.
  useEffect(() => {
    const onEnded = () => setStatus("no-session");
    window.addEventListener(SHARED_SESSION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SHARED_SESSION_ENDED_EVENT, onEnded);
  }, []);

  const actions = (
    <>
      <Button onClick={() => window.location.replace(withBasePath("/"))}>{t("open_app")}</Button>
      <Button variant="ghost" onClick={closePopoutWindow}>{t("close_window")}</Button>
    </>
  );

  return (
    <div data-popout-window={kind} data-popout-status={status} className="flex h-dvh flex-col overflow-hidden bg-background pt-[var(--app-top-inset)]">
      {status === "loading" && <PopoutSkeleton label={t("opening")} />}
      {status === "no-session" && kind === "message" && (
        <PopoutNotice title={t("session_ended_title")} body={t("session_ended_body")}>{actions}</PopoutNotice>
      )}
      {status === "no-session" && kind === "compose" && (
        <div role="alert" data-popout-session-ended="" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted px-4 py-2 text-sm text-foreground">
          <span className="min-w-0 flex-1">{t("session_ended_title")}. {t("session_ended_body")}</span>
          {actions}
        </div>
      )}
      {/* One place in the tree, so a composer stays mounted, text and all, when the session ends. */}
      {(status === "ready" || (status === "no-session" && kind === "compose")) && children}
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
