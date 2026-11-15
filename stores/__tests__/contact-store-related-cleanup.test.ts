import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContactStore } from '../contact-store';
import { planMerge } from '@/lib/contacts/merge';
import type { AddressBook, ContactCard } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// #1707: deleting a card takes it out of other cards' relatedTo.

const books: AddressBook[] = [
  { id: 'ab-1', name: 'Personal', isDefault: true, myRights: { mayRead: true, mayWrite: true, mayDelete: true } } as AddressBook,
  { id: 'ab-ro', name: 'Read only', myRights: { mayRead: true, mayWrite: false, mayDelete: false } } as AddressBook,
];

const card = (id: string, uid: string, extra: Partial<ContactCard> = {}): ContactCard => ({
  id,
  uid,
  addressBookIds: { 'ab-1': true },
  name: { full: id },
  ...extra,
});

const john = card('john', 'urn:uuid:john');
const jane = card('jane', 'urn:uuid:jane');
const company = card('company', 'urn:uuid:company', {
  kind: 'org',
  relatedTo: {
    'urn:uuid:john': { relation: { colleague: true } },
    'urn:uuid:jane': { relation: {} },
    'https://example.com/boss': { relation: { contact: true } },
  },
});

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getContactsAccountId: vi.fn(() => 'acct'),
    updateContact: vi.fn().mockResolvedValue(undefined),
    deleteContact: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const asClient = (c: ReturnType<typeof makeClient>) => c as unknown as IJMAPClient;
const contact = (id: string) => useContactStore.getState().contacts.find(c => c.id === id);

beforeEach(() => {
  useContactStore.setState({
    contacts: [john, jane, company],
    addressBooks: books,
    supportsSync: true,
    selectedContactIds: new Set(),
    selectedContactId: null,
  });
});

describe('deleting a contact cleans up relatedTo', () => {
  it('removes the deleted uid from the organization card and keeps its other relations', async () => {
    const client = makeClient();
    await useContactStore.getState().deleteContact(asClient(client), 'john');

    const expected = {
      'urn:uuid:jane': { relation: {} },
      'https://example.com/boss': { relation: { contact: true } },
    };
    expect(client.updateContact).toHaveBeenCalledTimes(1);
    expect(client.updateContact).toHaveBeenCalledWith('company', { relatedTo: expected }, undefined);
    expect(contact('company')?.relatedTo).toEqual(expected);
  });

  it('matches the uid with or without urn:uuid: and in any case', async () => {
    useContactStore.setState({
      contacts: [card('john', 'URN:UUID:ABC'), card('org', 'urn:uuid:org', { relatedTo: { abc: { relation: {} } } })],
    });
    const client = makeClient();
    await useContactStore.getState().deleteContact(asClient(client), 'john');
    expect(client.updateContact).toHaveBeenCalledWith('org', { relatedTo: undefined }, undefined);
    expect(contact('org')?.relatedTo).toBeUndefined();
  });

  it('bulk delete removes every deleted uid in one update per card', async () => {
    const client = makeClient();
    await useContactStore.getState().bulkDeleteContacts(asClient(client), ['john', 'jane']);

    expect(client.updateContact).toHaveBeenCalledTimes(1);
    expect(client.updateContact).toHaveBeenCalledWith('company', {
      relatedTo: { 'https://example.com/boss': { relation: { contact: true } } },
    }, undefined);
  });

  it('keeps the relations of a contact the server refused to delete', async () => {
    const client = makeClient({
      deleteContact: vi.fn(async (id: string) => { if (id === 'jane') throw new Error('nope'); }),
    });
    await useContactStore.getState().bulkDeleteContacts(asClient(client), ['john', 'jane']);

    expect(contact('company')?.relatedTo).toEqual({
      'urn:uuid:jane': { relation: {} },
      'https://example.com/boss': { relation: { contact: true } },
    });
  });

  it('leaves the entry when another card in the account still has that uid', async () => {
    useContactStore.setState({ contacts: [john, card('john-copy', 'urn:uuid:john'), company] });
    const client = makeClient();
    await useContactStore.getState().deleteContact(asClient(client), 'john');
    expect(client.updateContact).not.toHaveBeenCalled();
  });

  it('does not touch cards of another account or in a read-only address book', async () => {
    useContactStore.setState({
      contacts: [
        john,
        { ...company, id: 'shared:company', originalId: 'company', accountId: 'shared', isShared: true },
        { ...company, id: 'ro-company', addressBookIds: { 'ab-ro': true } },
      ],
    });
    const client = makeClient();
    await useContactStore.getState().deleteContact(asClient(client), 'john');
    expect(client.updateContact).not.toHaveBeenCalled();
  });

  it('keeps the delete and the local entries when the update fails', async () => {
    const client = makeClient({ updateContact: vi.fn().mockRejectedValue(new Error('down')) });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await useContactStore.getState().deleteContact(asClient(client), 'john')).toBe(true);
    errors.mockRestore();

    expect(contact('john')).toBeUndefined();
    expect(contact('company')?.relatedTo).toEqual(company.relatedTo);
  });

  it('writes to the account the related card lives in', async () => {
    const sharedJohn = { ...john, id: 'shared:john', originalId: 'john', accountId: 'shared', isShared: true };
    const sharedCompany = { ...company, id: 'shared:company', originalId: 'company', accountId: 'shared', isShared: true };
    useContactStore.setState({ contacts: [sharedJohn, sharedCompany] });
    const client = makeClient();
    await useContactStore.getState().deleteContact(asClient(client), 'shared:john');
    expect(client.updateContact).toHaveBeenCalledWith('company', expect.anything(), 'shared');
  });

  it('cleans local cards without a server', async () => {
    useContactStore.setState({ supportsSync: false });
    await useContactStore.getState().deleteLocalContact('john');
    expect(contact('company')?.relatedTo).not.toHaveProperty('urn:uuid:john');
    expect(contact('company')?.relatedTo).toHaveProperty(['urn:uuid:jane']);
  });

  it('points relations at the kept card when duplicates are merged', async () => {
    const john2 = card('john-2', 'urn:uuid:john-2', { emails: { e0: { address: 'john@example.com' } } });
    const john1 = { ...john, emails: { e0: { address: 'john@example.com' } } };
    const org = card('org', 'urn:uuid:org', { relatedTo: { 'urn:uuid:john-2': { relation: { colleague: true } } } });
    useContactStore.setState({ contacts: [john1, john2, org] });
    const client = makeClient();

    await useContactStore.getState().mergeContacts(asClient(client), planMerge([john1, john2]));

    expect(client.deleteContact).toHaveBeenCalledWith('john-2', undefined);
    expect(contact('org')?.relatedTo).toEqual({ 'urn:uuid:john': { relation: { colleague: true } } });
  });
});
