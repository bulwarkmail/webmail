import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
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
  registerOfflineHooks,
  scopeForAccount,
  setOfflineNotifier,
  wipeEverything,
  type OfflineNotice,
} from '../offline-mode';
import { useOfflineStore, writeEnabled } from '../state';

const NOW = Date.now();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const notices: OfflineNotice[] = [];
let store: InProcessStore;
let server: FakeJmap;

function setDevices(devices: Partial<typeof DEFAULT_ORGANISATION_POLICY.devices>): void {
  usePolicyStore.setState({
    loaded: true, source: 'server', subject: null, subjectPending: false,
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
    expect(JSON.parse(localStorage.getItem('bulwark-offline-choices')!).acc.days).toBe(30);
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
    expect(useOfflineStore.getState().health.acc?.opened).toBe(false);
    // It isn't read as a browser clearing the store at the next open.
    expect(notices.filter((n) => n.kind === 'evicted')).toEqual([]);
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

  it('holds to a cap from the first open', async () => {
    asDesktop();
    setDevices({ offlineMaxDays: 14 });
    enforcePolicy();
    await vi.waitFor(() => expect(useOfflineStore.getState().enabled).toEqual(['acc']));
    expect(scopeForAccount('acc').scope.days).toBe(14);
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
