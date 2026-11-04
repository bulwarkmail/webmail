import 'fake-indexeddb/auto';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/locales/en/common.json';

// settings-p3-20 (usability pass 3, 2026-11-04): Offline said it keeps "chosen files",
// while Files on this computer has copies of its own. It names the files kept offline
// in Files now. In English, as people read it.

vi.unmock('next-intl');
vi.mock('@/lib/offline/offline-mode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/offline/offline-mode')>()),
  readPersistence: vi.fn(async () => 'granted'),
  refreshUsage: vi.fn(async () => {}),
}));

const { OfflineSettings } = await import('../offline-settings');
const { useOfflineStore } = await import('@/lib/offline/state');
const { useAuthStore } = await import('@/stores/auth-store');
const { setStoreBackend } = await import('@/lib/store/client/api');

beforeEach(() => {
  setStoreBackend({ supported: () => true, area: vi.fn(async () => null), setScope: vi.fn(async () => {}) } as never);
  useAuthStore.setState({ activeAccountId: 'acc', getAllConnectedClients: (() => new Map()) as never });
  useOfflineStore.setState({
    enabled: ['acc'], outbox: [], pendingChanges: 0, conflicts: [], areaConflicts: [], syncing: [], lastSyncedAt: {}, choices: { acc: { on: true } }, health: {},
    storageFull: {}, progress: {}, persist: 'granted', browserOffline: false, downServers: [], startedOffline: false, usage: {},
  });
});

afterEach(() => { setStoreBackend(null); });

it('says which files it keeps: the ones kept offline in Files', () => {
  const { container } = render(
    <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
      <OfflineSettings />
    </NextIntlClientProvider>,
  );
  expect(container.textContent).toContain('the files you keep offline in Files');
  expect(container.textContent).not.toContain('chosen files');
});
