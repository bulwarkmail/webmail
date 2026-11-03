import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The way out when the PIN is gone. The order is what matters: nothing may be left
// signed in with no PIN, and no record may keep the layer with no vault, whatever
// the server does and wherever it stops.

const events = vi.hoisted(() => [] as string[]);
const logoutAll = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth-store', () => ({ useAuthStore: { getState: () => ({ logoutAll }) } }));
vi.mock('@/lib/store/client/purge', async () => {
  const keys = await vi.importActual<typeof import('@/lib/store/client/keys')>('@/lib/store/client/keys');
  return {
    purgeStoreFiles: async () => {
      events.push('keys');
      keys.deleteKeyDatabase();
    },
    deleteStorePool: async () => {},
  };
});
vi.mock('@/lib/offline/device-wipe', () => ({ forgetDeviceRows: async () => { events.push('rows'); } }));

import { getAccountRecord, listAccountRecords, openAccountKey } from '@/lib/store/client/keys';
import { enableAppLock, forgetEverything, lockEverywhere, resetAppLockForTests, setLeaveForTests, setReloadForTests } from '../controller';
import { readAppLockFile } from '../state';
import { deleteVault, readVault } from '../vault';
import { COOKIES_TO_CLEAR_KEY, FRESH_LOGIN_KEY } from '../sign-out';

const PIN = 'correct-pin';

class FakeChannel {
  onmessage = null;
  postMessage(): void {}
  close(): void {}
}

let left = 0;

beforeEach(async () => {
  events.length = 0;
  logoutAll.mockReset();
  left = 0;
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  setReloadForTests(() => {});
  setLeaveForTests(() => { left += 1; });
  resetAppLockForTests();
  await deleteVault();
  localStorage.setItem('account-registry', JSON.stringify({ state: { accounts: [{ id: 'a' }] } }));
  await openAccountKey('a');
  await enableAppLock(PIN);
  lockEverywhere();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setReloadForTests(null);
  setLeaveForTests(null);
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
});

describe('forgetting the PIN', () => {
  it('a server that hangs leaves nothing behind: no registry, no keys, no vault, no lock', async () => {
    logoutAll.mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    expect(await forgetEverything()).toBe(true);
    expect(left).toBe(1);
    expect(localStorage.getItem('account-registry')).toBeNull();
    expect(await listAccountRecords()).toEqual([]);
    expect(await readVault()).toBeNull();
    expect(readAppLockFile().on).toBe(false);
  }, 30_000);

  it('removes the registry and the keys first, lifts the lock last, and only then logs out', async () => {
    logoutAll.mockImplementation(async () => {
      events.push('logout');
      expect(localStorage.getItem('account-registry')).toBeNull();
      expect(await getAccountRecord('a')).toBeNull();
      expect(await readVault()).toBeNull();
      expect(readAppLockFile().on).toBe(false);
    });
    expect(await forgetEverything()).toBe(true);
    expect([...new Set(events)]).toEqual(['rows', 'keys', 'logout']);
  });

  it('a key database that won\'t go keeps the vault and the lock', async () => {
    const keys = await import('@/lib/store/client/keys');
    const stuck = vi.spyOn(keys, 'forgetAccountKey').mockRejectedValue(new Error('held'));
    const list = vi.spyOn(keys, 'listAccountRecords').mockResolvedValue([{ account: 'a', layers: ['applock'] }] as never);
    try {
      expect(await forgetEverything()).toBe(false);
      expect(left).toBe(0);
      expect(await readVault()).not.toBeNull();
      expect(readAppLockFile().on).toBe(true);
      expect(logoutAll).not.toHaveBeenCalled();
    } finally {
      stuck.mockRestore();
      list.mockRestore();
    }
  });

  it('keeps a mark while the cookies couldn\'t be cleared, and asks for a real login next', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    logoutAll.mockResolvedValue(undefined);
    expect(await forgetEverything()).toBe(true);
    expect(localStorage.getItem(COOKIES_TO_CLEAR_KEY)).toBe('1');
    expect(localStorage.getItem(FRESH_LOGIN_KEY)).toBe('1');
  });

  it('takes the cookie mark off once the server said it cleared them', async () => {
    logoutAll.mockResolvedValue(undefined);
    expect(await forgetEverything()).toBe(true);
    expect(localStorage.getItem(COOKIES_TO_CLEAR_KEY)).toBeNull();
    expect(localStorage.getItem(FRESH_LOGIN_KEY), 'the provider\'s session is still open').toBe('1');
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(([url, init]) => `${(init as RequestInit)?.method} ${url}`);
    expect(calls).toContain('DELETE /api/auth/session?all=true');
    expect(calls).toContain('DELETE /api/auth/token?all=true');
  });
});
