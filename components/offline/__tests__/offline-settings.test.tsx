import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const offline = vi.hoisted(() => ({ enableOffline: vi.fn(async () => {}), disableOffline: vi.fn(async () => {}) }));
vi.mock('@/lib/offline/offline-mode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/offline/offline-mode')>()),
  enableOffline: offline.enableOffline,
  disableOffline: offline.disableOffline,
}));

import { OfflineSettings } from '../offline-settings';
import { useOfflineStore } from '@/lib/offline/state';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { setStoreBackend, type StoreBackend } from '@/lib/store/client/api';

function setNoOffline(noOffline: boolean) {
  usePolicyStore.setState({
    loaded: true,
    subject: { email: 'alice@example.org', groups: [] },
    policy: { ...usePolicyStore.getState().policy, organisation: { ...DEFAULT_ORGANISATION_POLICY, devices: { ...DEFAULT_ORGANISATION_POLICY.devices, noOffline } } },
  });
}

beforeEach(() => {
  // jsdom has no OPFS: the store's page side says it's there, as a browser would.
  setStoreBackend({ supported: () => true } as unknown as StoreBackend);
  offline.enableOffline.mockClear();
  offline.disableOffline.mockClear();
  useAuthStore.setState({ activeAccountId: 'acc' });
  useOfflineStore.setState({ enabled: [], outbox: [], pendingChanges: 0, syncing: [], lastSyncedAt: {} });
  setNoOffline(false);
});

describe('Settings > Offline', () => {
  it('says so in a private window, with no switch to turn on', () => {
    useOfflineStore.setState({ storageBlocked: true });
    try {
      render(<OfflineSettings />);
      expect(screen.getByTestId('offline-private')).toBeTruthy();
      expect(screen.queryByTestId('offline-switch')).toBeNull();
    } finally {
      useOfflineStore.setState({ storageBlocked: false });
    }
  });

  it('offers removing everything where offline mode exists', () => {
    render(<OfflineSettings />);
    expect(screen.getByTestId('wipe-device-section')).toBeTruthy();
  });

  it('doesn\'t where it can\'t be used: a private window, a store that isn\'t there, an organisation\'s no', () => {
    useOfflineStore.setState({ storageBlocked: true });
    const privateWindow = render(<OfflineSettings />);
    expect(screen.queryByTestId('wipe-device-section')).toBeNull();
    privateWindow.unmount();
    useOfflineStore.setState({ storageBlocked: false });

    setStoreBackend({ supported: () => false } as unknown as StoreBackend);
    const noStore = render(<OfflineSettings />);
    expect(screen.queryByTestId('wipe-device-section')).toBeNull();
    noStore.unmount();
    setStoreBackend({ supported: () => true } as unknown as StoreBackend);

    setNoOffline(true);
    render(<OfflineSettings />);
    expect(screen.queryByTestId('wipe-device-section')).toBeNull();
  });

  it('is off until the user turns it on in this browser', () => {
    render(<OfflineSettings />);
    const toggle = screen.getByTestId('offline-switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(offline.enableOffline).toHaveBeenCalledWith('acc');
  });

  it('asks before turning off with unsent messages', async () => {
    useOfflineStore.setState({ enabled: ['acc'], outbox: [{ id: 1, account: 'acc', createdAt: Date.now(), subject: 'Hi', to: ['b@example.org'], status: 'waiting' }] });
    render(<OfflineSettings />);
    fireEvent.click(screen.getByTestId('offline-switch'));
    expect(await screen.findByText('off_confirm_title')).toBeInTheDocument();
    expect(offline.disableOffline).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'off_confirm' }));
    expect(offline.disableOffline).toHaveBeenCalledWith('acc');
  });

  it('hides the switch and says why when the organisation forbids it', () => {
    setNoOffline(true);
    render(<OfflineSettings />);
    expect(screen.queryByTestId('offline-switch')).toBeNull();
    expect(screen.getByTestId('offline-forbidden').textContent).toContain('forbidden');
  });

  it('follows a policy that changes while it is open', () => {
    render(<OfflineSettings />);
    expect(screen.getByTestId('offline-switch')).toBeInTheDocument();
    act(() => setNoOffline(true));
    expect(screen.queryByTestId('offline-switch')).toBeNull();
  });

  it('asks before turning off when a draft is only on this device, and counts both lists', async () => {
    useOfflineStore.setState({
      enabled: ['acc'],
      localDrafts: [{ account: 'acc', localId: 'local-1', jmap: 'j', subject: 'Only here', status: 'waiting', createdAt: 0 }],
      outbox: [{ id: 1, account: 'acc', createdAt: 0, subject: 'Queued', to: [], status: 'waiting' }],
    });
    render(<OfflineSettings />);
    fireEvent.click(screen.getByTestId('offline-switch'));
    expect(await screen.findByText('off_confirm_title')).toBeInTheDocument();
    expect(offline.disableOffline).not.toHaveBeenCalled();
    useOfflineStore.setState({ localDrafts: [], outbox: [] });
  });

  it('asks for one draft alone', () => {
    useOfflineStore.setState({
      enabled: ['acc'],
      localDrafts: [{ account: 'acc', localId: 'local-1', jmap: 'j', subject: 'Only here', status: 'waiting', createdAt: 0 }],
    });
    render(<OfflineSettings />);
    fireEvent.click(screen.getByTestId('offline-switch'));
    expect(offline.disableOffline).not.toHaveBeenCalled();
    useOfflineStore.setState({ localDrafts: [] });
  });

  it('lists the outbox', () => {
    useOfflineStore.setState({ outbox: [{ id: 1, account: 'acc', createdAt: Date.now(), subject: 'Quarterly', to: ['b@example.org'], status: 'failed', error: { text: 'Rejected' } }] });
    render(<OfflineSettings />);
    const rows = screen.getAllByTestId('offline-outbox-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Quarterly');
    expect(rows[0].getAttribute('data-status')).toBe('failed');
    expect(screen.getByRole('button', { name: 'retry_label' })).toBeInTheDocument();
  });
});

