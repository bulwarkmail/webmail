// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { textFilter } from '@/lib/jmap/search-utils';
import { DEFAULT_SCOPE, type StoreEvent } from '../area';
import { contactsArea } from '../contacts';
import { applyPatch, coversJson, mergePatches, sameJson } from '../contacts/patch';
import { AccountEngine } from '../engine/account-engine';
import type { MethodCall, StoreSession } from '../engine/transport';
import type { StorageAdapter } from '../storage';
import { JMAP_ACCOUNT } from './helpers/fake-jmap';
import { CONTACTS_SESSION, FakeContacts, MAIL_ONLY_ACCOUNT, SHARED_ACCOUNT } from './helpers/fake-contacts';
import { openFileStore, openMemoryStore } from './helpers/node-adapter';

function engineFor(server: FakeContacts, db: StorageAdapter = openMemoryStore(), emit?: (e: StoreEvent) => void, session: StoreSession = CONTACTS_SESSION) {
  return new AccountEngine({
    account: 'a@fake.test',
    db,
    session,
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
      second.close();
      // It goes on from the last card read, not from the start.
      const first_ = server.calls.find(([name]) => name === 'ContactCard/query')?.[1];
      expect(first_?.anchor).toBeTruthy();
      expect(first_?.anchorOffset).toBe(1);
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

  it('refuses a card too large to ever send, so it cannot hold up the rest', async () => {
    const server = new FakeContacts();
    const card = server.addCard();
    const { engine } = await synced(server);
    const photo = { p: { kind: 'photo', uri: `data:image/jpeg;base64,${'A'.repeat(9 * 1024 * 1024)}` } };
    const made = await call(engine, 'ContactCard/set', { create: { n: { name: { full: 'Big' }, addressBookIds: { book1: true }, media: photo } } });
    expect(made.notCreated.n.type).toBe('tooLarge');
    const edited = await call(engine, 'ContactCard/set', { update: { [card.id]: { media: photo } } });
    expect(edited.notUpdated[card.id].type).toBe('tooLarge');
    expect(await engine.areaCall('contacts.pending', undefined)).toBe(0);
    expect((await call(engine, 'ContactCard/get', { ids: [card.id] })).list[0]).not.toHaveProperty('media');
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

const mine = (engine: AccountEngine, patch: Record<string, unknown>, id: string) => call(engine, 'ContactCard/set', { update: { [id]: patch } });
const conflictsOf = async (engine: AccountEngine) => await engine.areaCall('contacts.conflicts', undefined) as Array<Record<string, any>>;
const pendingOf = (engine: AccountEngine) => engine.areaCall('contacts.pending', undefined);

describe('edits that make a card smaller', () => {
  it.each<[string, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>]>([
    ['the last email', { emails: { e1: { address: 'a@example.org' } } }, { emails: {} }, { emails: {} }],
    ['one of two emails', { emails: { e1: { address: 'a@example.org' }, e2: { address: 'b@example.org' } } }, { emails: { e1: { address: 'a@example.org' } } }, { emails: { e1: { address: 'a@example.org' } } }],
    ['an email by pointer', { emails: { e1: { address: 'a@example.org' }, e2: { address: 'b@example.org' } } }, { 'emails/e2': null }, { emails: { e1: { address: 'a@example.org' } } }],
    ['a keyword', { keywords: { work: true, home: true } }, { keywords: { work: true } }, { keywords: { work: true } }],
    ['an address book', { addressBookIds: { book1: true, book2: true } }, { addressBookIds: { book2: true } }, { addressBookIds: { book2: true } }],
    ['a group member', { kind: 'group', members: { 'urn:uuid:a': true, 'urn:uuid:b': true } }, { members: { 'urn:uuid:a': true } }, { members: { 'urn:uuid:a': true } }],
  ])('sends the removal of %s', async (_label, start, patch, expected) => {
    const server = new FakeContacts(['book1', 'book2']);
    const card = server.addCard(start);
    const { engine } = await synced(server);
    await mine(engine, patch, card.id);
    await engine.requestSync();
    expect(server.account().cards.get(card.id)).toMatchObject(expected);
    for (const [key, value] of Object.entries(expected)) expect(server.account().cards.get(card.id)?.[key]).toEqual(value);
    expect(await conflictsOf(engine)).toEqual([]);
    expect(await pendingOf(engine)).toBe(0);
  });

  it('reads a key only the server has as its own, and one it had before as not yet removed', () => {
    const wanted = { e1: { address: 'a' } };
    expect(coversJson(wanted, { e1: { address: 'a' }, added: { address: 'x' } }, { e1: { address: 'a' } })).toBe(true);
    expect(coversJson(wanted, { e1: { address: 'a' }, e2: { address: 'b' } }, { e1: { address: 'a' }, e2: { address: 'b' } })).toBe(false);
    expect(coversJson({ e: { '@type': 'x' } }, { e: { '@type': 'x', extra: 1 } }, undefined)).toBe(true);
    // Stalwart 1.0 keeps a data: URI as a blob.
    expect(coversJson({ m: { kind: 'photo', uri: 'data:image/png;base64,AA' } }, { m: { kind: 'photo', blobId: 'b1' } }, undefined)).toBe(true);
    expect(coversJson({ m: { kind: 'logo', uri: 'data:image/png;base64,AA' } }, { m: { kind: 'photo', blobId: 'b1' } }, undefined)).toBe(false);
    expect(sameJson({}, undefined)).toBe(true);
  });
});

describe('flush failures', () => {
  it('still syncs after the server refuses the set as a whole, and records the edits', async () => {
    const server = new FakeContacts();
    const card = server.addCard({ note: 'server' });
    const { engine } = await synced(server);
    await mine(engine, { note: 'mine' }, card.id);
    await call(engine, 'ContactCard/set', { create: { n: { name: { full: 'New' }, addressBookIds: { book1: true } } } });
    server.failSet = () => ({ jmapError: 'forbidden' });
    server.addCard({ name: { full: 'From the server' } });
    await engine.requestSync();
    expect(await search(engine, 'from the server')).toEqual(['From the server']);
    expect((await conflictsOf(engine)).map((c) => c.kind)).toEqual(['refused', 'refused']);
    expect(await pendingOf(engine)).toBe(0);
    expect((await call(engine, 'ContactCard/get', { ids: [card.id] })).list[0].note).toBe('server');
  });

  it('keeps edits and still syncs when the failure says nothing about them', async () => {
    const server = new FakeContacts();
    const card = server.addCard({ note: 'server' });
    const { engine } = await synced(server);
    await mine(engine, { note: 'mine' }, card.id);
    server.failSet = () => ({ jmapError: 'serverFail' });
    server.addCard({ name: { full: 'From the server' } });
    await engine.requestSync();
    expect(await search(engine, 'from the server')).toEqual(['From the server']);
    expect(await conflictsOf(engine)).toEqual([]);
    expect(await pendingOf(engine)).toBe(1);
    server.failSet = null;
    await engine.requestSync();
    expect(server.account().cards.get(card.id)?.note).toBe('mine');
  });

  it('takes the rest of a batch through when one card makes the request fail', async () => {
    const server = new FakeContacts();
    const good = server.addCard({ note: 'a' });
    const bad = server.addCard({ note: 'b' });
    const { engine } = await synced(server);
    await mine(engine, { note: 'good edit' }, good.id);
    await mine(engine, { note: 'poison' }, bad.id);
    server.failSet = (args) => (JSON.stringify(args).includes('poison') ? { http: 400 } : null);
    await engine.requestSync();
    expect(server.account().cards.get(good.id)?.note).toBe('good edit');
    expect(server.account().cards.get(bad.id)?.note).toBe('b');
    const conflicts = await conflictsOf(engine);
    expect(conflicts.map((c) => [c.recordId, c.kind])).toEqual([[bad.id, 'refused']]);
    expect(await pendingOf(engine)).toBe(0);
  });

  it('takes the request limit from the session', async () => {
    const server = new FakeContacts();
    const card = server.addCard();
    const session = { ...CONTACTS_SESSION, capabilities: { ...CONTACTS_SESSION.capabilities, 'urn:ietf:params:jmap:core': { maxSizeRequest: 1000 } } };
    const db = openMemoryStore();
    const engine = engineFor(server, db, undefined, session);
    await engine.requestSync();
    const result = await mine(engine, { note: 'x'.repeat(2000) }, card.id);
    expect(result.notUpdated[card.id].type).toBe('tooLarge');
  });
});

describe('a uid another card has', () => {
  it('does not turn an offline create into that card', async () => {
    const server = new FakeContacts();
    const other = server.addCard({ uid: 'urn:uuid:taken', name: { full: 'Their card' } });
    const { db, engine } = await synced(server);
    const { created } = await call(engine, 'ContactCard/set', { create: { n: { uid: 'urn:uuid:taken', name: { full: 'My card' }, addressBookIds: { book1: true } } } });
    await engine.requestSync();
    const conflicts = await conflictsOf(engine);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ kind: 'refused', recordId: created.n.id, summary: 'My card', local: { op: 'create', payload: { name: { full: 'My card' } } } });
    expect((await call(engine, 'ContactCard/get', { ids: [created.n.id] })).notFound).toEqual([created.n.id]);
    expect(db.all('SELECT id FROM contact_card').map((r) => r.id)).toEqual([other.id]);
    expect(server.account().cards.get(other.id)).toMatchObject({ name: { full: 'Their card' } });
  });

  it('does not take someone else\'s card for its own after a failed attempt either', async () => {
    const server = new FakeContacts();
    const { engine } = await synced(server);
    const { created } = await call(engine, 'ContactCard/set', { create: { n: { uid: 'urn:uuid:race', name: { full: 'Mine' }, addressBookIds: { book1: true } } } });
    server.offlineBeforeSet = true;
    await engine.requestSync();
    const other = server.addCard({ uid: 'urn:uuid:race', name: { full: 'Theirs' } });
    await engine.requestSync();
    expect((await conflictsOf(engine)).map((c) => [c.recordId, c.kind])).toEqual([[created.n.id, 'refused']]);
    expect(server.account().cards.size).toBe(1);
    expect(server.account().cards.get(other.id)).toMatchObject({ name: { full: 'Theirs' } });
  });

  it('does not delete someone else\'s card when the create was deleted again', async () => {
    const server = new FakeContacts();
    const { engine } = await synced(server);
    const { created } = await call(engine, 'ContactCard/set', { create: { n: { uid: 'urn:uuid:race', name: { full: 'Mine' }, addressBookIds: { book1: true } } } });
    server.offlineBeforeSet = true;
    await engine.requestSync();
    await call(engine, 'ContactCard/set', { destroy: [created.n.id] });
    const other = server.addCard({ uid: 'urn:uuid:race', name: { full: 'Theirs' } });
    await engine.requestSync();
    expect(server.account().cards.has(other.id)).toBe(true);
    expect(await pendingOf(engine)).toBe(0);
  });
});

describe('what the server really stored', () => {
  const photo = { p: { kind: 'photo', uri: 'data:image/png;base64,iVBORw0KGgo=', mediaType: 'image/png' } };

  it('does not read its own stored photo as a change after the network went, on 1.0', async () => {
    const server = new FakeContacts();
    server.mediaAsBlobs = true;
    const { engine } = await synced(server);
    const { created } = await call(engine, 'ContactCard/set', { create: { n: { name: { full: 'Foto' }, addressBookIds: { book1: true }, media: photo } } });
    server.offlineAfterSet = true;
    await engine.requestSync();
    expect(server.account().cards.size).toBe(1);
    server.offline = false;
    await call(engine, 'ContactCard/set', { destroy: [created.n.id] });
    await engine.requestSync();
    expect(await conflictsOf(engine)).toEqual([]);
    expect(server.account().cards.size).toBe(0);
  });

  it('adopts its own card by uid though the server keeps the photo as a blob', async () => {
    const server = new FakeContacts();
    server.mediaAsBlobs = true;
    const { engine } = await synced(server);
    await call(engine, 'ContactCard/set', { create: { n: { name: { full: 'Foto' }, addressBookIds: { book1: true }, media: photo } } });
    server.loseNextSet = true;
    await engine.requestSync();
    await engine.requestSync();
    expect(await conflictsOf(engine)).toEqual([]);
    expect(await pendingOf(engine)).toBe(0);
    expect(server.account().cards.size).toBe(1);
  });

  it('keeps the card as the server read it back, not as it was sent, before any delta', async () => {
    const server = new FakeContacts();
    server.mediaAsBlobs = true;
    const { db, engine } = await synced(server);
    await call(engine, 'ContactCard/set', { create: { n: { name: { full: 'Foto' }, addressBookIds: { book1: true }, media: photo } } });
    // The network goes right after the read-back, before the delta of this pass.
    server.beforeRequest = () => {
      const set = server.calls.findIndex(([name]) => name === 'ContactCard/set');
      if (set >= 0 && server.calls.slice(set).some(([name]) => name === 'ContactCard/get')) server.offline = true;
    };
    await engine.requestSync();
    server.beforeRequest = null;
    server.offline = false;
    const row = db.get<{ json: string }>('SELECT json FROM contact_card');
    expect((JSON.parse(row?.json as string) as { media: Record<string, unknown> }).media.p).toHaveProperty('blobId');
    const id = [...server.account().cards.keys()][0];
    await mine(engine, { note: 'after' }, id);
    await engine.requestSync();
    expect(await conflictsOf(engine)).toEqual([]);
    expect(server.account().cards.get(id)?.note).toBe('after');
  });

  it('does not take a lost photo update for someone else changing it, on 1.0', async () => {
    const server = new FakeContacts();
    server.mediaAsBlobs = true;
    const card = server.addCard({ note: 'old' });
    const { engine } = await synced(server);
    await mine(engine, { media: photo }, card.id);
    server.loseNextSet = true;
    await engine.requestSync();
    await engine.requestSync();
    expect(await conflictsOf(engine)).toEqual([]);
    expect(await pendingOf(engine)).toBe(0);
  });
});

describe('after a lost update', () => {
  it('still deletes the card', async () => {
    const server = new FakeContacts();
    const card = server.addCard({ note: 'old' });
    const { engine } = await synced(server);
    await mine(engine, { note: 'mine' }, card.id);
    server.loseNextSet = true;
    await engine.requestSync();
    await call(engine, 'ContactCard/set', { destroy: [card.id] });
    await engine.requestSync();
    expect(await conflictsOf(engine)).toEqual([]);
    expect(server.account().cards.has(card.id)).toBe(false);
  });

  it('does not delete when someone else changed another property too', async () => {
    const server = new FakeContacts();
    const card = server.addCard({ note: 'old', name: { full: 'A' } });
    const { engine } = await synced(server);
    await mine(engine, { note: 'mine' }, card.id);
    server.loseNextSet = true;
    await engine.requestSync();
    await call(engine, 'ContactCard/set', { destroy: [card.id] });
    server.editCard(card.id, { name: { full: 'B' } });
    await engine.requestSync();
    expect(server.account().cards.has(card.id)).toBe(true);
    expect((await conflictsOf(engine)).map((c) => c.kind)).toEqual(['changed']);
  });

  it('sends a newer edit of the same property', async () => {
    const server = new FakeContacts();
    const card = server.addCard({ note: 'old' });
    const { engine } = await synced(server);
    await mine(engine, { note: 'first' }, card.id);
    server.loseNextSet = true;
    await engine.requestSync();
    await mine(engine, { note: 'second' }, card.id);
    await engine.requestSync();
    expect(await conflictsOf(engine)).toEqual([]);
    expect(server.account().cards.get(card.id)?.note).toBe('second');
  });
});

describe('a refusal while the page kept editing', () => {
  it('keeps the newer edit, and only records a conflict if it is refused too', async () => {
    const server = new FakeContacts();
    const card = server.addCard({ note: 'old', name: { full: 'A' } });
    const { engine } = await synced(server);
    await mine(engine, { note: 'one' }, card.id);
    server.refuse.set(card.id, { type: 'forbidden' });
    const original = server.request.bind(server);
    let edited = false;
    server.request = async (calls: MethodCall[]) => {
      if (!edited && calls.some(([name]) => name === 'ContactCard/set')) {
        edited = true;
        await mine(engine, { 'name/full': 'B' }, card.id);
      }
      return original(calls);
    };
    await engine.requestSync();
    expect(await pendingOf(engine)).toBe(1);
    expect(await conflictsOf(engine)).toEqual([]);
    server.refuse.clear();
    await engine.requestSync();
    expect(server.account().cards.get(card.id)).toMatchObject({ note: 'one', name: { full: 'B' } });
    expect(await pendingOf(engine)).toBe(0);
  });
});

describe('session limits', () => {
  it('takes maxObjectsInGet and maxCallsInRequest from the session', async () => {
    const server = new FakeContacts();
    server.maxObjectsInGet = 2;
    const cards = [server.addCard(), server.addCard(), server.addCard(), server.addCard(), server.addCard()];
    const session = { ...CONTACTS_SESSION, capabilities: { ...CONTACTS_SESSION.capabilities, 'urn:ietf:params:jmap:core': { maxObjectsInGet: 2, maxCallsInRequest: 4 } } };
    const db = openMemoryStore();
    const events: StoreEvent[] = [];
    const engine = engineFor(server, db, (e) => events.push(e), session);
    await engine.requestSync();
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(count(db, 'contact_card')).toBe(5);
    for (const [name, args] of server.calls) {
      if (name === 'ContactCard/query') expect(args.limit).toBeLessThanOrEqual(2);
    }
    for (const card of cards.slice(0, 3)) await mine(engine, { note: 'x' }, card.id);
    await engine.requestSync();
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(await pendingOf(engine)).toBe(0);
    expect(cards.slice(0, 3).map((c) => server.account().cards.get(c.id)?.note)).toEqual(['x', 'x', 'x']);
  });
});

describe('an interrupted first sync', () => {
  it('answers serverUnavailable until the first full pass is done', async () => {
    const server = new FakeContacts();
    for (let i = 0; i < 2600; i += 1) server.addCard();
    const db = openMemoryStore();
    const engine = engineFor(server, db);
    let requests = 0;
    server.beforeRequest = () => {
      requests += 1;
      if (requests === 4) server.offline = true;
    };
    await engine.requestSync();
    expect(count(db, 'contact_card')).toBe(2000);
    expect(await engine.answer([['ContactCard/query', { accountId: JMAP_ACCOUNT, limit: 50 }, '0']])).toBeNull();
    expect(await engine.answer([['ContactCard/get', { accountId: JMAP_ACCOUNT, ids: null }, '0']])).toBeNull();
    server.offline = false;
    server.beforeRequest = null;
    await engine.requestSync();
    expect((await call(engine, 'ContactCard/query', { calculateTotal: true })).total).toBe(2600);
  });

  it('goes on answering from the old copy while a later resync runs', async () => {
    const server = new FakeContacts();
    for (let i = 0; i < 2600; i += 1) server.addCard();
    const { db, engine } = await synced(server);
    db.run("UPDATE sync_state SET state = 'bad state!' WHERE type = 'ContactCard'");
    let requests = 0;
    server.beforeRequest = () => {
      requests += 1;
      if (requests === 3) server.offline = true;
    };
    await engine.requestSync();
    expect((await call(engine, 'ContactCard/query', { calculateTotal: true })).total).toBe(2600);
  });
});

describe('paging while cards change', () => {
  it('does not skip a card when an earlier one is deleted between requests', async () => {
    const server = new FakeContacts();
    const cards = Array.from({ length: 2600 }, () => server.addCard());
    const db = openMemoryStore();
    const engine = engineFor(server, db);
    let queries = 0;
    const original = server.request.bind(server);
    server.request = async (calls: MethodCall[]) => {
      if (calls.some(([name]) => name === 'ContactCard/query')) {
        queries += 1;
        if (queries === 2) server.removeCard(cards[0].id);
      }
      return original(calls);
    };
    await engine.requestSync();
    const kept = new Set(db.all<{ id: string }>('SELECT id FROM contact_card').map((r) => r.id));
    expect(cards.slice(1).filter((c) => !kept.has(c.id))).toEqual([]);
    expect(kept.has(cards[0].id)).toBe(false);
    const anchored = server.calls.filter(([name, args]) => name === 'ContactCard/query' && args.anchor !== undefined);
    expect(anchored.length).toBeGreaterThan(0);
  });

  it('starts over when the card it paged from is gone', async () => {
    const server = new FakeContacts();
    const cards = Array.from({ length: 2600 }, () => server.addCard());
    const db = openMemoryStore();
    const engine = engineFor(server, db);
    let queries = 0;
    const original = server.request.bind(server);
    server.request = async (calls: MethodCall[]) => {
      if (calls.some(([name]) => name === 'ContactCard/query')) {
        queries += 1;
        if (queries === 2) server.removeCard(cards[1999].id);
      }
      return original(calls);
    };
    const events: StoreEvent[] = [];
    await engine.requestSync();
    expect(events).toEqual([]);
    const kept = new Set(db.all<{ id: string }>('SELECT id FROM contact_card').map((r) => r.id));
    expect(kept.size).toBe(2599);
    expect(kept.has(cards[1999].id)).toBe(false);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
