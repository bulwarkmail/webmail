import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * What survives a kill lives in IndexedDB, which the other tests don't have: they run on
 * the fallback in memory. A fresh module here is what a restart of the app sees.
 */

const fresh = async () => {
  vi.resetModules();
  return { store: await import('@/lib/mail-import/checkpoints'), dedupe: await import('@/lib/mail-import/dedupe') };
};

const checkpoint = (key: string, scope = 'a') => ({ key, scope, fileName: 'f', done: 3, imported: 3, updatedAt: Date.now() });

beforeEach(async () => {
  const { store } = await fresh();
  await store.clearAllCheckpoints();
});

describe('what an import keeps on disk', () => {
  it('what was imported is still known after a restart, with nothing in memory', async () => {
    const before = await fresh();
    await before.dedupe.localDedupe('a', 'acc').add(['k1']);
    expect(before.store.seenInMemory.size).toBe(0);
    const after = await fresh();
    expect(await after.dedupe.localDedupe('a', 'acc').has('k1')).toBe(true);
    expect(await after.dedupe.localDedupe('a', 'acc').has('k2')).toBe(false);
  });

  it('the job is still there after a restart, and gone once forgotten', async () => {
    const before = await fresh();
    await before.store.writeStoredJob({ id: 'job' });
    const after = await fresh();
    expect(await after.store.readStoredJob()).toEqual({ id: 'job' });
    await after.store.writeStoredJob(null);
    expect(await (await fresh()).store.readStoredJob()).toBeNull();
  });

  it('a sign-out takes that account\'s checkpoints and what it imported, and leaves the others', async () => {
    const { store, dedupe } = await fresh();
    await store.writeCheckpoint(checkpoint('ca', 'a'));
    await store.writeCheckpoint(checkpoint('cb', 'b'));
    await dedupe.localDedupe('a', 'acc').add(['seen-a']);
    await dedupe.localDedupe('b', 'acc').add(['seen-b']);
    await store.clearCheckpointsFor('a');
    expect(await store.readCheckpoint('ca')).toBeNull();
    expect(await store.readCheckpoint('cb')).not.toBeNull();
    expect(await dedupe.localDedupe('a', 'acc').has('seen-a')).toBe(false);
    expect(await dedupe.localDedupe('b', 'acc').has('seen-b')).toBe(true);
  });

  it('signing everyone out takes the job along', async () => {
    const { store } = await fresh();
    await store.writeStoredJob({ id: 'job' });
    await store.clearAllCheckpoints();
    expect(await (await fresh()).store.readStoredJob()).toBeNull();
  });

  it('a database from before this version keeps its checkpoints', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('bulwark-mail-import', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('checkpoints', { keyPath: 'key' }).createIndex('scope', 'scope');
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('checkpoints', 'readwrite');
        tx.objectStore('checkpoints').put(checkpoint('old'));
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
      request.onerror = () => reject(request.error);
    });
    const { store, dedupe } = await fresh();
    expect(await store.readCheckpoint('old')).not.toBeNull();
    await dedupe.localDedupe('a', 'acc').add(['k']);
    expect(await dedupe.localDedupe('a', 'acc').has('k')).toBe(true);
    // On disk: the new store exists. Without the upgrade this lands in the memory fallback.
    expect(store.seenInMemory.size).toBe(0);
  });
});
