/** Same tag as sw.js's OUTBOX_SYNC_TAG. */
const OUTBOX_SYNC_TAG = 'bulwark-outbox';

/**
 * Something went into the outbox: asks the browser to wake the service worker
 * when the network is back, which tells the open tabs to flush. Only a tab
 * can flush (the worker has no login), so this helps a tab that missed the
 * `online` event.
 *
 * Chromium only. Without it, or without a worker (Lite, development), or in
 * Electron, where register rejects, the outbox flushes as it always did.
 */
export function requestOutboxSync(): void {
  void (async () => {
    try {
      if (typeof window === 'undefined' || !('SyncManager' in window) || !navigator.serviceWorker) return;
      const registration = await navigator.serviceWorker.getRegistration();
      const sync = (registration as (ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }) | undefined)?.sync;
      await sync?.register(OUTBOX_SYNC_TAG);
    } catch {
      // Nothing to do: the outbox doesn't depend on this.
    }
  })();
}
