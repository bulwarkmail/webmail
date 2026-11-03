/**
 * What the local store and the OS integration say to each other, with nothing imported
 * either way: lib/offline runs in every browser, and the notification code pulls in half
 * the app's stores.
 */

import type { IJMAPClient } from '@/lib/jmap/client-interface';

type Handler = () => void;
type CreatedListener = (client: IJMAPClient, accountId: string, ids: readonly string[]) => void;

const wakeHandlers = new Set<Handler>();
const sleepHandlers = new Set<Handler>();
let createdListener: CreatedListener | null = null;

export function addWakeHandler(handler: Handler): () => void {
  wakeHandlers.add(handler);
  return () => {
    wakeHandlers.delete(handler);
  };
}

export function addSleepHandler(handler: Handler): () => void {
  sleepHandlers.add(handler);
  return () => {
    sleepHandlers.delete(handler);
  };
}

function runAll(handlers: Set<Handler>): void {
  for (const handler of [...handlers]) {
    try {
      handler();
    } catch (error) {
      console.error('A wake or sleep handler failed:', error);
    }
  }
}

export function runWakeHandlers(): void {
  runAll(wakeHandlers);
}

export function runSleepHandlers(): void {
  runAll(sleepHandlers);
}

/** The notification path, while it runs. */
export function setStoreCreatedListener(listener: CreatedListener | null): void {
  createdListener = listener;
}

/** The store's `created` event for mail. Does nothing in a browser or a pop-out. */
export function reportStoreCreatedMail(client: IJMAPClient, accountId: string, ids: readonly string[]): void {
  createdListener?.(client, accountId, ids);
}
