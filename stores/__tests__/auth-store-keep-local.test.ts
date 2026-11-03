import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// What an automatic sign-out does to the mail on this device. A real refusal of
// the login wipes it, like a sign-out. An outage, or a refusal that says nothing
// about the login, keeps it for the next sign-in.

const purge = vi.hoisted(() => ({ files: 0 }));
vi.mock('@/lib/store/client/purge', () => ({ purgeStoreFiles: async () => { purge.files += 1; }, deleteStorePool: async () => {} }));
vi.mock('@/lib/compose-flush-registry', () => ({ flushComposers: vi.fn(async () => ({ total: 0, settled: 0, failed: 0, timedOut: false })) }));

let useAuthStore: typeof import('../auth-store').useAuthStore;
let useAccountStore: typeof import('../account-store').useAccountStore;
let state: typeof import('@/lib/offline/state');
let offline: typeof import('@/lib/offline/offline-mode');
let queue: typeof import('@/lib/offline/queue');
let lost: typeof import('@/lib/offline/lost');
let store: import('@/lib/store/__tests__/helpers/in-process-store').InProcessStore;

const ALICE = 'alice@mail.example.test';

function entry(id: string, cookieSlot: number) {
  return {
    id, label: id, serverUrl: 'https://mail.example.test', username: id.split('@mail')[0], authMode: 'oauth', rememberMe: true,
    displayName: id, email: id, lastLoginAt: Date.now(), isConnected: true, hasError: false, isDefault: cookieSlot === 0, cookieSlot, avatarColor: '#000',
  };
}

function answer(status: number, body: unknown = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function tokenAnswers(next: () => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => (String(input).includes('/api/auth/token') ? next() : answer(200))));
}

/** `times`: as often as the retry timer would run it. */
async function refresh(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) await useAuthStore.getState().refreshAccessToken({ accountId: ALICE });
  await vi.waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(false));
}

beforeEach(async () => {
  vi.resetModules();
  purge.files = 0;
  localStorage.clear();
  sessionStorage.clear();
  ({ useAuthStore } = await import('../auth-store'));
  ({ useAccountStore } = await import('../account-store'));
  state = await import('@/lib/offline/state');
  offline = await import('@/lib/offline/offline-mode');
  queue = await import('@/lib/offline/queue');
  lost = await import('@/lib/offline/lost');
  const browserNavigation = await import('@/lib/browser-navigation');
  vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});
  const { InProcessStore } = await import('@/lib/store/__tests__/helpers/in-process-store');
  const { setStoreBackend } = await import('@/lib/store/client/api');
  store = new InProcessStore();
  setStoreBackend(store);
  useAccountStore.setState({ accounts: [entry(ALICE, 0)], activeAccountId: ALICE, defaultAccountId: ALICE } as never);
  useAuthStore.setState({ isAuthenticated: true, activeAccountId: ALICE, authMode: 'oauth', serverUrl: 'https://mail.example.test', username: 'alice' });
  state.writeEnabled([ALICE]);
  await queue.queueSend(ALICE, { subject: 'Unsent', to: [] }, { kind: 'email', args: [] });
}, 60_000);

function expectKept(): void {
  expect(purge.files).toBe(0);
  expect(state.useOfflineStore.getState().enabled).toEqual([ALICE]);
  expect(localStorage.getItem(state.OFFLINE_ACCOUNTS_KEY)).toContain(ALICE);
  expect(state.isEvicted(ALICE)).toBe(true);
  expect(store.removed).toEqual([]);
  expect(store.stopped).toBe(0);
  // Nothing was lost, so nothing is named at the sign-in page.
  expect(lost.consumeLost()).toEqual([]);
}

describe('an automatic sign-out of the active account', () => {
  it('keeps the data through a run of 502s from a proxy', async () => {
    tokenAnswers(() => answer(502, '<html>Bad Gateway</html>'));
    await refresh(5);
    expectKept();
  });

  it('keeps the data through a run of the route\'s own 500s', async () => {
    tokenAnswers(() => answer(500, { error: 'Internal server error' }));
    await refresh(5);
    expectKept();
  });

  it('keeps the data on a refusal that says nothing about the login', async () => {
    tokenAnswers(() => answer(401, { error: 'Refresh failed' }));
    await refresh();
    expectKept();
  });

  it('keeps the data on a refusal it can\'t read', async () => {
    tokenAnswers(() => answer(401, 'nope'));
    await refresh();
    expectKept();
  });

  it('wipes on a real invalid_grant, and names the lost mail', async () => {
    tokenAnswers(() => answer(401, { error: 'invalid_grant' }));
    offline.startOfflineMode();
    await refresh();
    await vi.waitFor(() => expect(purge.files).toBeGreaterThan(0));
    expect(localStorage.getItem(state.OFFLINE_ACCOUNTS_KEY)).toBeNull();
    expect(lost.consumeLost()).toEqual(['Unsent']);
  });

  it('wipes at the organisation\'s session limit', async () => {
    const { SESSION_TOO_OLD } = await import('@/lib/session-policy/constants');
    tokenAnswers(() => answer(401, { error: SESSION_TOO_OLD, maxHours: 8 }));
    await refresh();
    await vi.waitFor(() => expect(purge.files).toBeGreaterThan(0));
  });
});

