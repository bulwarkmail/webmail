/** The store's events, for the parts of the page that aren't offline mode itself. */

import type { StoreEvent } from '@/lib/store/area';

type Listener = (event: StoreEvent) => void;

const listeners = new Set<Listener>();

export function addStoreEventListener(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitStoreEvent(event: StoreEvent): void {
  for (const listener of [...listeners]) listener(event);
}
