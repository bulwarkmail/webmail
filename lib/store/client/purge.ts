/**
 * Deletes the local store from the page: the keys and the OPFS pool, with no
 * worker running and no wasm loaded, also on the sign-in page. Imports nothing
 * heavy, because lib/sign-out-cleanup.ts is in every page's bundle.
 */

import { OWNER_LOCK, POOL_DIRECTORY, RPC_CHANNEL, type ChannelMessage } from '../worker/protocol';
import { deleteKeyDatabase, STORE_OPENED_KEY } from './keys';

/** A worker just stopped may hold the files for a moment longer. */
const REMOVE_TRIES = 10;
const REMOVE_WAIT_MS = 200;
/** A sign-out doesn't wait for a tab that never lets go of the owner lock. */
const POOL_LOCK_WAIT_MS = 5_000;

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
  if (!navigator.locks) {
    await removePool();
    return;
  }
  try {
    await navigator.locks.request(OWNER_LOCK, { signal: AbortSignal.timeout(POOL_LOCK_WAIT_MS) }, removePool);
  } catch (error) {
    if ((error as Error)?.name !== 'TimeoutError' && (error as Error)?.name !== 'AbortError') throw error;
    // A tab that won't let go, stuck or asleep: the app has no key any more, so what
    // can be deleted goes now, and what it still holds goes at the next open.
    await removePool();
  }
}

/**
 * Forgets every key first, so the app can't read the files even if deleting them
 * fails, then has every tab stop its worker and deletes the files. The files going is
 * what counts against a copy of the disk: the browser's own files can hold a forgotten key
 * for a while (see keys.ts). A slot that couldn't be deleted goes at the next open.
 * Started synchronously: the sign-out may navigate away right after.
 */
export function purgeStoreFiles(): Promise<void> {
  const keysGone = deleteKeyDatabase();
  // Deleted on purpose: no account lost anything. The next open is a first one.
  try {
    localStorage.removeItem(STORE_OPENED_KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
  try {
    const channel = new BroadcastChannel(RPC_CHANNEL);
    channel.postMessage({ kind: 'shutdown' } satisfies ChannelMessage);
    channel.close();
  } catch {
    // No BroadcastChannel: no store either.
  }
  const poolGone = deleteStorePool().catch(() => {
    // The app has no key for what's left, and the next open deletes it.
  });
  return Promise.all([keysGone, poolGone]).then(() => undefined);
}
