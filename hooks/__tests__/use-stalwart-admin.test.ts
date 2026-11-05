import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', () => ({ apiFetch }));
type AuthSlice = { activeAccountId: string | null; connectedAccountsRevision: number };
const authStore = vi.hoisted(() => ({ current: null as unknown as import('zustand').StoreApi<AuthSlice> & (() => AuthSlice) }));
vi.mock('@/stores/auth-store', async () => {
  const { create } = await import('zustand');
  authStore.current = create<AuthSlice>(() => ({ activeAccountId: null, connectedAccountsRevision: 0 })) as typeof authStore.current;
  return { useAuthStore: authStore.current };
});

import { useStalwartAdmin } from '../use-stalwart-admin';
import { useAccountStore } from '@/stores/account-store';

const answer = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** Answers GET /api/admin/auth per slot: `admins` maps a slot to its answer. */
function serve(admins: Record<number, Record<string, unknown>>) {
  apiFetch.mockImplementation(async (_url: string, init: { method?: string; headers?: Record<string, string> }) => {
    if (init.method === 'POST') return answer({ ok: true });
    const slot = Number(init.headers?.['X-JMAP-Cookie-Slot']);
    return answer(admins[slot] ?? { stalwartAdmin: false });
  });
}

const adminAuto = { stalwartAdmin: true, authenticated: false, stalwartAutoLogin: true };

function account(id: string, cookieSlot: number, isConnected: boolean) {
  return {
    id, label: id, serverUrl: 'https://mail.example.com', username: id, authMode: 'basic' as const,
    cookieSlot, rememberMe: true, displayName: id, email: id, avatarColor: '#000',
    lastLoginAt: 0, isConnected, hasError: false, isDefault: cookieSlot === 0,
  };
}

const slotsAsked = () => apiFetch.mock.calls
  .filter(([, init]) => init.method === undefined)
  .map(([, init]) => init.headers['X-JMAP-Cookie-Slot']);

describe('useStalwartAdmin', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    authStore.current.setState({ activeAccountId: 'user@example.com', connectedAccountsRevision: 0 });
    useAccountStore.setState({
      accounts: [account('user@example.com', 0, true)],
      activeAccountId: 'user@example.com',
      defaultAccountId: 'user@example.com',
    });
  });

  it('is true when a signed-in account other than the open one is an admin, and mints the session for it', async () => {
    useAccountStore.setState({
      accounts: [account('user@example.com', 0, true), account('admin@example.com', 1, true)],
    });
    serve({ 1: adminAuto });

    const { result } = renderHook(() => useStalwartAdmin());

    await waitFor(() => expect(result.current).toBe(true));
    expect(apiFetch).toHaveBeenLastCalledWith('/api/admin/auth', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-JMAP-Cookie-Slot': '1' }),
    }));
  });

  it('asks the admin login once it has been restored after the first render (#1532)', async () => {
    useAccountStore.setState({
      accounts: [account('user@example.com', 0, true), account('admin@example.com', 1, false)],
    });
    serve({ 1: adminAuto });

    const { result } = renderHook(() => useStalwartAdmin());
    await waitFor(() => expect(slotsAsked()).toEqual(['0']));
    expect(result.current).toBe(false);

    act(() => {
      useAccountStore.setState((s) => ({
        accounts: s.accounts.map((a) => (a.cookieSlot === 1 ? { ...a, isConnected: true } : a)),
      }));
    });

    await waitFor(() => expect(result.current).toBe(true));
    expect(slotsAsked()).toEqual(['0', '1']);
  });

  it('asks again once the background restore is done', async () => {
    useAccountStore.setState({
      accounts: [account('user@example.com', 0, true), account('admin@example.com', 1, true)],
    });
    // The admin login's sign-in context is not written yet.
    serve({});
    const { result } = renderHook(() => useStalwartAdmin());
    await waitFor(() => expect(slotsAsked()).toHaveLength(2));
    expect(result.current).toBe(false);

    serve({ 1: adminAuto });
    act(() => { authStore.current.setState({ connectedAccountsRevision: 1 }); });

    await waitFor(() => expect(result.current).toBe(true));
  });

  it('hides the button and ends the auto session when the admin login signs out, and asks again when it is back', async () => {
    const both = [account('user@example.com', 0, true), account('admin@example.com', 1, true)];
    useAccountStore.setState({ accounts: both });
    serve({ 1: adminAuto });
    const { result } = renderHook(() => useStalwartAdmin());
    await waitFor(() => expect(result.current).toBe(true));

    act(() => { useAccountStore.setState({ accounts: [both[0]] }); });

    await waitFor(() => expect(result.current).toBe(false));
    expect(apiFetch).toHaveBeenCalledWith('/api/admin/auth', { method: 'DELETE' });

    act(() => { useAccountStore.setState({ accounts: both }); });
    await waitFor(() => expect(result.current).toBe(true));
    expect(slotsAsked().filter((s) => s === '1')).toHaveLength(2);
  });

  it('keeps a password-mode console session when the admin login signs out', async () => {
    const both = [account('user@example.com', 0, true), account('admin@example.com', 1, true)];
    useAccountStore.setState({ accounts: both });
    serve({ 1: { stalwartAdmin: true, authenticated: true, stalwartAutoLogin: false } });
    const { result } = renderHook(() => useStalwartAdmin());
    await waitFor(() => expect(result.current).toBe(true));

    act(() => { useAccountStore.setState({ accounts: [both[0]] }); });

    await waitFor(() => expect(result.current).toBe(false));
    expect(apiFetch).not.toHaveBeenCalledWith('/api/admin/auth', { method: 'DELETE' });
  });

  it('does not mint a session in password mode', async () => {
    serve({ 0: { stalwartAdmin: true, authenticated: false, stalwartAutoLogin: false } });

    const { result } = renderHook(() => useStalwartAdmin());

    await waitFor(() => expect(result.current).toBe(true));
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('stays false for other users and asks nothing without a connected login', async () => {
    serve({});
    const { result } = renderHook(() => useStalwartAdmin());
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(result.current).toBe(false);

    apiFetch.mockReset();
    useAccountStore.setState({ accounts: [account('user@example.com', 0, false)] });
    const { result: none } = renderHook(() => useStalwartAdmin());
    expect(none.current).toBe(false);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
