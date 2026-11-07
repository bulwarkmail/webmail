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

/**
 * Loads and runs the mail view's code now, once. Called when the sign-in
 * starts: a first visit opens the sign-in page without the mail view
 * (lib/signed-out-start.ts), so its code would otherwise first run after the
 * sign-in, on the way to the first rows. Started with the sign-in, it runs
 * while the browser waits for the server.
 */
export function warmMailView(): void {
  if (warming) return;
  warming = import("@/components/mail/mail-app").catch(() => {
    warming = null;
  });
}
