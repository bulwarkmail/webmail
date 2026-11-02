import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CollectionOptions, LogOptions, SharedStore } from '../types';

/**
 * One contract for both stores, so local mode and the shared store can't
 * drift apart (#1066). `makeStores(n)` returns n handles on one store: for
 * the shared store n separate connections, standing in for n replicas.
 */
export interface ContractTarget {
  name: string;
  makeStores: (n: number) => SharedStore[];
  /** Called after each test file; drop the keys the run used. */
  cleanup?: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function runStoreContract(target: ContractTarget): void {
  describe(`shared store contract: ${target.name}`, () => {
    let dir: string;
    let run = 0;
    const roots: string[] = [];

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'bulwark-store-'));
      roots.push(dir);
      run++;
    });

    afterAll(async () => {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
      await target.cleanup?.();
    });

    const coll = (name: string, extra: Partial<CollectionOptions> = {}): CollectionOptions => ({
      local: { dir: () => path.join(dir, name) },
      ...extra,
    });
    const key = (k: string) => `t${run}:${k}`;
    const open = async (n: number) => {
      const stores = target.makeStores(n);
      await Promise.all(stores.map((store) => store.ready()));
      return stores;
    };

    describe('kv', () => {
      it('sets, gets and deletes', async () => {
        const [s] = await open(1);
        expect(await s.kv.get(key('a'))).toBeNull();
        expect(await s.kv.set(key('a'), 'one')).toBe(true);
        expect(await s.kv.get(key('a'))).toBe('one');
        await s.kv.del(key('a'));
        expect(await s.kv.get(key('a'))).toBeNull();
      });

      it('expires values after their ttl', async () => {
        const [s] = await open(1);
        await s.kv.set(key('t'), 'x', { ttlMs: 150 });
        expect(await s.kv.get(key('t'))).toBe('x');
        await sleep(400);
        expect(await s.kv.get(key('t'))).toBeNull();
      });

      it('sets ifAbsent only once, across replicas', async () => {
        const stores = await open(3);
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) => stores[i % 3].kv.set(key('once'), `v${i}`, { ifAbsent: true })),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        const winner = results.indexOf(true);
        expect(await stores[1].kv.get(key('once'))).toBe(`v${winner}`);
      });

      it('hands a taken value to exactly one caller', async () => {
        const stores = await open(3);
        await stores[0].kv.set(key('code'), 'grant');
        const taken = await Promise.all(Array.from({ length: 12 }, (_, i) => stores[i % 3].kv.take(key('code'))));
        expect(taken.filter((v) => v === 'grant')).toHaveLength(1);
        expect(await stores[2].kv.get(key('code'))).toBeNull();
      });

      it('updates without losing concurrent changes', async () => {
        const stores = await open(3);
        await Promise.all(Array.from({ length: 30 }, (_, i) =>
          stores[i % 3].kv.update(key('n'), (cur) => String(Number(cur ?? '0') + 1)),
        ));
        expect(await stores[0].kv.get(key('n'))).toBe('30');
      });

      it('update can delete or leave a value', async () => {
        const [s] = await open(1);
        await s.kv.set(key('u'), 'a');
        expect(await s.kv.update(key('u'), () => undefined)).toBeUndefined();
        expect(await s.kv.get(key('u'))).toBe('a');
        expect(await s.kv.update(key('u'), () => null)).toBeNull();
        expect(await s.kv.get(key('u'))).toBeNull();
      });

      it('refuses keys with control characters', async () => {
        const [s] = await open(1);
        await expect(s.kv.get('bad\nkey')).rejects.toThrow(/Invalid store key/);
      });
    });

    describe('counters', () => {
      it('reserves up to the max and refuses without counting', async () => {
        const [s] = await open(1);
        const limit = [{ key: key('ip'), max: 3, windowMs: 60_000 }];
        for (let i = 1; i <= 3; i++) expect((await s.counters.reserve(limit)).ok).toBe(true);
        const refused = await s.counters.reserve(limit);
        expect(refused.ok).toBe(false);
        expect(refused.retryAfterMs).toBeGreaterThan(55_000);
        expect(refused.counts).toEqual([3]);
        expect((await s.counters.get(key('ip')))?.count).toBe(3);
      });

      it('checks every key before counting any (a full global ceiling stops a fresh client)', async () => {
        const [s] = await open(1);
        const global = { key: key('all'), max: 2, windowMs: 60_000 };
        expect((await s.counters.reserve([{ key: key('c1'), max: 5, windowMs: 60_000 }, global])).ok).toBe(true);
        expect((await s.counters.reserve([{ key: key('c2'), max: 5, windowMs: 60_000 }, global])).ok).toBe(true);
        const third = await s.counters.reserve([{ key: key('c3'), max: 5, windowMs: 60_000 }, global]);
        expect(third.ok).toBe(false);
        expect(await s.counters.get(key('c3'))).toBeNull();
        // A client over its own limit doesn't use up the ceiling either.
        const own = { key: key('own'), max: 1, windowMs: 60_000 };
        const wide = { key: key('wide'), max: 10, windowMs: 60_000 };
        await s.counters.reserve([own, wide]);
        for (let i = 0; i < 5; i++) await s.counters.reserve([own, wide]);
        expect((await s.counters.get(key('wide')))?.count).toBe(1);
      });

      it('counts together across replicas', async () => {
        const stores = await open(3);
        const limit = [{ key: key('shared'), max: 5, windowMs: 60_000 }];
        const results = await Promise.all(Array.from({ length: 12 }, (_, i) => stores[i % 3].counters.reserve(limit)));
        expect(results.filter((r) => r.ok)).toHaveLength(5);
      });

      it('starts a new window after windowMs, by the caller\'s clock', async () => {
        const [s] = await open(1);
        const t0 = Date.now();
        const limit = [{ key: key('w'), max: 1, windowMs: 1000 }];
        expect((await s.counters.reserve(limit, t0)).ok).toBe(true);
        expect((await s.counters.reserve(limit, t0 + 999)).ok).toBe(false);
        const next = await s.counters.reserve(limit, t0 + 1000);
        expect(next.ok).toBe(true);
        expect(next.resetAts[0]).toBe(t0 + 2000);
      });

      it('refunds only the window it reserved in', async () => {
        const [s] = await open(1);
        const t0 = Date.now();
        const limit = [{ key: key('r'), max: 2, windowMs: 1000 }];
        const first = await s.counters.reserve(limit, t0);
        await s.counters.reserve(limit, t0 + 10);
        await s.counters.refund([{ key: key('r'), resetAt: first.resetAts[0] }], t0 + 20);
        expect((await s.counters.get(key('r'), t0 + 30))?.count).toBe(1);
        // A new window: the old reservation's refund doesn't touch it.
        await s.counters.reserve(limit, t0 + 1500);
        await s.counters.refund([{ key: key('r'), resetAt: first.resetAts[0] }], t0 + 1510);
        expect((await s.counters.get(key('r'), t0 + 1520))?.count).toBe(1);
        // Never below zero.
        await s.counters.refund([{ key: key('r') }, { key: key('r') }, { key: key('r') }], t0 + 1530);
        expect((await s.counters.get(key('r'), t0 + 1540))?.count).toBe(0);
      });

      it('hits, gets and resets', async () => {
        const [s] = await open(1);
        const t0 = Date.now();
        expect(await s.counters.hit(key('h'), 5000, t0)).toEqual({ count: 1, resetAt: t0 + 5000 });
        expect((await s.counters.hit(key('h'), 5000, t0 + 1)).count).toBe(2);
        await s.counters.reset(key('h'));
        expect(await s.counters.get(key('h'), t0 + 2)).toBeNull();
      });
    });

    describe('documents', () => {
      it('round-trips bytes and changes the version on every write', async () => {
        const [s] = await open(1);
        const docs = s.collection('things', coll('things'));
        const bytes = Buffer.from([0, 1, 2, 255, 10, 13]);
        const put = await docs.put('a.bin', bytes);
        expect(put.ok).toBe(true);
        const got = await docs.get('a.bin');
        expect(got?.data.equals(bytes)).toBe(true);
        expect(got?.version).toBe(put.ok && put.version);
        const again = await docs.put('a.bin', 'text');
        expect(again.ok && again.version).not.toBe(got?.version);
        expect((await docs.get('a.bin'))?.data.toString()).toBe('text');
      });

      it('creates only once with ifVersion: null, across replicas', async () => {
        const stores = await open(3);
        const results = await Promise.all(Array.from({ length: 9 }, (_, i) =>
          stores[i % 3].collection('once', coll('once')).put('x', `v${i}`, { ifVersion: null }),
        ));
        expect(results.filter((r) => r.ok)).toHaveLength(1);
      });

      it('refuses a stale version and returns the current document', async () => {
        const [s] = await open(1);
        const docs = s.collection('cas', coll('cas'));
        const first = await docs.put('p', 'one');
        await docs.put('p', 'two');
        const stale = await docs.put('p', 'three', { ifVersion: first.ok ? first.version : '' });
        expect(stale.ok).toBe(false);
        expect(!stale.ok && stale.current?.data.toString()).toBe('two');
        expect((await docs.get('p'))?.data.toString()).toBe('two');
      });

      it('update loses no concurrent change across replicas', async () => {
        const stores = await open(3);
        await Promise.all(Array.from({ length: 24 }, (_, i) =>
          stores[i % 3].collection('upd', coll('upd')).update('list.json', (cur) => {
            const list = cur ? (JSON.parse(cur.toString()) as number[]) : [];
            return JSON.stringify([...list, i]);
          }, { maxRetries: 100 }),
        ));
        const final = JSON.parse((await stores[0].collection('upd', coll('upd')).get('list.json'))!.data.toString()) as number[];
        expect(final.sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i));
      });

      it('update leaves the document alone on undefined and deletes on null', async () => {
        const [s] = await open(1);
        const docs = s.collection('upd2', coll('upd2'));
        await docs.put('d', 'keep');
        const left = await docs.update('d', () => undefined);
        expect(left.data).toBeUndefined();
        expect((await docs.get('d'))?.data.toString()).toBe('keep');
        await docs.update('d', () => null);
        expect(await docs.get('d')).toBeNull();
        // Deleting what isn't there is fine.
        expect((await docs.update('d', () => null)).data).toBeNull();
      });

      it('deletes, conditionally too', async () => {
        const [s] = await open(1);
        const docs = s.collection('del', coll('del'));
        const put = await docs.put('d', 'x');
        expect(await docs.delete('d', { ifVersion: 'nope' })).toBe(false);
        expect(await docs.delete('d', { ifVersion: put.ok ? put.version : '' })).toBe(true);
        expect(await docs.get('d')).toBeNull();
        expect(await docs.delete('d')).toBe(true);
      });

      it('lists ids by prefix, nested ones included', async () => {
        const [s] = await open(1);
        const docs = s.collection('tree', coll('tree'));
        await docs.put('history/a/1.0.0/bundle.js', 'a1');
        await docs.put('history/a/1.1.0/bundle.js', 'a2');
        await docs.put('history/b/1.0.0/bundle.js', 'b1');
        await docs.put('registry.json', '{}');
        expect(await docs.list('history/a/')).toEqual(['history/a/1.0.0/bundle.js', 'history/a/1.1.0/bundle.js']);
        expect(await docs.list()).toHaveLength(4);
        await docs.delete('history/a/1.0.0/bundle.js');
        expect(await docs.list('history/a/')).toEqual(['history/a/1.1.0/bundle.js']);
      });

      it('refuses ids that would leave the collection', async () => {
        const [s] = await open(1);
        const docs = s.collection('safe', coll('safe'));
        for (const bad of ['../x', 'a/../../x', '/abs', '', 'a//b', '.', 'a/./b', 'sp ace']) {
          await expect(docs.put(bad, 'x')).rejects.toThrow();
        }
      });

      it('expires documents of a ttl collection', async () => {
        const [s] = await open(1);
        const docs = s.collection('ttl', coll('ttl', { ttlMs: 300 }));
        expect((await docs.put('m', '', { ifVersion: null })).ok).toBe(true);
        expect((await docs.put('m', '', { ifVersion: null })).ok).toBe(false);
        await sleep(1200);
        expect(await docs.get('m')).toBeNull();
        expect(await docs.list()).toEqual([]);
        expect((await docs.put('m', '', { ifVersion: null })).ok).toBe(true);
      });
    });

    describe('log', () => {
      const logOptions = (): LogOptions => ({
        local: { path: () => path.join(dir, 'audit.log'), maxBytes: 10 * 1024 * 1024, rotations: 3 },
        maxEntries: 10_000,
      });

      it('keeps every line from concurrent writers, untorn and in each writer\'s order', async () => {
        const stores = await open(3);
        const logs = stores.map((s) => s.log(`audit-${run}`, logOptions()));
        await Promise.all(logs.map((log, r) => Promise.all(
          Array.from({ length: 50 }, (_, i) => log.append(JSON.stringify({ r, i, pad: 'x'.repeat(200) }))),
        )));
        const lines = await logs[0].readAll();
        expect(lines).toHaveLength(150);
        const parsed = lines.map((l) => JSON.parse(l) as { r: number; i: number });
        for (let r = 0; r < 3; r++) {
          expect(parsed.filter((p) => p.r === r).map((p) => p.i)).toEqual(Array.from({ length: 50 }, (_, i) => i));
        }
        expect(await logs[1].length()).toBe(150);
      });

      it('never writes a line break into a line', async () => {
        const [s] = await open(1);
        const log = s.log(`audit-${run}`, logOptions());
        await log.append('one\ntwo');
        expect(await log.readAll()).toEqual(['one two']);
      });

      it('appends a batch in order, with no other writer\'s line inside it', async () => {
        const [a, b] = await open(2);
        const batch = Array.from({ length: 200 }, (_, i) => `batch-${i}`);
        await Promise.all([
          a.log(`audit-${run}`, logOptions()).appendMany(batch),
          ...Array.from({ length: 20 }, (_, i) => b.log(`audit-${run}`, logOptions()).append(`single-${i}`)),
        ]);
        const lines = await a.log(`audit-${run}`, logOptions()).readAll();
        expect(lines).toHaveLength(220);
        const start = lines.indexOf('batch-0');
        expect(lines.slice(start, start + 200)).toEqual(batch);
        await a.log(`audit-${run}`, logOptions()).appendMany([]);
        expect(await b.log(`audit-${run}`, logOptions()).length()).toBe(220);
      });

      it('clears the log for every replica', async () => {
        const [a, b] = await open(2);
        await a.log(`audit-${run}`, logOptions()).appendMany(['one', 'two\nthree']);
        expect(await b.log(`audit-${run}`, logOptions()).readAll()).toEqual(['one', 'two three']);
        await b.log(`audit-${run}`, logOptions()).clear();
        expect(await a.log(`audit-${run}`, logOptions()).readAll()).toEqual([]);
        expect(await a.log(`audit-${run}`, logOptions()).length()).toBe(0);
        await b.log(`audit-${run}`, logOptions()).clear();
        await a.log(`audit-${run}`, logOptions()).append('again');
        expect(await b.log(`audit-${run}`, logOptions()).readAll()).toEqual(['again']);
      });
    });

    describe('leases', () => {
      it('has one holder at a time and hands over after expiry', async () => {
        const [a, b] = await open(2);
        const name = `lease-${run}`;
        expect(await a.leases.acquire(name, 'A', 300)).toBe(true);
        expect(await b.leases.acquire(name, 'B', 300)).toBe(false);
        expect(await a.leases.acquire(name, 'A', 300)).toBe(true); // renew
        expect(await b.leases.holder(name)).toBe('A');
        await sleep(500);
        expect(await b.leases.acquire(name, 'B', 300)).toBe(true);
        await a.leases.release(name, 'A'); // not A's any more
        expect(await a.leases.holder(name)).toBe('B');
        await b.leases.release(name, 'B');
        expect(await a.leases.holder(name)).toBeNull();
      });
    });

    describe('epochs and replicas', () => {
      it('bumps epochs that every replica reads', async () => {
        const [a, b] = await open(2);
        const area = `area-${run}`;
        const before = (await b.epochs.all())[area] ?? 0;
        expect(await a.epochs.bump(area)).toBe(before + 1);
        expect((await b.epochs.all())[area]).toBe(before + 1);
      });

      it('lists replicas that beat recently', async () => {
        const [a, b] = await open(2);
        await a.replicas.beat({ id: `r${run}-a`, version: '1.0.0', startedAt: 1 });
        await b.replicas.beat({ id: `r${run}-b`, version: '1.0.0', startedAt: 2 });
        const ids = (await a.replicas.recent(60_000)).map((r) => r.id);
        expect(ids).toEqual(expect.arrayContaining([`r${run}-a`, `r${run}-b`]));
      });

      it('answers a ping', async () => {
        const [s] = await open(1);
        await expect(s.ping()).resolves.toBeUndefined();
        expect(s.status().connected || s.mode === 'redis').toBe(true);
      });
    });
  });
}
