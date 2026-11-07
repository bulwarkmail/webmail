"use client";

import { useEffect } from "react";
import { IS_LITE } from "@/lib/lite";
import { adoptWaitingWorker, announceBuildToServiceWorker, serviceWorkerUrl, SW_SCOPE } from "@/lib/app-update";

/** How long after the page's start a first worker install waits at least. */
export const FIRST_INSTALL_DELAY_MS = 4000;

/**
 * Runs `fn` once the page has loaded, FIRST_INSTALL_DELAY_MS after its start
 * and when the browser is idle (or 2 s later). Returns a cancel function.
 */
function afterFirstScreen(fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  let done = false;
  const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  const schedule = () => {
    timer = setTimeout(() => {
      if (w.requestIdleCallback) idle = w.requestIdleCallback(run, { timeout: 2000 });
      else run();
    }, Math.max(0, FIRST_INSTALL_DELAY_MS - performance.now()));
  };
  if (document.readyState === "complete") schedule();
  else window.addEventListener("load", schedule, { once: true });
  return () => {
    done = true;
    window.removeEventListener("load", schedule);
    if (timer !== undefined) clearTimeout(timer);
    if (idle !== undefined) w.cancelIdleCallback?.(idle);
  };
}

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    // sw.js enriches push notifications through /api/push/preview and serves
    // icons from /api/pwa-icon; neither exists in the static build. Push stays
    // off in Lite v1, so the worker is not registered at all.
    if (IS_LITE) {
      return;
    }

    if (process.env.NODE_ENV !== "production") {
      // In development, unregister any previously installed service worker
      // and clear its caches so hot reload always serves fresh assets.
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        registrations.forEach((registration) => registration.unregister());
      });
      if ("caches" in window) {
        caches.keys().then((keys) => {
          keys.forEach((key) => caches.delete(key));
        });
      }
      return;
    }

    // With this build's id in the URL, a deploy installs a new worker, which
    // keeps its caches apart from the old build's (public/sw.js).
    const register = () => {
      navigator.serviceWorker
        .register(serviceWorkerUrl(), { scope: SW_SCOPE })
        .then((registration) => {
          console.log("Service Worker registered successfully:", registration);
          announceBuildToServiceWorker();
          adoptWaitingWorker(registration);
        })
        .catch((error) => {
          console.error("Service Worker registration failed:", error);
        });
    };
    // A worker that takes over later (after a deploy) learns this tab's build too.
    const onControllerChange = () => announceBuildToServiceWorker();
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    const cleanup = () => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    // A page a worker already serves registers at once (that's the update
    // check). Without one, a first visit, installing it waits until the first
    // screen is up: once it takes over, every request of the page goes
    // through it, and its own download and start compete with the page's.
    if (navigator.serviceWorker.controller) {
      register();
      return cleanup;
    }
    const cancel = afterFirstScreen(register);
    return () => {
      cancel();
      cleanup();
    };
  }, []);

  return null;
}
