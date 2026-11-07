"use client";

import { useEffect } from "react";
import { useRouter } from "@/i18n/navigation";

/**
 * Starts loading the mail view's code while the login form is on screen.
 * Signing in pushes to it, and without this its scripts were only requested
 * once the sign-in had finished, adding their download to every login.
 */
export function usePrefetchMailView(enabled: boolean): void {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    router.prefetch("/");
  }, [enabled, router]);
}

let warming: Promise<unknown> | null = null;

/** How long the form waits for the browser to go idle before the mail view's code runs anyway. */
export const WARM_IDLE_TIMEOUT_MS = 1_000;

/**
 * Runs the mail view's code once the sign-in form is drawn (`formShown`) and
 * the browser is idle. A first visit opens the sign-in page without the mail
 * view (lib/signed-out-start.ts); run after the sign-in, its code held up the
 * way to the first rows, and run while the sign-in request was out it held
 * up each step of it. While the user types, it costs nothing.
 */
export function useWarmMailViewWhenIdle(formShown: boolean): void {
  useEffect(() => {
    if (!formShown || warming) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (!w.requestIdleCallback) {
      const timer = setTimeout(warmMailView, 200);
      return () => clearTimeout(timer);
    }
    const id = w.requestIdleCallback(warmMailView, { timeout: WARM_IDLE_TIMEOUT_MS });
    return () => w.cancelIdleCallback?.(id);
  }, [formShown]);
}

/**
 * Loads and runs the mail view's code now, once (see
 * useWarmMailViewWhenIdle). The sign-in calls it too, for a form sent before
 * the browser went idle.
 */
export function warmMailView(): void {
  if (warming) return;
  warming = import("@/components/mail/mail-app").catch(() => {
    warming = null;
  });
}
