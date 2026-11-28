import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCopyToAccount } from '@/hooks/use-message-file-actions';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import type { Email } from '@/lib/jmap/types';

// #1888: "Copy to" also offers the message's own login, with one account
// signed in, and a copy there goes to copyToFolder, not to another account.

const client = { getUsername: () => 'me@example.org' };
const account = (id: string, email: string) => ({
  id, label: email, serverUrl: 'https://mail.example.org', username: email, authMode: 'basic' as const, rememberMe: true, cookieSlot: 0,
  displayName: email, email, isConnected: true, hasError: false, lastLoginAt: 1, avatarColor: '#000000', isDefault: true,
});

const initial = { auth: useAuthStore.getState(), accounts: useAccountStore.getState(), email: useEmailStore.getState() };
let copyToFolder: ReturnType<typeof vi.fn>;
let copyEmailsToAccount: ReturnType<typeof vi.fn>;
beforeEach(() => {
  useAuthStore.setState({
    activeAccountId: 'acc-me',
    client: client as never,
    getClientForAccount: ((id: string) => (id === 'acc-me' ? client : undefined)) as never,
    getAllConnectedClients: (() => new Map<string, unknown>([['acc-me', client]])) as never,
  });
  useAccountStore.setState({ accounts: [account('acc-me', 'me@example.org')] });
  copyToFolder = vi.fn(async () => {});
  copyEmailsToAccount = vi.fn(async () => {});
  useEmailStore.setState({ viewingAccountId: null, error: null, copyToFolder, copyEmailsToAccount } as never);
});
afterEach(() => {
  useAuthStore.setState(initial.auth, true);
  useAccountStore.setState(initial.accounts, true);
  useEmailStore.setState(initial.email, true);
});

describe('Copy to a folder of the same login (#1888)', () => {
  const message = { id: 'm1' } as Email;

  it('offers the own login with one account signed in', () => {
    const { result } = renderHook(() => useCopyToAccount(message, true));
    expect(result.current.copyTargets).toEqual([]);
    expect(result.current.ownTarget).toEqual({ accountId: 'acc-me', label: 'me@example.org' });
  });

  it('offers nothing while the menu is closed', () => {
    const { result } = renderHook(() => useCopyToAccount(message, false));
    expect(result.current.ownTarget).toBeNull();
  });

  it('copies into the own login through copyToFolder', async () => {
    const { result } = renderHook(() => useCopyToAccount(message, true));
    await act(async () => { await result.current.copyToAccount([message], 'acc-me', 'S:cases'); });
    expect(copyToFolder).toHaveBeenCalledWith([message], 'S:cases');
    expect(copyEmailsToAccount).not.toHaveBeenCalled();
  });
});
