import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const offline = vi.hoisted(() => ({
  clearAccount: vi.fn(async () => {}),
  chooseScope: vi.fn(),
  requestPersistence: vi.fn(async () => 'refused'),
  dismissAreaConflict: vi.fn(async () => {}),
}));
vi.mock('@/lib/offline/offline-mode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/offline/offline-mode')>()),
  clearAccount: offline.clearAccount,
  chooseScope: offline.chooseScope,
  requestPersistence: offline.requestPersistence,
  dismissAreaConflict: offline.dismissAreaConflict,
  readPersistence: vi.fn(async () => 'refused'),
  refreshUsage: vi.fn(async () => {}),
}));

import { OfflineSettings } from '../offline-settings';
import { OfflineBanner } from '../offline-banner';
import { useOfflineStore } from '@/lib/offline/state';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { setStoreBackend, type StoreBackend } from '@/lib/store/client/api';
import { fileRefFor } from '@/hooks/use-keep-file-offline';

const area = vi.fn(async (_account: string, name: string) => (name === 'files.kept' ? {
  files: [
    { jmap: 'j', id: 'f1', name: 'Pinned.pdf', size: 2048, pinned: true, kept: true, error: null },
    { jmap: 'j', id: 'f2', name: 'Big.iso', size: 1048576, pinned: true, kept: false, error: 'overLimit' },
    { jmap: 'j', id: 'f3', name: 'Opened.txt', size: 5, pinned: false, kept: true, error: null },
  ],
} : null));

function setDevices(devices: Partial<typeof DEFAULT_ORGANISATION_POLICY.devices>) {
  usePolicyStore.setState({
    loaded: true, source: 'server', subject: null,
    policy: { ...usePolicyStore.getState().policy, organisation: { ...DEFAULT_ORGANISATION_POLICY, devices: { ...DEFAULT_ORGANISATION_POLICY.devices, ...devices } } },
  } as never);
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  setStoreBackend({ supported: () => true, area, setScope: vi.fn(async () => {}) } as unknown as StoreBackend);
  useAuthStore.setState({ activeAccountId: 'acc', getAllConnectedClients: (() => new Map()) as never });
  useOfflineStore.setState({
    enabled: ['acc'], outbox: [], pendingChanges: 0, conflicts: [], areaConflicts: [], syncing: [], lastSyncedAt: {}, choices: { acc: { on: true } }, health: {},
    storageFull: {}, progress: {}, persist: 'granted', browserOffline: false, downServers: [], startedOffline: false,
    usage: { acc: { bytes: 5000, parts: [{ part: 'mail', bytes: 4000, items: 12 }, { part: 'attachments', bytes: 1000, items: 2 }] } },
  });
  setDevices({});
});

afterEach(() => { setStoreBackend(null); });

const windowSelect = () => screen.getByText('window_label').closest('[data-search-label]')!.querySelector('select') as HTMLSelectElement;

