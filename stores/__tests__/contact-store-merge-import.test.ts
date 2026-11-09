import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContactStore } from '../contact-store';
import { planMerge } from '@/lib/contacts/merge';
import type { AddressBook, ContactCard } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

const books: AddressBook[] = [
  { id: 'ab-1', name: 'Personal', isDefault: true } as AddressBook,
  { id: 'ab-2', name: 'Work' } as AddressBook,
  { id: 'team:ab-9', originalId: 'ab-9', name: 'Team', isShared: true, accountId: 'team', accountName: 'Team' } as AddressBook,
];

function makeClient() {
  let n = 0;
  return {
    getContactsAccountId: vi.fn(() => 'acct'),
    createContact: vi.fn(async (c: Partial<ContactCard>) => ({ ...c, id: `new-${++n}` } as ContactCard)),
    updateContact: vi.fn().mockResolvedValue(undefined),
    deleteContact: vi.fn().mockResolvedValue(undefined),
  };
}

const incoming: ContactCard = {
  id: 'import-1',
  addressBookIds: {},
  name: { components: [{ kind: 'given', value: 'Ada' }], isOrdered: true },
};

beforeEach(() => {
  useContactStore.setState({ contacts: [], addressBooks: books, supportsSync: true, selectedContactIds: new Set() });
});

describe('importContacts into a chosen address book', () => {
  it('files the cards in the book picked, not the default one', async () => {
    const client = makeClient();
    const count = await useContactStore.getState().importContacts(client as unknown as IJMAPClient, [incoming], 'ab-2');
    expect(count).toBe(1);
    expect(client.createContact).toHaveBeenCalledWith(expect.objectContaining({ addressBookIds: { 'ab-2': true } }), undefined);
    expect(client.createContact.mock.calls[0][0]).not.toHaveProperty('id');
  });

  it('writes to the sharing account for a shared book, and lists the card under its namespaced ids', async () => {
    const client = makeClient();
    await useContactStore.getState().importContacts(client as unknown as IJMAPClient, [incoming], 'team:ab-9');
    expect(client.createContact).toHaveBeenCalledWith(expect.objectContaining({ addressBookIds: { 'ab-9': true } }), 'team');
    const [card] = useContactStore.getState().contacts;
    expect(card).toMatchObject({ id: 'team:new-1', originalId: 'new-1', isShared: true, accountId: 'team', addressBookIds: { 'team:ab-9': true } });
  });

  it('without a book, leaves the choice to the server as before', async () => {
    const client = makeClient();
    await useContactStore.getState().importContacts(client as unknown as IJMAPClient, [incoming]);
    expect(client.createContact).toHaveBeenCalledWith(expect.objectContaining({ addressBookIds: {} }));
  });

  it('puts local cards in the book too', async () => {
    useContactStore.setState({ supportsSync: false });
    await useContactStore.getState().importContacts(null, [incoming], 'ab-2');
    expect(useContactStore.getState().contacts[0].addressBookIds).toEqual({ 'ab-2': true });
  });
});

