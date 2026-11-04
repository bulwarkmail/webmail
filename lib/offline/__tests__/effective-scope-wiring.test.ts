import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { EMPTY_POLICY_LAYERS, resolvePolicies } from '@/lib/desktop/policy-schema';
import { getOfflineHooks, setOfflineHooks } from '@/lib/jmap/offline-hooks';
import { setStoreBackend } from '@/lib/store/client/api';
import { FakeJmap } from '@/lib/store/__tests__/helpers/fake-jmap';
import { InProcessStore } from '@/lib/store/__tests__/helpers/in-process-store';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import {
  chooseScope,
  clearAccount,
  disableOffline,
  enableOffline,
  enforcePolicy,
  offlineActive,
  offlineAllowed,
  refreshQueueState,
  refreshUsage,
  registerOfflineHooks,
  scopeForAccount,
  setOfflineNotifier,
  startOfflineMode,
  unsentCount,
  wipeEverything,
  type OfflineNotice,
} from '../offline-mode';
import { clearEvicted, markEvicted, OFFLINE_HEALTH_KEY, useOfflineStore, writeEnabled, writeHealth } from '../state';

const NOW = Date.now();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const notices: OfflineNotice[] = [];
let store: InProcessStore;
let server: FakeJmap;

function setDevices(devices: Partial<typeof DEFAULT_ORGANISATION_POLICY.devices>): void {
  usePolicyStore.setState({
    loaded: true, source: 'server', subject: { email: 'alice@example.org', groups: [] }, subjectPending: false,
    policy: { ...usePolicyStore.getState().policy, organisation: { ...DEFAULT_ORGANISATION_POLICY, devices: { ...DEFAULT_ORGANISATION_POLICY.devices, ...devices } } },
  } as never);
}

const ids = (account = 'acc') => store.dbs.get(account)!.all<{ id: string }>('SELECT id FROM email ORDER BY id').map((row) => row.id);

beforeEach(() => {
  localStorage.clear();
  server = new FakeJmap();
  store = new InProcessStore(server);
  setStoreBackend(store);
  notices.length = 0;
  setOfflineNotifier((notice) => notices.push(notice));
  useOfflineStore.setState({ enabled: [], choices: {}, health: {}, outbox: [], conflicts: [], areaConflicts: [], usage: {}, storageFull: {}, progress: {}, persist: 'unknown', browserOffline: false, downServers: [], startedOffline: false });
  useAccountStore.setState({ accounts: [{ id: 'acc', label: 'alice', serverUrl: 'https://mail.example.org', username: 'alice@example.org' } as never] });
  useAuthStore.setState({ activeAccountId: 'acc', client: null, getClientForAccount: (() => null) as never, getAllConnectedClients: (() => new Map()) as never });
  setDevices({});
});

afterEach(async () => {
  delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  setOfflineHooks(null);
  setOfflineNotifier(() => {});
  await wipeEverything();
  setStoreBackend(null);
});

