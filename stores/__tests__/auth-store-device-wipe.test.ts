import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// Where the auth store meets wipes: the check at a start comes before any local
// data, a refused login fires the hook on every path and only ever hides the data,
// and the organisation's session limit isn't a refusal at all.

const clients = vi.hoisted(() => ({
  connect: (async () => {}) as (client: unknown) => Promise<void>,
  made: [] as Array<{ refused?: (ms: number) => void }>,
}));

vi.mock('@/lib/jmap/client', () => {
  class JMAPClient {
    refused?: (ms: number) => void;
    constructor(public serverUrl: string, public username: string) { clients.made.push(this); }
    static withBearer(serverUrl: string, _token: string, username: string) { return new JMAPClient(serverUrl, username); }
    static fromOfflineSession(serverUrl: string, username: string) { return new JMAPClient(serverUrl, username); }
    async connect() { await clients.connect(this); }
    getAuthHeader() { return 'Basic x'; }
    onConnectionChange() {}
    onRateLimit() {}
    onCredentialsRefused(callback: (ms: number) => void) { this.refused = callback; }
    getRateLimitRemainingMs() { return 0; }
    disconnect() {}
    getUsername() { return this.username; }
    async getIdentities() { return []; }
    supportsContacts() { return false; }
    supportsPrincipals() { return false; }
    supportsVacationResponse() { return false; }
    supportsCalendars() { return false; }
    supportsSieve() { return false; }
    getSharedAccounts() { return []; }
    getAccountInfo() { return undefined; }
  }
  class RateLimitError extends Error {}
  class RequestTimeoutError extends Error {}
  return { JMAPClient, RateLimitError, RequestTimeoutError, generateMessageId: () => '<x@y>' };
});

const order = vi.hoisted(() => [] as string[]);
const gate = vi.hoisted(() => ({ run: (async () => {}) as () => Promise<void> }));
vi.mock('@/lib/offline/device-wipe', () => ({
  runDeviceGate: async () => { order.push('gate'); await gate.run(); order.push('gate done'); },
}));
vi.mock('@/lib/offline/offline-mode', () => ({
  registerOfflineHooks: () => {},
  offlineSessionFor: async () => { order.push('local copy'); return {}; },
  markStartedOffline: () => {},
  // Real storage deletion is covered by auth-store-retain-accounts.
  wipeAccount: async () => {},
}));

const heard = vi.hoisted(() => [] as string[]);
const certain = vi.hoisted(() => [] as boolean[]);
const kinds = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/offline/credentials-rejected', () => ({
  noteCredentialsRejected: (account: string, sure = true, kind = 'refused') => { heard.push(account); certain.push(sure); kinds.push(kind); },
  onCredentialsRejected: () => () => {},
}));

import { readRefusedLogins, CREDENTIALS_REFUSED_CONFIRM_MS, markWipePending, clearWipePending } from '@/lib/devices/wipe-state';

// Fresh for each test: a sign-out leaves slots closing in the module for a while.
let isEvicted: typeof import('@/lib/offline/state').isEvicted;
let useOfflineStore: typeof import('@/lib/offline/state').useOfflineStore;
let useAccountStore: typeof import('@/stores/account-store').useAccountStore;
let useAuthStore: typeof import('@/stores/auth-store').useAuthStore;

const ALICE = 'alice@mail.example.test';
const BOB = 'bob@mail.example.test';

function account(id: string, slot: number, authMode: 'basic' | 'oauth') {
  return {
    id, label: id, serverUrl: 'https://mail.example.test', username: id.split('@mail')[0], authMode, rememberMe: true,
    displayName: id, email: id, lastLoginAt: 1, isConnected: false, hasError: false, isDefault: slot === 0, cookieSlot: slot, avatarColor: '#000',
  };
}

/** How accounts leave: 'explicit' is what takes their data with it. */
async function removalReasons(): Promise<string[]> {
  const { onAccountRemoved } = await import('@/stores/account-store');
  const reasons: string[] = [];
  onAccountRemoved((_id, reason) => { reasons.push(reason); });
  return reasons;
}

type Answer = (url: string, method: string) => Response | null;
let answer: Answer;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(async () => {
  vi.resetModules();
  ({ useOfflineStore, isEvicted } = await import('@/lib/offline/state'));
  ({ useAccountStore } = await import('@/stores/account-store'));
  ({ useAuthStore } = await import('@/stores/auth-store'));
  const nav = await import('@/lib/browser-navigation');
  localStorage.clear();
  sessionStorage.clear();
  order.length = 0;
  heard.length = 0;
  certain.length = 0;
  kinds.length = 0;
  clients.made.length = 0;
  clients.connect = async () => {};
  gate.run = async () => {};
  answer = () => null;
  vi.spyOn(nav, 'replaceWindowLocation').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const given = answer(url, init?.method ?? 'GET');
    if (given) return given;
    if (url.includes('/api/config')) return json(200, createConfig());
    if (url.includes('/api/auth/session') && init?.method === 'PUT') return json(200, { serverUrl: 'https://mail.example.test', username: 'alice', password: 'p' });
    if (url.includes('/api/auth/token') && init?.method === 'PUT') return json(200, { access_token: 't', expires_in: 3600 });
    return json(200, {});
  }));
  useOfflineStore.setState({ enabled: [] });
  useAuthStore.setState({ isAuthenticated: false, activeAccountId: null, client: null });
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null } as never);
}, 60_000);

