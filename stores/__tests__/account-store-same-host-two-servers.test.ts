import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAccountStore } from '../account-store';
import { checkStoreOwner, markEvicted, onStoreOwnerChanged, readStoreOwners } from '@/lib/offline/state';

/**
 * The app's id of a login is `username@hostname`: no port, no path. Two mail
 * servers on one host (production on 443 and a second instance on 8443, or two
 * path-mounted servers) with the same user name are one login to the app. A
 * sign-in to the second while the first is signed in reuses the first one's
 * cookie slot and replaces its client: it is a change of owner. The entry
 * names the server signed in to, and what the device kept under the id for
 * the first server (offline store, outbox, cached settings) goes before the
 * second can see it.
 */

const entry = (serverUrl: string) => ({
  label: 'u', serverUrl, username: 'u@example.org', authMode: 'basic' as const,
  rememberMe: true, displayName: 'u', email: 'u@example.org', lastLoginAt: 0,
  isConnected: true, hasError: false, isDefault: false,
});

const FIRST = 'https://mail.example.org';
const SECOND = 'https://mail.example.org:8443';

describe('two servers on one host with the same user name', () => {
  beforeEach(() => {
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  });

  it('are two logins, or the second sign-in at least names the server it went to', () => {
    const first = useAccountStore.getState().addAccount(entry(FIRST));
    const second = useAccountStore.getState().addAccount(entry(SECOND));
    const accounts = useAccountStore.getState().accounts;
    const serverOf = (id: string) => new URL(accounts.find((a) => a.id === id)!.serverUrl).origin;

    // The login the user just made must be registered for the server they signed in to.
    expect(serverOf(second)).toBe(new URL(SECOND).origin);
    // And the first login, if it is still there, for its own.
    if (first !== second) expect(serverOf(first)).toBe(new URL(FIRST).origin);
  });

  it('a second server mounted under another path of the host is named too', () => {
    const id = useAccountStore.getState().addAccount(entry('https://mail.example.org/one'));
    useAccountStore.getState().addAccount(entry('https://mail.example.org/two/'));
    expect(useAccountStore.getState().getAccountById(id)?.serverUrl).toBe('https://mail.example.org/two/');
  });

  it('another spelling of the same server leaves the entry as it was', () => {
    const id = useAccountStore.getState().addAccount(entry(FIRST));
    useAccountStore.getState().addAccount(entry('https://MAIL.example.org:443/'));
    expect(useAccountStore.getState().getAccountById(id)?.serverUrl).toBe(FIRST);
  });
});

describe('what the device kept for the first server', () => {
  const ACCOUNT = 'u@example.org@mail.example.org';
  let wiped: string[];
  let stop: () => void;

  beforeEach(() => {
    localStorage.clear();
    wiped = [];
    stop = onStoreOwnerChanged(async (account) => { wiped.push(account); });
  });

  afterEach(() => stop());

  it('goes at a sign-in to a second server on another port, though nothing waited for a sign-in', async () => {
    await checkStoreOwner(ACCOUNT, 'ee', FIRST);
    await checkStoreOwner(ACCOUNT, 'ee', SECOND);
    expect(wiped).toEqual([ACCOUNT]);
    expect(readStoreOwners()[ACCOUNT]).toEqual({ jmap: 'ee', server: SECOND });
  });

  it('goes at a sign-in to a second server under another path of the host', async () => {
    await checkStoreOwner(ACCOUNT, 'ee', 'https://mail.example.org/one');
    await checkStoreOwner(ACCOUNT, 'ee', 'https://mail.example.org/two');
    expect(wiped).toEqual([ACCOUNT]);
  });

  it('stays for the same server written another way', async () => {
    await checkStoreOwner(ACCOUNT, 'ee', FIRST);
    await checkStoreOwner(ACCOUNT, 'ee', 'https://MAIL.example.org:443/');
    await checkStoreOwner(ACCOUNT, 'ee', `${FIRST}/`);
    expect(wiped).toEqual([]);
  });

  it('goes for a store that waited for a sign-in, as before', async () => {
    await checkStoreOwner(ACCOUNT, 'ee', FIRST);
    markEvicted(ACCOUNT);
    await checkStoreOwner(ACCOUNT, 'ee', SECOND);
    expect(wiped).toEqual([ACCOUNT]);
  });

  it('stays when the record names the origin only, as records from before paths were noted do', async () => {
    localStorage.setItem('bulwark-offline-owners', JSON.stringify({ [ACCOUNT]: { jmap: 'ee', server: FIRST } }));
    await checkStoreOwner(ACCOUNT, 'ee', `${FIRST}/jmap`);
    expect(wiped).toEqual([]);
    expect(readStoreOwners()[ACCOUNT]).toEqual({ jmap: 'ee', server: `${FIRST}/jmap` });
  });
});
