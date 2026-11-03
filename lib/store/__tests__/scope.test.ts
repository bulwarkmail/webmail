// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCOPE, type StoreArea, type StoreScope } from '../area';
import { calendarArea } from '../calendar';
import { AccountEngine } from '../engine/account-engine';
import { mailArea } from '../mail';
import { CALENDAR_SESSION, FakeCalendarJmap } from './helpers/fake-calendar';
import { FAKE_SESSION, FakeJmap, JMAP_ACCOUNT } from './helpers/fake-jmap';
import { openMemoryStore } from './helpers/node-adapter';

const NOW = Date.UTC(2026, 10, 3);
const DAY = 86_400_000;
const EVERYTHING: StoreScope = { ...DEFAULT_SCOPE, days: null };
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

class Files extends FakeJmap {
  downloads: string[] = [];
  sizes = new Map<string, number>();
  override async download(_jmap?: string, blobId?: string): Promise<Uint8Array> {
    this.downloads.push(String(blobId));
    return new Uint8Array(this.sizes.get(String(blobId)) ?? 3);
  }
  withFile(id: string, blobId: string, size: number, daysAgo: number) {
    this.sizes.set(blobId, size);
    return this.addEmail({
      id,
      receivedAt: iso(daysAgo),
      hasAttachment: true,
      attachments: [{ partId: '2', blobId, name: `${blobId}.pdf`, type: 'application/pdf', size }],
    } as never);
  }
}

function setup(server: FakeJmap, scope: StoreScope, areas: StoreArea[] = [mailArea], clock = { now: NOW }, db = openMemoryStore()) {
  const engine = new AccountEngine({
    account: 'a@fake.test', db, session: FAKE_SESSION, transport: server, areas, scope, now: () => clock.now, sleep: async () => {},
  });
  return { engine, db, clock };
}

