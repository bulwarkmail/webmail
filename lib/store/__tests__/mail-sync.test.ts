// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SCOPE, type StoreContext, type StoreEvent } from '../area';
import { AccountEngine } from '../engine/account-engine';
import { runChangesLoop } from '../engine/changes';
import { answerRequest, buildMethodTable } from '../engine/responder';
import type { SqlValue } from '../storage';
import { TransportError, type MethodCall } from '../engine/transport';
import { mailArea } from '../mail';
import { FAKE_SESSION, FakeJmap, JMAP_ACCOUNT } from './helpers/fake-jmap';
import { openFileStore, openMemoryStore } from './helpers/node-adapter';

// No files: raw messages would add a commit per message, and these tests are about mail.
const EVERYTHING = { ...DEFAULT_SCOPE, days: null, attachments: false };
const INBOX = { inMailbox: 'inbox' };

function engineFor(server: FakeJmap, db = openMemoryStore(), emit?: (e: StoreEvent) => void) {
  return new AccountEngine({
    account: 'a@fake.test',
    db,
    session: FAKE_SESSION,
    transport: server,
    areas: [mailArea],
    scope: EVERYTHING,
    emit,
    now: () => Date.UTC(2026, 10, 3),
    sleep: async () => {},
  });
}

function count(db: ReturnType<typeof openMemoryStore>, table: string): number {
  return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n);
}

function callsNamed(server: FakeJmap, name: string): MethodCall[] {
  return server.calls.filter(([n]) => n === name);
}

describe('full sync', () => {
  it('stores every message, thread and body across pages', async () => {
    const server = new FakeJmap();
    for (let i = 0; i < 1234; i += 1) server.addEmail();
    const db = openMemoryStore();
    await engineFor(server, db).requestSync();
    expect(count(db, 'email')).toBe(1234);
    expect(count(db, 'email_body')).toBe(1234);
    expect(count(db, 'thread')).toBe(1234);
    expect(count(db, 'email_mailbox')).toBe(1234);
  });

  it('captures the state before paging, so a message landing mid-sync is not lost', async () => {
    const server = new FakeJmap();
    for (let i = 0; i < 600; i += 1) server.addEmail();
    let landed = false;
    server.beforeRequest = (n) => {
      if (n === 4 && !landed) {
        landed = true;
        server.addEmail({ id: 'late' });
      }
    };
    const db = openMemoryStore();
    await engineFor(server, db).requestSync();
    expect(landed).toBe(true);
    expect(db.get('SELECT id FROM email WHERE id = ?', ['late'])).toBeTruthy();
  });

  it('keeps only the chosen window', async () => {
    const server = new FakeJmap();
    server.addEmail({ id: 'old', receivedAt: '2020-01-01T00:00:00Z' });
    server.addEmail({ id: 'new', receivedAt: '2026-10-30T00:00:00Z' });
    const db = openMemoryStore();
    const engine = new AccountEngine({
      account: 'a@fake.test', db, session: FAKE_SESSION, transport: server, areas: [mailArea],
      scope: { ...DEFAULT_SCOPE, days: 30 }, now: () => Date.UTC(2026, 10, 3), sleep: async () => {},
    });
    await engine.requestSync();
    expect(db.all('SELECT id FROM email').map((r) => r.id)).toEqual(['new']);
  });
});

