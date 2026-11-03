/**
 * Deletes the local store from the page: the keys and the OPFS pool, with no
 * worker running and no wasm loaded, also on the sign-in page. Imports nothing
 * heavy, because lib/sign-out-cleanup.ts is in every page's bundle.
 */

import { OWNER_LOCK, POOL_DIRECTORY, RPC_CHANNEL, type ChannelMessage } from '../worker/protocol';
import { deleteKeyDatabase } from './keys';

/** A worker just stopped may hold the files for a moment longer. */
const REMOVE_TRIES = 10;
const REMOVE_WAIT_MS = 200;

async function removePool(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await root.removeEntry(POOL_DIRECTORY, { recursive: true });
      return;
    } catch (error) {
      if ((error as Error)?.name === 'NotFoundError') return;
      if (attempt >= REMOVE_TRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, REMOVE_WAIT_MS));
    }
  }
}

/** Deletes the pool folder, holding the owner lock so no worker can take the files meanwhile. */
export async function deleteStorePool(): Promise<void> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') return;
  if (navigator.locks) await navigator.locks.request(OWNER_LOCK, removePool);
  else await removePool();
}

/**
 * Forgets every key first, which makes the files unreadable even if deleting
 * them fails, then has every tab stop its worker and deletes the files.
 * Started synchronously: the sign-out may navigate away right after.
 */
export function purgeStoreFiles(): Promise<void> {
  deleteKeyDatabase();
  try {
    const channel = new BroadcastChannel(RPC_CHANNEL);
    channel.postMessage({ kind: 'shutdown' } satisfies ChannelMessage);
    channel.close();
  } catch {
    // No BroadcastChannel: no store either.
  }
  return deleteStorePool().catch(() => {
    // The key is gone, so what's left can't be read.
  });
}