const ids = (db: ReturnType<typeof openMemoryStore>, table = 'email') => db.all<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`).map((row) => row.id);
const blobs = (db: ReturnType<typeof openMemoryStore>) => db.all<{ blob_id: string }>('SELECT blob_id FROM blob ORDER BY blob_id').map((row) => row.blob_id);
const count = (db: ReturnType<typeof openMemoryStore>, table: string) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n);

describe('a tightened scope', () => {
  it('prunes mail outside the window without fetching what stays', async () => {
    const server = new FakeJmap();
    server.addEmail({ id: 'old', receivedAt: iso(100) });
    server.addEmail({ id: 'mid', receivedAt: iso(40) });
    server.addEmail({ id: 'new', receivedAt: iso(5) });
    const { engine, db } = setup(server, EVERYTHING);
    await engine.requestSync();
    expect(ids(db)).toEqual(['mid', 'new', 'old']);

    server.calls.length = 0;
    expect(engine.setScope({ ...EVERYTHING, days: 30 })).toBe(true);
    await engine.requestSync();

    expect(ids(db)).toEqual(['new']);
    expect(count(db, 'email_body')).toBe(1);
    expect(count(db, 'email_mailbox')).toBe(1);
    // No resync: neither a listing nor the bodies of what stayed.
    expect(server.calls.filter(([name]) => name === 'Email/query')).toEqual([]);
    expect(server.calls.filter(([name, args]) => name === 'Email/get' && (args as { fetchAllBodyValues?: boolean }).fetchAllBodyValues)).toEqual([]);
  });

  it('prunes without a network', async () => {
    const server = new FakeJmap();
    server.addEmail({ id: 'old', receivedAt: iso(100) });
    server.addEmail({ id: 'new', receivedAt: iso(5) });
    const { engine, db } = setup(server, EVERYTHING);
    await engine.requestSync();
    engine.setOnline(false);
    server.calls.length = 0;
    engine.setScope({ ...EVERYTHING, days: 30 });
    await engine.requestSync();
    expect(ids(db)).toEqual(['new']);
    expect(server.calls).toEqual([]);
  });

  it('applies when the store opens under a tighter scope than it was left with', async () => {
    const server = new FakeJmap();
    server.addEmail({ id: 'old', receivedAt: iso(100) });
    server.addEmail({ id: 'new', receivedAt: iso(5) });
    const first = setup(server, EVERYTHING);
    await first.engine.requestSync();
    await first.engine.close();
    const second = setup(server, { ...EVERYTHING, days: 30 }, [mailArea], { now: NOW }, first.db);
    await second.engine.requestSync();
    expect(ids(first.db)).toEqual(['new']);
  });

  it('keeps the last scope when the page can\'t tell yet', async () => {
    const server = new FakeJmap();
    server.addEmail({ id: 'old', receivedAt: iso(100) });
    server.addEmail({ id: 'new', receivedAt: iso(5) });
    const first = setup(server, { ...EVERYTHING, days: 30 });
    await first.engine.requestSync();
    await first.engine.close();
    server.calls.length = 0;
    const second = new AccountEngine({
      account: 'a@fake.test', db: first.db, session: FAKE_SESSION, transport: server, areas: [mailArea], now: () => NOW, sleep: async () => {},
    });
    await second.requestSync();
    // Not the default's 90 days: that would look like a wider window to fetch.
    expect(server.calls.filter(([name]) => name === 'Email/query')).toEqual([]);
    expect(ids(first.db)).toEqual(['new']);
  });

  it('moves with the clock, once a day', async () => {
    const server = new FakeJmap();
    server.addEmail({ id: 'ageing', receivedAt: iso(29) });
    const { engine, db, clock } = setup(server, { ...EVERYTHING, days: 30 });
    await engine.requestSync();
    expect(ids(db)).toEqual(['ageing']);
    clock.now = NOW + 2 * DAY;
    await engine.requestSync();
    expect(ids(db)).toEqual([]);
  });

  it('drops attachments when they are forbidden, and can fetch them again', async () => {
    const server = new Files();
    server.withFile('m', 'b-1', 10, 1);
    const { engine, db } = setup(server, EVERYTHING);
    await engine.requestSync();
    expect(blobs(db)).toEqual(['b-1']);

    engine.setScope({ ...EVERYTHING, attachments: false });
    await engine.requestSync();
    expect(blobs(db)).toEqual([]);
    expect(ids(db)).toEqual(['m']);

    engine.setScope(EVERYTHING);
    await engine.requestSync();
    expect(blobs(db)).toEqual(['b-1']);
  });

  it('drops attachments over the new size', async () => {
    const server = new Files();
    server.withFile('small', 'b-small', 10, 1);
    server.withFile('big', 'b-big', 1000, 2);
    const { engine, db } = setup(server, EVERYTHING);
    await engine.requestSync();
    expect(blobs(db)).toEqual(['b-big', 'b-small']);
    engine.setScope({ ...EVERYTHING, maxAttachmentBytes: 100 });
    await engine.requestSync();
    expect(blobs(db)).toEqual(['b-small']);
  });

  it('drops the oldest attachments over the new total, and doesn\'t fetch them back', async () => {
    const server = new Files();
    server.withFile('newest', 'b-newest', 100, 1);
    server.withFile('middle', 'b-middle', 100, 2);
    server.withFile('oldest', 'b-oldest', 100, 3);
    const { engine, db } = setup(server, EVERYTHING);
    await engine.requestSync();
    server.downloads.length = 0;
    engine.setScope({ ...EVERYTHING, maxTotalBytes: 150 });
    await engine.requestSync();
    expect(blobs(db)).toEqual(['b-newest']);
    expect(server.downloads).toEqual([]);
  });

  it('counts what another area keeps towards the total', async () => {
    const server = new Files();
    server.withFile('newest', 'b-newest', 100, 1);
    server.withFile('older', 'b-older', 100, 2);
    const filesArea: StoreArea = { name: 'files', migrations: [], methods: {}, syncers: [], keptBytes: () => 150 };
    const { engine, db } = setup(server, { ...EVERYTHING, maxTotalBytes: 250 }, [mailArea, filesArea]);
    await engine.requestSync();
    expect(blobs(db)).toEqual(['b-newest']);
  });

  it('won\'t record a file the scope doesn\'t allow', async () => {
    const server = new Files();
    server.withFile('m', 'b-1', 10, 1);
    const { engine, db } = setup(server, { ...EVERYTHING, attachments: false });
    await engine.requestSync();
    expect(await engine.areaCall('mail.recordBlob', { jmap: JMAP_ACCOUNT, blobId: 'b-1', type: null, data: new Uint8Array(10) })).toBe(false);
    expect(blobs(db)).toEqual([]);
    engine.setScope({ ...EVERYTHING, maxAttachmentBytes: 5 });
    expect(await engine.areaCall('mail.recordBlob', { jmap: JMAP_ACCOUNT, blobId: 'b-1', type: null, data: new Uint8Array(10) })).toBe(false);
    engine.setScope(EVERYTHING);
    expect(await engine.areaCall('mail.recordBlob', { jmap: JMAP_ACCOUNT, blobId: 'b-1', type: null, data: new Uint8Array(10) })).toBe(true);
  });

  it('stops a pass under way, and the pass after it goes by the new scope', async () => {
    const server = new FakeJmap();
    for (let i = 0; i < 700; i += 1) server.addEmail({ receivedAt: iso(100) });
    server.addEmail({ id: 'new', receivedAt: iso(5) });
    const { engine, db } = setup(server, EVERYTHING);
    let tightened = false;
    server.beforeRequest = (n) => {
      if (n >= 3 && !tightened) {
        tightened = true;
        engine.setScope({ ...EVERYTHING, days: 30 });
      }
    };
    await engine.requestSync();
    expect(tightened).toBe(true);
    expect(ids(db)).toEqual(['new']);
  });
});

describe('a scope changed while one is being applied', () => {
  it('fetches back what the first one already removed', async () => {
    const server = new FakeJmap();
    server.addEmail({ id: 'old', receivedAt: iso(100) });
    for (let i = 0; i < 450; i += 1) server.addEmail({ id: `mid${i}`, receivedAt: iso(50) });
    server.addEmail({ id: 'new', receivedAt: iso(5) });
    const { engine, db } = setup(server, EVERYTHING);
    await engine.requestSync();

    engine.setScope({ ...EVERYTHING, days: 30 });
    const run = engine.requestSync();
    // One batch in: the rows are going, and the change back arrives before the first is done.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(count(db, 'email')).toBeLessThan(452);
    engine.setScope(EVERYTHING);
    await run;
    await engine.requestSync();
    expect(count(db, 'email')).toBe(452);
  });
});

describe('a loosened scope', () => {
  it('starts a backfill of the wider window and keeps the bodies it has', async () => {
    const server = new FakeJmap();
    server.addEmail({ id: 'old', receivedAt: iso(100) });
    server.addEmail({ id: 'new', receivedAt: iso(5) });
    const { engine, db } = setup(server, { ...EVERYTHING, days: 30 });
    await engine.requestSync();
    expect(ids(db)).toEqual(['new']);

    server.calls.length = 0;
    engine.setScope({ ...EVERYTHING, days: 365 });
    await engine.requestSync();
    expect(ids(db)).toEqual(['new', 'old']);
    expect(count(db, 'email_body')).toBe(2);
    // The new message's body wasn't fetched again.
    const fetchedBodies = server.calls
      .filter(([name, args]) => name === 'Email/get' && (args as { fetchAllBodyValues?: boolean }).fetchAllBodyValues)
      .flatMap(([, args]) => (args as { ids: string[] }).ids);
    expect(fetchedBodies).toEqual(['old']);
  });

  it('does nothing when the scope is the same', async () => {
    const server = new FakeJmap();
    server.addEmail({ id: 'new', receivedAt: iso(5) });
    const { engine } = setup(server, { ...EVERYTHING, days: 30 });
    await engine.requestSync();
    expect(engine.setScope({ ...EVERYTHING, days: 30 })).toBe(false);
  });
});

describe('the calendar', () => {
  function calendarSetup(scope: StoreScope) {
    const server = new FakeCalendarJmap('1.0');
    const db = openMemoryStore();
    const engine = new AccountEngine({
      account: 'a@fake.test', db, session: CALENDAR_SESSION, transport: server, areas: [calendarArea], scope, now: () => NOW, sleep: async () => {},
    });
    return { server, db, engine };
  }

  it('follows the window, and series and what is ahead stay', async () => {
    const { server, db, engine } = calendarSetup(EVERYTHING);
    server.addEvent({ id: 'old', start: '2026-06-01T10:00:00' });
    server.addEvent({ id: 'recent', start: '2026-10-30T10:00:00' });
    server.addEvent({ id: 'ahead', start: '2027-01-01T10:00:00' });
    server.addEvent({ id: 'series', start: '2015-01-01T10:00:00', recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly' } });
    await engine.requestSync();
    expect(ids(db, 'calendar_event')).toEqual(['ahead', 'old', 'recent', 'series']);

    engine.setOnline(false);
    engine.setScope({ ...EVERYTHING, days: 30 });
    await engine.requestSync();
    expect(ids(db, 'calendar_event')).toEqual(['ahead', 'recent', 'series']);

    engine.setOnline(true);
    await engine.requestSync();
    expect(ids(db, 'calendar_event')).toEqual(['ahead', 'recent', 'series']);
  });

  it('lists again when the window gets wider, since no change will name what was left out', async () => {
    const { server, db, engine } = calendarSetup({ ...EVERYTHING, days: 30 });
    server.addEvent({ id: 'old', start: '2026-06-01T10:00:00' });
    await engine.requestSync();
    expect(ids(db, 'calendar_event')).toEqual([]);
    engine.setScope({ ...EVERYTHING, days: 365 });
    await engine.requestSync();
    expect(ids(db, 'calendar_event')).toEqual(['old']);
  });
});

describe('what the storage page reads', () => {
  it('says what each part takes, with the rest under mail, and doesn\'t count freed pages', async () => {
    const server = new Files();
    server.withFile('m', 'b-1', 50_000, 1);
    server.addEmail({ id: 'old', receivedAt: iso(100), subject: 'x'.repeat(40_000) } as never);
    const { engine } = setup(server, EVERYTHING);
    await engine.requestSync();
    const before = await engine.areaCall('store.usage', undefined) as { bytes: number; parts: Array<{ part: string; bytes: number; items: number }> };
    const parts = Object.fromEntries(before.parts.map((part) => [part.part, part]));
    expect(parts.attachments).toEqual({ part: 'attachments', bytes: 50_000, items: 1 });
    expect(parts.mail.items).toBe(2);
    expect(parts.mail.bytes).toBe(before.bytes - 50_000);

    engine.setScope({ ...EVERYTHING, days: 30, attachments: false });
    await engine.requestSync();
    const after = await engine.areaCall('store.usage', undefined) as typeof before;
    expect(after.bytes).toBeLessThan(before.bytes - 50_000);
    expect(after.parts.find((part) => part.part === 'attachments')?.items).toBe(0);
  });
});