describe('OfflineEnabled from the desktop app\'s OS policy', () => {
  function forced(value: unknown): void {
    const snapshot = resolvePolicies({ ...EMPTY_POLICY_LAYERS, forcedMachine: { OfflineEnabled: value } });
    (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', mode: 'standalone', policy: { get: () => snapshot, onChange: () => () => {} } };
  }

  it('a value that makes no sense stops keeping mail and deletes nothing', async () => {
    await enableOffline('acc');
    expect(useOfflineStore.getState().enabled).toEqual(['acc']);

    forced('yes');
    expect(offlineAllowed('acc')).toBe(false);
    enforcePolicy();
    await vi.waitFor(() => expect(offlineActive('acc')).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(useOfflineStore.getState().enabled).toEqual(['acc']);
    expect(notices.map((notice) => notice.kind)).not.toContain('forbidden');
  });

  it('forced off does delete', async () => {
    await enableOffline('acc');
    forced(0);
    enforcePolicy();
    await vi.waitFor(() => expect(useOfflineStore.getState().enabled).toEqual([]));
    expect(notices.map((notice) => notice.kind)).toContain('forbidden');
  });
});

describe('at page load, before the subject is known', () => {
  const forbiddenExceptGroup = {
    ...usePolicyStore.getState().rawPolicy,
    organisation: { devices: { noOffline: true } },
    scopes: [{ id: 'allowed', label: 'Allowed', match: { groups: ['team@example.org'] }, policy: { organisation: { devices: { noOffline: false } } } }],
  };

  function loading(): void {
    useOfflineStore.setState({ enabled: ['acc'] });
    usePolicyStore.setState({ rawPolicy: forbiddenExceptGroup, loaded: true, source: 'server', partial: false, subjectPending: false, subject: null } as never);
    usePolicyStore.setState({ policy: usePolicyStore.getState().resolveFor(null) } as never);
    useAuthStore.setState({ activeAccountId: 'acc', isLoading: true, client: null });
  }

  it('Everyone forbidding it wipes nothing while a group scope may allow it', async () => {
    loading();
    enforcePolicy();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.removed).toEqual([]);
    expect(useOfflineStore.getState().enabled).toEqual(['acc']);
    expect(notices.filter((n) => n.kind === 'forbidden')).toEqual([]);
  });

  it('with the subject in, the group decides', async () => {
    loading();
    usePolicyStore.getState().setPolicySubject({ email: 'alice@example.org', groups: ['team@example.org'] });
    enforcePolicy();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(useOfflineStore.getState().enabled).toEqual(['acc']);

    usePolicyStore.getState().setPolicySubject({ email: 'bob@example.org', groups: [] });
    enforcePolicy();
    await vi.waitFor(() => expect(useOfflineStore.getState().enabled).toEqual([]));
  });

  it('with no client coming, Everyone decides', async () => {
    loading();
    useAuthStore.setState({ isLoading: false, client: null });
    enforcePolicy();
    await vi.waitFor(() => expect(useOfflineStore.getState().enabled).toEqual([]));
  });

  it('pushes no scope either: a wider one would cost a re-list on every reload', async () => {
    usePolicyStore.setState({ rawPolicy: { ...forbiddenExceptGroup, organisation: {}, scopes: [] }, loaded: true, source: 'server', partial: false, subject: null } as never);
    useOfflineStore.setState({ enabled: ['acc'] });
    useAuthStore.setState({ activeAccountId: 'acc', isLoading: true, client: null });
    const setScope = vi.spyOn(store, 'setScope');
    enforcePolicy();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(setScope).not.toHaveBeenCalled();
  });
});

describe('the public part of the policy', () => {
  it('is not the organisation\'s word: no scope goes out, and no desktop default', async () => {
    useOfflineStore.setState({ enabled: ['acc'] });
    usePolicyStore.setState({ partial: true } as never);
    const setScope = vi.spyOn(store, 'setScope');
    enforcePolicy();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(setScope).not.toHaveBeenCalled();

    useOfflineStore.setState({ enabled: [] });
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1 };
    enforcePolicy();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(useOfflineStore.getState().enabled).toEqual([]);
  });
});

describe('an account dropped by the app', () => {
  it('is judged by what applies to anyone, not by the groups of whoever is signed in', async () => {
    const policy = {
      ...usePolicyStore.getState().rawPolicy,
      organisation: { devices: { noOffline: true } },
      scopes: [{ id: 'allowed', label: 'Allowed', match: { groups: ['team@example.org'] }, policy: { organisation: { devices: { noOffline: false } } } }],
    };
    usePolicyStore.setState({ rawPolicy: policy, loaded: true, source: 'server', partial: false, subjectPending: false, subject: null } as never);
    useAuthStore.setState({ activeAccountId: 'other', isLoading: false, client: null });
    useAccountStore.setState({ accounts: [{ id: 'other', label: 'other', serverUrl: 'https://mail.example.org', username: 'other@example.org' } as never] });
    usePolicyStore.getState().setPolicySubject({ email: 'other@example.org', groups: ['team@example.org'] });
    useOfflineStore.setState({ enabled: ['gone', 'other'] });
    markEvicted('gone');
    enforcePolicy();
    await vi.waitFor(() => expect(store.removed).toContain('gone'));
    // Whoever is here keeps theirs: they are in the group.
    expect(store.removed).not.toContain('other');
    expect(useOfflineStore.getState().enabled).toEqual(['other']);
    clearEvicted('gone');
  });
});

describe('a policy fetch', () => {
  async function kept(): Promise<void> {
    server.addEmail({ id: 'old', receivedAt: iso(100) });
    server.addEmail({ id: 'new', receivedAt: iso(5) });
    writeEnabled(['acc']);
    useOfflineStore.setState({ choices: { acc: { on: true, days: null } } });
    await store.setScope('acc', scopeForAccount('acc').scope);
    await store.sync('acc');
    expect(ids()).toEqual(['new', 'old']);
  }

  it('with a lower cap prunes what is kept, without fetching what stays', async () => {
    await kept();
    server.calls.length = 0;
    setDevices({ offlineMaxDays: 30 });
    enforcePolicy();
    await vi.waitFor(() => expect(ids()).toEqual(['new']));
    expect(server.calls.filter(([name]) => name === 'Email/query')).toEqual([]);
  });

  it('with the cap raised again starts a backfill', async () => {
    await kept();
    setDevices({ offlineMaxDays: 30 });
    enforcePolicy();
    await vi.waitFor(() => expect(ids()).toEqual(['new']));
    setDevices({});
    enforcePolicy();
    await vi.waitFor(() => expect(ids()).toEqual(['new', 'old']));
  });

  it('with defaults only (no policy heard yet) changes nothing', async () => {
    await kept();
    usePolicyStore.setState({ source: 'fallback' } as never);
    const setScope = vi.spyOn(store, 'setScope');
    enforcePolicy();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(setScope).not.toHaveBeenCalled();
  });
});

