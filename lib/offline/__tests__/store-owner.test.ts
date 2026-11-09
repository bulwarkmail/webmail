import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkStoreOwner, markEvicted, isEvicted, onStoreOwnerChanged, readStoreOwners, useOfflineStore } from '../state';

const ACCOUNT = 'alice@example.org@mail.example.test';
const SERVER = 'https://mail.example.test';

describe('who signs in to a store that waits', () => {
  let wiped: string[];
  let stop: () => void;

  beforeEach(() => {
    localStorage.clear();
    wiped = [];
    useOfflineStore.setState({ enabled: [ACCOUNT] });
    stop = onStoreOwnerChanged(async (account) => { wiped.push(account); });
  });

  afterEach(() => {
    stop();
    useOfflineStore.setState({ enabled: [] });
    vi.restoreAllMocks();
  });

  it('the same account: nothing happens, and it is kept for next time', async () => {
    await checkStoreOwner(ACCOUNT, 'ee', SERVER);
    markEvicted(ACCOUNT);
    await checkStoreOwner(ACCOUNT, 'ee', SERVER);
    expect(wiped).toEqual([]);
    expect(readStoreOwners()[ACCOUNT]).toEqual({ jmap: 'ee', server: SERVER });
  });

  it('another account under the same address: the old one\'s data goes before anyone gets its key', async () => {
    await checkStoreOwner(ACCOUNT, 'ee', SERVER);
    markEvicted(ACCOUNT);
    await checkStoreOwner(ACCOUNT, 'ef', SERVER);
    expect(wiped).toEqual([ACCOUNT]);
    expect(readStoreOwners()[ACCOUNT]).toEqual({ jmap: 'ef', server: SERVER });
  });

  it('another server on the same host name, at another port', async () => {
    await checkStoreOwner(ACCOUNT, 'ee', SERVER);
    markEvicted(ACCOUNT);
    await checkStoreOwner(ACCOUNT, 'ee', 'https://mail.example.test:8443');
    expect(wiped).toEqual([ACCOUNT]);
  });

  it('nothing known from before: nothing to compare, and it is noted now', async () => {
    markEvicted(ACCOUNT);
    await checkStoreOwner(ACCOUNT, 'ee', SERVER);
    expect(wiped).toEqual([]);
    expect(isEvicted(ACCOUNT)).toBe(true);
    expect(readStoreOwners()[ACCOUNT]?.jmap).toBe('ee');
  });

  it('a different id with nothing evicted is left alone: only a store nobody vouched for is at stake', async () => {
    await checkStoreOwner(ACCOUNT, 'ee', SERVER);
    await checkStoreOwner(ACCOUNT, 'ef', SERVER);
    expect(wiped).toEqual([]);
  });
});