describe('a background account', () => {
  const BOB = 'bob@mail.example.test';
  const token = async () => useAuthStore.getState().refreshAccessToken({ accountId: BOB });

  beforeEach(() => {
    useAccountStore.setState({ accounts: [entry(ALICE, 0), entry(BOB, 1)] } as never);
    state.writeEnabled([ALICE, BOB]);
    offline.startOfflineMode();
  });

  it('keeps its data on an unknown refusal', async () => {
    tokenAnswers(() => answer(401, { error: 'Refresh failed' }));
    await token();
    await vi.waitFor(() => expect(useAccountStore.getState().getAccountById(BOB)).toBeUndefined());
    expect(state.isEvicted(BOB)).toBe(true);
    expect(store.removed).toEqual([]);
  });

  it('wipes on a real invalid_grant', async () => {
    tokenAnswers(() => answer(401, { error: 'invalid_grant' }));
    await token();
    await vi.waitFor(() => expect(store.removed).toEqual([BOB]));
    expect(state.isEvicted(BOB)).toBe(false);
  });
});

describe('data waiting for a sign-in', () => {
  const BOB = 'bob@mail.example.test';

  beforeEach(async () => {
    state.writeEnabled([ALICE, BOB]);
    await queue.queueSend(BOB, { subject: 'Bob\'s', to: [] }, { kind: 'email', args: [] });
    useAccountStore.setState({ accounts: [entry(ALICE, 0), entry(BOB, 1)] } as never);
    useAccountStore.getState().removeAccount(BOB, 'evicted');
  });

  it('is hidden from anyone else, in every list', async () => {
    await offline.refreshQueueState();
    expect(state.useOfflineStore.getState().outbox.map((row) => row.subject)).toEqual(['Unsent']);
    expect((await queue.readQueue()).outbox.map((row) => row.account)).toEqual([ALICE]);
    await offline.refreshUsage();
    expect(state.visibleAccounts()).toEqual([ALICE]);
  });

  it('shows again when the account signs in', async () => {
    useAccountStore.getState().addAccount({ username: 'bob', serverUrl: 'https://mail.example.test', authMode: 'oauth', rememberMe: true, label: 'bob', displayName: 'bob', email: 'bob', lastLoginAt: 1, isConnected: true, hasError: false, isDefault: false } as never);
    expect(state.isEvicted(BOB)).toBe(false);
    await offline.refreshQueueState();
    expect(state.useOfflineStore.getState().outbox.map((row) => row.subject).sort()).toEqual(['Bob\'s', 'Unsent']);
  });

  it('goes after 30 days', async () => {
    localStorage.setItem(state.OFFLINE_EVICTED_KEY, JSON.stringify({ [BOB]: Date.now() - state.EVICTED_KEEP_MS - 1000 }));
    offline.startOfflineMode();
    await vi.waitFor(() => expect(store.removed).toEqual([BOB]));
    expect(state.isEvicted(BOB)).toBe(false);
    expect(state.useOfflineStore.getState().enabled).toEqual([ALICE]);
  });

  it('stays before that', async () => {
    offline.startOfflineMode();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.removed).toEqual([]);
    expect(state.useOfflineStore.getState().enabled).toEqual([ALICE, BOB]);
  });

  it('survives someone else\'s full sign-out, whose own data goes', async () => {
    offline.startOfflineMode();
    await useAuthStore.getState().logout({ endProviderSession: false });
    await vi.waitFor(() => expect(store.removed).toEqual([ALICE]));
    expect(purge.files).toBe(0);
    expect(state.useOfflineStore.getState().enabled).toEqual([BOB]);
    expect(state.isEvicted(BOB)).toBe(true);
  });
});

describe('a login without "remember me"', () => {
  it('ends with its data at a reload, naming lost mail, even before the host runs', async () => {
    useAccountStore.setState({ accounts: [{ ...entry(ALICE, 0), rememberMe: false }] } as never);
    tokenAnswers(() => answer(200));
    await useAuthStore.getState().checkAuth();
    expect(useAccountStore.getState().getAccountById(ALICE)).toBeUndefined();
    expect(state.isEvicted(ALICE)).toBe(false);
    offline.startOfflineMode();
    await vi.waitFor(() => expect(purge.files).toBeGreaterThan(0));
    expect(lost.consumeLost()).toEqual(['Unsent']);
  });
});