describe('the user picking what to keep', () => {
  it('goes to the store and prunes', async () => {
    server.addEmail({ id: 'old', receivedAt: iso(100) });
    server.addEmail({ id: 'new', receivedAt: iso(5) });
    writeEnabled(['acc']);
    useOfflineStore.setState({ choices: { acc: { on: true, days: null } } });
    await store.setScope('acc', scopeForAccount('acc').scope);
    await store.sync('acc');
    chooseScope('acc', { days: 30 });
    await vi.waitFor(() => expect(ids()).toEqual(['new']));
    expect(JSON.parse(localStorage.getItem('bulwark-offline-scope')!).acc.days).toBe(30);
  });

  it('waits for a choice to settle: arrowing past a short window prunes nothing', async () => {
    writeEnabled(['acc']);
    useOfflineStore.setState({ choices: { acc: { on: true, days: null } } });
    const setScope = vi.spyOn(store, 'setScope');
    vi.useFakeTimers();
    try {
      chooseScope('acc', { days: 30 });
      await vi.advanceTimersByTimeAsync(300);
      chooseScope('acc', { days: 90 });
      await vi.advanceTimersByTimeAsync(300);
      chooseScope('acc', { days: 365 });
      await vi.advanceTimersByTimeAsync(300);
      expect(setScope).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
    }
    expect(setScope).toHaveBeenCalledTimes(1);
    expect(setScope.mock.calls[0][1].days).toBe(365);
  });

  it('starts from what is in force: someone from before the local store keeps the rest of what they had', () => {
    writeEnabled(['acc']);
    useOfflineStore.setState({ choices: {} });
    chooseScope('acc', { attachments: false });
    expect(useOfflineStore.getState().choices.acc).toMatchObject({ on: true, days: 30, attachments: false });
  });

  it('can\'t get past the cap', () => {
    setDevices({ offlineMaxDays: 30 });
    writeEnabled(['acc']);
    chooseScope('acc', { days: null });
    expect(scopeForAccount('acc').scope.days).toBe(30);
  });
});

describe('opened messages', () => {
  it('past the organisation\'s cap aren\'t recorded; under it they are', async () => {
    registerOfflineHooks();
    writeEnabled(['acc']);
    setDevices({ offlineMaxDays: 30 });
    const area = vi.spyOn(store, 'area');
    const client = { getServerUrl: () => 'https://mail.example.org', getUsername: () => 'alice@example.org', getAccountId: () => 'j' } as never;
    const message = (id: string, receivedAt: string) => ({ id, receivedAt, mailboxIds: { inbox: true }, bodyValues: { 1: { value: 'x', isTruncated: false } } });
    getOfflineHooks()!.record!(client, [['Email/get', { accountId: 'j' }, 'c']], {
      methodResponses: [['Email/get', { accountId: 'j', list: [message('old', iso(100)), message('new', iso(5))] }, 'c']],
    } as never);
    await vi.waitFor(() => expect(area).toHaveBeenCalled());
    const recorded = area.mock.calls.filter(([, name]) => name === 'mail.recordOpened').flatMap(([, , params]) => (params as { emails: Array<{ id: string }> }).emails.map((email) => email.id));
    expect(recorded).toEqual(['new']);
  });
});

describe('the usage of several accounts', () => {
  it('one store in trouble leaves what the others said', async () => {
    writeEnabled(['acc', 'bad']);
    const area = vi.spyOn(store, 'area');
    const real = area.getMockImplementation();
    area.mockImplementation(async (account: string, name: string) => {
      if (name !== 'store.usage') return real ? real(account, name) : undefined;
      if (account === 'bad') throw new Error('gone');
      return { bytes: 5, parts: [] };
    });
    await refreshUsage();
    expect(useOfflineStore.getState().usage.acc?.bytes).toBe(5);
    area.mockRestore();
  });
});

describe('what a browser clearing the store would lose', () => {
  it('counts local drafts too', async () => {
    writeEnabled(['acc']);
    const real = store.area.bind(store);
    vi.spyOn(store, 'area').mockImplementation(async (account: string, name: string, params?: unknown) => (
      name.startsWith('drafts.') && !name.includes('Elsewhere')
        ? [{ localId: 'local-1', jmap: 'j', subject: 'Only here', status: 'waiting', createdAt: 0 }]
        : real(account, name, params)
    ) as never);
    await refreshQueueState();
    expect(useOfflineStore.getState().health.acc?.pending).toBe(1);
    vi.restoreAllMocks();
  });
});