describe('the offline banner', () => {
  it('says the app is offline and opens the outbox in place', async () => {
    const { OfflineBanner } = await import('../offline-banner');
    useOfflineStore.setState({
      enabled: ['acc'],
      browserOffline: true,
      outbox: [{ id: 1, account: 'acc', createdAt: Date.now(), subject: 'Quarterly', to: ['b@example.org'], status: 'waiting' }],
    });
    render(<OfflineBanner />);
    expect(screen.getByTestId('offline-banner').textContent).toContain('banner.offline');
    fireEvent.click(screen.getByTestId('offline-banner-outbox'));
    // The outbox is its own chunk, loaded when the dialog opens.
    expect((await screen.findByTestId('offline-outbox-row')).textContent).toContain('Quarterly');
  });

  it('can be hidden, and comes back when what it says changes', async () => {
    const { OfflineBanner } = await import('../offline-banner');
    sessionStorage.clear();
    useOfflineStore.setState({ enabled: ['acc'], browserOffline: true, outbox: [] });
    const { unmount } = render(<OfflineBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'hide_offline_notice' }));
    expect(screen.queryByTestId('offline-banner')).toBeNull();
    // Another page of the app, the same state: still hidden.
    unmount();
    render(<OfflineBanner />);
    expect(screen.queryByTestId('offline-banner')).toBeNull();
    // A message now waits: that's news.
    act(() => useOfflineStore.setState({ outbox: [{ id: 2, account: 'acc', createdAt: Date.now(), subject: 'Later', to: ['b@example.org'], status: 'waiting' }] }));
    expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
    sessionStorage.clear();
  });

  it('stays away for an account that doesn\'t keep mail here', async () => {
    const { OfflineBanner } = await import('../offline-banner');
    useOfflineStore.setState({ enabled: [], browserOffline: true, outbox: [] });
    render(<OfflineBanner />);
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });
});

// settings-p2-18: in a browser the page said "use disk encryption" twice,
// once in the warning and again in the key note below it.
describe('Settings > Offline in a browser', () => {
  it('warns about the browser profile once', async () => {
    await act(async () => { render(<OfflineSettings />); });
    expect(screen.getByTestId('offline-warning').textContent).toBe('warning');
    expect(screen.queryByText('browser_note')).toBeNull();
  });
});
