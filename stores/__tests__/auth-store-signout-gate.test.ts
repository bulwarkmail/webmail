import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as browserNavigation from '@/lib/browser-navigation';
import { clearAllHooks } from '@/lib/plugin-hooks';
import { addSignOutGate } from '@/lib/sign-out-cleanup';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';

// Offline mode (#523): a sign-out the user starts may be stopped by the
// question about unsent mail; an automatic one (the session limits, a
// refused renewal) is never held up by it.
describe('sign-out gates', () => {
  let removeGate: () => void = () => {};

  beforeEach(() => {
    removeGate();
    vi.restoreAllMocks();
    clearAllHooks();
    sessionStorage.clear();
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
    useAuthStore.setState({ isAuthenticated: true, authMode: 'basic', client: null, activeAccountId: null });
  });

  it('keeps everyone signed in when the user says no', async () => {
    const gate = vi.fn(async () => false);
    removeGate = addSignOutGate(gate);
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    await useAuthStore.getState().logoutAll();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(gate).toHaveBeenCalledTimes(2);
  });

  it('signs out when the user says yes', async () => {
    removeGate = addSignOutGate(async () => true);
    await useAuthStore.getState().logoutAll();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('never asks at an automatic sign-out', async () => {
    const gate = vi.fn(async () => false);
    removeGate = addSignOutGate(gate);
    await useAuthStore.getState().logoutAll({ endProviderSession: false });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    useAuthStore.setState({ isAuthenticated: true });
    await useAuthStore.getState().logout({ endProviderSession: false });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(gate).not.toHaveBeenCalled();
  });
});
