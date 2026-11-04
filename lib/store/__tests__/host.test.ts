// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCOPE } from '../area';
import { mailArea } from '../mail';
import type { StorageAdapter } from '../storage';
import { StoreHost, type HostStorage, type StoreCopy } from '../worker/host';
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

describe('opening an account', () => {
  it('says it was created, also after a first try with no session', async () => {
    const storage = new FakeStorage();
    await expect(host(storage).openAccount(params('/a1.db', null))).rejects.toThrow('No session');
    expect(storage.files()).toEqual([]);
    const running = host(storage);
    expect(await running.openAccount(params('/a1.db'))).toEqual({ created: true });
    await running.closeAll();
    expect(await host(storage).openAccount(params('/a1.db', null))).toEqual({ created: false });
  });
});

describe('re-encrypting an account', () => {
  class FakeCopy implements StoreCopy {
    left = 500;
    total = 500;
    steps: number[] = [];
    log: string[] = [];
    aborted = false;
    finished = false;
    failOnStep = 0;
    step(pages: number): 'more' | 'done' | 'busy' {
      this.steps.push(pages);
      if (this.failOnStep && this.steps.length === this.failOnStep) throw new Error('The disk is full');
      if (pages < 0) {
        this.log.push('last step');
        this.left = 0;
        return 'done';
      }
      this.left -= pages;
      if (this.left <= 0) {
        this.left = 0;
        return 'done';
      }
      return 'more';
    }
    remaining(): number { return this.left; }
    pageCount(): number { return this.total; }
    finish(): void { this.finished = true; this.log.push('finish'); }
    abort(): void { this.aborted = true; this.log.push('abort'); }
  }

  class CopyingStorage extends FakeStorage {
    copy = new FakeCopy();
    started: Array<{ file: string; keyHex: string }> = [];
    async startCopy(_source: StorageAdapter, file: string, keyHex: string): Promise<StoreCopy> {
      this.started.push({ file, keyHex });
      return this.copy;
    }
  }

  const hostWith = (storage: CopyingStorage, events: unknown[] = []) => new StoreHost({
    areas: [mailArea], storage, emit: (event) => events.push(event), needAuth: () => {},
  });
  const NEXT = 'd'.repeat(64);

  it('copies in small steps, stops the engine before the last pages, and leaves the account closed', async () => {
    const storage = new CopyingStorage();
    const events: Array<{ type: string; percent?: number }> = [];
    const running = hostWith(storage, events);
    await running.openAccount(params('/a1.db'));
    await running.rekey('a', '/a2.db', NEXT);
    expect(storage.started).toEqual([{ file: '/a2.db', keyHex: NEXT }]);
    // Never to the end while the engine runs: a write after the copy's end would be lost.
    expect(storage.copy.steps.slice(0, -1).every((pages) => pages > 0)).toBe(true);
    expect(storage.copy.steps.at(-1)).toBe(-1);
    expect(storage.copy.log).toEqual(['last step', 'finish']);
    const percents = events.filter((event) => event.type === 'rekey').map((event) => event.percent);
    expect(percents.at(-1)).toBe(100);
    expect(percents.length).toBeGreaterThan(1);
    await expect(running.call('answer', { account: 'a', calls: [] })).rejects.toMatchObject({ name: 'StoreAccountClosedError' });
  });

  it('a failure on the way leaves the account open on its old file, and takes the copy away', async () => {
    const storage = new CopyingStorage();
    storage.copy.failOnStep = 3;
    const running = hostWith(storage);
    await running.openAccount(params('/a1.db'));
    await expect(running.rekey('a', '/a2.db', NEXT)).rejects.toThrow('The disk is full');
    expect(storage.copy.aborted).toBe(true);
    await expect(running.call('status', { account: 'a' })).resolves.toMatchObject({ open: true });
  });

  it('closing the account for a lock stops the copy first: a database under a copy can\'t close', async () => {
    const storage = new CopyingStorage();
    const running = hostWith(storage);
    await running.openAccount(params('/a1.db'));
    const copying = running.rekey('a', '/a2.db', NEXT);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await running.closeAll();
    await expect(copying).rejects.toMatchObject({ name: 'StoreRekeyStoppedError' });
    expect(storage.copy.log).toEqual(['abort']);
  });
});

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