describe('a start', () => {
  beforeEach(() => {
    useAccountStore.setState({ accounts: [account(ALICE, 0, 'basic')], activeAccountId: ALICE, defaultAccountId: ALICE } as never);
    useAuthStore.setState({ activeAccountId: ALICE });
  });

  it('with mail kept here checks for a wipe before it reads the local copy', async () => {
    useOfflineStore.setState({ enabled: [ALICE] });
    await useAuthStore.getState().checkAuth();
    expect(order.slice(0, 3)).toEqual(['gate', 'gate done', 'local copy']);
  });

  it('with no mail here and nothing waiting doesn\'t load any of it', async () => {
    await useAuthStore.getState().checkAuth();
    expect(order).toEqual([]);
  });

  it('with a wipe cut short looks too, with offline switched off by then', async () => {
    markWipePending(ALICE, 'admin');
    await useAuthStore.getState().checkAuth();
    clearWipePending(ALICE);
    expect(order).toContain('gate');
  });

  it('in the desktop app on an instance looks too', async () => {
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', mode: 'instance' };
    await useAuthStore.getState().checkAuth();
    delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop;
    expect(order).toContain('gate');
  });

  it('shows nothing of an account the check removed, and stops when none is left', async () => {
    useOfflineStore.setState({ enabled: [ALICE] });
    gate.run = async () => {
      useAccountStore.setState({ accounts: [], activeAccountId: null } as never);
    };
    await useAuthStore.getState().checkAuth();
    expect(order).not.toContain('local copy');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().isLoading).toBe(false);
    expect(clients.made).toEqual([]);
  });

  it('goes on when the check itself breaks', async () => {
    useOfflineStore.setState({ enabled: [ALICE] });
    gate.run = async () => { throw new Error('no'); };
    await useAuthStore.getState().checkAuth();
    expect(order).toContain('local copy');
  });
});

describe('a login the server ended, at a start', () => {
  beforeEach(() => {
    useAccountStore.setState({ accounts: [account(ALICE, 0, 'oauth')], activeAccountId: ALICE, defaultAccountId: ALICE } as never);
    useAuthStore.setState({ activeAccountId: ALICE });
  });

  it('invalid_grant fires the hook, for certain, and only hides the data', async () => {
    const reasons = await removalReasons();
    useOfflineStore.setState({ enabled: [ALICE] });
    answer = (url, method) => (url.includes('/api/auth/token') && method === 'PUT' ? json(401, { error: 'invalid_grant' }) : null);
    await useAuthStore.getState().checkAuth();
    // With mail kept here the real connect goes on behind the local copy.
    await vi.waitFor(() => expect(heard).toEqual([ALICE]));
    await vi.waitFor(() => expect(reasons).toEqual(['evicted']));
    expect(certain).toEqual([true]);
    expect(isEvicted(ALICE)).toBe(true);
    expect(useOfflineStore.getState().enabled).toEqual([ALICE]);
    expect(Object.keys(readRefusedLogins())).toEqual([ALICE]);
  });

  it.each([
    ['a password login', 'basic', '/api/auth/session'],
    ['an OAuth login', 'oauth', '/api/auth/token'],
  ])('the session limit goes the same way, as what it is, for %s: nothing about the password', async (_name, mode, route) => {
    useOfflineStore.setState({ enabled: [ALICE] });
    useAccountStore.setState({ accounts: [account(ALICE, 0, mode as 'basic' | 'oauth')] } as never);
    answer = (url, method) => (url.includes(route) && method === 'PUT' ? json(401, { error: 'session_expired', maxHours: 8 }) : null);
    await useAuthStore.getState().checkAuth();
    await vi.waitFor(() => expect(useAccountStore.getState().getAccountById(ALICE)?.awaitingSignIn).toBe(true));
    expect(heard).toEqual([ALICE]);
    expect(kinds).toEqual(['session']);
    expect(readRefusedLogins()[ALICE]).toMatchObject({ kind: 'session', certain: true });
    expect(isEvicted(ALICE)).toBe(true);
    expect(useOfflineStore.getState().enabled).toEqual([ALICE]);
  });

  it.each([
    ['a refusal other than invalid_grant', () => json(401, { error: 'Refresh failed' })],
    ['a 401 it can\'t read', () => new Response('nope', { status: 401 })],
    ['a 500', () => json(500, {})],
    ['a 503', () => json(503, {})],
  ])('%s doesn\'t', async (_name, make) => {
    answer = (url, method) => (url.includes('/api/auth/token') && method === 'PUT' ? make() : null);
    await useAuthStore.getState().checkAuth();
    expect(heard).toEqual([]);
  });

  it('a missing session cookie doesn\'t', async () => {
    useAccountStore.setState({ accounts: [account(ALICE, 0, 'basic')] } as never);
    answer = (url, method) => (url.includes('/api/auth/session') && method === 'PUT' ? json(401, { error: 'No session' }) : null);
    await useAuthStore.getState().checkAuth();
    expect(heard).toEqual([]);
    expect(readRefusedLogins()).toEqual({});
  });
});

