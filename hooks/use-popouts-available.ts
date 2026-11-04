"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useAuthStore } from "@/stores/auth-store";
import { resolveEmailBlobContext } from "@/stores/email-store";
import { toast } from "@/stores/toast-store";
import type { Email } from "@/lib/jmap/types";
import { openMessageWindow } from "@/lib/popout/open";
import { composerPopoutsAvailable, popoutsAvailable } from "@/lib/popout/support";
import { isPopoutWindow } from "@/lib/popout/window-role";

/**
 * Whether to offer "Open in new window" here: for a composer, the default,
 * also in a browser tab on a computer; for a message only in an installed or
 * the desktop app. False on the server and in the first render, so the
 * markup hydrates the same; false in the demo, whose client has no session to
 * share, and inside a pop-out (for a message: it is already in its own window).
 * The main window's side of pop-outs (PopoutHost) runs wherever a composer can
 * move out.
 */
export function usePopoutsAvailable(kind: "compose" | "message" = "compose"): boolean {
  const isDemoMode = useAuthStore((s) => s.isDemoMode);
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const check = () => setAvailable((kind === "message" ? popoutsAvailable() : composerPopoutsAvailable()) && !isPopoutWindow());
    check();
    // Installing the running tab turns it into a window without a reload.
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(display-mode: standalone)");
    media.addEventListener?.("change", check);
    return () => media.removeEventListener?.("change", check);
  }, [kind]);
  return available && !isDemoMode;
}

/**
 * Opens a message in its own window, through the login and the account it was
 * read in. Null when that isn't on offer here. Says so when the browser
 * blocks the window; nothing else changes then.
 */
export function useOpenEmailInWindow(): ((email: Email) => void) | null {
  const available = usePopoutsAvailable("message");
  const t = useTranslations("pwaWindows");
  const open = useCallback((email: Email) => {
    const auth = useAuthStore.getState();
    const source = resolveEmailBlobContext(email, auth.client);
    const opened = openMessageWindow({
      emailId: email.id,
      localAccountId: source.clientAccountId ?? auth.activeAccountId,
      ownerAccountId: source.accountId,
    });
    if (!opened) toast.error(t("popup_blocked"));
  }, [t]);
  return available ? open : null;
}
