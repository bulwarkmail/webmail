import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAccountStore } from '../account-store';
import { checkStoreOwner, onStoreOwnerChanged, readStoreOwners } from '@/lib/offline/state';

// Two mail servers on one host with the same user name are one login id.
// More pairs than the delivered test names: a server at the root of the host
// and a second one under a path, in both orders, with the record written by
// this version (not one kept from an earlier version).

const ACCOUNT = 'u@example.org@mail.example.org';
const ROOT = 'https://mail.example.org';
const MOUNTED = 'https://mail.example.org/second';

const entry = (serverUrl: string) => ({
  label: 'u', serverUrl, username: 'u@example.org', authMode: 'basic' as const,
  rememberMe: true, displayName: 'u', email: 'u@example.org', lastLoginAt: 0,
  isConnected: true, hasError: false, isDefault: false,
});

describe('a server at the root of a host and a second one under a path', () => {
  let wiped: string[];
  let stop: () => void;

  beforeEach(() => {
    localStorage.clear();
    wiped = [];
    stop = onStoreOwnerChanged(async (account) => { wiped.push(account); });
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  });
  afterEach(() => stop());

  it('root first, then the mounted one: what the device kept for the root server goes', async () => {
    // Signed in to the root server with this version: the record is this version's.
    await checkStoreOwner(ACCOUNT, 'ee', ROOT);
    expect(readStoreOwners()[ACCOUNT]).toEqual({ jmap: 'ee', server: ROOT });
    // The same user name on the second server, which gave it the same account id.
    await checkStoreOwner(ACCOUNT, 'ee', MOUNTED);
    expect(wiped).toEqual([ACCOUNT]);
  });

  it('root first, then the mounted one, with another JMAP account id there: it goes too', async () => {
    await checkStoreOwner(ACCOUNT, 'ee', ROOT);
    await checkStoreOwner(ACCOUNT, 'fz', MOUNTED);
    expect(wiped).toEqual([ACCOUNT]);
  });

  it('mounted first, then root: it goes', async () => {
    await checkStoreOwner(ACCOUNT, 'ee', MOUNTED);
    await checkStoreOwner(ACCOUNT, 'ee', ROOT);
    expect(wiped).toEqual([ACCOUNT]);
  });

  it('the entry names the mounted server after the second sign-in', () => {
    const id = useAccountStore.getState().addAccount(entry(ROOT));
    useAccountStore.getState().addAccount(entry(MOUNTED));
    expect(useAccountStore.getState().getAccountById(id)?.serverUrl).toBe(MOUNTED);
  });

  it('a record kept from before paths were noted, for a server that is mounted under a path, is not wiped at the upgrade', async () => {
    localStorage.setItem('bulwark-offline-owners', JSON.stringify({ [ACCOUNT]: { jmap: 'ee', server: ROOT } }));
    await checkStoreOwner(ACCOUNT, 'ee', MOUNTED);
    expect(wiped).toEqual([]);
    // From then on the record names the path, and another path is another server.
    await checkStoreOwner(ACCOUNT, 'ee', 'https://mail.example.org/third');
    expect(wiped).toEqual([ACCOUNT]);
  });

  it('the same mounted server written another way stays', async () => {
    await checkStoreOwner(ACCOUNT, 'ee', MOUNTED);
    await checkStoreOwner(ACCOUNT, 'ee', 'https://MAIL.example.org:443/second/');
    await checkStoreOwner(ACCOUNT, 'ee', 'https://mail.example.org/second?x=1#y');
    expect(wiped).toEqual([]);
  });
});
