import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStoreBackend, type StoreBackend } from '@/lib/store/client/api';
import { useOfflineStore } from '@/lib/offline/state';
import { useAuthStore } from '@/stores/auth-store';
import { OutboxList } from '../outbox-list';
import { OfflineBanner } from '../offline-banner';

const conflict = (id: number, reason: 'changed' | 'gone' | 'refused', op: 'update' | 'destroy' = 'update', detail?: string) => ({
  id,
  account: 'acc',
  recordId: `m${id}`,
  createdAt: Date.UTC(2026, 10, 3),
  summary: { subject: `Subject ${id}`, op, reason, ...(detail ? { detail } : {}) },
});

let area: ReturnType<typeof vi.fn>;

beforeEach(() => {
  area = vi.fn(async (_account: string, name: string) => (name === 'outbox.read' ? { patches: 0, entries: [], conflicts: [] } : undefined));
  setStoreBackend({ supported: () => true, area } as unknown as StoreBackend);
  useAuthStore.setState({ activeAccountId: 'acc' });
  useOfflineStore.setState({ enabled: ['acc'], outbox: [], pendingChanges: 0, conflicts: [], browserOffline: false, downServers: [], startedOffline: false });
});

afterEach(() => {
  setStoreBackend(null);
  useOfflineStore.setState({ enabled: [], conflicts: [] });
});

describe('changes that did not go through', () => {
  it('lists each with what happened to it', () => {
    useOfflineStore.setState({ conflicts: [conflict(1, 'changed'), conflict(2, 'changed', 'destroy'), conflict(3, 'gone'), conflict(4, 'refused', 'update', 'Read only')] });
    render(<OutboxList />);
    const rows = screen.getAllByTestId('offline-conflict-row');
    expect(rows.map((row) => row.getAttribute('data-reason'))).toEqual(['changed', 'changed', 'gone', 'refused']);
    expect(rows[0].textContent).toContain('Subject 1');
    expect(rows[0].textContent).toContain('changed');
    expect(rows[1].textContent).toContain('changed_delete');
    expect(rows[2].textContent).toContain('gone');
    expect(rows[3].textContent).toContain('refused');
  });

  it('shows nothing when there are none', () => {
    render(<OutboxList />);
    expect(screen.queryByTestId('offline-conflicts')).toBeNull();
  });

  it('dismisses one in the store and reads the queue again', async () => {
    useOfflineStore.setState({ conflicts: [conflict(7, 'changed')] });
    render(<OutboxList />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'dismiss_label' }));
    });
    expect(area).toHaveBeenCalledWith('acc', 'outbox.dismissConflict', { id: 7 });
    // Offline mode loads with the click.
    await waitFor(() => expect(area).toHaveBeenCalledWith('acc', 'outbox.read'));
    await waitFor(() => expect(useOfflineStore.getState().conflicts).toEqual([]));
  });

  it('the banner points to them while online, with nothing else to say', async () => {
    useOfflineStore.setState({ conflicts: [conflict(1, 'changed')] });
    render(<OfflineBanner />);
    expect(screen.getByTestId('offline-banner-conflicts')).toBeTruthy();
    fireEvent.click(screen.getByTestId('offline-banner-conflicts'));
    expect(await screen.findByTestId('offline-conflict-row')).toBeTruthy();
  });
});
