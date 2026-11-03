import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as browserNavigation from '@/lib/browser-navigation';
import { authHooks, clearAllHooks } from '@/lib/plugin-hooks';
import { useAuthStore, LOGOUT_HOOK_BUDGET_MS } from '../auth-store';
import { useAccountStore } from '../account-store';

describe('sign-out with plugins', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearAllHooks();
    sessionStorage.clear();
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
    useAuthStore.setState({ isAuthenticated: true, authMode: 'basic', client: null, activeAccountId: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('signs out even when a plugin answers false before sign-out', async () => {
    const before = vi.fn().mockReturnValue(false);
    const after = vi.fn();
    authHooks.onBeforeLogout.register('p', before);
    authHooks.onAfterLogout.register('p', after);

    await useAuthStore.getState().logout();

    expect(before).toHaveBeenCalledWith({ accountId: 'all' });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(after).toHaveBeenCalledWith({ accountId: 'all' });
  });

  describe('keys in the OS store', () => {
    afterEach(() => { delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop; });
    const withBridge = (clearGrants?: () => Promise<void>) => {
      (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, keystore: { clearGrants } };
    };

    it('takes back this session\'s certificate grants at sign-out', async () => {
      const clearGrants = vi.fn().mockResolvedValue(undefined);
      withBridge(clearGrants);
      await useAuthStore.getState().logout();
      expect(clearGrants).toHaveBeenCalledTimes(1);
    });

    it('does so when all accounts sign out too', async () => {
      const clearGrants = vi.fn().mockResolvedValue(undefined);
      withBridge(clearGrants);
      await useAuthStore.getState().logoutAll();
      expect(clearGrants).toHaveBeenCalled();
    });

    it('and when switching to another account', () => {
      const clearGrants = vi.fn().mockResolvedValue(undefined);
      withBridge(clearGrants);
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'a1' });
      expect(clearGrants).not.toHaveBeenCalled();
      useAuthStore.setState({ activeAccountId: 'a2' });
      expect(clearGrants).toHaveBeenCalledTimes(1);
    });

    it('signs out all the same on a shell without the call, or one that fails', async () => {
      withBridge(undefined);
      await useAuthStore.getState().logout();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);

      useAuthStore.setState({ isAuthenticated: true });
      withBridge(vi.fn().mockRejectedValue(new Error('gone')));
      await useAuthStore.getState().logout();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });
  });

  it('does not wait on a plugin that never answers', async () => {
    vi.useFakeTimers();
    authHooks.onBeforeLogout.register('p', () => new Promise(() => {}));

    const done = useAuthStore.getState().logout();
    await vi.advanceTimersByTimeAsync(LOGOUT_HOOK_BUDGET_MS + 10);
    await done;

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});
