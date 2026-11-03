// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { textFilter } from '@/lib/jmap/search-utils';
import { DEFAULT_SCOPE, type StoreEvent } from '../area';
import { contactsArea } from '../contacts';
import { applyPatch, mergePatches } from '../contacts/patch';
import { AccountEngine } from '../engine/account-engine';
import type { MethodCall } from '../engine/transport';
import type { StorageAdapter } from '../storage';
import { JMAP_ACCOUNT } from './helpers/fake-jmap';
import { CONTACTS_SESSION, FakeContacts, MAIL_ONLY_ACCOUNT, SHARED_ACCOUNT } from './helpers/fake-contacts';
import { openFileStore, openMemoryStore } from './helpers/node-adapter';

function engineFor(server: FakeContacts, db: StorageAdapter = openMemoryStore(), emit?: (e: StoreEvent) => void) {
  return new AccountEngine({
    account: 'a@fake.test',
    db,
    session: CONTACTS_SESSION,
    transport: server,
    areas: [contactsArea],
    scope: DEFAULT_SCOPE,
    emit,
    now: () => Date.UTC(2026, 10, 3),
    sleep: async () => {},
  });
}

async function synced(server: FakeContacts) {
  const db = openMemoryStore();
  const engine = engineFor(server, db);
  await engine.requestSync();
  return { db, engine };
}

