import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('@/hooks/use-is-embedded', () => ({ useIsEmbedded: () => false }));

import { useProMultiAccountMailboxes } from '@/hooks/use-pro-multi-account-mailboxes';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { invalidateUnifiedMailboxes, useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';

/**
 * The Pro shell needs every login's folders for its per-account tree. While
 * a browser restores its logins they connect one after another, and reloading
 * every connected account on each connection cost 1 + 2 + … + N folder lists.
 * Each login must now be loaded once.
 */
const clients = new Map<string, { getMailboxes: ReturnType<typeof vi.fn> }>();
const client = (id: string) => {
  if (!clients.has(id)) clients.set(id, { getMailboxes: vi.fn(async () => [{ id: `${id}-inbox`, role: 'inbox' }]) });
  return clients.get(id)!;
};

function connected(ids: string[], active = ids[0]) {
  useAccountStore.setState({
    activeAccountId: active,
    accounts: ids.map((id) => ({
      id, label: id, email: id, username: id, serverUrl: 'https://mail.example.org', displayName: id,
      cookieSlot: 0, avatarColor: '#123456', rememberMe: true, isConnected: true, hasError: false,
      isDefault: false, lastLoginAt: Date.now(), authMode: 'basic',
    })) as never,
  });
}

describe('useProMultiAccountMailboxes', () => {
  beforeEach(() => {
    clients.clear();
    invalidateUnifiedMailboxes();
    useEmailStore.setState({ accountMailboxes: {} });
    useSettingsStore.setState({ proInterface: true } as never);
    useAuthStore.setState({ getClientForAccount: (id: string) => client(id) } as never);
  });

  it('loads each login once while logins connect one after another', async () => {
    connected(['a']);
    renderHook(() => useProMultiAccountMailboxes());
    for (const n of [2, 3, 4, 5, 6]) {
      act(() => connected(['a', 'b', 'c', 'd', 'e', 'f'].slice(0, n), 'a'));
    }
    await waitFor(() => expect(Object.keys(useEmailStore.getState().accountMailboxes)).toHaveLength(6));
    for (const [id, c] of clients) expect(c.getMailboxes, id).toHaveBeenCalledTimes(1);
  });

  it('does not refetch for changes that are not a connection', async () => {
    connected(['a', 'b']);
    renderHook(() => useProMultiAccountMailboxes());
    await waitFor(() => expect(client('b').getMailboxes).toHaveBeenCalledTimes(1));
    // A display-name or login-time update rewrites `accounts` but connects no one.
    act(() => connected(['a', 'b']));
    act(() => connected(['a', 'b']));
    expect(client('a').getMailboxes).toHaveBeenCalledTimes(1);
    expect(client('b').getMailboxes).toHaveBeenCalledTimes(1);
  });

  it('reloads every login once when the user switches account', async () => {
    connected(['a', 'b'], 'a');
    renderHook(() => useProMultiAccountMailboxes());
    await waitFor(() => expect(client('b').getMailboxes).toHaveBeenCalledTimes(1));
    act(() => connected(['a', 'b'], 'b'));
    await waitFor(() => expect(client('a').getMailboxes).toHaveBeenCalledTimes(2));
    expect(client('b').getMailboxes).toHaveBeenCalledTimes(2);
  });

  it('tries a login again when its first folder load failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    connected(['a', 'b']);
    client('b').getMailboxes.mockRejectedValueOnce(new Error('offline'));
    renderHook(() => useProMultiAccountMailboxes());
    await waitFor(() => expect(client('b').getMailboxes).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    act(() => connected(['a', 'b', 'c']));
    await waitFor(() => expect(useEmailStore.getState().accountMailboxes.b).toBeDefined());
    expect(client('b').getMailboxes).toHaveBeenCalledTimes(2);
  });

  it('stays idle outside the Pro shell', () => {
    useSettingsStore.setState({ proInterface: false } as never);
    connected(['a', 'b']);
    renderHook(() => useProMultiAccountMailboxes());
    expect(client('a').getMailboxes).not.toHaveBeenCalled();
  });
});
