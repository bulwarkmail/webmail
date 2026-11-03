import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStoreBackend, type StoreBackend } from '@/lib/store/client/api';
import { useOfflineStore } from '@/lib/offline/state';
import type { LocalDraftRow } from '@/lib/offline/queue';
import { useAuthStore } from '@/stores/auth-store';
import { OutboxList } from '../outbox-list';
import { OfflineBanner } from '../offline-banner';

const push = vi.fn();
let pathname = '/settings/backup/offline';

vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => pathname,
}));

const draft = (overrides: Partial<LocalDraftRow> = {}): LocalDraftRow => ({
  account: 'acc',
  localId: 'local-1',
  jmap: 'j1',
  subject: 'Only here',
  status: 'waiting',
  createdAt: Date.UTC(2026, 10, 3),
  ...overrides,
});

let area: ReturnType<typeof vi.fn>;

beforeEach(() => {
  push.mockClear();
  pathname = '/settings/backup/offline';
  area = vi.fn(async (_account: string, name: string) => {
    if (name === 'outbox.read') return { patches: 0, entries: [], conflicts: [] };
    if (name === 'drafts.list') return [];
    return undefined;
  });
  setStoreBackend({ supported: () => true, area } as unknown as StoreBackend);
  useAuthStore.setState({ activeAccountId: 'acc' });
  useOfflineStore.setState({ enabled: ['acc'], outbox: [], pendingChanges: 0, conflicts: [], localDrafts: [], draftToOpen: null, browserOffline: false, downServers: [], startedOffline: false });
});

afterEach(() => {
  setStoreBackend(null);
  useOfflineStore.setState({ enabled: [], conflicts: [], localDrafts: [], draftToOpen: null });
});

describe('drafts that are only on this device', () => {
  it('shows nothing when there are none', () => {
    render(<OutboxList />);
    expect(screen.queryByTestId('offline-local-drafts')).toBeNull();
  });

  it('shows a refused one with the server\'s reason, and a way to open and retry it', () => {
    useOfflineStore.setState({ localDrafts: [draft({ status: 'refused', error: { type: 'overQuota', text: 'No room left' } })] });
    render(<OutboxList />);
    const row = screen.getByTestId('offline-local-draft-row');
    expect(row.getAttribute('data-status')).toBe('refused');
    expect(row.textContent).toContain('Only here');
    expect(row.textContent).toContain('status_refused');
    expect(screen.getByRole('button', { name: 'open_label' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'retry_label' })).toBeTruthy();
  });

  it('offers no retry for one that waits by itself', () => {
    useOfflineStore.setState({ localDrafts: [draft()] });
    render(<OutboxList />);
    expect(screen.getByTestId('offline-local-draft-row').textContent).toContain('status_waiting');
    expect(screen.queryByRole('button', { name: 'retry_label' })).toBeNull();
  });

  it('opens it on the mail page, going there from elsewhere', () => {
    useOfflineStore.setState({ localDrafts: [draft()] });
    const onOpenDraft = vi.fn();
    render(<OutboxList onOpenDraft={onOpenDraft} />);
    fireEvent.click(screen.getByRole('button', { name: 'open_label' }));
    expect(useOfflineStore.getState().draftToOpen).toEqual({ account: 'acc', jmap: 'j1', id: 'local-1' });
    expect(onOpenDraft).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('/mail');
  });

  it('stays on the mail page when it\'s already there', () => {
    pathname = '/mail';
    useOfflineStore.setState({ localDrafts: [draft()] });
    render(<OutboxList />);
    fireEvent.click(screen.getByRole('button', { name: 'open_label' }));
    expect(push).not.toHaveBeenCalled();
  });

  it('asks the store to try again, and reads the queue', async () => {
    useOfflineStore.setState({ localDrafts: [draft({ status: 'refused' })] });
    render(<OutboxList />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'retry_label' }));
    });
    expect(area).toHaveBeenCalledWith('acc', 'drafts.retry', { localId: 'local-1' });
    expect(area).toHaveBeenCalledWith('acc', 'drafts.list');
    expect(useOfflineStore.getState().localDrafts).toEqual([]);
  });

  it('says both versions are kept for a draft changed elsewhere', () => {
    useOfflineStore.setState({
      conflicts: [
        { id: 1, account: 'acc', recordId: 'r', createdAt: 0, summary: { subject: 'A', op: 'draft', reason: 'changed' } },
        { id: 2, account: 'acc', recordId: 's', createdAt: 0, summary: { subject: 'B', op: 'draft', reason: 'gone' } },
      ],
    });
    render(<OutboxList />);
    const rows = screen.getAllByTestId('offline-conflict-row');
    expect(rows[0].textContent).toContain('conflict_changed');
    expect(rows[1].textContent).toContain('conflict_gone');
  });

  it('says in the banner while online that drafts wait, and which were refused', () => {
    useOfflineStore.setState({ localDrafts: [draft()] });
    const { rerender } = render(<OfflineBanner />);
    expect(screen.queryByTestId('offline-banner-drafts')).toBeNull();
    expect(screen.getByTestId('offline-banner-drafts-waiting').textContent).toContain('banner_waiting');
    act(() => useOfflineStore.setState({ localDrafts: [draft({ status: 'refused' })] }));
    rerender(<OfflineBanner />);
    expect(screen.getByTestId('offline-banner-drafts').textContent).toContain('banner_refused');
    expect(screen.queryByTestId('offline-banner-drafts-waiting')).toBeNull();
  });
});