describe('persisted state', () => {
  it('survives a reload and continues from the saved state with a delta', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'store-'));
    const file = path.join(dir, 's.db');
    try {
      const server = new FakeJmap();
      for (let i = 0; i < 50; i += 1) server.addEmail();
      const first = openFileStore(file);
      await engineFor(server, first).requestSync();
      first.close();

      server.addEmail({ id: 'after-reload' });
      server.calls.length = 0;
      const second = openFileStore(file);
      await engineFor(server, second).requestSync();
      expect(second.get('SELECT id FROM email WHERE id = ?', ['after-reload'])).toBeTruthy();
      expect(count(second, 'email')).toBe(51);
      // A delta, not another full listing.
      expect(callsNamed(server, 'Email/query')).toHaveLength(0);
      expect(callsNamed(server, 'Email/changes').length).toBeGreaterThan(0);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resumes an interrupted full sync from its cursor', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'store-'));
    const file = path.join(dir, 's.db');
    try {
      const server = new FakeJmap();
      for (let i = 0; i < 4500; i += 1) server.addEmail();
      const first = openFileStore(file);
      // Goes down after the first page of the list.
      server.beforeRequest = (n) => {
        if (n === 4) server.offline = true;
      };
      await engineFor(server, first).requestSync();
      const listed = count(first, 'email');
      expect(listed).toBeGreaterThan(0);
      expect(listed).toBeLessThan(4500);
      first.close();

      server.offline = false;
      server.beforeRequest = null;
      server.calls.length = 0;
      const second = openFileStore(file);
      await engineFor(server, second).requestSync();
      expect(count(second, 'email')).toBe(4500);
      const firstQuery = callsNamed(server, 'Email/query')[0];
      expect(firstQuery[1]).toMatchObject({ anchorOffset: 1 });
      expect(second.get<{ id: string }>('SELECT id FROM email WHERE id = ?', [firstQuery[1].anchor as string])).toBeTruthy();
      expect(firstQuery[1]).not.toHaveProperty('position');
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('a full pass while the server changes', () => {
  // Newest first, four pages of 500 to a request: the second request starts at 2000.
  function bigServer() {
    const server = new FakeJmap();
    for (let i = 0; i < 2600; i += 1) server.addEmail({ id: `m${i}` });
    return server;
  }

  it('misses no message when something before its place is deleted, which would shift positions', async () => {
    const server = bigServer();
    const db = openMemoryStore();
    let deleted = false;
    server.beforeRequest = () => {
      // Once the first request of the list has been answered: the newest
      // message, long passed by the pass.
      if (!deleted && callsNamed(server, 'Email/query').length >= 4) {
        deleted = true;
        server.destroyEmail('m2599');
      }
    };
    await engineFor(server, db).requestSync();
    expect(deleted).toBe(true);
    expect(count(db, 'email')).toBe(2599);
    for (let i = 0; i < 2599; i += 1) expect(db.get('SELECT 1 AS x FROM email WHERE id = ?', [`m${i}`])).toBeTruthy();
  });

  it('goes back to positions, with an overlap, when the anchor itself is deleted', async () => {
    const server = bigServer();
    const db = openMemoryStore();
    let deleted = false;
    server.beforeRequest = () => {
      if (deleted || server.calls.filter(([n]) => n === 'Email/query').length < 4) return;
      deleted = true;
      // The last id of the first request, and one before it.
      const newestFirst = [...server.emails.keys()].reverse();
      server.destroyEmail(newestFirst[1999]);
      server.destroyEmail(newestFirst[0]);
    };
    await engineFor(server, db).requestSync();
    expect(deleted).toBe(true);
    expect(count(db, 'email')).toBe(2598);
    expect(callsNamed(server, 'Email/query').some(([, args]) => args.anchor === undefined && Number(args.position) > 0)).toBe(true);
    expect(server.emails.size).toBe(2598);
    for (const id of server.emails.keys()) expect(db.get('SELECT 1 AS x FROM email WHERE id = ?', [id])).toBeTruthy();
  });

  it('keeps what a pass missed but the server still has, and drops only what is gone or out of the window', async () => {
    const server = new FakeJmap();
    server.addEmail({ id: 'stays', subject: 'Before', receivedAt: '2026-11-01T00:00:00Z' });
    server.addEmail({ id: 'gone', receivedAt: '2026-11-01T00:00:01Z' });
    server.addEmail({ id: 'old', receivedAt: '2026-10-01T00:00:00Z' });
    const db = openMemoryStore();
    const engine = new AccountEngine({
      account: 'a@fake.test', db, session: FAKE_SESSION, transport: server, areas: [mailArea],
      scope: { ...DEFAULT_SCOPE, days: null }, now: () => Date.UTC(2026, 10, 3), sleep: async () => {},
    });
    await engine.requestSync();
    expect(count(db, 'email')).toBe(3);

    // A start over, in a narrower window, where paging misses `stays`.
    engine.setScope({ ...DEFAULT_SCOPE, days: 10 });
    server.hiddenFromQuery.add('stays');
    server.updateEmail('stays', { subject: 'After' });
    server.destroyEmail('gone');
    server.truncateLog('Email');
    server.calls.length = 0;
    await engine.requestSync();
    expect(db.all('SELECT id FROM email').map((row) => row.id)).toEqual(['stays']);
    expect(JSON.parse(String(db.get<{ json: string }>('SELECT json FROM email WHERE id = ?', ['stays'])?.json)).subject).toBe('After');
    // Its text wasn't thrown away either.
    expect(count(db, 'email_body')).toBe(1);
    expect(callsNamed(server, 'Email/get').some(([, args]) => (args.ids as string[] | undefined)?.includes('gone'))).toBe(true);
  });

  it('picks the check up again after a stop, and asks 500 at a time', async () => {
    const server = new FakeJmap();
    for (let i = 0; i < 700; i += 1) server.addEmail({ id: `m${i}` });
    const db = openMemoryStore();
    const engine = engineFor(server, db);
    await engine.requestSync();
    for (let i = 0; i < 700; i += 1) server.hiddenFromQuery.add(`m${i}`);
    server.truncateLog('Email');
    server.calls.length = 0;
    let gets = 0;
    server.beforeRequest = () => {
      if (callsNamed(server, 'Email/get').filter(([, args]) => Array.isArray(args.ids) && (args.ids as string[]).length > 0).length > gets) gets += 1;
      if (gets === 1) server.offline = true;
    };
    await engine.requestSync();
    expect(count(db, 'email')).toBe(700);
    server.offline = false;
    server.beforeRequest = null;
    await engine.requestSync();
    expect(count(db, 'email')).toBe(700);
    const sizes = callsNamed(server, 'Email/get').map(([, args]) => (args.ids as string[] | undefined)?.length ?? 0);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(500);
    // The pass finished: back to /changes.
    server.calls.length = 0;
    await engine.requestSync();
    expect(callsNamed(server, 'Email/query')).toHaveLength(0);
  });
});

describe('deltas', () => {
  it('applies created, updated and destroyed, and leaves bodies alone on an update', async () => {
    const server = new FakeJmap();
    const a = server.addEmail();
    const b = server.addEmail();
    const db = openMemoryStore();
    const engine = engineFor(server, db);
    await engine.requestSync();

    server.updateEmail(a.id, { keywords: { $seen: true } });
    server.destroyEmail(b.id);
    server.addEmail({ id: 'c' });
    await engine.requestSync();

    expect(db.all('SELECT id FROM email ORDER BY id').map((r) => r.id)).toEqual(['c', a.id]);
    expect(db.get('SELECT 1 AS x FROM email_keyword WHERE keyword = ?', ['$seen'])).toBeTruthy();
    const kept = db.get<{ body_state: number }>('SELECT body_state FROM email WHERE id = ?', [a.id]);
    expect(kept?.body_state).toBe(1);
    // The destroyed message left nothing behind in the search index.
    expect(db.all("SELECT rowid FROM email_fts_word WHERE email_fts_word MATCH ?", [`"Subject" `]).length).toBe(2);
  });

  it('pages through more changes than one call gives', async () => {
    const server = new FakeJmap();
    server.addEmail();
    const db = openMemoryStore();
    const engine = engineFor(server, db);
    await engine.requestSync();
    server.calls.length = 0;
    for (let i = 0; i < 1500; i += 1) server.addEmail();
    await engine.requestSync();
    expect(count(db, 'email')).toBe(1501);
    expect(callsNamed(server, 'Email/changes').length).toBeGreaterThanOrEqual(3);
    const page = callsNamed(server, 'Email/changes')[0][1];
    expect(page.maxChanges).toBe(500);
  });

  it('sends sinceState last, because a malformed one otherwise fails the whole request on Stalwart', async () => {
    const server = new FakeJmap();
    server.addEmail();
    const engine = engineFor(server);
    await engine.requestSync();
    server.addEmail();
    server.calls.length = 0;
    await engine.requestSync();
    const keys = Object.keys(callsNamed(server, 'Email/changes')[0][1]);
    expect(keys[keys.length - 1]).toBe('sinceState');
  });

  it('keeps going while behind the pushed state, since hasMoreChanges false does not mean caught up', async () => {
    const server = new FakeJmap();
    server.addEmail();
    const applied: string[] = [];
    let wrote = false;
    const outcome = await runChangesLoop({
      transport: server,
      type: 'Email',
      jmap: JMAP_ACCOUNT,
      using: [],
      since: 's0',
      target: 's2',
      apply: async (page) => {
        applied.push(page.newState);
        if (!wrote) {
          wrote = true;
          server.addEmail();
        }
      },
    });
    expect(outcome).toMatchObject({ outcome: 'caughtUp', state: 's2' });
    expect(applied).toEqual(['s1', 's2']);
  });

  it('stops when the state stands still even though the push named a newer one', async () => {
    const server = new FakeJmap();
    server.addEmail();
    const outcome = await runChangesLoop({
      transport: server, type: 'Email', jmap: JMAP_ACCOUNT, using: [], since: 's1', target: 's9',
      apply: async () => {},
    });
    expect(outcome.outcome).toBe('caughtUp');
    expect(server.requests).toBe(1);
  });
});

describe('resync', () => {
  it('starts Email over on cannotCalculateChanges, keeps bodies, and drops what is gone', async () => {
    const server = new FakeJmap();
    const keep = server.addEmail({ id: 'keep' });
    server.addEmail({ id: 'gone' });
    const db = openMemoryStore();
    const engine = engineFor(server, db);
    await engine.requestSync();

    server.destroyEmail('gone');
    server.updateEmail(keep.id, { keywords: { $flagged: true } });
    server.truncateLog('Email');
    server.calls.length = 0;
    await engine.requestSync();

    expect(callsNamed(server, 'Email/query').length).toBeGreaterThan(0);
    expect(db.all('SELECT id FROM email').map((r) => r.id)).toEqual(['keep']);
    expect(db.get('SELECT 1 AS x FROM email_keyword WHERE keyword = ?', ['$flagged'])).toBeTruthy();
    // The body wasn't fetched a second time.
    const bodyFetches = callsNamed(server, 'Email/get').filter(([, a]) => a.fetchTextBodyValues);
    expect(bodyFetches).toHaveLength(0);
    expect(count(db, 'email_body')).toBe(1);
  });

  it.each([
    ['invalidArguments', { jmapError: 'invalidArguments' }],
    ['cannotCalculateChanges', { jmapError: 'cannotCalculateChanges' }],
  ])('treats %s as a reason to start over', async (_name, thrown) => {
    const server = new FakeJmap();
    const original = server.request.bind(server);
    let refused = false;
    server.request = async (calls) => {
      if (!refused && calls[0][0] === 'Email/changes') {
        refused = true;
        return { methodResponses: [['error', { type: thrown.jmapError }, 'c']] };
      }
      return original(calls);
    };
    const outcome = await runChangesLoop({ transport: server, type: 'Email', jmap: JMAP_ACCOUNT, using: [], since: 's0', apply: async () => {} });
    expect(outcome.outcome).toBe('resync');
  });

  it('treats an HTTP 400 notRequest as a reason to start over, not as an outage', async () => {
    const server = new FakeJmap();
    server.request = async () => {
      throw new TransportError('http', 'bad', 400, 'urn:ietf:params:jmap:error:notRequest');
    };
    const outcome = await runChangesLoop({ transport: server, type: 'Email', jmap: JMAP_ACCOUNT, using: [], since: 's0', apply: async () => {} });
    expect(outcome.outcome).toBe('resync');
  });

  it('never sends a stored state a server cannot have sent', async () => {
    const server = new FakeJmap();
    const outcome = await runChangesLoop({ transport: server, type: 'Email', jmap: JMAP_ACCOUNT, using: [], since: 'bad state\n', apply: async () => {} });
    expect(outcome.outcome).toBe('resync');
    expect(server.requests).toBe(0);
  });
});

describe('when the server is busy or gone', () => {
  it('backs off and carries on after a 429', async () => {
    const server = new FakeJmap();
    server.addEmail();
    server.busyNext = 2;
    const db = openMemoryStore();
    await engineFor(server, db).requestSync();
    expect(count(db, 'email')).toBe(1);
  });

  it('ends the run quietly when the network is gone, and picks up when back', async () => {
    const server = new FakeJmap();
    server.addEmail();
    server.offline = true;
    const events: StoreEvent[] = [];
    const db = openMemoryStore();
    const engine = engineFor(server, db, (e) => events.push(e));
    await engine.requestSync();
    expect(count(db, 'email')).toBe(0);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    server.offline = false;
    await engine.requestSync();
    expect(count(db, 'email')).toBe(1);
  });

  it('tells the page about new mail only for messages it had not seen', async () => {
    const server = new FakeJmap();
    server.addEmail();
    const events: StoreEvent[] = [];
    const engine = engineFor(server, openMemoryStore(), (e) => events.push(e));
    await engine.requestSync();
    expect(events.filter((e) => e.type === 'created')).toHaveLength(0);
    server.addEmail({ id: 'fresh' });
    await engine.requestSync();
    expect(events.filter((e) => e.type === 'created')).toEqual([
      { type: 'created', account: 'a@fake.test', jmap: JMAP_ACCOUNT, collection: 'Email', ids: ['fresh'] },
    ]);
  });
});

describe('query plans', () => {
  it('reads a newest-first folder page off the index, without sorting the folder', async () => {
    const server = new FakeJmap();
    for (let i = 0; i < 30; i += 1) server.addEmail();
    const db = openMemoryStore();
    const engine = engineFor(server, db);
    await engine.requestSync();
    const seen: string[] = [];
    const spied = {
      ...db,
      all: <T extends object>(sql: string, params?: readonly SqlValue[]) => {
        seen.push(sql);
        return db.all<T>(sql, params);
      },
    };
    const answer = await answerRequest(
      { account: 'a', db: spied as typeof db, session: FAKE_SESSION, scope: EVERYTHING, now: Date.now, emit: () => {}, overlay: (_jmap, _type, records) => records, defaultJmap: JMAP_ACCOUNT, invertedKeywordSort: false },
      buildMethodTable([mailArea]),
      [['Email/query', { filter: INBOX, sort: [{ property: 'receivedAt', isAscending: false }], limit: 5 }, 'q']],
    );
    expect(answer?.methodResponses[0][1].ids).toHaveLength(5);
    const [sql] = seen;
    const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, [JMAP_ACCOUNT, 'inbox', 5, 0]).map((row) => row.detail).join('; ');
    expect(plan).not.toContain('TEMP B-TREE');
    expect(plan).toContain('email_mailbox_list');
    // The folder condition isn't looked up again for every row.
    expect(sql).not.toContain('m.mailbox_id');
  });
});

describe('a failure inside a transaction', () => {
  it('reports the real error even when SQLite has already rolled back', () => {
    const db = openMemoryStore();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    expect(() => db.transaction(() => {
      db.exec('ROLLBACK');
      throw new Error('disk is full');
    })).toThrow('disk is full');
    // And the connection still works.
    db.transaction(() => db.run('INSERT INTO t (id) VALUES (1)'));
    expect(db.all('SELECT id FROM t')).toHaveLength(1);
  });
});

describe('calls into an area', () => {
  const noteArea = {
    name: 'note',
    migrations: [{ id: 9999, name: 'note', sql: 'CREATE TABLE note (id INTEGER PRIMARY KEY, text TEXT)' }],
    methods: {},
    syncers: [],
    calls: {
      'note.add': (ctx: StoreContext, params: { text: string }) => ctx.db.run('INSERT INTO note (text) VALUES (?)', [params.text]).lastInsertRowid,
    },
  };

  it('reaches the area and runs its migration', async () => {
    const engine = new AccountEngine({
      account: 'a@fake.test', db: openMemoryStore(), session: FAKE_SESSION, transport: new FakeJmap(), areas: [mailArea, noteArea], scope: EVERYTHING,
    });
    expect(await engine.areaCall('note.add', { text: 'hello' })).toBe(1);
    await expect(engine.areaCall('note.nothing', {})).rejects.toThrow('Unknown store call');
  });

  it('refuses two areas defining the same name', () => {
    expect(() => new AccountEngine({
      account: 'a@fake.test', db: openMemoryStore(), session: FAKE_SESSION, transport: new FakeJmap(),
      areas: [noteArea, { ...noteArea, name: 'other', migrations: [] }], scope: EVERYTHING,
    })).toThrow('Two store areas define note.add');
  });
});

describe('answers from the store', () => {
  async function seeded() {
    const server = new FakeJmap();
    server.addEmail({ id: 'one', subject: 'Zahlungserinnerung Rechnungsbetrag', keywords: { $seen: true } });
    server.addEmail({ id: 'two', subject: 'Hello', mailboxIds: { inbox: true }, bodyValues: { 1: { value: 'See you Tuesday' } } });
    const db = openMemoryStore();
    const engine = engineFor(server, db);
    await engine.requestSync();
    return { engine, db, server };
  }

  it('gives every call its own answer, in order, with a per-call error for what it cannot answer', async () => {
    const { engine } = await seeded();
    const answer = await engine.answer([
      ['Email/query', { filter: INBOX, sort: [{ property: 'receivedAt', isAscending: false }], calculateTotal: true }, 'a'],
      ['SieveScript/get', {}, 'b'],
      ['Email/get', { '#ids': { resultOf: 'a', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject'] }, 'c'],
    ]);
    expect(answer?.methodResponses.map(([name, , id]) => [name, id])).toEqual([
      ['Email/query', 'a'], ['error', 'b'], ['Email/get', 'c'],
    ]);
    expect(answer?.methodResponses[0][1]).toMatchObject({ ids: ['two', 'one'], total: 2, position: 0 });
    expect(answer?.methodResponses[1][1].type).toBe('serverUnavailable');
    expect(answer?.methodResponses[2][1].list).toEqual([
      { id: 'two', subject: 'Hello' },
      { id: 'one', subject: 'Zahlungserinnerung Rechnungsbetrag' },
    ]);
  });

  it('answers null when nothing in the request could be answered', async () => {
    const { engine } = await seeded();
    expect(await engine.answer([['SieveScript/get', {}, 'a']])).toBeNull();
  });

  it('finds a German compound from inside the word, and a word start', async () => {
    const { engine } = await seeded();
    const search = async (text: string) => (await engine.answer([['Email/query', { filter: { text } }, 'q']]))?.methodResponses[0][1].ids;
    expect(await search('rechnung')).toEqual(['one']);
    expect(await search('erinnerung')).toEqual(['one']);
    expect(await search('zahl*')).toEqual(['one']);
    expect(await search('tuesday')).toEqual(['two']);
    expect(await search('nichtda')).toEqual([]);
  });

  it('reads keyword sort the way the client sends it for that server', async () => {
    const { engine } = await seeded();
    const sorted = async () => (await engine.answer([['Email/query', {
      filter: INBOX,
      sort: [{ property: 'hasKeyword', keyword: '$seen', isAscending: false }],
    }, 'q']]))?.methodResponses[0][1].ids;
    expect(await sorted()).toEqual(['one', 'two']);
    engine.setInvertedKeywordSort(true);
    expect(await sorted()).toEqual(['two', 'one']);
  });

  it('does not make up a message with empty text when the body is not kept', async () => {
    const { engine, db } = await seeded();
    db.run('DELETE FROM email_body');
    const answer = await engine.answer([['Email/get', { ids: ['one'], fetchTextBodyValues: true }, 'g']]);
    expect(answer?.methodResponses[0][1]).toMatchObject({ list: [], notFound: ['one'] });
  });

  it('answers with the real server state, never a made-up one', async () => {
    const { engine, server } = await seeded();
    const answer = await engine.answer([['Email/get', { ids: ['one'], properties: ['id'] }, 'g']]);
    expect(answer?.methodResponses[0][1].state).toBe(server.coll.Email.state());
  });
});
