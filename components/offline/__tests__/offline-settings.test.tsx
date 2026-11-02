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

function setNoOffline(noOffline: boolean) {
  usePolicyStore.setState({
    loaded: true,
    subject: null,
    policy: { ...usePolicyStore.getState().policy, organisation: { ...DEFAULT_ORGANISATION_POLICY, devices: { ...DEFAULT_ORGANISATION_POLICY.devices, noOffline } } },
  });
}

beforeEach(() => {
  offline.enableOffline.mockClear();
  offline.disableOffline.mockClear();
  useAuthStore.setState({ activeAccountId: 'acc' });
  useOfflineStore.setState({ enabled: [], outbox: [], pendingChanges: 0, syncing: [], lastSyncedAt: {} });
  setNoOffline(false);
});

describe('Settings > Offline', () => {
  it('is off until the user turns it on in this browser', () => {
    render(<OfflineSettings />);
    const toggle = screen.getByTestId('offline-switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(offline.enableOffline).toHaveBeenCalledWith('acc');
  });

  it('asks before turning off with unsent messages', () => {
    useOfflineStore.setState({ enabled: ['acc'], outbox: [{ id: 1, account: 'acc', createdAt: Date.now(), subject: 'Hi', to: ['b@example.org'], status: 'waiting' }] });
    render(<OfflineSettings />);
    fireEvent.click(screen.getByTestId('offline-switch'));
    expect(offline.disableOffline).not.toHaveBeenCalled();
    expect(screen.getByText('off_confirm_title')).toBeInTheDocument();
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
    expect(screen.getByTestId('offline-outbox-row').textContent).toContain('Quarterly');
  });

  it('stays away for an account that doesn\'t keep mail here', async () => {
    const { OfflineBanner } = await import('../offline-banner');
    useOfflineStore.setState({ enabled: [], browserOffline: true, outbox: [] });
    render(<OfflineBanner />);
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });
});
