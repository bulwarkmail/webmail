// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCOPE } from '../area';
import { AccountEngine } from '../engine/account-engine';
import { metaGet } from '../engine/core-schema';
import { mailArea } from '../mail';
import { outboxArea } from '../outbox';
import type { StorageAdapter } from '../storage';
import { FAKE_SESSION, FakeJmap, JMAP_ACCOUNT } from './helpers/fake-jmap';
import { FakeJmapMail } from './helpers/fake-jmap-mail';
import { openMemoryStore } from './helpers/node-adapter';

/** Every statement that changed a row. A commit on OPFS costs a journal and a flush. */
function writesOf(db: StorageAdapter) {
  const writes: string[] = [];
  const run = db.run.bind(db);
  db.run = (sql, params) => {
    const result = run(sql, params);
    // One that changed no row dirtied no page, so there is nothing to commit for it.
    if (result.changes > 0) writes.push(sql);
    return result;
  };
  return writes;
}

const SCOPE = { ...DEFAULT_SCOPE, days: null };
/** With identities and quotas, which every pass asks for too. */
const FULL_SESSION = {
  ...FAKE_SESSION,
  accounts: {
    [JMAP_ACCOUNT]: {
      name: 'a@example.org',
      isPersonal: true,
      accountCapabilities: { 'urn:ietf:params:jmap:mail': {}, 'urn:ietf:params:jmap:submission': {}, 'urn:ietf:params:jmap:quota': {} },
    },
  },
};

function open(db: StorageAdapter, server: FakeJmap, session = FAKE_SESSION) {
  return new AccountEngine({
    account: 'a@fake.test', db, session, transport: server, areas: [mailArea, outboxArea],
    scope: SCOPE, invertedKeywordSort: false, sleep: async () => {},
  });
}

describe('opening a kept store', () => {
  it('writes nothing when nothing changed since the last time', async () => {
    const db = openMemoryStore();
    const server = new FakeJmap();
    server.addEmail({ subject: 'Hallo' });
    const first = open(db, server);
    await first.requestSync();
    await first.close();
    const writes = writesOf(db);
    open(db, server);
    expect(writes).toEqual([]);
  });

  it('still keeps what did change', async () => {
    const db = openMemoryStore();
    const server = new FakeJmap();
    await open(db, server).close();
    const moved = { ...FAKE_SESSION, apiUrl: 'https://elsewhere.test/jmap/' };
    const writes = writesOf(db);
    open(db, server, moved);
    expect(writes.length).toBeGreaterThan(0);
    expect(JSON.parse(metaGet(db, 'session') ?? '{}').apiUrl).toBe('https://elsewhere.test/jmap/');
  });
});

describe('a pass that finds nothing new', () => {
  it('writes nothing', async () => {
    const db = openMemoryStore();
    const server = new FakeJmapMail({ mailboxes: [{ id: 'inbox', role: 'inbox' }] });
    server.addEmail({ subject: 'Hallo', mailboxIds: { inbox: true } });
    server.quotas.push({ id: 'q', used: 10, hardLimit: 100 });
    server.identities.set('i1', { id: 'i1', email: 'a@example.org', name: 'A' });
    const engine = open(db, server, FULL_SESSION);
    await engine.requestSync();
    await engine.requestSync();
    const writes = writesOf(db);
    await engine.requestSync();
    expect(writes).toEqual([]);
  });

  it('still keeps a quota that moved', async () => {
    const server = new FakeJmapMail();
    server.quotas.push({ id: 'q', used: 10, hardLimit: 100 });
    const engine = open(openMemoryStore(), server, FULL_SESSION);
    await engine.requestSync();
    server.quotas[0] = { id: 'q', used: 20, hardLimit: 100 };
    await engine.requestSync();
    const answer = await engine.answer([['Quota/get', { accountId: JMAP_ACCOUNT, ids: null }, 'q']]);
    expect(answer?.methodResponses[0][1].list).toEqual([{ id: 'q', used: 20, hardLimit: 100 }]);
  });
});
