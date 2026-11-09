/**
 * Registering the service worker (public/sw.js), once per page, and waiting
 * for it to be active.
 *
 * components/service-worker-registration.tsx registers it on every page: at
 * once when a worker already serves the page or this browser keeps accounts,
 * after the first screen on a first visit. Offline mode can't wait for that:
 * turning it on registers the worker now and waits for it (activeServiceWorker),
 * so the app shell is kept before the switch says it's on.
 */

import { adoptWaitingWorker, announceBuildToServiceWorker, serviceWorkerUrl, SW_SCOPE } from '@/lib/app-update';

/** Kept on the window: a page's state, never the server's. */
const KEY = '__bulwarkSwRegistering';

type Win = Window & { [KEY]?: Promise<ServiceWorkerRegistration | null> };

function supported(): boolean {
  return typeof window !== 'undefined' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/** Registers the worker, once per page; null where there are none or it failed. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return Promise.resolve(null);
  const w = window as Win;
  const pending = w[KEY];
  if (pending) return pending;
  const started = navigator.serviceWorker
    .register(serviceWorkerUrl(), { scope: SW_SCOPE })
    .then((registration) => {
      console.log('Service Worker registered successfully:', registration);
      announceBuildToServiceWorker();
      adoptWaitingWorker(registration);
      return registration;
    })
    .catch((error) => {
      console.error('Service Worker registration failed:', error);
      // A later call may try again.
      delete w[KEY];
      return null;
    });
  w[KEY] = started;
  return started;
}

/** Whether this page has asked for the worker yet (tests). */
export function serviceWorkerRegistrationStarted(): boolean {
  return supported() && !!(window as Win)[KEY];
}

/**
 * The page's active worker, registering it first when this page hasn't, and
 * waiting up to `timeoutMs` for it to install and take over. Null without
 * one by then.
 */
export async function activeServiceWorker(timeoutMs = 20_000): Promise<ServiceWorker | null> {
  if (!supported()) return null;
  try {
    const existing = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    if (existing?.active) return existing.active;
  } catch {
    // Asked below.
  }
  const registration = await registerServiceWorker();
  if (!registration) return null;
  if (registration.active) return registration.active;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = await Promise.race([
    navigator.serviceWorker.ready.then((r) => r.active ?? null).catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
  ]);
  clearTimeout(timer);
  return ready ?? registration.active ?? null;
}
