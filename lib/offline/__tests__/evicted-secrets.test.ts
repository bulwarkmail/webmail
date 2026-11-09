import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A dropped account's plugin secrets, on the desktop app's own server. It has no
// cookie left, so what the account store wrote down at the time is all there is.

const ALICE = 'alice@mail.example.test';
const entry = {
  id: ALICE, label: ALICE, serverUrl: 'https://mail.example.test', username: 'alice', authMode: 'basic', rememberMe: true,
  displayName: ALICE, email: ALICE, lastLoginAt: 1, isConnected: true, hasError: false, isDefault: true, cookieSlot: 0, avatarColor: '#000',
};

async function load(desktop: boolean) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', desktop ? '1' : '');
  const { useAccountStore } = await import('@/stores/account-store');
  const state = await import('../state');
  const { forgetEvictedSecrets } = await import('../evicted-secrets');
  useAccountStore.setState({ accounts: [entry], activeAccountId: ALICE, defaultAccountId: ALICE } as never);
  state.writeEnabled([ALICE]);
  return { useAccountStore, state, forgetEvictedSecrets };
}

let calls: Array<{ url: string; method?: string }>;
let answer: () => Response;

beforeEach(() => {
  localStorage.clear();
  calls = [];
  answer = () => new Response('{"ok":true}', { status: 200 });
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    return answer();
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('a dropped account\'s plugin secrets', () => {
  it('in the desktop app go by who it was, with no cookie', async () => {
    const { useAccountStore, state, forgetEvictedSecrets } = await load(true);
    useAccountStore.getState().removeAccount(ALICE, 'evicted');
    expect(state.readEvictedOwners()[ALICE]).toEqual({ username: 'alice', serverUrl: 'https://mail.example.test' });
    expect(JSON.stringify(state.readEvictedOwners())).not.toContain('password');

    await forgetEvictedSecrets(ALICE);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url, 'https://desktop.local');
    expect(calls[0].method).toBe('DELETE');
    expect(url.pathname).toBe('/api/plugin-secrets');
    expect(Object.fromEntries(url.searchParams)).toEqual({ all: 'true', username: 'alice', server: 'https://mail.example.test' });
    expect(state.readEvictedOwners()).toEqual({});
  });

  it('are asked for again when the server couldn\'t', async () => {
    const { useAccountStore, state, forgetEvictedSecrets } = await load(true);
    useAccountStore.getState().removeAccount(ALICE, 'evicted');
    answer = () => new Response('{}', { status: 503 });
    await forgetEvictedSecrets(ALICE);
    expect(Object.keys(state.readEvictedOwners())).toEqual([ALICE]);
  });

  it('stay when the account signs in again, and nobody remembers it was dropped', async () => {
    const { useAccountStore, state, forgetEvictedSecrets } = await load(true);
    useAccountStore.getState().removeAccount(ALICE, 'evicted');
    useAccountStore.getState().addAccount(entry as never);
    expect(state.readEvictedOwners()).toEqual({});
    await forgetEvictedSecrets(null);
    expect(calls).toEqual([]);
  });

  it('on an instance aren\'t this device\'s: nothing is written down or asked', async () => {
    const { useAccountStore, state, forgetEvictedSecrets } = await load(false);
    useAccountStore.getState().removeAccount(ALICE, 'evicted');
    expect(state.readEvictedOwners()).toEqual({});
    await forgetEvictedSecrets(null);
    expect(calls).toEqual([]);
  });
});
