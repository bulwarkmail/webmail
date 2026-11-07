// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCOPE, STORAGE_ERROR_AREA, type StoreEvent } from '../area';
import { AccountEngine } from '../engine/account-engine';
import { TransportError } from '../engine/transport';
import { mailArea } from '../mail';
import { outboxArea } from '../outbox';
import { isStorageFailure, type SqlValue, type StorageAdapter } from '../storage';
import { FAKE_SESSION } from './helpers/fake-jmap';
import { FakeJmapMail } from './helpers/fake-jmap-mail';
import { openMemoryStore } from './helpers/node-adapter';

/** Records the SQL of a query, so its plan can be read. */
function spying(db: StorageAdapter) {
  const seen: Array<{ sql: string; params: readonly SqlValue[] }> = [];
  const spied: StorageAdapter = {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => {
      seen.push({ sql, params: params ?? [] });
      return db.run(sql, params);
    },
    all: <T extends object>(sql: string, params?: readonly SqlValue[]) => {
      seen.push({ sql, params: params ?? [] });
      return db.all<T>(sql, params);
    },
    get: <T extends object>(sql: string, params?: readonly SqlValue[]) => {
      seen.push({ sql, params: params ?? [] });
      return db.get<T>(sql, params);
    },
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
  };
  return { spied, seen };
}

function setup(emails: Array<{ id: string; keywords?: Record<string, boolean>; mailboxIds?: Record<string, boolean> }>) {
  const server = new FakeJmapMail({ mailboxes: [{ id: 'inbox', role: 'inbox' }, { id: 'other' }] });
  emails.forEach((email, i) => server.addEmail({
    keywords: {},
    mailboxIds: { inbox: true },
    receivedAt: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(),
    ...email,
  }));
  const raw = openMemoryStore();
  const { spied, seen } = spying(raw);
  const engine = new AccountEngine({
    account: 'a', db: spied, session: FAKE_SESSION, transport: server, areas: [mailArea, outboxArea],
    scope: { ...DEFAULT_SCOPE, days: null, attachments: false }, sleep: async () => {},
  });
  return { server, raw, seen, engine };
}

const NEWEST = { property: 'receivedAt', isAscending: false };
const PINNED = { property: 'hasKeyword', keyword: '$pinned', isAscending: false };
const UNREAD_FIRST = { property: 'hasKeyword', keyword: '$seen', isAscending: true };
const IN_INBOX = { inMailbox: 'inbox' };

async function ids(engine: AccountEngine, args: Record<string, unknown>): Promise<string[]> {
  const answer = await engine.answer([['Email/query', args, 'q']]);
  return answer?.methodResponses[0][1].ids;
}

async function plans(t: ReturnType<typeof setup>, args: Record<string, unknown>) {
  t.seen.length = 0;
  await t.engine.answer([['Email/query', args, 'q']]);
  const reads = t.seen.filter(({ sql }) => /^SELECT (e\.id|COUNT)/.test(sql) && !sql.includes('sync_state'));
  return reads.map(({ sql, params }) => ({
    sql,
    plan: t.raw.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params).map((row) => row.detail).join('; '),
  }));
}

