/**
 * Noticing a deploy in a tab that stays open (#523). Every build has an id
 * (next.config.ts BULWARK_BUILD_ID; Lite: NEXT_PUBLIC_LITE_BUILD_ID). The
 * server says which build it runs now (/api/version; Lite: lite-build.json),
 * and a tab whose own build differs offers a reload
 * (components/app-update-prompt.tsx).
 *
 * The service worker is registered as sw.js?v=<build id>, so a deploy also
 * installs a new worker, which keeps its caches apart from the old build's
 * (public/sw.js).
 */

import { apiFetch } from '@/lib/browser-navigation';
import { IS_LITE, LITE_BUILD_ID } from '@/lib/lite';

/** The build this tab runs; empty where there is none (tests). */
export function currentBuildId(): string {
  return (IS_LITE ? LITE_BUILD_ID : process.env.NEXT_PUBLIC_BUILD_ID) ?? '';
}

const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

/** Where the service worker is registered, with this build's id. */
export const SW_SCOPE = `${BASE_PATH}/`;

export function serviceWorkerUrl(): string {
  const id = currentBuildId();
  return `${BASE_PATH}/sw.js${id ? `?v=${encodeURIComponent(id)}` : ''}`;
}

/** The build the server serves now, or null when it can't be asked (offline, an old server). */
export async function fetchDeployedBuildId(): Promise<string | null> {
  try {
    // lite-build.json is a static file, possibly behind an immutable cache:
    // a fresh query string gets past every cache on the way.
    const res = IS_LITE
      ? await apiFetch(`/lite-build.json?t=${Date.now()}`, { cache: 'no-store' })
      : await apiFetch('/api/version', { cache: 'no-store' });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const id = data && typeof data === 'object' ? (data as { buildId?: unknown }).buildId : null;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/** The id of a newer build than this tab's, when the server runs one. */
export async function newerBuildId(): Promise<string | null> {
  const current = currentBuildId();
  if (!current) return null;
  const deployed = await fetchDeployedBuildId();
  return deployed && deployed !== current ? deployed : null;
}

/**
 * Loads the new build. A new service worker that waits for the old build's
 * tabs to close (it does while offline mode keeps the old build's files) is
 * told to take over first, so the reload isn't answered by the old worker.
 */
export async function reloadToNewBuild(): Promise<void> {
  try {
    const registration = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
      ? await navigator.serviceWorker.getRegistration(SW_SCOPE)
      : undefined;
    const waiting = registration?.waiting;
    if (waiting) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(); }, { once: true });
        waiting.postMessage({ type: 'skip-waiting' });
      });
    }
  } catch {
    // Reload anyway: the network answers.
  }
  window.location.reload();
}

/**
 * A worker of this tab's own build that waits (offline mode on, so it
 * doesn't take over while tabs of the old build are open): this tab runs
 * that build already, so it takes over now. Tabs of the old build keep
 * their files: the old build's cache stays until the last of them closes,
 * and the new worker answers chunks from every build's cache.
 */
export function adoptWaitingWorker(registration: ServiceWorkerRegistration): void {
  const id = currentBuildId();
  if (!id) return;
  const ours = (worker: ServiceWorker | null | undefined) => !!worker && new URL(worker.scriptURL).searchParams.get('v') === id;
  const adopt = () => {
    if (ours(registration.waiting)) registration.waiting!.postMessage({ type: 'skip-waiting' });
  };
  const watch = (worker: ServiceWorker | null) => {
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed') adopt();
    });
  };
  adopt();
  // Still installing when the registration resolved, or installed later.
  watch(registration.installing);
  registration.addEventListener('updatefound', () => watch(registration.installing));
}

/** Tells the service worker which build this tab runs, so it keeps that build's files while the tab is open. */
export function announceBuildToServiceWorker(): void {
  const id = currentBuildId();
  if (!id || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.ready
    .then((registration) => {
      (navigator.serviceWorker.controller ?? registration.active)?.postMessage({ type: 'client-build', buildId: id });
    })
    .catch(() => {});
}

/** Whether a failed script or chunk load says this tab's build is gone from the server. */
export function isChunkLoadFailure(event: Event | PromiseRejectionEvent): boolean {
  if ('reason' in event) {
    const reason = event.reason as { name?: unknown; message?: unknown } | null;
    const name = typeof reason?.name === 'string' ? reason.name : '';
    const message = typeof reason?.message === 'string' ? reason.message : '';
    return name === 'ChunkLoadError' || /Loading chunk [\w-]+ failed|Failed to load chunk|error loading dynamically imported module|Importing a module script failed/i.test(message);
  }
  const target = event.target as { tagName?: unknown; src?: unknown; href?: unknown } | null;
  if (!target || (target.tagName !== 'SCRIPT' && target.tagName !== 'LINK')) return false;
  const url = typeof target.src === 'string' && target.src ? target.src : typeof target.href === 'string' ? target.href : '';
  return url.includes('/_next/static/');
}
