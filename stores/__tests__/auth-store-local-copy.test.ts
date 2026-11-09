import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// With the local store on, a start paints from the local copy at once, then
// connects and swaps. The hooks are there before the first request.
const offline = vi.hoisted(() => ({
  order: [] as string[],
  session: { apiUrl: 'x' } as unknown,
  gone: false,
  ready: true,
  // A local copy with no identities kept answers an empty list.
  localIdentities: Promise.resolve([]) as Promise<unknown[]>,
  releaseLocal: () => {},
}));

vi.mock('@/lib/offline/offline-mode', () => ({
  registerOfflineHooks: () => { offline.order.push('hooks'); },
  offlineSessionFor: async (_account: string, options?: { withFolders?: boolean }) => (options?.withFolders && !offline.ready ? null : offline.session),
  serverUnreachable: async () => offline.gone,
  markStartedOffline: () => { offline.order.push('startedOffline'); },
}));

let connectGate: Promise<void> = Promise.resolve();

vi.mock('@/lib/jmap/client', () => {
  class JMAPClient {
    offlineOnly = false;
    constructor(public serverUrl: string, public username: string, public password: string) {}
    static withBearer() { throw new Error('not used'); }
    static fromOfflineSession(serverUrl: string, username: string) {
      offline.order.push('local client');
      const client = new JMAPClient(serverUrl, username, '');
      client.offlineOnly = true;
      return client;
    }
    isOfflineOnly() { return this.offlineOnly; }
    async connect() { offline.order.push('connect'); await connectGate; }
    getSessionUsername() { return this.username; }
    getUsername() { return this.username; }
    async getIdentities() {
      return this.offlineOnly ? offline.localIdentities : [{ id: 'a', email: this.username, name: this.username, mayDelete: false }];
    }
    getAuthHeader() { return 'Basic eA=='; }
    onConnectionChange() {}
    onRateLimit() {}
    getRateLimitRemainingMs() { return 0; }
    supportsContacts() { return false; }
    supportsPrincipals() { return false; }
    supportsVacationResponse() { return false; }
    supportsCalendars() { return false; }
    supportsSieve() { return false; }
    disconnect() {}
    getAccountId() { return 'acct'; }
  }
  class RateLimitError extends Error {}
  class RequestTimeoutError extends Error {}
  return { JMAPClient, RateLimitError, RequestTimeoutError };
});
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));

import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useOfflineStore } from '@/lib/offline/state';

// The auth store keeps its clients for good, so each test gets an account of its own.
let run = 0;
let ACCOUNT = makeAccount();

function makeAccount() {
  run += 1;
  const username = `bob${run}@x.test`;
  return {
    id: `${username}@mail.x.test`, label: 'Bob', serverUrl: 'https://mail.x.test', username, authMode: 'basic' as const,
    rememberMe: true, cookieSlot: 0, displayName: 'Bob', email: username, isConnected: false, hasError: false,
    lastLoginAt: 1, avatarColor: '#000000', isDefault: true,
  };
}

let sessionAnswer: () => Response;

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/auth/session')) return sessionAnswer();
    if (url.includes('/api/config')) return new Response(JSON.stringify(createConfig()), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
});

const goodSession = () => new Response(JSON.stringify({ serverUrl: ACCOUNT.serverUrl, username: ACCOUNT.username, password: 'x' }), { status: 200 });

beforeEach(async () => {
  ACCOUNT = makeAccount();
  offline.order.length = 0;
  offline.session = { apiUrl: 'x' };
  offline.gone = false;
  offline.ready = true;
  offline.localIdentities = Promise.resolve([]);
  connectGate = Promise.resolve();
  sessionAnswer = goodSession;
  useAccountStore.setState({ accounts: [ACCOUNT] as never, activeAccountId: ACCOUNT.id, defaultAccountId: ACCOUNT.id });
  useOfflineStore.setState({ enabled: [ACCOUNT.id], startedOffline: false });
  useAuthStore.setState({ client: null, isAuthenticated: false, activeAccountId: ACCOUNT.id, identities: [], primaryIdentity: null });
});

type ClientLike = { isOfflineOnly(): boolean };
const current = () => useAuthStore.getState().client as unknown as ClientLike | null;

it('registers the hooks first, shows the local copy before connecting, then swaps', async () => {
  let open: () => void = () => {};
  connectGate = new Promise((resolve) => { open = resolve; });
  await useAuthStore.getState().checkAuth();

  // The real connect hasn't finished, and the app is up on the local copy.
  expect(useAuthStore.getState().isAuthenticated).toBe(true);
  expect(useAuthStore.getState().isLoading).toBe(false);
  expect(current()?.isOfflineOnly()).toBe(true);
  expect(offline.order[0]).toBe('hooks');
  expect(offline.order).toContain('local client');
  // No "you're offline" while the server is simply being asked.
  expect(offline.order).not.toContain('startedOffline');

  open();
  await vi.waitFor(() => expect(current()?.isOfflineOnly()).toBe(false));
  expect(useAuthStore.getState().isAuthenticated).toBe(true);
  expect(useAuthStore.getState().getClientForAccount(ACCOUNT.id)).toBe(useAuthStore.getState().client);
});

