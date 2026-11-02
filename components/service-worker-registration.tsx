"use client";

import { useEffect } from "react";
import { IS_LITE } from "@/lib/lite";
import { adoptWaitingWorker, announceBuildToServiceWorker, serviceWorkerUrl, SW_SCOPE } from "@/lib/app-update";

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
    // A worker that takes over later (after a deploy) learns this tab's build too.
    const onControllerChange = () => announceBuildToServiceWorker();
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    return () => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
  }, []);

  return null;
}
