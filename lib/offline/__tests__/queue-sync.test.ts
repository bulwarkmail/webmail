import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStoreBackend } from '@/lib/store/client/api';
import { InProcessStore } from '@/lib/store/__tests__/helpers/in-process-store';
import { getOfflineHooks } from '@/lib/jmap/offline-hooks';
import { usePolicyStore } from '@/stores/policy-store';
import { useAccountStore } from '@/stores/account-store';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { queueSend, readQueue } from '../queue';
import { registerOfflineHooks } from '../offline-mode';
import { writeEnabled } from '../state';

// Whatever goes into the outbox asks for a Background Sync, once it's stored.

const seen = vi.hoisted(() => ({ calls: 0, onCall: (() => {}) as () => void }));
vi.mock('@/lib/pwa-notify/outbox-sync', () => ({ requestOutboxSync: () => { seen.calls += 1; seen.onCall(); } }));

let store: InProcessStore;

beforeEach(() => {
  store = new InProcessStore();
  setStoreBackend(store);
  seen.calls = 0;
  seen.onCall = () => {};
  usePolicyStore.setState({ loaded: true, subject: { email: 'alice@example.org', groups: [] }, policy: { ...usePolicyStore.getState().policy, organisation: DEFAULT_ORGANISATION_POLICY } });
  useAccountStore.setState({ accounts: [{ id: 'acc', serverUrl: 'https://mail.example.org', username: 'alice@example.org' } as never] });
});

afterEach(() => {
  setStoreBackend(null);
  writeEnabled([]);
});

describe('the outbox', () => {
  it('asks for a sync after storing a message, and still returns its id', async () => {
    let storedWhenAsked = -1;
    seen.onCall = () => { void readQueue('acc').then(({ outbox }) => { storedWhenAsked = outbox.length; }); };
    const id = await queueSend('acc', { subject: 'S', to: [] }, { kind: 'email', args: [] });
    expect(id).toBe(1);
    expect(seen.calls).toBe(1);
    await vi.waitFor(() => expect(storedWhenAsked).toBe(1));
  });

  it('asks for a sync after keeping a change the client made, not after a read', async () => {
    writeEnabled(['acc']);
    registerOfflineHooks();
    const client = { getServerUrl: () => 'https://mail.example.org', getUsername: () => 'alice@example.org', getAccountId: () => 'acc1' };
    await getOfflineHooks()?.answer(client, [['Email/set', { update: { m: { 'keywords/$seen': true } } }, '0']]);
    expect(seen.calls).toBe(1);
    await getOfflineHooks()?.answer(client, [['Email/get', { ids: [] }, '0']]);
    expect(seen.calls).toBe(1);
  });
});
