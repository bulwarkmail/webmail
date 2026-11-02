/**
 * The app shell for offline mode (#523): tells the service worker
 * (public/sw.js) to keep this build's pages and files while any account
 * keeps mail on this device, and to drop them when none does.
 */

import { apiFetch, withBasePath } from '@/lib/browser-navigation';
import { currentBuildId, SW_SCOPE } from '@/lib/app-update';

/** The app's pages kept for a start without the network. */
const SHELL_PAGES = ['/', '/mail', '/settings'];

/**
 * The files of this tab's build. After a deploy the server lists the new
 * build's files: nothing then, rather than another build's files under this
 * build's name.
 */
export async function shellFiles(): Promise<string[]> {
  try {
    const res = await apiFetch('/api/offline/shell', { cache: 'no-store' });
    if (!res.ok) return [];
    const data = (await res.json()) as { files?: unknown; buildId?: unknown };
    if (data.buildId !== currentBuildId()) return [];
    return Array.isArray(data.files) ? data.files.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

async function activeWorker(): Promise<ServiceWorker | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    return registration?.active ?? navigator.serviceWorker.controller ?? null;
  } catch {
    return null;
  }
}

export async function tellServiceWorker(on: boolean): Promise<void> {
  const worker = await activeWorker();
  if (!worker) return;
  const files = on ? await shellFiles() : [];
  // Without this build's files (a deploy happened), not its pages either:
  // they would be the new build's.
  const urls = on && files.length > 0 ? [...SHELL_PAGES.map((p) => withBasePath(p)), ...files] : [];
  worker.postMessage({ type: 'offline-shell', on, urls, buildId: currentBuildId() });
}

/** The service worker's copies of the shell, from the page (also when no worker runs). */
export async function deleteShellCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('bulwark-shell-')).map((key) => caches.delete(key)));
  } catch {
    /* no Cache API */
  }
}
