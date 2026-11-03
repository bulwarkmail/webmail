"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { useConfig } from "@/hooks/use-config";
import { productName } from "@/lib/product-name";
import { isChunkLoadFailure, newerBuildId, reloadToNewBuild } from "@/lib/app-update";
import { toast, useToastStore } from "@/stores/toast-store";

/** How often an open tab asks whether a new build was deployed. */
export const UPDATE_CHECK_MS = 15 * 60 * 1000;
/** Focus and tab switches ask at most this often. */
const FOCUS_THROTTLE_MS = 60 * 1000;

/**
 * "A new version of Bulwark is ready. Reload" (#523): once the server runs
 * another build than this tab, on focus, every 15 minutes, and right away
 * when a chunk of this tab's build fails to load (it is gone after a
 * deploy). Shown once per new build; with offline mode off as well as on.
 */
export function AppUpdatePrompt() {
  const t = useTranslations("app_update");
  const appName = productName(useConfig().appName);
  const text = useRef({ ready: "", reload: "" });
  text.current = { ready: t("ready", { appName }), reload: t("reload") };

  useEffect(() => {
    let shownFor: string | null = null;
    let toastId: string | null = null;
    let lastCheck = 0;
    let checking = false;
    const check = async (force: boolean) => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden" && !force) return;
      const now = Date.now();
      if (checking || (!force && now - lastCheck < FOCUS_THROTTLE_MS)) return;
      checking = true;
      lastCheck = now;
      try {
        const id = await newerBuildId();
        if (!id || id === shownFor) return;
        shownFor = id;
        // Reload loads whatever build is newest, so a toast for an older one
        // still does the job. One per tab, however many builds go out.
        if (toastId && useToastStore.getState().toasts.some((t) => t.id === toastId)) return;
        toastId = toast.info(text.current.ready, {
          duration: 0,
          action: { label: text.current.reload, onClick: () => { void reloadToNewBuild(); } },
        });
      } finally {
        checking = false;
      }
    };
    const onFocus = () => { void check(false); };
    const onLoadFailure = (event: Event) => {
      if (isChunkLoadFailure(event)) void check(true);
    };
    lastCheck = Date.now();
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    window.addEventListener("error", onLoadFailure, true);
    window.addEventListener("unhandledrejection", onLoadFailure);
    const interval = setInterval(() => { void check(true); }, UPDATE_CHECK_MS);
    return () => {
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("error", onLoadFailure, true);
      window.removeEventListener("unhandledrejection", onLoadFailure);
      clearInterval(interval);
    };
  }, []);

  return null;
}
