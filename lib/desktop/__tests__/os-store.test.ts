import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorePageHooks } from '@/lib/store/client/api';

/** The local store and the OS integration: mail it found, and a machine going to sleep. */

const configured = vi.hoisted(() => ({ hooks: null as StorePageHooks | null }));
const setOnline = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/lib/store/client/api', async (original) => ({
  ...(await original<typeof import('@/lib/store/client/api')>()),
  configureStore: (hooks: StorePageHooks | null) => {
    if (hooks) configured.hooks = hooks;
  },
  getStore: () => ({
    supported: () => true,
    setOnline,
    ensureOpen: async () => {},
    refresh: () => {},
    sync: async () => {},
    stop: () => {},
  }),
}));

describe('the store and the OS integration', () => {
  const client = { isOfflineOnly: () => false, getAccountId: () => 'acc' };

  beforeEach(async () => {
    vi.clearAllMocks();
    const { useAuthStore } = await import('@/stores/auth-store');
    useAuthStore.setState({ getClientForAccount: () => client as never } as never);
    const { registerOfflineHooks } = await import('@/lib/offline/offline-mode');
    registerOfflineHooks();
  });

  afterEach(async () => {
    const { setStoreCreatedListener } = await import('../system-events');
    setStoreCreatedListener(null);
  });

  it("hands the store's new mail to the notification path, with the login's client", async () => {
    const { setStoreCreatedListener } = await import('../system-events');
    const listener = vi.fn();
    setStoreCreatedListener(listener);
    configured.hooks?.onEvent({ type: 'created', account: 'alice@one', jmap: 'acc', collection: 'Email', ids: ['e1', 'e2'] });
    expect(listener).toHaveBeenCalledWith(client, 'acc', ['e1', 'e2']);
  });

  it('other collections are not mail', async () => {
    const { setStoreCreatedListener } = await import('../system-events');
    const listener = vi.fn();
    setStoreCreatedListener(listener);
    configured.hooks?.onEvent({ type: 'created', account: 'alice@one', jmap: 'acc', collection: 'CalendarEvent', ids: ['c1'] });
    expect(listener).not.toHaveBeenCalled();
  });

  it('with nothing listening, as in a browser, it does nothing', () => {
    expect(() => configured.hooks?.onEvent({ type: 'created', account: 'alice@one', jmap: 'acc', collection: 'Email', ids: ['e1'] })).not.toThrow();
  });

  it('a sleep takes the engine offline; waking brings it back and syncs through the events it already listens to', async () => {
    const { startOfflineMode, offlineSupported } = await import('@/lib/offline/offline-mode');
    expect(offlineSupported()).toBe(true);
    const { runSleepHandlers } = await import('../system-events');
    const stop = startOfflineMode();
    runSleepHandlers();
    expect(setOnline).toHaveBeenLastCalledWith(false);
    window.bulwarkDesktop = { version: 1, platform: 'win32', os: { onPower: (listener: (event: string) => void) => { listener('resume'); return () => {}; } } } as never;
    const { startPowerWatch } = await import('../power');
    const stopPower = startPowerWatch();
    expect(setOnline).toHaveBeenLastCalledWith(true);
    stopPower();
    stop();
    window.bulwarkDesktop = undefined;
  });
});