describe('pinned and unread first', () => {
  const MAIL: Array<{ id: string; keywords?: Record<string, boolean>; mailboxIds?: Record<string, boolean> }> = [
    { id: 'old-read', keywords: { $seen: true } },
    { id: 'old-unread' },
    { id: 'pin-read', keywords: { $seen: true, $pinned: true } },
    { id: 'mid-read', keywords: { $seen: true } },
    { id: 'pin-unread', keywords: { $pinned: true } },
    { id: 'new-unread' },
    { id: 'new-read', keywords: { $seen: true } },
    { id: 'elsewhere', keywords: { $pinned: true }, mailboxIds: { other: true } },
  ];

  let t: ReturnType<typeof setup>;

  beforeEach(async () => {
    t = setup(MAIL);
    await t.engine.requestSync();
  });

  it('comes out the same as sorting the whole folder would', async () => {
    expect(await ids(t.engine, { filter: IN_INBOX, sort: [PINNED, NEWEST] }))
      .toEqual(['pin-unread', 'pin-read', 'new-read', 'new-unread', 'mid-read', 'old-unread', 'old-read']);
    expect(await ids(t.engine, { filter: IN_INBOX, sort: [UNREAD_FIRST, NEWEST] }))
      .toEqual(['new-unread', 'pin-unread', 'old-unread', 'new-read', 'mid-read', 'pin-read', 'old-read']);
    expect(await ids(t.engine, { filter: IN_INBOX, sort: [PINNED, UNREAD_FIRST, NEWEST] }))
      .toEqual(['pin-unread', 'pin-read', 'new-unread', 'old-unread', 'new-read', 'mid-read', 'old-read']);
    // No date level at all: the same.
    expect(await ids(t.engine, { filter: IN_INBOX, sort: [PINNED] }))
      .toEqual(['pin-unread', 'pin-read', 'new-read', 'new-unread', 'mid-read', 'old-unread', 'old-read']);
  });

  it('pages across the groups', async () => {
    const whole = await ids(t.engine, { filter: IN_INBOX, sort: [PINNED, NEWEST] });
    for (let position = 0; position < whole.length + 2; position += 1) {
      for (const limit of [1, 2, 3, 50]) {
        expect(await ids(t.engine, { filter: IN_INBOX, sort: [PINNED, NEWEST], position, limit })).toEqual(whole.slice(position, position + limit));
      }
    }
  });

  it('keeps conditions, across the whole account too', async () => {
    expect(await ids(t.engine, { filter: { operator: 'AND', conditions: [IN_INBOX, { notKeyword: '$seen' }] }, sort: [PINNED, NEWEST] }))
      .toEqual(['pin-unread', 'new-unread', 'old-unread']);
    expect(await ids(t.engine, { sort: [PINNED, NEWEST], limit: 2 })).toEqual(['elsewhere', 'pin-unread']);
    expect(await ids(t.engine, { filter: { text: 'nothing-matches-this' }, sort: [PINNED, NEWEST] })).toEqual([]);
  });

  it('reads the comparator the way the client sends it for a server that flips it', async () => {
    t.engine.setInvertedKeywordSort(true);
    expect((await ids(t.engine, { filter: IN_INBOX, sort: [{ ...PINNED, isAscending: true }, NEWEST], limit: 2 }))).toEqual(['pin-unread', 'pin-read']);
    expect((await ids(t.engine, { filter: IN_INBOX, sort: [{ ...PINNED, isAscending: false }, NEWEST], limit: 1 }))).toEqual(['new-read']);
  });

  it('answers the client\'s polarity probe the way a server would', async () => {
    const asc = await ids(t.engine, { sort: [{ property: 'hasKeyword', keyword: '$seen', isAscending: true }, NEWEST], limit: 1 });
    const desc = await ids(t.engine, { sort: [{ property: 'hasKeyword', keyword: '$seen', isAscending: false }, NEWEST], limit: 1 });
    expect(asc).toEqual(['elsewhere']);
    expect(desc).toEqual(['new-read']);
  });

  it('never sorts the folder', async () => {
    for (const sort of [[PINNED, NEWEST], [UNREAD_FIRST, NEWEST], [PINNED, UNREAD_FIRST, NEWEST]]) {
      const reads = await plans(t, { filter: IN_INBOX, sort, limit: 5 });
      expect(reads.length).toBeGreaterThan(0);
      for (const { plan, sql } of reads) {
        // A rare keyword's own rows may be sorted. The folder's never are.
        if (sql.includes('email_keyword r')) expect(plan).toContain('email_keyword_lookup');
        else expect(plan).not.toContain('TEMP B-TREE');
      }
    }
  });

  it('reads a rare keyword off its index first, and the rest off the folder\'s', async () => {
    const reads = await plans(t, { filter: IN_INBOX, sort: [PINNED, NEWEST], limit: 3 });
    const pages = reads.filter(({ sql }) => sql.startsWith('SELECT e.id'));
    expect(pages[0].plan).toContain('email_keyword_lookup');
    expect(pages[1].plan).toContain('email_mailbox_list');
    expect(pages[1].plan).not.toContain('TEMP B-TREE');
  });

  it('counts what it skips without reading a message', async () => {
    const reads = await plans(t, { filter: IN_INBOX, sort: [PINNED, NEWEST], position: 3, limit: 1 });
    const counts = reads.filter(({ sql }) => sql.startsWith('SELECT COUNT'));
    expect(counts.length).toBeGreaterThan(0);
    for (const { plan } of counts) expect(plan).not.toMatch(/\bSCAN e\b|SEARCH e\b/);
  });

  it('leaves other orders to a full sort, and they still work', async () => {
    expect(await ids(t.engine, { filter: IN_INBOX, sort: [PINNED, { property: 'size', isAscending: true }, NEWEST], limit: 2 })).toHaveLength(2);
    expect(await ids(t.engine, { filter: IN_INBOX, sort: [NEWEST], collapseThreads: true, limit: 2 })).toHaveLength(2);
  });
});

