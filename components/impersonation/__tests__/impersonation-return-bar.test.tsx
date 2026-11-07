import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The banner's "Return to my account" (#1538) shows only in an impersonated
// session the server can return from.

const client = vi.hoisted(() => ({
  canReturnToOwnAccount: vi.fn(async () => true),
  returnToOwnAccount: vi.fn(async () => {}),
}));
vi.mock('@/lib/impersonation/return-client', () => client);

import { ImpersonationReturnBar } from '../impersonation-return-bar';
import { useAccountStore } from '@/stores/account-store';

const account = {
  id: 'alice@x.test@mail.x.test', label: 'Alice', serverUrl: 'https://mail.x.test', username: 'alice@x.test',
  authMode: 'basic' as const, rememberMe: true, cookieSlot: 0, displayName: 'Alice', email: 'alice@x.test',
  isConnected: true, hasError: false, lastLoginAt: 1, avatarColor: '#000000', isDefault: true,
};

async function renderBar() {
  await act(async () => {
    render(<ImpersonationReturnBar />);
  });
}

describe('ImpersonationReturnBar', () => {
  beforeEach(() => {
    client.canReturnToOwnAccount.mockReset().mockResolvedValue(true);
    client.returnToOwnAccount.mockReset().mockResolvedValue(undefined);
  });

  it('offers the way back in an impersonated session', async () => {
    useAccountStore.setState({ accounts: [{ ...account, impersonated: true }], activeAccountId: account.id });
    await renderBar();

    expect(screen.getByTestId('impersonation-return-bar').textContent).toContain('return_notice');
    fireEvent.click(screen.getByRole('button', { name: /return_button/ }));
    expect(client.returnToOwnAccount).toHaveBeenCalledTimes(1);
  });

  it('stays hidden when the server holds nothing to return to', async () => {
    client.canReturnToOwnAccount.mockResolvedValue(false);
    useAccountStore.setState({ accounts: [{ ...account, impersonated: true }], activeAccountId: account.id });
    await renderBar();
    expect(screen.queryByTestId('impersonation-return-bar')).toBeNull();
  });

  it('does not ask the server for a session the user opened themselves', async () => {
    useAccountStore.setState({ accounts: [account], activeAccountId: account.id });
    await renderBar();
    expect(screen.queryByTestId('impersonation-return-bar')).toBeNull();
    expect(client.canReturnToOwnAccount).not.toHaveBeenCalled();
  });
});
