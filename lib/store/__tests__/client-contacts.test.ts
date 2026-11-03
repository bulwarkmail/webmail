// @vitest-environment node
/**
 * The real JMAPClient reading the store's answers: what the client's own code
 * makes of them is the contract, not the store's idea of the shape.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import { setOfflineHooks, type OfflineHooks } from '@/lib/jmap/offline-hooks';
import { partialAccounts } from '@/lib/jmap/partial-accounts';
import type { AddressBook, ContactCard } from '@/lib/jmap/types';
import { DEFAULT_SCOPE } from '../area';
import { contactsArea } from '../contacts';
import { AccountEngine } from '../engine/account-engine';
import { JMAP_ACCOUNT } from './helpers/fake-jmap';
import { CONTACTS_SESSION, FakeContacts, SHARED_ACCOUNT } from './helpers/fake-contacts';
import { openMemoryStore } from './helpers/node-adapter';

afterEach(() => setOfflineHooks(null));

async function offlineClient(server: FakeContacts): Promise<{ client: JMAPClient; engine: AccountEngine }> {
  const engine = new AccountEngine({
    account: 'a@fake.test',
    db: openMemoryStore(),
    session: CONTACTS_SESSION,
    transport: server,
    areas: [contactsArea],
    scope: DEFAULT_SCOPE,
    sleep: async () => {},
  });
  await engine.requestSync();
  engine.setOnline(false);
  const hooks: Partial<OfflineHooks> = {
    skipNetwork: () => true,
    answer: (_client, calls) => engine.answer(calls),
    record: () => {},
    noteNetwork: () => {},
  };
  setOfflineHooks(hooks as OfflineHooks);
  const client = JMAPClient.fromOfflineSession('https://fake.test', 'a@example.org', {
    ...CONTACTS_SESSION,
    capabilities: { ...CONTACTS_SESSION.capabilities, 'urn:ietf:params:jmap:core': { maxObjectsInGet: 2 } },
  });
  return { client, engine };
}

function seeded(): FakeContacts {
  const server = new FakeContacts();
  for (const full of ['Anna Bauer', 'Bernd Graf', 'Carla Müller']) server.addCard({ name: { full } });
  server.addBook({ id: 'teambook', name: 'Team' }, SHARED_ACCOUNT);
  server.addCard({ id: 'c1', name: { full: 'Dora Team' }, addressBookIds: { teambook: true } }, SHARED_ACCOUNT);
  return server;
}

describe('the client over the store', () => {
  it('reports a store that has nothing yet as a failure, not as no contacts', async () => {
    const engine = new AccountEngine({
      account: 'a@fake.test', db: openMemoryStore(), session: CONTACTS_SESSION, transport: new FakeContacts(),
      areas: [contactsArea], scope: DEFAULT_SCOPE, sleep: async () => {},
    });
    // Answered per call, with one more call the store can answer: the error isn't hidden by a null answer.
    const perCall: Partial<OfflineHooks> = {
      skipNetwork: () => true,
      answer: async (_client, calls) => (await engine.answer(calls)) ?? {
        methodResponses: calls.map(([, , id]) => ['error', { type: 'serverUnavailable' }, id]),
      },
      record: () => {},
      noteNetwork: () => {},
    };
    setOfflineHooks(perCall as OfflineHooks);
    const client = JMAPClient.fromOfflineSession('https://fake.test', 'a@example.org', CONTACTS_SESSION);
    await expect(client.getAllContacts()).rejects.toThrow();
    await expect(client.getAllAddressBooks()).rejects.toThrow();
  });

  it('lists all contacts and books across accounts, paging in its own batch size', async () => {
    const { client } = await offlineClient(seeded());
    const contacts = await client.getAllContacts();
    expect(contacts.map((c) => c.name?.full).sort()).toEqual(['Anna Bauer', 'Bernd Graf', 'Carla Müller', 'Dora Team']);
    const shared = contacts.find((c) => c.name?.full === 'Dora Team');
    expect(shared).toMatchObject({ id: `${SHARED_ACCOUNT}:c1`, originalId: 'c1', isShared: true });
    const books = await client.getAllAddressBooks();
    expect(books.map((b) => b.id).sort()).toEqual(['book1', `${SHARED_ACCOUNT}:teambook`]);
  });

  it('says which account failed, with what the others gave', async () => {
    const { client, engine } = await offlineClient(seeded());
    const failPrimary: Partial<OfflineHooks> = {
      skipNetwork: () => true,
      answer: async (_client, calls) => (calls[0][1].accountId === JMAP_ACCOUNT
        ? { methodResponses: calls.map(([, , id]) => ['error', { type: 'serverUnavailable' }, id]) }
        : engine.answer(calls)),
      record: () => {},
      noteNetwork: () => {},
    };
    setOfflineHooks(failPrimary as OfflineHooks);
    const contacts = await client.getAllContacts().catch((error: unknown) => error);
    const partial = partialAccounts<ContactCard>(contacts);
    expect(partial?.failedAccountIds).toEqual([JMAP_ACCOUNT]);
    expect(partial?.primaryAccountId).toBe(JMAP_ACCOUNT);
    expect(partial?.items.map((c) => c.name?.full)).toEqual(['Dora Team']);
    const books = partialAccounts<AddressBook>(await client.getAllAddressBooks().catch((error: unknown) => error));
    expect(books?.failedAccountIds).toEqual([JMAP_ACCOUNT]);
    expect(books?.items.map((b) => b.originalId)).toEqual(['teambook']);
  });

  it('searches with its own filter', async () => {
    const { client } = await offlineClient(seeded());
    expect((await client.searchContacts('müll')).map((c) => c.name?.full)).toEqual(['Carla Müller']);
    expect((await client.searchContacts('team')).map((c) => c.originalId)).toEqual(['c1']);
  });

  it('creates, edits and deletes through its own methods with the stand-in id', async () => {
    const { client, engine } = await offlineClient(seeded());
    const created = await client.createContact({ name: { full: 'Neue Person' }, emails: { e: { address: 'neu@example.org' } } });
    expect(created.id).toBeTruthy();
    expect(created.addressBookIds).toEqual({ book1: true });
    await client.updateContact(created.id, { name: { full: 'Neue Person B' } });
    expect((await client.getContact(created.id))?.name?.full).toBe('Neue Person B');
    expect((await client.searchContacts('person b')).map((c) => c.id)).toEqual([created.id]);
    await client.deleteContact(created.id);
    expect(await client.getContact(created.id)).toBeNull();
    expect(await engine.areaCall('contacts.pending', undefined)).toBe(0);
  });

  it('throws the server-style error for an edit to a card it does not have', async () => {
    const { client } = await offlineClient(seeded());
    await expect(client.updateContact('nope', { name: { full: 'X' } })).rejects.toThrow();
    await expect(client.deleteContact('nope')).rejects.toThrow();
  });

  it('reads an account the store has as the primary contacts account', async () => {
    const { client } = await offlineClient(seeded());
    expect(client.getContactsAccountId()).toBe(JMAP_ACCOUNT);
    expect((await client.getContacts('book1')).length).toBe(3);
  });
});
