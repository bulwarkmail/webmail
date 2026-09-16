"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/browser-navigation";

const POLL_MS = 5 * 60_000;
const MIN_GAP_MS = 60_000;

/** Fetches the stamp of the build the server is running; null when unknown. */
export async function fetchServerBuildStamp(): Promise<string | null> {
  try {
    const res = await apiFetch("/api/system/build", { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { stamp?: unknown };
    return typeof body.stamp === "string" && body.stamp ? body.stamp : null;
  } catch {
    return null;
  }
}

/**
 * Keeps long-lived tabs on the current build. Bulwark talks to the mail server
 * directly, so a tab can sit on the inbox for days without ever asking Next.js
 * for a page, and never notices a deploy. This polls a build stamp and, when it
 * changes, reloads a hidden tab silently and offers a reload to a visible one.
 */
export function BuildRefresh() {
  const t = useTranslations("build_refresh");
  const own = process.env.NEXT_PUBLIC_BUILD_STAMP || "";
  const [stale, setStale] = useState(false);
  const lastCheck = useRef(0);

  const check = useCallback(async (force = false) => {
    if (!own) return;
    if (!force && Date.now() - lastCheck.current < MIN_GAP_MS) return;
    lastCheck.current = Date.now();
    const server = await fetchServerBuildStamp();
    if (server && server !== own) setStale(true);
  }, [own]);

  useEffect(() => {
    if (!own) return;
    const timer = setInterval(() => { void check(); }, POLL_MS);
    const onVisible = () => { if (!document.hidden) void check(); };
    const onOnline = () => { void check(true); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [own, check]);

  useEffect(() => {
    if (!stale) return;
    // A background tab has nobody typing in it: refresh it now so the user comes
    // back to the current build. A visible tab keeps its state and gets a banner.
    if (document.hidden) { window.location.reload(); return; }
    const onHidden = () => { if (document.hidden) window.location.reload(); };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [stale]);

  if (!stale) return null;
  return (
    <div role="status" className="fixed inset-x-0 top-0 z-[80] flex items-center justify-center gap-3 border-b border-border bg-background/95 px-4 py-2 text-sm shadow-md backdrop-blur">
      <span>{t("title")}</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-primary-foreground hover:bg-primary/90"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        {t("reload")}
      </button>
    </div>
  );
}
