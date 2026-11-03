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
  const item = (text: string) => ({ data: new Blob([text]), size: text.length });

  it('what was imported is still known after a restart, with nothing in memory', async () => {
    const before = await fresh();
    const dedupe = before.dedupe.localDedupe('a', 'acc');
    const { key } = await dedupe.check(item('Subject: one\r\n\r\nx'), 'inbox');
    await dedupe.add([key]);
    expect(before.store.seenInMemory.size).toBe(0);
    const after = await fresh();
    const again = after.dedupe.localDedupe('a', 'acc');
    expect(await again.check(item('Subject: one\r\n\r\nx'), 'inbox')).toEqual({ key, seen: true });
    expect((await again.check(item('Subject: two\r\n\r\nx'), 'inbox')).seen).toBe(false);
  });

  it('the job is still there after a restart, per account, and gone once forgotten', async () => {
    const before = await fresh();
    await before.store.writeStoredJob('a', { id: 'job-a' });
    await before.store.writeStoredJob('b', { id: 'job-b' });
    const after = await fresh();
    expect(await after.store.readStoredJob('a')).toEqual({ id: 'job-a' });
    expect(await after.store.readStoredJob('b')).toEqual({ id: 'job-b' });
    await after.store.writeStoredJob('a', null);
    const later = await fresh();
    expect(await later.store.readStoredJob('a')).toBeNull();
    expect(await later.store.readStoredJob('b')).toEqual({ id: 'job-b' });
  });

  it('a sign-out takes that account\'s checkpoints and what it imported, and leaves the others', async () => {
    const { store, dedupe } = await fresh();
    await store.writeCheckpoint(checkpoint('ca', 'a'));
    await store.writeCheckpoint(checkpoint('cb', 'b'));
    const a = dedupe.localDedupe('a', 'acc');
    const b = dedupe.localDedupe('b', 'acc');
    const mail = () => item('Subject: x\r\n\r\ny');
    await a.add([(await a.check(mail(), 'inbox')).key]);
    await b.add([(await b.check(mail(), 'inbox')).key]);
    await store.clearCheckpointsFor('a');
    expect(await store.readCheckpoint('ca')).toBeNull();
    expect(await store.readCheckpoint('cb')).not.toBeNull();
    expect((await a.check(mail(), 'inbox')).seen).toBe(false);
    expect((await b.check(mail(), 'inbox')).seen).toBe(true);
  });

  it('signing everyone out takes the job along', async () => {
    const { store } = await fresh();
    await store.writeStoredJob('a', { id: 'job' });
    await store.clearAllCheckpoints();
    expect(await (await fresh()).store.readStoredJob('a')).toBeNull();
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
    const remember = dedupe.localDedupe('a', 'acc');
    const { key } = await remember.check(item('Subject: x\r\n\r\ny'), 'inbox');
    await remember.add([key]);
    expect((await remember.check(item('Subject: x\r\n\r\ny'), 'inbox')).seen).toBe(true);
    // On disk: the new store exists. Without the upgrade this lands in the memory fallback.
    expect(store.seenInMemory.size).toBe(0);
  });
});