describe('a login the server ended, at a switch', () => {
  beforeEach(() => {
    useAccountStore.setState({ accounts: [account(ALICE, 0, 'oauth'), account(BOB, 1, 'oauth')], activeAccountId: ALICE, defaultAccountId: ALICE } as never);
    useAuthStore.setState({ activeAccountId: ALICE, isAuthenticated: true });
  });

  it('invalid_grant fires the hook and hides the account, keeping its data', async () => {
    const reasons = await removalReasons();
    useOfflineStore.setState({ enabled: [ALICE, BOB] });
    answer = (url, method) => (url.includes('/api/auth/token') && method === 'PUT' ? json(401, { error: 'invalid_grant' }) : null);
    await useAuthStore.getState().switchAccount(BOB);
    expect(heard).toEqual([BOB]);
    expect(reasons).toEqual(['evicted']);
    expect(useAccountStore.getState().getAccountById(BOB)?.awaitingSignIn).toBe(true);
    expect(isEvicted(BOB)).toBe(true);
    expect(useOfflineStore.getState().enabled).toContain(BOB);
  });

  it('the session limit fires it as what it is, and only drops the account', async () => {
    useOfflineStore.setState({ enabled: [ALICE, BOB] });
    answer = (url, method) => (url.includes('/api/auth/token') && method === 'PUT' ? json(401, { error: 'session_expired', maxHours: 8 }) : null);
    await useAuthStore.getState().switchAccount(BOB);
    expect(heard).toEqual([BOB]);
    expect(kinds).toEqual(['session']);
    expect(isEvicted(BOB)).toBe(true);
    expect(useOfflineStore.getState().enabled).toContain(BOB);
  });

  it('another refusal doesn\'t', async () => {
    answer = (url, method) => (url.includes('/api/auth/token') && method === 'PUT' ? json(401, { error: 'Refresh failed' }) : null);
    await useAuthStore.getState().switchAccount(BOB);
    expect(heard).toEqual([]);
  });
});

describe('a refusal with another account signed in', () => {
  beforeEach(() => {
    useAccountStore.setState({ accounts: [account(ALICE, 0, 'oauth'), account(BOB, 1, 'oauth')], activeAccountId: ALICE, defaultAccountId: ALICE } as never);
    useAuthStore.setState({ activeAccountId: ALICE, isAuthenticated: true });
  });

  it('writes down who was there, so the note reaches them and nobody later', async () => {
    useOfflineStore.setState({ enabled: [ALICE, BOB] });
    answer = (url, method) => (url.includes('/api/auth/token') && method === 'PUT' ? json(401, { error: 'invalid_grant' }) : null);
    await useAuthStore.getState().refreshAccessToken({ accountId: BOB });
    expect(readRefusedLogins()[BOB]).toMatchObject({ seenBy: [ALICE], label: BOB, username: 'bob' });
  });
});

describe('a login with no "Remember me", when the browser closed', () => {
  it('still takes its data with it: that was the choice on a shared computer', async () => {
    const reasons = await removalReasons();
    useAccountStore.setState({ accounts: [{ ...account(ALICE, 0, 'basic'), rememberMe: false }], activeAccountId: ALICE, defaultAccountId: ALICE } as never);
    useAuthStore.setState({ activeAccountId: ALICE });
    useOfflineStore.setState({ enabled: [ALICE] });
    await useAuthStore.getState().checkAuth();
    await vi.waitFor(() => expect(reasons).toEqual(['explicit']));
    expect(readRefusedLogins()).toEqual({});
    expect(heard).toEqual([]);
  });
});