describe('what an account keeps', () => {
  it('offers every window and hands the choice on', () => {
    render(<OfflineSettings />);
    expect([...windowSelect().options].map((o) => o.value)).toEqual(['30', '90', '365', 'all']);
    expect(windowSelect().value).toBe('90');
    fireEvent.change(windowSelect(), { target: { value: 'all' } });
    expect(offline.chooseScope).toHaveBeenCalledWith('acc', { days: null });
  });

  it('under a cap offers only what fits, and says who set it', () => {
    setDevices({ offlineMaxDays: 60 });
    render(<OfflineSettings />);
    expect([...windowSelect().options].map((o) => o.value)).toEqual(['30', '60']);
    expect(windowSelect().value).toBe('60');
    expect(within(screen.getByText('window_label').closest('[data-search-label]') as HTMLElement).getByText('org_locked')).toBeInTheDocument();
  });

  it('locks the window when the cap leaves no choice', () => {
    setDevices({ offlineMaxDays: 14 });
    render(<OfflineSettings />);
    const row = screen.getByText('window_label').closest('[data-search-label]') as HTMLElement;
    expect(windowSelect().parentElement?.closest('[inert]')).not.toBeNull();
    expect(within(row).getByText('org_locked')).toBeInTheDocument();
  });

  it('locks attachments off when the organisation forbids them, and hides the size', () => {
    useOfflineStore.setState({ choices: { acc: { on: true, attachments: true } } });
    setDevices({ noOfflineAttachments: true });
    render(<OfflineSettings />);
    const toggle = screen.getByTestId('offline-attachments');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.closest('[inert]')).not.toBeNull();
    expect(screen.queryByText('attachment_cap_label')).toBeNull();
    fireEvent.click(toggle);
  });

  it('caps the size choice', () => {
    setDevices({ offlineMaxAttachmentMb: 10 });
    render(<OfflineSettings />);
    const select = screen.getByText('attachment_cap_label').closest('[data-search-label]')!.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['5', '10']);
    fireEvent.change(select, { target: { value: '5' } });
    expect(offline.chooseScope).toHaveBeenCalledWith('acc', { maxAttachmentBytes: 5 * 1024 * 1024 });
  });

  it('says when the total is set by the organisation', () => {
    setDevices({ offlineMaxTotalMb: 100 });
    render(<OfflineSettings />);
    expect(screen.getByTestId('offline-total-locked').textContent).toContain('total_locked');
  });

  it('locks the switch when the desktop policy forces it', () => {
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, policy: { get: () => ({ OfflineEnabled: { value: true, locked: true, source: 'machine' } }) } };
    render(<OfflineSettings />);
    expect(screen.getByTestId('offline-switch').closest('[inert]')).not.toBeNull();
    delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  });

  it('shows nothing of this with offline off', () => {
    useOfflineStore.setState({ enabled: [] });
    render(<OfflineSettings />);
    expect(screen.queryByText('window_label')).toBeNull();
    expect(screen.queryByTestId('offline-clear')).toBeNull();
  });
});

describe('what it takes', () => {
  it('lists each part', () => {
    render(<OfflineSettings />);
    const usage = screen.getByTestId('offline-usage');
    expect(usage.textContent).toContain('usage_mail');
    expect(usage.textContent).toContain('usage_attachments');
    expect(screen.getByTestId('offline-status').textContent).toContain('usage');
  });

  it('shows the time of the last sync from before a reload', () => {
    useOfflineStore.setState({ health: { acc: { lastSync: Date.now() - 60_000 } } });
    render(<OfflineSettings />);
    expect(screen.getByTestId('offline-status').textContent).toContain('usage_updated');
  });

  it('shows a large sync going on, with the time left once it can tell', () => {
    const now = Date.now();
    useOfflineStore.setState({
      syncing: ['acc'],
      progress: { acc: { area: 'mail', phase: 'bodies', done: 500, total: 5000, startedAt: now - 60_000, startedDone: 0, at: now } },
    });
    render(<OfflineSettings />);
    const line = screen.getByTestId('offline-progress');
    expect(line.textContent).toContain('progress_bodies');
    expect(line.textContent).toContain('progress_count');
    expect(line.textContent).toContain('progress_left');
    expect(line.querySelector('progress')?.getAttribute('max')).toBe('5000');
  });

  it('keeps a small catch-up quiet', () => {
    const now = Date.now();
    useOfflineStore.setState({ syncing: ['acc'], progress: { acc: { area: 'mail', phase: 'bodies', done: 1, total: 3, startedAt: now, startedDone: 0, at: now } } });
    render(<OfflineSettings />);
    expect(screen.queryByTestId('offline-progress')).toBeNull();
  });
});

describe('clearing an account', () => {
  it('asks first, naming unsent mail', () => {
    useOfflineStore.setState({ outbox: [{ id: 1, account: 'acc', createdAt: 1, subject: 'Hi', to: [], status: 'waiting' }] });
    render(<OfflineSettings />);
    fireEvent.click(screen.getByTestId('offline-clear'));
    expect(offline.clearAccount).not.toHaveBeenCalled();
    expect(screen.getByText(/clear_confirm_unsent/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'clear_confirm' }));
    expect(offline.clearAccount).toHaveBeenCalledWith('acc');
  });
});

