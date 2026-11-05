import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContactStore } from '@/stores/contact-store';
import { clearAllStores } from '@/lib/account-state-manager';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// The Pro shell lists the address books and contacts of every login together.
// At a switch or an added login the auth store also asks for the one login's
// list (initializeFeatureStores). Both replaced the list, so whichever
// answered last won: one login's books in place of everyone's.

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function login(name: string, gate?: Promise<void>) {
  return {
    getAllAddressBooks: async () => {
      await gate;
      return [{ id: `${name}-book`, name: `${name} book`, accountId: name }];
    },
    getAllContacts: async () => {
      await gate;
      return [{ id: `${name}-card`, name: { full: `${name} card` }, addressBookIds: { [`${name}-book`]: true } }];
    },
  };
}

const ids = <T extends { id: string }>(list: T[]) => list.map((item) => item.id).sort();

beforeEach(() => {
  clearAllStores();
  useContactStore.setState({ accountClients: null, addressBooks: [], contacts: [] });
});

describe('the Pro shell\'s list of every login', () => {
  it('isn\'t replaced by one login\'s list that answers later', async () => {
    const gate = deferred();
    const slowBob = login('bob', gate.promise);
    const store = useContactStore.getState();
    const single = [store.fetchAddressBooks(slowBob as never), store.fetchContacts(slowBob as never)];

    const every = [
      { localAccountId: 'acct-alice', client: login('alice') },
      { localAccountId: 'acct-bob', client: login('bob') },
    ];
    await store.fetchAllAccountsAddressBooks(every as never);
    await store.fetchAllAccountsContacts(every as never);
    gate.resolve();
    await Promise.all(single);

    const after = useContactStore.getState();
    expect(ids(after.addressBooks)).toEqual(['acct-alice::alice-book', 'acct-bob::bob-book']);
    expect(ids(after.contacts)).toEqual(['acct-alice::alice-card', 'acct-bob::bob-card']);
  });

  it('is what one login\'s refresh brings while every login is listed', async () => {
    const every = [
      { localAccountId: 'acct-alice', client: login('alice') },
      { localAccountId: 'acct-bob', client: login('bob') },
    ];
    useContactStore.getState().setAccountClients(every as never);
    await useContactStore.getState().fetchAddressBooks(every[1].client as never);
    await useContactStore.getState().fetchContacts(every[1].client as never);

    const after = useContactStore.getState();
    expect(ids(after.addressBooks)).toEqual(['acct-alice::alice-book', 'acct-bob::bob-book']);
    expect(ids(after.contacts)).toEqual(['acct-alice::alice-card', 'acct-bob::bob-card']);
  });

  it('with one login shown, its refresh is its own list as before', async () => {
    useContactStore.getState().setAccountClients(null);
    await useContactStore.getState().fetchAddressBooks(login('bob') as never);
    expect(ids(useContactStore.getState().addressBooks)).toEqual(['bob-book']);
  });
});