describe('what would be lost', () => {
  it('counts changes per account when a store can\'t answer, and local drafts', async () => {
    useOfflineStore.setState({
      enabled: ['acc', 'b'],
      changesBy: { acc: 2, b: 7 },
      outbox: [],
      localDrafts: [{ account: 'acc', localId: 'd', status: 'waiting' } as never],
    });
    vi.spyOn(store, 'area').mockRejectedValue(new Error('gone'));
    expect(await unsentCount('acc')).toEqual({ messages: 1, changes: 2 });
    vi.restoreAllMocks();
  });
});

describe('turning the last account off', () => {
  it('keeps the off of another account still signed in', async () => {
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1 };
    useAuthStore.setState({ activeAccountId: 'acc', getAllConnectedClients: (() => new Map([['acc', {}], ['other', {}]])) as never });
    useOfflineStore.setState({ choices: { other: { on: false } } });
    writeEnabled(['acc']);
    await disableOffline('acc');
    expect(useOfflineStore.getState().choices).toEqual({ acc: { on: false }, other: { on: false } });
    expect(JSON.parse(localStorage.getItem('bulwark-offline-scope')!).other.on).toBe(false);
  });
});

describe('clearing an account', () => {
  it('removes its store and starts over, and it stays on', async () => {
    server.addEmail({ id: 'new', receivedAt: iso(5) });
    writeEnabled(['acc']);
    await store.sync('acc');
    expect(ids()).toEqual(['new']);
    const before = store.dbs.get('acc');

    await clearAccount('acc');

    expect(store.removed).toContain('acc');
    expect(useOfflineStore.getState().enabled).toEqual(['acc']);
    expect(store.dbs.get('acc')).not.toBe(before);
    expect(useOfflineStore.getState().health.acc?.clearedAt).toBeGreaterThan(0);
    expect(notices.filter((n) => n.kind === 'store-reset')).toEqual([]);
  });
});

describe('clearing in another tab', () => {
  it('opens the new store here, in case this tab owns it', async () => {
    writeEnabled(['acc']);
    writeHealth('acc', { clearedAt: 1 });
    const stop = startOfflineMode();
    const ensureOpen = vi.spyOn(store, 'ensureOpen');
    ensureOpen.mockClear();
    const area = vi.spyOn(store, 'area');
    // What the start itself asks for is over.
    await new Promise((resolve) => setTimeout(resolve, 20));
    area.mockClear();
    localStorage.setItem(OFFLINE_HEALTH_KEY, JSON.stringify({ acc: { clearedAt: 2, pending: 0 } }));
    window.dispatchEvent(new StorageEvent('storage', { key: OFFLINE_HEALTH_KEY }));
    expect(ensureOpen).toHaveBeenCalledWith('acc');
    expect(useOfflineStore.getState().health.acc.clearedAt).toBe(2);
    // Its lists and sizes are of a store that's gone.
    await vi.waitFor(() => expect(area).toHaveBeenCalledWith('acc', 'store.usage'));
    stop();
  });
});

describe('the desktop app', () => {
  const asDesktop = () => { (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1 }; };

  it('keeps mail for an account without asking, and says so once', async () => {
    asDesktop();
    enforcePolicy();
    await vi.waitFor(() => expect(useOfflineStore.getState().enabled).toEqual(['acc']));
    expect(notices.filter((n) => n.kind === 'default-on')).toHaveLength(1);
    enforcePolicy();
    expect(notices.filter((n) => n.kind === 'default-on')).toHaveLength(1);
  });

  it('not when the organisation forbids it', async () => {
    asDesktop();
    setDevices({ noOffline: true });
    enforcePolicy();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(useOfflineStore.getState().enabled).toEqual([]);
    expect(notices.filter((n) => n.kind === 'default-on')).toEqual([]);
  });

  it('not before the policy is known', async () => {
    asDesktop();
    usePolicyStore.setState({ source: 'none' } as never);
    enforcePolicy();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(useOfflineStore.getState().enabled).toEqual([]);
  });

  it('not after the user turned it off', async () => {
    asDesktop();
    enforcePolicy();
    await vi.waitFor(() => expect(useOfflineStore.getState().enabled).toEqual(['acc']));
    await disableOffline('acc');
    enforcePolicy();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(useOfflineStore.getState().enabled).toEqual([]);
    expect(useOfflineStore.getState().choices.acc?.on).toBe(false);
  });

});

describe('a browser', () => {
  it('stays opt-in', async () => {
    enforcePolicy();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(useOfflineStore.getState().enabled).toEqual([]);
    expect(notices).toEqual([]);
    await enableOffline('acc');
    expect(useOfflineStore.getState().enabled).toEqual(['acc']);
  });
});