describe('what the browser may do', () => {
  it('warns when it refused to keep the data, and can ask again', async () => {
    useOfflineStore.setState({ persist: 'refused' });
    render(<OfflineSettings />);
    expect(screen.getByTestId('offline-persist-refused').textContent).toContain('persist_refused');
    await act(async () => { fireEvent.click(screen.getByTestId('offline-persist-retry')); });
    expect(offline.requestPersistence).toHaveBeenCalled();
  });

  it('says nothing when it agreed', () => {
    render(<OfflineSettings />);
    expect(screen.queryByTestId('offline-persist-refused')).toBeNull();
  });

  it('warns about a store it deleted, with the count, until read', () => {
    useOfflineStore.setState({ health: { acc: { reset: { at: 1, lost: 2 } } } });
    render(<OfflineSettings />);
    expect(screen.getByTestId('offline-evicted').textContent).toContain('evicted_lost');
    fireEvent.click(within(screen.getByTestId('offline-evicted')).getByRole('button', { name: 'evicted_dismiss' }));
    expect(useOfflineStore.getState().health.acc.reset).toBeUndefined();
  });

  it('says the device is full, with what to do', () => {
    useOfflineStore.setState({ storageFull: { acc: 1 } });
    render(<OfflineSettings />);
    const alert = screen.getByTestId('offline-storage-full');
    expect(alert.textContent).toContain('storage_full_title');
    fireEvent.click(within(alert).getByRole('button', { name: 'clear_button' }));
    expect(screen.getByRole('button', { name: 'clear_confirm' })).toBeInTheDocument();
  });

  it('gives the Safari hint only in Safari', () => {
    const real = window.navigator.userAgent;
    render(<OfflineSettings />);
    expect(screen.queryByTestId('offline-safari-hint')).toBeNull();
    Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15' });
    render(<OfflineSettings />);
    expect(screen.getByTestId('offline-safari-hint')).toBeInTheDocument();
    Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: real });
  });
});

describe('everything that did not go through', () => {
  const conflicts = [
    { area: 'calendar', account: 'acc', id: 1, createdAt: 1, title: 'Team meeting', reason: 'changed', destroy: false, detail: null },
    { area: 'contacts', account: 'acc', id: 2, createdAt: 1, title: 'Ana Silva', reason: 'refused', destroy: false, detail: 'Nope' },
  ] as const;

  it('lists calendar and contacts next to mail, and each can be dismissed', async () => {
    useOfflineStore.setState({ areaConflicts: [...conflicts] });
    render(<OfflineSettings />);
    const rows = screen.getAllByTestId('offline-conflict-row');
    expect(rows.map((row) => row.getAttribute('data-area'))).toEqual(['calendar', 'contacts']);
    expect(rows[0].textContent).toContain('Team meeting');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'dismiss_label' }));
    await waitFor(() => expect(offline.dismissAreaConflict).toHaveBeenCalledWith(conflicts[1]));
  });

  it('counts them all in the banner', () => {
    useOfflineStore.setState({ areaConflicts: [...conflicts] });
    render(<OfflineBanner />);
    expect(screen.getByTestId('offline-banner-conflicts')).toBeInTheDocument();
  });
});

describe('files kept offline', () => {
  it('lists the pinned ones with their state, and can let go of one', async () => {
    render(<OfflineSettings />);
    const rows = await screen.findAllByTestId('offline-kept-file');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('kept_state_kept');
    expect(rows[1].textContent).toContain('kept_error_overLimit');
    expect(screen.queryByText('Opened.txt')).toBeNull();
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'unpin_label' }));
    await waitFor(() => expect(area).toHaveBeenCalledWith('acc', 'files.unpin', expect.objectContaining({ jmap: 'j', id: 'f1' })));
  });

  it('a node of another account goes by that account', () => {
    expect(fileRefFor('shared1:n7', 'own')).toEqual({ jmap: 'shared1', id: 'n7' });
    expect(fileRefFor('n7', 'own')).toEqual({ jmap: 'own', id: 'n7' });
  });
});