describe('a page deep in a folder', () => {
  it('is picked off the folder index, and reads only its own messages', async () => {
    const t = setup(Array.from({ length: 30 }, (_, i) => ({ id: `m${String(i).padStart(2, '0')}` })));
    await t.engine.requestSync();
    t.seen.length = 0;
    const answer = await t.engine.answer([['Email/query', { filter: IN_INBOX, sort: [NEWEST], position: 20, limit: 3 }, 'q']]);
    // Newest first: m29 is first, so position 20 is m09.
    expect(answer?.methodResponses[0][1].ids).toEqual(['m09', 'm08', 'm07']);
    const page = t.seen.find(({ sql }) => sql.startsWith('SELECT e.id'))!;
    const rows = t.raw.all<{ id: number; parent: number; detail: string }>(`EXPLAIN QUERY PLAN ${page.sql}`, page.params);
    const folder = rows.find((row) => /SEARCH d USING COVERING INDEX email_mailbox_list/.test(row.detail))!;
    const message = rows.find((row) => /SEARCH e USING INTEGER PRIMARY KEY/.test(row.detail))!;
    // The folder's index is walked inside the subquery; the message table only after it, at the top.
    expect(folder.parent).not.toBe(0);
    expect(message.parent).toBe(0);
  });
});

describe('calculateTotal', () => {
  it('counts folder conditions off the index and the keyword rows, reading no message', async () => {
    const t = setup([{ id: 'a' }, { id: 'b', keywords: { $seen: true } }]);
    await t.engine.requestSync();
    t.seen.length = 0;
    const answer = await t.engine.answer([['Email/query', {
      filter: { operator: 'AND', conditions: [IN_INBOX, { notKeyword: '$seen' }, { after: '2020-01-01T00:00:00Z' }] },
      sort: [NEWEST],
      limit: 1,
      calculateTotal: true,
    }, 'q']]);
    expect(answer?.methodResponses[0][1].total).toBe(1);
    const count = t.seen.find(({ sql }) => sql.startsWith('SELECT COUNT'))!;
    const plan = t.raw.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${count.sql}`, count.params).map((row) => row.detail).join('; ');
    expect(plan).toContain('email_mailbox_list');
    expect(plan).not.toMatch(/\bSCAN e\b|SEARCH e\b/);
  });

  it('reads each search term off the index once for the page and its total, and counts no message', async () => {
    const t = setup([
      { id: 'a', subject: 'Rechnung' } as never,
      { id: 'b', subject: 'Termin' } as never,
      { id: 'c', subject: 'Zahlungserinnerung zur Rechnung' } as never,
    ]);
    await t.engine.requestSync();
    t.seen.length = 0;
    const answer = await t.engine.answer([['Email/query', {
      filter: { operator: 'AND', conditions: [IN_INBOX, { text: 'rechnung' }] },
      sort: [NEWEST],
      limit: 1,
      calculateTotal: true,
    }, 'q']]);
    expect(answer?.methodResponses[0][1]).toMatchObject({ ids: ['c'], total: 2 });
    // Word and trigram index, head and body: four lookups, each read once.
    const lookups = t.seen.reduce((n, { sql }) => n + (sql.match(/\bMATCH\b/g)?.length ?? 0), 0);
    expect(lookups).toBe(4);
    const count = t.seen.find(({ sql }) => sql.startsWith('SELECT COUNT'))!;
    const plan = t.raw.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${count.sql}`, count.params).map((row) => row.detail).join('; ');
    expect(plan).toContain('email_mailbox_list');
    expect(plan).not.toMatch(/\bSCAN e\b|SEARCH e\b/);
  });

  it('still reads the message for a condition only it can answer', async () => {
    const t = setup([{ id: 'a', size: 5 } as never, { id: 'b', size: 500 } as never]);
    await t.engine.requestSync();
    const answer = await t.engine.answer([['Email/query', { filter: { operator: 'AND', conditions: [IN_INBOX, { minSize: 100 }] }, calculateTotal: true }, 'q']]);
    expect(answer?.methodResponses[0][1].total).toBe(1);
  });
});