function count(db: StorageAdapter, table: string): number {
  return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- answers are shaped like the server's */
async function call(engine: AccountEngine, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await engine.answer([[name, { accountId: JMAP_ACCOUNT, ...args }, '0']]);
  if (!response) throw new Error('nothing answered');
  const [answered, result] = response.methodResponses[0];
  if (answered === 'error') throw new Error(result.type);
  return result;
}

/** The client's searchContacts: its filter, limit 50, then a get on the query's ids. */
async function search(engine: AccountEngine, query: string, accountId = JMAP_ACCOUNT): Promise<string[]> {
  const calls: MethodCall[] = [
    ['ContactCard/query', { accountId, filter: textFilter(query), limit: 50 }, '0'],
    ['ContactCard/get', { accountId, '#ids': { resultOf: '0', name: 'ContactCard/query', path: '/ids' } }, '1'],
  ];
  const response = await engine.answer(calls);
  return (response?.methodResponses[1][1].list as Array<{ name: { full: string } }>).map((c) => c.name.full);
}

function setCalls(server: FakeContacts): Array<Record<string, any>> {
  return server.calls.filter(([name]) => name === 'ContactCard/set').map(([, args]) => args as Record<string, any>);
}

describe('contacts sync', () => {
  it('pages every card of every account with the capability, and only those', async () => {
    const server = new FakeContacts();
    server.addBook({ id: 'teambook', name: 'Team' }, SHARED_ACCOUNT);
    for (let i = 0; i < 2345; i += 1) server.addCard();
    server.addCard({ id: 'c1', name: { full: 'Same id in the shared account' } }, SHARED_ACCOUNT);
    server.addCard({}, MAIL_ONLY_ACCOUNT);
    const { db } = await synced(server);

    expect(Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contact_card WHERE jmap = ?', [JMAP_ACCOUNT])?.n)).toBe(2345);
    expect(Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contact_card WHERE jmap = ?', [SHARED_ACCOUNT])?.n)).toBe(1);
    expect(Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contact_card WHERE jmap = ?', [MAIL_ONLY_ACCOUNT])?.n)).toBe(0);
    // Same id in two accounts stays two cards.
    const names = db.all<{ json: string }>("SELECT json FROM contact_card WHERE id = 'c1' ORDER BY jmap").map((r) => (JSON.parse(r.json) as { name: { full: string } }).name.full);
    expect(names).toHaveLength(2);
    for (const [name, args] of server.calls) {
      if (name === 'ContactCard/query') expect(args.limit).toBeLessThanOrEqual(500);
    }
  });

  it('continues a stopped full sync from its cursor after a reload', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'store-contacts-'));
    try {
      const file = path.join(dir, 's.db');
      const server = new FakeContacts();
      for (let i = 0; i < 2600; i += 1) server.addCard();
      const first = openFileStore(file);
      const engine = engineFor(server, first);
      let queries = 0;
      server.beforeRequest = () => {
        queries += 1;
        // The address book call and the state capture, then one page of 2000: the network goes.
        if (queries === 4) server.offline = true;
      };
      await engine.requestSync();
      await engine.close();
      expect(count(first, 'contact_card')).toBe(2000);
      first.close();

      server.offline = false;
      server.beforeRequest = null;
      server.calls.length = 0;
      const second = openFileStore(file);
      await engineFor(server, second).requestSync();
      expect(count(second, 'contact_card')).toBe(2600);
      const positions = server.calls.filter(([name]) => name === 'ContactCard/query').map(([, args]) => args.position);
      expect(positions[0]).toBe(2000);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies created, updated and destroyed cards as deltas, across pages', async () => {
    const server = new FakeContacts();
    const a = server.addCard({ name: { full: 'Anna' } });
    const b = server.addCard({ name: { full: 'Bernd' } });
    const { db, engine } = await synced(server);
    server.calls.length = 0;

    for (let i = 0; i < 1200; i += 1) server.addCard();
    server.editCard(a.id, { name: { full: 'Anna Neu' } });
    server.removeCard(b.id);
    await engine.requestSync();

    expect(server.calls.filter(([name]) => name === 'ContactCard/changes').length).toBeGreaterThan(1);
    expect(server.calls.some(([name]) => name === 'ContactCard/query')).toBe(false);
    expect(count(db, 'contact_card')).toBe(1201);
    expect(await search(engine, 'anna')).toEqual(['Anna Neu']);
    expect(await search(engine, 'bernd')).toEqual([]);
  });

  it('follows address book changes', async () => {
    const server = new FakeContacts();
    const { engine } = await synced(server);
    server.addBook({ id: 'book2', name: 'Work' });
    await engine.requestSync();
    expect(server.calls.some(([name]) => name === 'AddressBook/changes')).toBe(true);
    const books = await call(engine, 'AddressBook/get', {});
    expect(books.list.map((b: { id: string }) => b.id).sort()).toEqual(['book1', 'book2']);
  });

  it('starts over when the server can no longer give changes, and drops what it no longer has', async () => {
    const server = new FakeContacts();
    const gone = server.addCard({ name: { full: 'Gone' } });
    const kept = server.addCard({ name: { full: 'Kept' } });
    const { db, engine } = await synced(server);
    server.removeCard(gone.id);
    server.account().coll.ContactCard.truncatedBelow = server.account().coll.ContactCard.log.length;
    await engine.requestSync();
    expect(db.all('SELECT id FROM contact_card').map((r) => r.id)).toEqual([kept.id]);
  });

  it('keeps a queued create through a resync', async () => {
    const server = new FakeContacts();
    server.addCard();
    const { db, engine } = await synced(server);
    const { created } = await call(engine, 'ContactCard/set', { create: { n: { name: { full: 'Offline' }, addressBookIds: { book1: true } } } });
    // The create can't go out yet, and the sweep of a full sync must not take
    // it for something the server deleted.
    server.refuse.set(created.n.uid, { type: 'serverFail' });
    db.run("UPDATE sync_state SET state = 'bad state!' WHERE type = 'ContactCard'");
    await engine.requestSync();
    expect(await search(engine, 'offline')).toEqual(['Offline']);
    server.refuse.clear();
    await engine.requestSync();
    expect(await search(engine, 'offline')).toEqual(['Offline']);
    expect([...server.account().cards.values()].filter((c) => (c.name as { full: string }).full === 'Offline')).toHaveLength(1);
  });
});

describe('contact answers', () => {
  it('says so instead of answering empty when nothing was synced yet', async () => {
    const engine = engineFor(new FakeContacts());
    const response = await engine.answer([['ContactCard/query', { accountId: JMAP_ACCOUNT, limit: 50 }, '0'], ['AddressBook/get', { accountId: JMAP_ACCOUNT }, '1']]);
    expect(response).toBeNull();
  });

  it('gives the last server state, never a made-up one, and asked-for properties only', async () => {
    const server = new FakeContacts();
    const card = server.addCard();
    const { engine } = await synced(server);
    const got = await call(engine, 'ContactCard/get', { ids: [card.id, 'nope'], properties: ['uid'] });
    expect(got.state).toBe(server.account().coll.ContactCard.state());
    expect(got.list).toEqual([{ id: card.id, uid: card.uid }]);
    expect(got.notFound).toEqual(['nope']);
    const books = await call(engine, 'AddressBook/get', { properties: ['name'] });
    expect(books.state).toBe(server.account().coll.AddressBook.state());
    expect(books.list).toEqual([{ id: 'book1', name: 'book1' }]);
  });

  it('pages a query with total and filters by address book', async () => {
    const server = new FakeContacts();
    server.addBook({ id: 'book2', name: 'Work' });
    for (let i = 0; i < 5; i += 1) server.addCard({ addressBookIds: { book1: true } });
    server.addCard({ addressBookIds: { book2: true } });
    const { engine } = await synced(server);
    const page = await call(engine, 'ContactCard/query', { position: 2, limit: 2, calculateTotal: true });
    expect(page.ids).toHaveLength(2);
    expect(page.position).toBe(2);
    expect(page.total).toBe(6);
    const work = await call(engine, 'ContactCard/query', { filter: { inAddressBook: 'book2' } });
    expect(work.ids).toHaveLength(1);
  });

  it('refuses a filter it cannot read, for that call only', async () => {
    const server = new FakeContacts();
    server.addCard();
    const { engine } = await synced(server);
    const response = await engine.answer([
      ['ContactCard/query', { accountId: JMAP_ACCOUNT, filter: { phone: '123' } }, '0'],
      ['AddressBook/get', { accountId: JMAP_ACCOUNT }, '1'],
    ]);
    expect(response?.methodResponses[0][0]).toBe('error');
    expect(response?.methodResponses[0][1].type).toBe('unsupportedFilter');
    expect(response?.methodResponses[1][0]).toBe('AddressBook/get');
  });
});

describe('autocomplete', () => {
  async function people() {
    const server = new FakeContacts();
    server.addCard({
      name: { full: 'Jörg Müller-Lüdenscheidt', components: [{ kind: 'given', value: 'Jörg' }, { kind: 'surname', value: 'Müller-Lüdenscheidt' }] },
      emails: { e: { address: 'joerg.mueller@example.org' } },
      organizations: { o: { name: 'Bäckerei Straße', units: [{ name: 'Backstube' }] } },
    });
    server.addCard({ name: { full: 'Johannes Weiß' }, emails: { e: { address: 'jw@firma.example' } } });
    server.addCard({ name: { full: 'José Ñandú' }, nicknames: { n: { name: 'Pepe' } } });
    server.addCard({ name: { components: [{ kind: 'given', value: 'Hartmann' }] }, emails: { e: { address: 'h@x.example' } } });
    server.addCard({ name: { full: 'Käthe Schön' } });
    return synced(server);
  }

  it.each([
    ['Müller', 'Jörg Müller-Lüdenscheidt'],
    ['müll', 'Jörg Müller-Lüdenscheidt'],
    ['MÜLLER', 'Jörg Müller-Lüdenscheidt'],
    ['muller', 'Jörg Müller-Lüdenscheidt'],
    ['mueller', 'Jörg Müller-Lüdenscheidt'],
    ['joerg', 'Jörg Müller-Lüdenscheidt'],
    ['lüden', 'Jörg Müller-Lüdenscheidt'],
    ['bäck', 'Jörg Müller-Lüdenscheidt'],
    ['strasse', 'Jörg Müller-Lüdenscheidt'],
    ['Straße', 'Jörg Müller-Lüdenscheidt'],
    ['backstube', 'Jörg Müller-Lüdenscheidt'],
    ['schoen', 'Käthe Schön'],
    ['kaethe', 'Käthe Schön'],
    ['schon', 'Käthe Schön'],
    ['SCHÖN', 'Käthe Schön'],
    ['hannes', 'Johannes Weiß'],
    ['weiss', 'Johannes Weiß'],
    ['firma', 'Johannes Weiß'],
    ['jw@firma', 'Johannes Weiß'],
    ['jose', 'José Ñandú'],
    ['nandu', 'José Ñandú'],
    ['pepe', 'José Ñandú'],
    ['jö mül', 'Jörg Müller-Lüdenscheidt'],
    ['"Jörg Müller"', 'Jörg Müller-Lüdenscheidt'],
    ['jö', null],
    ['jo*', null],
  ])('finds %s', async (query, expected) => {
    const { engine } = await people();
    const found = await search(engine, query);
    if (expected) expect(found).toEqual([expected]);
    else expect(found.length).toBeGreaterThan(1);
  });

  it('does not match words that only share a start with another card', async () => {
    const { engine } = await people();
    expect(await search(engine, 'mül weiß')).toEqual([]);
    expect(await search(engine, 'xyz')).toEqual([]);
    expect(await search(engine, '*')).toEqual([]);
  });

  it('finds a card by a component when it has no full name', async () => {
    const { db, engine } = await people();
    expect(await call(engine, 'ContactCard/query', { filter: { text: 'hart' } })).toMatchObject({ ids: [expect.any(String)] });
    expect(db.get<{ sort_key: string }>("SELECT sort_key FROM contact_card WHERE json LIKE '%Hartmann%'")?.sort_key).toBe('hartmann');
  });

  it('lists names starting with the text before names containing it, and stops at the limit', async () => {
    const server = new FakeContacts();
    for (let i = 0; i < 60; i += 1) server.addCard({ name: { full: `Aanna ${String(i).padStart(2, '0')}` } });
    server.addCard({ name: { full: 'Zoe Anna' } });
    const { engine } = await synced(server);
    const found = await search(engine, 'anna');
    expect(found).toHaveLength(50);
    expect(found[0]).toBe('Zoe Anna');
  });

  it('keeps accounts apart', async () => {
    const server = new FakeContacts();
    server.addCard({ name: { full: 'Own Person' } });
    server.addBook({ id: 'teambook', name: 'Team' }, SHARED_ACCOUNT);
    server.addCard({ name: { full: 'Team Person' } }, SHARED_ACCOUNT);
    const { engine } = await synced(server);
    expect(await search(engine, 'person')).toEqual(['Own Person']);
    expect(await search(engine, 'person', SHARED_ACCOUNT)).toEqual(['Team Person']);
  });

  it('finds the new name and not the old after an edit is queued', async () => {
    const server = new FakeContacts();
    const card = server.addCard({ name: { full: 'Oldname' } });
    const { engine } = await synced(server);
    await call(engine, 'ContactCard/set', { update: { [card.id]: { name: { full: 'Newname' } } } });
    expect(await search(engine, 'newname')).toEqual(['Newname']);
    expect(await search(engine, 'oldname')).toEqual([]);
  });
});

describe('patches', () => {
  it('applies pointers and removes on null, leaving the original alone', () => {
    const card = { name: { full: 'A', given: 'B' }, note: 'x' };
    const out = applyPatch(card, { 'name/full': 'C', note: null, 'a~1b': 1 });
    expect(out).toEqual({ name: { full: 'C', given: 'B' }, 'a/b': 1 });
    expect(card.name.full).toBe('A');
    expect(() => applyPatch(card, { 'missing/x': 1 })).toThrow();
  });

  it('merges: newer wins, a whole property replaces what is below it, a path goes into an older whole value', () => {
    expect(mergePatches({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
    expect(mergePatches({ 'name/full': 'A', 'name/given': 'B' }, { name: { full: 'C' } })).toEqual({ name: { full: 'C' } });
    expect(mergePatches({ name: { full: 'A', given: 'B' } }, { 'name/full': 'C' })).toEqual({ name: { full: 'C', given: 'B' } });
    expect(mergePatches({ note: 'x' }, { note: null })).toEqual({ note: null });
  });
});

describe('queued edits', () => {
  it('merges edits per card, and sends one patch after coming back', async () => {
    const server = new FakeContacts();
    const card = server.addCard({ note: 'old', name: { full: 'Anna' } });
    const { db, engine } = await synced(server);
    server.offline = true;
    engine.setOnline(false);

    await call(engine, 'ContactCard/set', { update: { [card.id]: { note: 'first' } } });
    await call(engine, 'ContactCard/set', { update: { [card.id]: { note: 'second', 'name/full': 'Anna B' } } });
    await call(engine, 'ContactCard/set', { update: { [card.id]: { 'name/full': 'Anna C' } } });
    expect(count(db, 'contact_pending')).toBe(1);
    expect(await engine.areaCall('contacts.pending', undefined)).toBe(1);
    const seen = await call(engine, 'ContactCard/get', { ids: [card.id] });
    expect(seen.list[0]).toMatchObject({ note: 'second', name: { full: 'Anna C' } });

    server.offline = false;
    engine.setOnline(true);
    await engine.areaCall('contacts.flush', undefined);
    const sets = setCalls(server);
    expect(sets).toHaveLength(1);
    expect(sets[0].update[card.id]).toEqual({ note: 'second', 'name/full': 'Anna C' });
    expect(server.account().cards.get(card.id)).toMatchObject({ note: 'second', name: { full: 'Anna C' } });
    expect(count(db, 'contact_pending')).toBe(0);
  });

  it('lets stand-in ids work in later edits and sends one create', async () => {
    const server = new FakeContacts();
    const { db, engine } = await synced(server);
    engine.setOnline(false);
    const { created } = await call(engine, 'ContactCard/set', { create: { n: { name: { full: 'Neu' }, addressBookIds: { book1: true } } } });
    const standIn = created.n.id;
    expect(created.n.uid).toMatch(/^urn:uuid:/);

    const fetched = await call(engine, 'ContactCard/get', { ids: [standIn] });
    expect(fetched.list[0]).toMatchObject({ id: standIn, name: { full: 'Neu' }, uid: created.n.uid });
    const updated = await call(engine, 'ContactCard/set', { update: { [standIn]: { note: 'added' } } });
    expect(updated.updated).toEqual({ [standIn]: null });

    engine.setOnline(true);
    await engine.requestSync();
    const sets = setCalls(server);
    expect(sets).toHaveLength(1);
    const sent = Object.values(sets[0].create)[0] as Record<string, unknown>;
    expect(sent).toMatchObject({ name: { full: 'Neu' }, note: 'added', uid: created.n.uid });
    expect(sent).not.toHaveProperty('id');
    const onServer = [...server.account().cards.values()];
    expect(onServer).toHaveLength(1);

    // The page may still hold the stand-in id: it finds the card, and can edit it.
    const late = await call(engine, 'ContactCard/get', { ids: [standIn] });
    expect(late.list[0].id).toBe(onServer[0].id);
    expect(db.get('SELECT 1 AS x FROM contact_card WHERE id = ?', [standIn])).toBeUndefined();
    expect(count(db, 'contact_card')).toBe(1);
    engine.setOnline(false);
    await call(engine, 'ContactCard/set', { update: { [standIn]: { note: 'later' } } });
    engine.setOnline(true);
    await engine.requestSync();
    expect(server.account().cards.get(onServer[0].id)).toMatchObject({ note: 'later' });
  });

  it('never sends a card created and deleted while offline', async () => {
    const server = new FakeContacts();
    const { db, engine } = await synced(server);
    engine.setOnline(false);
    const { created } = await call(engine, 'ContactCard/set', { create: { n: { name: { full: 'Short' }, addressBookIds: { book1: true } } } });
    const gone = await call(engine, 'ContactCard/set', { destroy: [created.n.id] });
    expect(gone.destroyed).toEqual([created.n.id]);
    engine.setOnline(true);
    await engine.requestSync();
    expect(setCalls(server)).toHaveLength(0);
    expect(count(db, 'contact_card')).toBe(0);
  });

  it('hides a queued delete, also from sync, then deletes on the server', async () => {
    const server = new FakeContacts();
    const card = server.addCard();
    const { db, engine } = await synced(server);
    engine.setOnline(false);
    await call(engine, 'ContactCard/set', { destroy: [card.id] });
    expect((await call(engine, 'ContactCard/get', { ids: [card.id] })).notFound).toEqual([card.id]);
    const again = await call(engine, 'ContactCard/set', { destroy: [card.id], update: { [card.id]: { note: 'x' } } });
    expect(again.notDestroyed[card.id].type).toBe('notFound');
    expect(again.notUpdated[card.id].type).toBe('notFound');
    engine.setOnline(true);
    await engine.requestSync();
    expect(server.account().cards.has(card.id)).toBe(false);
    expect(count(db, 'contact_card')).toBe(0);
  });

  it('keeps a queued delete hidden when a full sync brings the card again', async () => {
    const server = new FakeContacts();
    const card = server.addCard({ name: { full: 'Hidden' } });
    const { db, engine } = await synced(server);
    await call(engine, 'ContactCard/set', { destroy: [card.id] });
    server.refuse.set(card.id, { type: 'serverFail' });
    db.run("UPDATE sync_state SET state = 'bad state!' WHERE type = 'ContactCard'");
    await engine.requestSync();
    expect(await engine.areaCall('contacts.pending', undefined)).toBe(1);
    expect(await search(engine, 'hidden')).toEqual([]);
    server.refuse.clear();
    await engine.requestSync();
    expect(server.account().cards.has(card.id)).toBe(false);
  });

  it('keeps the queued edit on top when sync brings a newer card', async () => {
    const server = new FakeContacts();
    const card = server.addCard({ note: 'old', name: { full: 'Anna' } });
    const { engine } = await synced(server);
    await call(engine, 'ContactCard/set', { update: { [card.id]: { note: 'mine' } } });
    // A pass with the flush step still to come: the row was already there, so the merge shows on the delta.
    server.refuse.set(card.id, { type: 'serverFail' });
    server.editCard(card.id, { name: { full: 'Anna Server' } });
    await engine.requestSync();
    const seen = await call(engine, 'ContactCard/get', { ids: [card.id] });
    expect(seen.list[0]).toMatchObject({ note: 'mine', name: { full: 'Anna Server' } });
    expect(await engine.areaCall('contacts.pending', undefined)).toBe(1);
    server.refuse.clear();
    await engine.requestSync();
    expect(server.account().cards.get(card.id)).toMatchObject({ note: 'mine', name: { full: 'Anna Server' } });
    expect(await engine.areaCall('contacts.conflicts', undefined)).toEqual([]);
  });

  it('refuses a held upload as a photo, the way the client takes as a blob refusal', async () => {
    const server = new FakeContacts();
    const card = server.addCard();
    const { engine } = await synced(server);
    const result = await call(engine, 'ContactCard/set', { update: { [card.id]: { media: { p: { kind: 'photo', blobId: 'bulwark-local-123' } } } } });
    expect(result.notUpdated[card.id]).toMatchObject({ type: 'invalidProperties', properties: ['media'] });
    expect(await engine.areaCall('contacts.pending', undefined)).toBe(0);
  });

  it('refuses a card with no address book, since it could never be saved', async () => {
    const server = new FakeContacts();
    const { engine } = await synced(server);
    const result = await call(engine, 'ContactCard/set', { create: { n: { name: { full: 'Nowhere' } } } });
    expect(result.notCreated.n).toMatchObject({ type: 'invalidProperties', properties: ['addressBookIds'] });
    expect(await engine.areaCall('contacts.pending', undefined)).toBe(0);
  });

  it('answers a patch that leads nowhere per record', async () => {
    const server = new FakeContacts();
    const card = server.addCard();
    const { engine } = await synced(server);
    const result = await call(engine, 'ContactCard/set', { update: { [card.id]: { 'nope/x': 1 } } });
    expect(result.notUpdated[card.id].type).toBe('invalidPatch');
  });
});

describe('lost responses', () => {
  it('finds the card by uid instead of creating it twice', async () => {
    const server = new FakeContacts();
    // Without the refusal Stalwart gives, only the uid lookup can stop a second card.
    server.allowDuplicateUids = true;
    const { db, engine } = await synced(server);
    const { created } = await call(engine, 'ContactCard/set', { create: { n: { name: { full: 'Once' }, addressBookIds: { book1: true } } } });

    server.loseNextSet = true;
    await engine.requestSync();
    expect(server.account().cards.size).toBe(1);
    expect(await engine.areaCall('contacts.pending', undefined)).toBe(1);

    await engine.requestSync();
    expect(server.account().cards.size).toBe(1);
    expect(setCalls(server)).toHaveLength(1);
    expect(await engine.areaCall('contacts.pending', undefined)).toBe(0);
    const real = [...server.account().cards.keys()][0];
    expect(db.all('SELECT id FROM contact_card').map((r) => r.id)).toEqual([real]);
    expect((await call(engine, 'ContactCard/get', { ids: [created.n.id] })).list[0].id).toBe(real);
  });

  it('takes the server refusing the uid as the card being there', async () => {
    const server = new FakeContacts();
    const { engine } = await synced(server);
    const { created } = await call(engine, 'ContactCard/set', { create: { n: { name: { full: 'Once' }, addressBookIds: { book1: true } } } });
    // The card reached the server by another way than this flush saw.
    server.addCard({ uid: created.n.uid, name: { full: 'Once' } });
    await engine.requestSync();
    expect(server.account().cards.size).toBe(1);
    expect(await engine.areaCall('contacts.pending', undefined)).toBe(0);
    expect(await engine.areaCall('contacts.conflicts', undefined)).toEqual([]);
    expect((await call(engine, 'ContactCard/query', {})).ids).toHaveLength(1);
  });

  it('does not take its own lost update for a change on the server', async () => {
    const server = new FakeContacts();
    const card = server.addCard({ note: 'old' });
    const { engine } = await synced(server);
    await call(engine, 'ContactCard/set', { update: { [card.id]: { note: 'mine' } } });
    server.loseNextSet = true;
    await engine.requestSync();
    expect(server.account().cards.get(card.id)).toMatchObject({ note: 'mine' });
    await engine.requestSync();
    expect(setCalls(server)).toHaveLength(1);
    expect(await engine.areaCall('contacts.conflicts', undefined)).toEqual([]);
    expect(await engine.areaCall('contacts.pending', undefined)).toBe(0);
  });

  it('keeps everything queued when the network fails, and a delete after a lost create still deletes', async () => {
    const server = new FakeContacts();
    const { engine } = await synced(server);
    const { created } = await call(engine, 'ContactCard/set', { create: { n: { name: { full: 'Twice' }, addressBookIds: { book1: true } } } });
    server.loseNextSet = true;
    await engine.requestSync();
    expect(server.account().cards.size).toBe(1);
    await call(engine, 'ContactCard/set', { destroy: [created.n.id] });
    await engine.requestSync();
    expect(server.account().cards.size).toBe(0);
    expect(await engine.areaCall('contacts.pending', undefined)).toBe(0);
  });
});

describe('conflicts', () => {
  it('records a refused create and takes it out of the answers', async () => {
    const server = new FakeContacts();
    const { engine } = await synced(server);
    const { created } = await call(engine, 'ContactCard/set', { create: { n: { name: { full: 'Refused' }, addressBookIds: { book1: true } } } });
    const uid = created.n.uid;
    server.refuse.set(uid, { type: 'forbidden', description: 'No rights here' });
    await engine.requestSync();
    const conflicts = await engine.areaCall('contacts.conflicts', undefined) as Array<Record<string, any>>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ kind: 'refused', summary: 'Refused', error: 'forbidden: No rights here', jmap: JMAP_ACCOUNT, local: { op: 'create' } });
    expect(await search(engine, 'refused')).toEqual([]);
    expect(await engine.areaCall('contacts.pending', undefined)).toBe(0);
  });

  it('records a refused update and goes back to the server copy', async () => {
    const server = new FakeContacts();
    const card = server.addCard({ note: 'server' });
    const { engine } = await synced(server);
    await call(engine, 'ContactCard/set', { update: { [card.id]: { note: 'mine' } } });
    server.refuse.set(card.id, { type: 'forbidden' });
    await engine.requestSync();
    const conflicts = await engine.areaCall('contacts.conflicts', undefined) as Array<Record<string, any>>;
    expect(conflicts[0]).toMatchObject({ kind: 'refused', recordId: card.id, local: { op: 'update', payload: { note: 'mine' } } });
    expect((await call(engine, 'ContactCard/get', { ids: [card.id] })).list[0].note).toBe('server');
    await engine.areaCall('contacts.dismissConflict', { id: conflicts[0].id });
    expect(await engine.areaCall('contacts.conflicts', undefined)).toEqual([]);
  });

  it('records an edit to a property the server changed too, and does not overwrite it', async () => {
    const server = new FakeContacts();
    const card = server.addCard({ note: 'old' });
    const { engine } = await synced(server);
    await call(engine, 'ContactCard/set', { update: { [card.id]: { note: 'mine' } } });
    server.editCard(card.id, { note: 'theirs' });
    await engine.requestSync();
    const conflicts = await engine.areaCall('contacts.conflicts', undefined) as Array<Record<string, any>>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ kind: 'changed', local: { payload: { note: 'mine' } }, server: { note: 'theirs' } });
    expect(setCalls(server)).toHaveLength(0);
    expect(server.account().cards.get(card.id)?.note).toBe('theirs');
    expect((await call(engine, 'ContactCard/get', { ids: [card.id] })).list[0].note).toBe('theirs');
  });

  it('sends an edit when the server only changed other properties', async () => {
    const server = new FakeContacts();
    const card = server.addCard({ note: 'old', name: { full: 'A' } });
    const { engine } = await synced(server);
    await call(engine, 'ContactCard/set', { update: { [card.id]: { note: 'mine' } } });
    server.editCard(card.id, { name: { full: 'B' } });
    await engine.requestSync();
    expect(await engine.areaCall('contacts.conflicts', undefined)).toEqual([]);
    expect(server.account().cards.get(card.id)).toMatchObject({ note: 'mine', name: { full: 'B' } });
  });

  it('records an edit to a card deleted on the server', async () => {
    const server = new FakeContacts();
    const card = server.addCard({ name: { full: 'Vanished' } });
    const { engine } = await synced(server);
    await call(engine, 'ContactCard/set', { update: { [card.id]: { note: 'mine' } } });
    server.removeCard(card.id);
    await engine.requestSync();
    const conflicts = await engine.areaCall('contacts.conflicts', undefined) as Array<Record<string, any>>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ kind: 'gone', summary: 'Vanished', recordId: card.id });
    expect(await search(engine, 'vanished')).toEqual([]);
  });

  it('does not delete a card that changed on the server since the delete was queued', async () => {
    const server = new FakeContacts();
    const card = server.addCard({ note: 'old', name: { full: 'Keep me' } });
    const { engine } = await synced(server);
    await call(engine, 'ContactCard/set', { destroy: [card.id] });
    server.editCard(card.id, { note: 'someone cares' });
    await engine.requestSync();
    expect(server.account().cards.has(card.id)).toBe(true);
    expect(await search(engine, 'keep')).toEqual(['Keep me']);
    const conflicts = await engine.areaCall('contacts.conflicts', undefined) as Array<Record<string, any>>;
    expect(conflicts[0]).toMatchObject({ kind: 'changed', local: { op: 'destroy' } });
  });

  it('does not count a delete of a card already gone as a conflict', async () => {
    const server = new FakeContacts();
    const card = server.addCard();
    const { engine } = await synced(server);
    await call(engine, 'ContactCard/set', { destroy: [card.id] });
    server.removeCard(card.id);
    await engine.requestSync();
    expect(await engine.areaCall('contacts.conflicts', undefined)).toEqual([]);
    expect(await engine.areaCall('contacts.pending', undefined)).toBe(0);
  });
});

describe('edits while sending', () => {
  it('keeps an edit made while the create was on its way', async () => {
    const server = new FakeContacts();
    const { engine } = await synced(server);
    const { created } = await call(engine, 'ContactCard/set', { create: { n: { name: { full: 'Racing' }, note: 'one', addressBookIds: { book1: true } } } });
    let edited = false;
    const original = server.request.bind(server);
    server.request = async (calls: MethodCall[]) => {
      if (!edited && calls.some(([name]) => name === 'ContactCard/set')) {
        edited = true;
        await call(engine, 'ContactCard/set', { update: { [created.n.id]: { note: 'two' } } });
      }
      return original(calls);
    };
    await engine.requestSync();
    await engine.requestSync();
    const cards = [...server.account().cards.values()];
    expect(cards).toHaveLength(1);
    expect(cards[0].note).toBe('two');
    expect(await engine.areaCall('contacts.pending', undefined)).toBe(0);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
