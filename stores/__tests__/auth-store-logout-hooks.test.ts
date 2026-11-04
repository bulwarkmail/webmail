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

  describe('crash files, which can hold the mail of whoever was signed in', () => {
    afterEach(() => { delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop; });
    const withBridge = (deleteCrashes?: () => Promise<void>) => {
      (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', privacy: { deleteCrashes } };
    };

    it('go at sign-out', async () => {
      const deleteCrashes = vi.fn().mockResolvedValue(undefined);
      withBridge(deleteCrashes);
      await useAuthStore.getState().logout();
      expect(deleteCrashes).toHaveBeenCalledTimes(1);
    });

    it('go when all accounts sign out', async () => {
      const deleteCrashes = vi.fn().mockResolvedValue(undefined);
      withBridge(deleteCrashes);
      await useAuthStore.getState().logoutAll();
      expect(deleteCrashes).toHaveBeenCalled();
    });

    it('go when switching to another account, and not before', () => {
      const deleteCrashes = vi.fn().mockResolvedValue(undefined);
      withBridge(deleteCrashes);
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'a1' });
      expect(deleteCrashes).not.toHaveBeenCalled();
      useAuthStore.setState({ activeAccountId: 'a2' });
      expect(deleteCrashes).toHaveBeenCalledTimes(1);
    });

    it('signing out works all the same on a shell without the call, or one that fails', async () => {
      withBridge(undefined);
      await useAuthStore.getState().logout();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      useAuthStore.setState({ isAuthenticated: true });
      withBridge(vi.fn().mockRejectedValue(new Error('gone')));
      await useAuthStore.getState().logout();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });
  });

  describe('client certificates chosen for servers', () => {
    afterEach(() => { delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop; });
    const withBridge = (clearChoices?: () => Promise<void>) => {
      (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, certificates: { clearChoices } };
    };

    it('all of them at the sign-out that leaves nobody', async () => {
      const clearChoices = vi.fn().mockResolvedValue(undefined);
      withBridge(clearChoices);
      await useAuthStore.getState().logout();
      expect(clearChoices).toHaveBeenCalledTimes(1);
      expect(clearChoices.mock.calls[0][0]).toMatchObject({ last: true });
    });

    it('all of them when all accounts sign out', async () => {
      const clearChoices = vi.fn().mockResolvedValue(undefined);
      withBridge(clearChoices);
      await useAuthStore.getState().logoutAll();
      expect(clearChoices).toHaveBeenCalledWith({ last: true });
    });

    it('only its own while another account stays', async () => {
      const clearChoices = vi.fn().mockResolvedValue(undefined);
      withBridge(clearChoices);
      const accounts = useAccountStore.getState();
      const entry = (id: string) => ({ id, label: id, serverUrl: 'https://mail.example.test', username: id, authMode: 'basic' as const, rememberMe: true, displayName: id, email: id, lastLoginAt: 1, isConnected: true, hasError: false, isDefault: false, cookieSlot: id === 'a1' ? 0 : 1, avatarColor: '#000' });
      useAccountStore.setState({ ...accounts, accounts: [entry('a1'), entry('a2')], activeAccountId: 'a1' });
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'a1' });
      await useAuthStore.getState().logout();
      expect(clearChoices).toHaveBeenCalledWith({ account: 'a1', last: false });
      expect(clearChoices.mock.calls.some(([scope]) => scope.last === true)).toBe(false);
    });

    it('nothing when switching to another account or searching across them', () => {
      const clearChoices = vi.fn().mockResolvedValue(undefined);
      const setAccount = vi.fn().mockResolvedValue(undefined);
      (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, certificates: { clearChoices, setAccount } };
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'a1' });
      useAuthStore.setState({ activeAccountId: 'a2' });
      useAuthStore.setState({ activeAccountId: 'a1' });
      expect(clearChoices).not.toHaveBeenCalled();
      expect(setAccount.mock.calls.at(-1)).toEqual(['a1']);
      expect(setAccount).toHaveBeenCalledWith('a2');
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

    it('and when a session ends with no sign-out at all', () => {
      const clearGrants = vi.fn().mockResolvedValue(undefined);
      withBridge(clearGrants);
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'a1' });
      expect(clearGrants).not.toHaveBeenCalled();
      useAuthStore.setState({ client: null, isAuthenticated: false, activeAccountId: null });
      expect(clearGrants).toHaveBeenCalledTimes(1);
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'a1' });
      expect(clearGrants, 'nothing to take back when one starts').toHaveBeenCalledTimes(1);
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
