import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminPolicyPatch, migrateSettings, useSettingsStore } from '../settings-store';
import { TRUSTED_SENDERS_BOOK_NAME, useContactStore } from '../contact-store';
import type { ContactCard } from '@/lib/jmap/types';

// "Keep the list in your address book" is on by default. Existing users who
// never chose get it on; an Off they chose stays. Turning it on files the
// list kept on the device into the book, once, and a server without address
// books keeps the list on the device without complaint.

const migrate = (state: Record<string, unknown>, version: number) =>
  migrateSettings(state, version) as unknown as Record<string, unknown>;

const card = (id: string, address: string, books: Record<string, boolean> = { book: true }): ContactCard =>
  ({ id, addressBookIds: books, emails: { e0: { address } } }) as unknown as ContactCard;

/** A JMAP server with one trusted senders book whose cards are kept in memory. */
function makeServer(initial: ContactCard[] = [], overrides: Record<string, unknown> = {}) {
  let cards = [...initial];
  let next = 0;
  const client = {
    supportsContacts: () => true,
    getAddressBooks: vi.fn(async () => [{ id: 'book', name: TRUSTED_SENDERS_BOOK_NAME }]),
    createAddressBook: vi.fn(),
    getContacts: vi.fn(async () => cards.map((c) => ({ ...c }))),
    createContact: vi.fn(async (c: Partial<ContactCard>) => {
      const created = { ...c, id: `new-${next++}` } as ContactCard;
      cards.push(created);
      return created;
    }),
    updateContact: vi.fn(),
    deleteContact: vi.fn(async (id: string) => {
      cards = cards.filter((c) => c.id !== id);
    }),
    deleteAddressBook: vi.fn(),
    ...overrides,
  };
  return { client, cards: () => cards };
}

function addressesIn(cards: ContactCard[]): string[] {
  return cards.flatMap((c) => Object.values(c.emails ?? {}).map((e) => e.address)).sort();
}

const resetBookCache = () =>
  useContactStore.setState({
    trustedSenderEmails: [],
    trustedSendersBookId: null,
    trustedSendersLoaded: false,
    trustedSendersLoading: false,
    trustedSendersBookUnavailable: false,
  });

beforeEach(() => {
  useSettingsStore.getState().resetToDefaults();
  resetBookCache();
});

describe('default and migration', () => {
  it('is on in a fresh store', () => {
    expect(useSettingsStore.getState().trustedSendersAddressBook).toBe(true);
  });

  it('turns on for an existing store that never chose', () => {
    // Off was the default before July 2026, "not decided" (null) since.
    expect(migrate({ trustedSendersAddressBook: false, explicitSettings: [] }, 13).trustedSendersAddressBook).toBe(true);
    expect(migrate({ trustedSendersAddressBook: null, explicitSettings: [] }, 13).trustedSendersAddressBook).toBe(true);
    const old = migrate({ trustedSendersAddressBook: false }, 7);
    expect(old.trustedSendersAddressBook).toBe(true);
    expect(old.explicitSettings).not.toContain('trustedSendersAddressBook');
  });

  it('keeps Off that the user chose', () => {
    const out = migrate({ trustedSendersAddressBook: false, explicitSettings: ['trustedSendersAddressBook'] }, 13);
    expect(out.trustedSendersAddressBook).toBe(false);

    // The switch records the choice, so the stored state keeps it.
    useSettingsStore.getState().updateSetting('trustedSendersAddressBook', false);
    const stored = JSON.parse(JSON.stringify(useSettingsStore.getState())) as Record<string, unknown>;
    expect(migrate(stored, 13).trustedSendersAddressBook).toBe(false);
  });

  it("doesn't let an older device's server copy switch it back off", () => {
    const store = useSettingsStore.getState();
    expect(store.importSettings(JSON.stringify({ trustedSendersAddressBook: false, explicitSettings: [] }))).toBe(true);
    expect(useSettingsStore.getState().trustedSendersAddressBook).toBe(true);

    expect(store.importSettings(JSON.stringify({ trustedSendersAddressBook: false, explicitSettings: ['trustedSendersAddressBook'] }))).toBe(true);
    expect(useSettingsStore.getState().trustedSendersAddressBook).toBe(false);
  });

  it('gives way to an admin lock, and an admin default applies to users who never chose', () => {
    const locked = adminPolicyPatch(
      { trustedSendersAddressBook: true, explicitSettings: ['trustedSendersAddressBook'] },
      { restrictions: { trustedSendersAddressBook: { locked: true, value: false } } },
    );
    expect(locked).toEqual({ trustedSendersAddressBook: false });
    const preset = adminPolicyPatch({ trustedSendersAddressBook: true, explicitSettings: [] }, { defaults: { trustedSendersAddressBook: false } });
    expect(preset).toEqual({ trustedSendersAddressBook: false });
  });
});