it('stays on the local copy when the server can\'t be reached', async () => {
  sessionAnswer = () => new Response('{}', { status: 503 });
  offline.gone = true;
  await useAuthStore.getState().checkAuth();
  await vi.waitFor(() => expect(offline.order).toContain('startedOffline'));
  expect(useAuthStore.getState().isAuthenticated).toBe(true);
  expect(current()?.isOfflineOnly()).toBe(true);
  expect(useAccountStore.getState().getAccountById(ACCOUNT.id)).toBeTruthy();
});

it('stays on the local copy, and says so, when the server answers a start with a 5xx or 429', async () => {
  for (const status of [502, 429]) {
    ACCOUNT = makeAccount();
    offline.order.length = 0;
    useAccountStore.setState({ accounts: [ACCOUNT] as never, activeAccountId: ACCOUNT.id, defaultAccountId: ACCOUNT.id });
    useOfflineStore.setState({ enabled: [ACCOUNT.id] });
    useAuthStore.setState({ client: null, isAuthenticated: false, activeAccountId: ACCOUNT.id });
    sessionAnswer = () => new Response('{}', { status });
    // The probe passes: the server itself is there.
    offline.gone = false;
    await useAuthStore.getState().checkAuth();
    await vi.waitFor(() => expect(offline.order).toContain('startedOffline'));
    expect(current()?.isOfflineOnly()).toBe(true);
    expect(useAccountStore.getState().getAccountById(ACCOUNT.id)).toBeTruthy();
  }
});

it('goes the usual way when the store has no copy', async () => {
  offline.session = null;
  await useAuthStore.getState().checkAuth();
  expect(offline.order).not.toContain('local client');
  expect(current()?.isOfflineOnly()).toBe(false);
});

it('doesn\'t touch the store for an account without it', async () => {
  useOfflineStore.setState({ enabled: [] });
  await useAuthStore.getState().checkAuth();
  expect(offline.order).toEqual(['connect']);
  expect(current()?.isOfflineOnly()).toBe(false);
});

it('goes the usual way while the store has no folders yet', async () => {
  offline.ready = false;
  await useAuthStore.getState().checkAuth();
  expect(offline.order).not.toContain('local client');
  expect(current()?.isOfflineOnly()).toBe(false);
});

it('still starts on an empty store when the server can\'t be reached', async () => {
  offline.ready = false;
  offline.gone = true;
  sessionAnswer = () => new Response('{}', { status: 503 });
  await useAuthStore.getState().checkAuth();
  await vi.waitFor(() => expect(current()?.isOfflineOnly()).toBe(true));
});

it('fills the From list from the server after the swap, when the local copy had none', async () => {
  let open: () => void = () => {};
  connectGate = new Promise((resolve) => { open = resolve; });
  await useAuthStore.getState().checkAuth();
  await vi.waitFor(() => expect(current()?.isOfflineOnly()).toBe(true));
  expect(useAuthStore.getState().identities).toEqual([]);
  open();
  await vi.waitFor(() => expect(useAuthStore.getState().identities.map((identity) => identity.email)).toEqual([ACCOUNT.username]));
  expect(useAuthStore.getState().primaryIdentity?.email).toBe(ACCOUNT.username);
});

it('doesn\'t let a late local answer overwrite the server\'s From list', async () => {
  offline.localIdentities = new Promise((resolve) => { offline.releaseLocal = () => resolve([{ id: 'old', email: 'stale@x.test', name: 'Stale', mayDelete: false }]); });
  await useAuthStore.getState().checkAuth();
  await vi.waitFor(() => expect(useAuthStore.getState().identities.map((identity) => identity.email)).toEqual([ACCOUNT.username]));
  offline.releaseLocal();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(useAuthStore.getState().identities.map((identity) => identity.email)).toEqual([ACCOUNT.username]);
});

it('leaves the login path to a refused account, and keeps its data', async () => {
  sessionAnswer = () => new Response('{}', { status: 401 });
  await useAuthStore.getState().checkAuth();
  await vi.waitFor(() => expect(useAccountStore.getState().getAccountById(ACCOUNT.id)).toMatchObject({ awaitingSignIn: true, isConnected: false }));
  await vi.waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(false));
  expect(useAuthStore.getState().client).toBeNull();
  expect(useOfflineStore.getState().enabled).toEqual([ACCOUNT.id]);
});
