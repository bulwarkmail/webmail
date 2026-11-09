import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccountStore } from '@/stores/account-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { handOffFiles, pendingHandoffs } from '@/lib/launch-handoff';
import { disableOffline, enforcePolicy, wipeEverything } from '../offline-mode';
import { setStoreBackend } from '@/lib/store/client/api';
import { InProcessStore } from '@/lib/store/__tests__/helpers/in-process-store';
import { useOfflineStore, writeEnabled } from '../state';

// Offline mode's wipes take what was on its way into an account along.

function waiting() {
  handOffFiles([new File(['x'], 'a.ics')], 'calendar');
  expect(pendingHandoffs()).toHaveLength(1);
}

beforeEach(async () => {
  setStoreBackend(new InProcessStore());
  localStorage.clear();
  useOfflineStore.setState({ enabled: [], outbox: [], pendingChanges: 0, browserOffline: false, downServers: [], startedOffline: false });
  usePolicyStore.setState({ loaded: true, subject: { email: 'alice@example.org', groups: [] }, subjectPending: false, policy: { ...usePolicyStore.getState().policy, organisation: DEFAULT_ORGANISATION_POLICY } } as never);
  useAccountStore.setState({ accounts: [{ id: 'acc', label: 'alice', serverUrl: 'https://mail.example.org', username: 'alice@example.org' } as never] });
});

afterEach(async () => {
  await wipeEverything();
  setStoreBackend(null);
});

describe('offline wipes and handoffs', () => {
  it('wipeEverything clears them', async () => {
    waiting();
    await wipeEverything();
    expect(pendingHandoffs()).toHaveLength(0);
  });

  it('disableOffline clears them', async () => {
    writeEnabled(['acc']);
    waiting();
    await disableOffline('acc');
    expect(pendingHandoffs()).toHaveLength(0);
  });

  it('enforcePolicy clears them when the organisation forbids offline mode', async () => {
    writeEnabled(['acc']);
    waiting();
    usePolicyStore.setState({ policy: { ...usePolicyStore.getState().policy, organisation: { ...DEFAULT_ORGANISATION_POLICY, devices: { ...DEFAULT_ORGANISATION_POLICY.devices, noOffline: true } } } });
    enforcePolicy();
    await vi.waitFor(() => expect(useOfflineStore.getState().enabled).toEqual([]));
    expect(pendingHandoffs()).toHaveLength(0);
  });

  it('enforcePolicy leaves them while offline mode is allowed', () => {
    writeEnabled(['acc']);
    waiting();
    enforcePolicy();
    expect(pendingHandoffs()).toHaveLength(1);
  });
});
