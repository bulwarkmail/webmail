import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OfflineHost } from '../offline-host';
import { queueSend } from '@/lib/offline/queue';
import { useOfflineStore, writeEnabled } from '@/lib/offline/state';
import { passSignOutGates } from '@/lib/sign-out-cleanup';
import { setStoreBackend } from '@/lib/store/client/api';
import { InProcessStore } from '@/lib/store/__tests__/helpers/in-process-store';
import { offlineNotify, wipeEverything } from '@/lib/offline/offline-mode';
import { firstStartNoticesWaiting, resetFirstStartNotices } from '@/lib/first-start-notices';
import { useToastStore } from '@/stores/toast-store';
import { useAccountStore } from '@/stores/account-store';

let store: InProcessStore;

beforeEach(() => {
  store = new InProcessStore();
  setStoreBackend(store);
  localStorage.clear();
  useOfflineStore.setState({ outbox: [], pendingChanges: 0, conflicts: [] });
  useAccountStore.setState({ accounts: [{ id: 'acc' }] as never });
  writeEnabled(['acc']);
});

afterEach(async () => {
  cleanup();
  await wipeEverything();
  setStoreBackend(null);
});

describe('the question before a sign-out', () => {
  it('counts what the queue holds, though the screen has seen none of it', async () => {
    await queueSend('acc', { subject: 'Hello', to: [] }, { kind: 'email', args: [] });
    useOfflineStore.setState({ outbox: [] });
    render(<OfflineHost />);
    const answer = passSignOutGates('acc');
    fireEvent.click(await screen.findByRole('button', { name: /signout\.confirm/ }));
    expect(await answer).toBe(true);
  });

  it('asks about a change that hasn\'t reached the server, on its own', async () => {
    await store.ensureOpen('acc');
    store.dbs.get('acc')!.run("INSERT INTO calendar_pending (jmap, record_id, kind, patch, queued_at) VALUES ('j1', 'ev', 'update', '{}', 1)");
    render(<OfflineHost />);
    const answer = passSignOutGates('acc');
    expect(await screen.findByText(/signout_changes_title/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /signout\.confirm/ }));
    expect(await answer).toBe(true);
  });

  it('asks nothing with nothing waiting', async () => {
    render(<OfflineHost />);
    expect(await passSignOutGates('acc')).toBe(true);
    expect(screen.queryByRole('button', { name: /signout\.confirm/ })).toBeNull();
  });
});

describe('the notice that the desktop app keeps mail on this device', () => {
  it('is a first-start notice above the list, not a toast that covers the composer', () => {
    resetFirstStartNotices();
    useToastStore.setState({ toasts: [] });
    render(<OfflineHost />);
    offlineNotify({ kind: 'default-on' });
    expect(useToastStore.getState().toasts).toHaveLength(0);
    // One line now (pass-2 mail-p2-19): the text that fits it, with Open settings.
    expect(firstStartNoticesWaiting().map((n) => n.text)).toEqual(['offline_default_on']);
    expect(firstStartNoticesWaiting()[0].action?.label).toBe('open_settings');
  });
});
