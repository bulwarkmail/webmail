// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCOPE } from '../area';
import { mailArea } from '../mail';
import type { StorageAdapter } from '../storage';
import { StoreHost, type HostStorage } from '../worker/host';
import { FAKE_SESSION } from './helpers/fake-jmap';
import { openMemoryStore } from './helpers/node-adapter';

const KEY = 'a'.repeat(64);

function keyError(): Error {
  const error = new Error('The local store could not be opened with this key');
  error.name = 'StoreKeyError';
  return error;
}

class FakeStorage implements HostStorage {
  readonly dbs = new Map<string, StorageAdapter>();
  failNext: Error | null = null;
  removed: string[] = [];
  files(): string[] {
    return [...this.dbs.keys()];
  }
  async open(file: string): Promise<StorageAdapter> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    let db = this.dbs.get(file);
    if (!db) {
      db = openMemoryStore();
      this.dbs.set(file, db);
    }
    // The host closes a database; the "file" stays for the next open.
    return { ...db, exec: db.exec.bind(db), run: db.run.bind(db), all: db.all.bind(db), get: db.get.bind(db), transaction: db.transaction.bind(db), close() {} };
  }
  remove(file: string): boolean {
    this.removed.push(file);
    this.dbs.delete(`${file}-journal`);
    return this.dbs.delete(file);
  }
}

function host(storage: FakeStorage): StoreHost {
  return new StoreHost({ areas: [mailArea], storage, emit: () => {}, needAuth: () => {} });
}

const params = (file: string, session: unknown = FAKE_SESSION, account = 'a') => ({
  account, file, keyHex: KEY, session, scope: DEFAULT_SCOPE, invertedKeywordSort: null, auth: null,
}) as Parameters<StoreHost['openAccount']>[0];

describe('opening an account', () => {
  it('says whether its file was there', async () => {
    const storage = new FakeStorage();
    const first = host(storage);
    expect(await first.openAccount(params('/a1.db'))).toEqual({ fileExisted: false });
    expect(await first.openAccount(params('/a1.db'))).toEqual({ fileExisted: true });
    await first.closeAll();
    expect(await host(storage).openAccount(params('/a1.db'))).toEqual({ fileExisted: true });
  });

  it('makes no empty file while it has no session, so the next open can still tell', async () => {
    const storage = new FakeStorage();
    await expect(host(storage).openAccount(params('/a1.db', null))).rejects.toThrow('No session');
    expect(storage.files()).toEqual([]);
    expect(await host(storage).openAccount(params('/a1.db'))).toEqual({ fileExisted: false });
  });

  it('starts over from a file its key can\'t read, and says the file is gone', async () => {
    const storage = new FakeStorage();
    storage.dbs.set('/a1.db', openMemoryStore());
    storage.failNext = keyError();
    expect(await host(storage).openAccount(params('/a1.db'))).toEqual({ fileExisted: false });
    expect(storage.removed).toEqual(['/a1.db']);
  });

  it('never deletes a file over any other error', async () => {
    const storage = new FakeStorage();
    storage.dbs.set('/a1.db', openMemoryStore());
    storage.failNext = new Error('disk I/O error');
    await expect(host(storage).openAccount(params('/a1.db'))).rejects.toThrow('disk I/O');
    expect(storage.removed).toEqual([]);
  });
});

describe('files with no key', () => {
  it('are deleted, journals included; known ones and those in use stay', async () => {
    const storage = new FakeStorage();
    const running = host(storage);
    await running.openAccount(params('/ainuse.db'));
    storage.dbs.set('/aknown.db', openMemoryStore());
    storage.dbs.set('/aorphan.db', openMemoryStore());
    storage.dbs.set('/aorphan.db-journal', openMemoryStore());
    expect(running.sweepFiles(['/aknown.db'])).toBeGreaterThan(0);
    expect(storage.files().sort()).toEqual(['/ainuse.db', '/aknown.db']);
  });
});

describe('a scope from another tab', () => {
  it('reaches the engine over the channel call', async () => {
    const storage = new FakeStorage();
    const running = host(storage);
    await running.openAccount(params('/a1.db'));
    await running.call('setScope', { account: 'a', scope: { ...DEFAULT_SCOPE, days: 7 } });
    const stored = storage.dbs.get('/a1.db')!.get<{ v: string }>("SELECT v FROM meta WHERE k = 'scope'");
    expect(JSON.parse(String(stored?.v)).days).toBe(7);
    await expect(running.call('setScope', { account: 'nobody', scope: DEFAULT_SCOPE })).rejects.toMatchObject({ name: 'StoreAccountClosedError' });
  });
});
