// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCOPE } from '../area';
import { mailArea } from '../mail';
import type { StorageAdapter } from '../storage';
import { StoreHost, type HostStorage } from '../worker/host';
import { FAKE_SESSION } from './helpers/fake-jmap';
import { openMemoryStore } from './helpers/node-adapter';

const KEY = 'a'.repeat(64);

class FakeStorage implements HostStorage {
  readonly dbs = new Map<string, StorageAdapter>();
  removed: string[] = [];
  files(): string[] {
    return [...this.dbs.keys()];
  }
  async open(file: string): Promise<StorageAdapter> {
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

describe('removing an account', () => {
  it('tells every tab, once the file is gone', async () => {
    const storage = new FakeStorage();
    const events: unknown[] = [];
    const running = new StoreHost({ areas: [mailArea], storage, emit: (event) => events.push({ event, file: storage.files().length }), needAuth: () => {} });
    await running.openAccount(params('/a1.db'));
    events.length = 0;
    await running.removeAccount('a', '/a1.db');
    expect(events).toContainEqual({ event: { type: 'removed', account: 'a' }, file: 0 });
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