describe('a failed write', () => {
  function failing(now: { at: number }) {
    const server = new FakeJmapMail();
    for (let i = 0; i < 400; i += 1) server.addEmail({ bodyValues: { 1: { value: 'x'.repeat(2000) } } });
    const db = openMemoryStore();
    const events: StoreEvent[] = [];
    const engine = new AccountEngine({
      account: 'a', db, session: FAKE_SESSION, transport: server, areas: [mailArea, outboxArea],
      scope: { ...DEFAULT_SCOPE, days: null, attachments: false }, sleep: async () => {},
      emit: (event) => events.push(event), now: () => now.at,
    });
    // A real full disk, as SQLite reports it.
    const pages = Number(db.get<{ page_count: number }>('PRAGMA page_count')?.page_count);
    db.exec(`PRAGMA max_page_count = ${pages + 40}`);
    return { server, db, events, engine };
  }

  const storageErrors = (events: StoreEvent[]) => events.filter((event) => event.type === 'error' && event.area === STORAGE_ERROR_AREA);

  it('tells the page, says no "synced", and doesn\'t try again on every push', async () => {
    const now = { at: 1_000_000 };
    const t = failing(now);
    await t.engine.requestSync();
    expect(storageErrors(t.events)).toHaveLength(1);
    expect(t.events.some((event) => event.type === 'synced')).toBe(false);

    const requests = t.server.requests;
    t.engine.noteStateChange({ acc1: { Email: 'whatever' } });
    await t.engine.requestSync();
    await t.engine.requestSync();
    expect(t.server.requests).toBe(requests);
    expect(storageErrors(t.events)).toHaveLength(1);
  });

  it('tries again after a while, longer each time, and carries on once there\'s room', async () => {
    const now = { at: 1_000_000 };
    const t = failing(now);
    await t.engine.requestSync();

    now.at += 61_000;
    await t.engine.requestSync();
    expect(storageErrors(t.events)).toHaveLength(2);

    // Now it waits two minutes.
    now.at += 61_000;
    const requests = t.server.requests;
    await t.engine.requestSync();
    expect(t.server.requests).toBe(requests);

    now.at += 61_000;
    t.db.exec('PRAGMA max_page_count = 1000000');
    await t.engine.requestSync();
    expect(t.events.some((event) => event.type === 'synced')).toBe(true);
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM email')?.n).toBe(400);
  });

  it('lets the user make room by keeping less, without waiting', async () => {
    const now = { at: 1_000_000 };
    const t = failing(now);
    await t.engine.requestSync();
    const requests = t.server.requests;
    t.engine.setScope({ ...DEFAULT_SCOPE, days: 1 });
    await t.engine.requestSync();
    expect(t.server.requests).toBeGreaterThan(requests);
  });

  it('reports a change that couldn\'t be kept, and fails it rather than pretending', async () => {
    const now = { at: 1_000_000 };
    const t = failing(now);
    t.db.exec('PRAGMA max_page_count = 1000000');
    await t.engine.requestSync();
    const pages = Number(t.db.get<{ page_count: number }>('PRAGMA page_count')?.page_count);
    t.db.exec(`PRAGMA max_page_count = ${pages}`);
    const big = 'x'.repeat(5_000_000);
    await expect(t.engine.areaCall('outbox.queueSend', { summary: { subject: big, to: [] }, item: { kind: 'email', args: [] } })).rejects.toThrow(/full/);
    expect(storageErrors(t.events)).toHaveLength(1);
    t.db.exec('PRAGMA max_page_count = 1000000');
    expect((await t.engine.areaCall('outbox.read', {}) as { entries: unknown[] }).entries).toEqual([]);
  });

  it('knows these errors from others', () => {
    expect(isStorageFailure(new Error('database or disk is full'))).toBe(true);
    expect(isStorageFailure(new Error('SQLITE_FULL: sqlite3 result code 13'))).toBe(true);
    expect(isStorageFailure(Object.assign(new Error('x'), { name: 'QuotaExceededError' }))).toBe(true);
    expect(isStorageFailure(new Error('no such table: x'))).toBe(false);
    expect(isStorageFailure(new TransportError('network', 'Failed to fetch'))).toBe(false);
  });
});