describe('filing the list kept on the device', () => {
  it('moves it into the book once, without duplicates', async () => {
    useSettingsStore.setState({ trustedSenders: ['a@example.org', 'b@example.org', 'c@example.org'] });
    const server = makeServer([card('c1', 'b@example.org')]);

    await useContactStore.getState().loadTrustedSendersBook(server.client as never);

    expect(server.client.createContact).toHaveBeenCalledTimes(2);
    expect(addressesIn(server.cards())).toEqual(['a@example.org', 'b@example.org', 'c@example.org']);
    expect(useContactStore.getState().trustedSenderEmails.sort()).toEqual(['a@example.org', 'b@example.org', 'c@example.org']);
    expect(useSettingsStore.getState().trustedSenders).toEqual([]);

    // The next start, or another device whose list synced before it was
    // cleared, finds nothing to file.
    resetBookCache();
    useSettingsStore.setState({ trustedSenders: ['a@example.org', 'c@example.org'] });
    await useContactStore.getState().loadTrustedSendersBook(server.client as never);
    expect(server.client.createContact).toHaveBeenCalledTimes(2);
    expect(addressesIn(server.cards())).toEqual(['a@example.org', 'b@example.org', 'c@example.org']);
    expect(useSettingsStore.getState().trustedSenders).toEqual([]);
  });

  it('removes the second card two devices filed at the same moment, the same one everywhere', async () => {
    const server = makeServer([card('x2', 'a@example.org'), card('x1', 'a@example.org'), card('x3', 'a@example.org', { book: true, personal: true })]);

    await useContactStore.getState().loadTrustedSendersBook(server.client as never);

    expect(server.client.deleteContact).toHaveBeenCalledTimes(1);
    expect(server.client.deleteContact).toHaveBeenCalledWith('x2');
    expect(server.cards().map((c) => c.id).sort()).toEqual(['x1', 'x3']);
  });

  it('keeps a sender on the device when the server refuses its card', async () => {
    useSettingsStore.setState({ trustedSenders: ['a@example.org', 'b@example.org'] });
    const server = makeServer([]);
    server.client.createContact.mockImplementationOnce(async () => { throw new Error('forbidden'); });

    await useContactStore.getState().loadTrustedSendersBook(server.client as never);

    expect(useSettingsStore.getState().trustedSenders).toEqual(['a@example.org']);
  });

  it('leaves the list alone while the setting is off', async () => {
    useSettingsStore.setState({ trustedSendersAddressBook: false, trustedSenders: ['a@example.org'] });
    const server = makeServer([]);

    await useContactStore.getState().loadTrustedSendersBook(server.client as never);

    expect(server.client.createContact).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().trustedSenders).toEqual(['a@example.org']);
  });
});

describe('a server without address books', () => {
  it('keeps the list on the device without asking the server', async () => {
    useSettingsStore.setState({ trustedSenders: ['a@example.org'] });
    const server = makeServer([], { supportsContacts: () => false });

    await useContactStore.getState().loadTrustedSendersBook(server.client as never);
    await useContactStore.getState().addToTrustedSendersBook(server.client as never, 'New <b@example.org>');

    expect(server.client.getAddressBooks).not.toHaveBeenCalled();
    expect(useContactStore.getState().trustedSendersBookUnavailable).toBe(true);
    expect(useSettingsStore.getState().trustedSenders).toEqual(['a@example.org', 'b@example.org']);
  });

  it('keeps it on the device when the book cannot be created', async () => {
    const server = makeServer([], {
      getAddressBooks: vi.fn(async () => []),
      createAddressBook: vi.fn(async () => { throw new Error('forbidden'); }),
    });

    await expect(useContactStore.getState().addToTrustedSendersBook(server.client as never, 'b@example.org')).resolves.toBeUndefined();

    expect(useContactStore.getState().trustedSendersBookUnavailable).toBe(true);
    expect(useSettingsStore.getState().trustedSenders).toEqual(['b@example.org']);
  });

  it('takes a sender off the device list when there is no book', async () => {
    useSettingsStore.setState({ trustedSenders: ['a@example.org'] });
    useContactStore.setState({ trustedSendersBookUnavailable: true, trustedSendersLoaded: true });

    await useContactStore.getState().removeFromTrustedSendersBook(makeServer().client as never, 'a@example.org');

    expect(useSettingsStore.getState().trustedSenders).toEqual([]);
  });
});