describe('a password the server keeps refusing', () => {
  beforeEach(() => {
    useAccountStore.setState({ accounts: [account(ALICE, 0, 'basic')], activeAccountId: ALICE, defaultAccountId: ALICE } as never);
    useAuthStore.setState({ activeAccountId: ALICE });
    useOfflineStore.setState({ enabled: [ALICE] });
  });

  it('at a start: signed out and hidden, not for certain, since one answer hasn\'t lasted', async () => {
    useOfflineStore.setState({ enabled: [ALICE] });
    clients.connect = async (client) => {
      (client as { refused?: (ms: number) => void }).refused?.(0);
      throw new Error('Invalid username or password');
    };
    await useAuthStore.getState().checkAuth();
    await vi.waitFor(() => expect(heard).toEqual([ALICE]));
    expect(Object.keys(readRefusedLogins())).toEqual([ALICE]);
    expect(certain).toEqual([false]);
    expect(useAccountStore.getState().getAccountById(ALICE)?.awaitingSignIn).toBe(true);
    expect(isEvicted(ALICE)).toBe(true);
  });

  describe('that recovered', () => {
    /** Gone from this page and back, with a session cookie that ran out: nothing says anything about the password. */
    async function backWithAFailingServer(): Promise<void> {
      useAuthStore.getState().removeAccount(BOB, 'wiped');
      useAccountStore.setState((state) => ({ accounts: [...state.accounts, account(BOB, 1, 'basic')] }) as never);
      answer = (url, method) => (url.includes('/api/auth/session') && method === 'PUT' ? json(401, { error: 'No session' }) : null);
      await useAuthStore.getState().switchAccount(BOB);
      // Got as far as the failure that would read the mark.
      expect(useAccountStore.getState().getAccountById(BOB)?.awaitingSignIn).toBe(true);
    }

    beforeEach(() => {
      useOfflineStore.setState({ enabled: [] });
      useAccountStore.setState({ accounts: [account(ALICE, 0, 'basic'), account(BOB, 1, 'basic')] } as never);
    });

    it('during the connect: a later failure isn\'t read as a refusal', async () => {
      clients.connect = async (client) => {
        (client as { refused?: (ms: number) => void }).refused?.(0);
      };
      await useAuthStore.getState().checkAuth();
      await vi.waitFor(() => expect(clients.made.length).toBeGreaterThanOrEqual(2));
      await vi.waitFor(() => expect(useAuthStore.getState().getClientForAccount(BOB)).toBeTruthy());
      await backWithAFailingServer();
      expect(heard).toEqual([]);
    });

    it('while running: a short refusal leaves no mark either', async () => {
      await useAuthStore.getState().checkAuth();
      await vi.waitFor(() => expect(useAuthStore.getState().getClientForAccount(BOB)).toBeTruthy());
      (useAuthStore.getState().getClientForAccount(BOB) as unknown as { refused: (ms: number) => void }).refused(0);
      await backWithAFailingServer();
      expect(heard).toEqual([]);
    });
  });

  it('a refusal at a start in a page with no offline kept records no wait', async () => {
    useOfflineStore.setState({ enabled: [] });
    clients.connect = async (client) => {
      (client as { refused?: (ms: number) => void }).refused?.(0);
      throw new Error('Invalid username or password');
    };
    await useAuthStore.getState().checkAuth();
    expect(readRefusedLogins()).toEqual({});
    expect(heard).toEqual([ALICE]);
  });

  it('at a start, with a server that only failed: no wait', async () => {
    useOfflineStore.setState({ enabled: [] });
    clients.connect = async () => { throw new Error('Failed to get session: 500'); };
    await useAuthStore.getState().checkAuth();
    expect(readRefusedLogins()).toEqual({});
    expect(heard).toEqual([]);
  });

  describe('while running', () => {
    async function running(): Promise<{ refused: (ms: number) => void }> {
      useOfflineStore.setState({ enabled: [] });
      await useAuthStore.getState().checkAuth();
      await vi.waitFor(() => expect(useAuthStore.getState().client).not.toBeNull());
      const client = useAuthStore.getState().client as unknown as { refused: (ms: number) => void };
      return client;
    }

    it('one answer changes nothing', async () => {
      const client = await running();
      client.refused(0);
      client.refused(CREDENTIALS_REFUSED_CONFIRM_MS - 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(useAccountStore.getState().getAccountById(ALICE)).toBeDefined();
      expect(readRefusedLogins()).toEqual({});
    });

    it('lasting a minute signs out at once and hides the data, for certain', async () => {
      const client = await running();
      useOfflineStore.setState({ enabled: [ALICE] });
      client.refused(CREDENTIALS_REFUSED_CONFIRM_MS);
      await vi.waitFor(() => expect(useAccountStore.getState().getAccountById(ALICE)?.awaitingSignIn).toBe(true));
      expect(Object.keys(readRefusedLogins())).toEqual([ALICE]);
      expect(heard).toEqual([ALICE]);
      expect(certain).toEqual([true]);
      expect(isEvicted(ALICE)).toBe(true);
      expect(sessionStorage.getItem('session_expired')).toBe('true');
    });
  });
});