describe('mergeContacts', () => {
  const older: ContactCard = {
    id: 'c-old', uid: 'urn:uuid:old', addressBookIds: { 'ab-1': true }, updated: '2026-01-01T00:00:00Z',
    name: { components: [{ kind: 'given', value: 'Anna' }, { kind: 'surname', value: 'Example' }], isOrdered: true },
    emails: { e0: { address: 'anna@home.example.net' } },
    phones: { p0: { number: '+49 30 550000' } },
  };
  const newer: ContactCard = {
    id: 'c-new', uid: 'urn:uuid:new', addressBookIds: { 'ab-1': true }, updated: '2026-06-01T00:00:00Z',
    name: { components: [{ kind: 'given', value: 'Anna' }, { kind: 'surname', value: 'Example' }], isOrdered: true },
    emails: { e0: { address: 'anna@example.net' } },
  };
  const team: ContactCard = { id: 'g-team', kind: 'group', addressBookIds: { 'ab-1': true }, members: { 'urn:uuid:old': true, 'urn:uuid:x': true } };

  it('writes the kept card, moves the group membership, deletes the other card, and Undo puts it all back', async () => {
    useContactStore.setState({ contacts: [older, newer, team] });
    const client = makeClient();
    const store = useContactStore.getState();
    const plan = planMerge([older, newer]);

    const undo = await store.mergeContacts(client as unknown as IJMAPClient, plan);
    expect(undo).not.toBeNull();
    expect(client.updateContact).toHaveBeenCalledWith('c-new', {
      emails: { e0: { address: 'anna@example.net' }, e0m1: { address: 'anna@home.example.net' } },
      phones: { p0: { number: '+49 30 550000' } },
    }, undefined);
    expect(client.updateContact).toHaveBeenCalledWith('g-team', { members: { 'urn:uuid:x': true, 'urn:uuid:new': true } }, undefined);
    expect(client.deleteContact).toHaveBeenCalledWith('c-old', undefined);
    let contacts = useContactStore.getState().contacts;
    expect(contacts.map((c) => c.id)).toEqual(['c-new', 'g-team']);
    expect(contacts[1].members).toEqual({ 'urn:uuid:x': true, 'urn:uuid:new': true });
    expect(Object.keys(contacts[0].emails ?? {})).toEqual(['e0', 'e0m1']);

    client.updateContact.mockClear();
    expect(await useContactStore.getState().undoMergeContacts(client as unknown as IJMAPClient, undo!)).toBe(true);
    // The other card comes back under its own uid, so the group finds it again.
    expect(client.createContact).toHaveBeenCalledWith(expect.objectContaining({ uid: 'urn:uuid:old', emails: older.emails }), undefined);
    expect(client.createContact.mock.calls[0][0]).not.toHaveProperty('id');
    expect(client.updateContact).toHaveBeenCalledWith('g-team', { members: team.members }, undefined);
    // What the kept card didn't have is cleared again (undefined goes out as null).
    const keptCall = client.updateContact.mock.calls.find((call) => call[0] === 'c-new');
    expect(keptCall?.[1]).toEqual({ emails: newer.emails });
    expect(keptCall?.[1]).toHaveProperty('phones', undefined);
    contacts = useContactStore.getState().contacts;
    expect(contacts.find((c) => c.id === 'g-team')?.members).toEqual(team.members);
    expect(contacts.find((c) => c.uid === 'urn:uuid:old')).toBeTruthy();
  });

  // A delete the server refused left the card in place while the toast said
  // merged, and Undo then created it a second time.
  it('says when a card could not be deleted, and Undo does not create it again', async () => {
    useContactStore.setState({ contacts: [older, newer, team] });
    const client = makeClient();
    client.deleteContact.mockRejectedValueOnce(new Error('server said no'));
    const undo = await useContactStore.getState().mergeContacts(client as unknown as IJMAPClient, planMerge([older, newer]));
    expect(undo?.incomplete).toBe(true);
    expect(undo?.others).toEqual([]);
    expect(useContactStore.getState().contacts.some((c) => c.id === 'c-old')).toBe(true);
    await useContactStore.getState().undoMergeContacts(client as unknown as IJMAPClient, undo!);
    expect(client.createContact).not.toHaveBeenCalled();
  });

  it('deletes nothing and still hands back Undo when moving a group member fails', async () => {
    useContactStore.setState({ contacts: [older, newer, team] });
    const client = makeClient();
    client.updateContact.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('group write failed'));
    const undo = await useContactStore.getState().mergeContacts(client as unknown as IJMAPClient, planMerge([older, newer]));
    expect(undo).toMatchObject({ keepId: 'c-new', incomplete: true, others: [] });
    expect(client.deleteContact).not.toHaveBeenCalled();
  });

  it('deletes nothing when the kept card cannot be written', async () => {
    useContactStore.setState({ contacts: [older, newer, team] });
    const client = makeClient();
    client.updateContact.mockRejectedValueOnce(new Error('server said no'));
    await expect(useContactStore.getState().mergeContacts(client as unknown as IJMAPClient, planMerge([older, newer]))).rejects.toThrow();
    expect(client.deleteContact).not.toHaveBeenCalled();
    expect(useContactStore.getState().contacts).toHaveLength(3);
  });
});
