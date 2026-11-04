import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSettings } from '../account-settings';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';
import type { Identity } from '@/lib/jmap/types';

// settings-p2-2: Account had "Display name" (Stalwart's account description,
// "DSO UX audit settings (throwaway…)") while mail went out as the identity's
// "Sam Settings". There is one name now: the address's, "Your name".
// settings-p2-11: the server host stood under every account, and the drag
// hint showed with one account.

vi.mock('next-intl', () => {
  const t = (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key);
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: vi.fn(async () => 'Admin note (throwaway)') }));
vi.mock('../identity-settings', () => ({ EmailAddressesSection: () => null }));
vi.mock('../layout-settings', () => ({ MultipleAccountsSection: () => null }));
vi.mock('../sign-out-row', () => ({ SignOutRow: () => null }));
vi.mock('../account-archive-settings', () => ({ AccountArchiveSettings: () => null }));

const sam: Identity = {
  id: 'i1', name: 'Sam Settings', email: 'sam@x.test', textSignature: '', htmlSignature: '', mayDelete: false,
};

function entry(id: string, email: string, serverUrl = 'https://mail.x.test') {
  return {
    id, label: 'Admin note (throwaway)', displayName: 'Admin note (throwaway)', email, username: email, serverUrl,
    authMode: 'basic' as const, rememberMe: true, cookieSlot: 0, isConnected: true, hasError: false, lastLoginAt: 1,
    avatarColor: '#2563eb', isDefault: id === 'a',
  };
}

const updateIdentity = vi.fn();
const removeAccount = vi.fn();

function signIn(accounts: ReturnType<typeof entry>[]) {
  useAccountStore.setState({ accounts: accounts as never, activeAccountId: 'a', defaultAccountId: 'a' });
  useIdentityStore.setState({ identities: [sam] });
  useAuthStore.setState({
    username: 'sam@x.test', serverUrl: 'https://mail.x.test', isDemoMode: false, authMode: 'basic',
    client: { updateIdentity, getSharedAccounts: () => [] } as never,
    activeAccountId: 'a', identities: [sam], primaryIdentity: sam, removeAccount,
  } as never);
}

beforeEach(() => {
  updateIdentity.mockReset().mockResolvedValue(undefined);
  removeAccount.mockReset();
});

describe('Account: your name', () => {
  it("shows the address's name, not the server's account description, and saves it to the address", async () => {
    signIn([entry('a', 'sam@x.test')]);
    render(<AccountSettings />);

    const row = screen.getByText('label').closest('[data-search-label]') as HTMLElement;
    const input = within(row).getByRole('textbox');
    expect(input).toHaveValue('Sam Settings');
    const profile = document.querySelector('[data-settings-section="profile"]') as HTMLElement;
    expect(within(profile).queryByText('Admin note (throwaway)')).toBeNull();
    expect(within(profile).queryByDisplayValue('Admin note (throwaway)')).toBeNull();
    expect(screen.queryByText('name_label')).toBeNull();

    fireEvent.change(input, { target: { value: 'Sam Lee' } });
    await act(async () => { fireEvent.submit(input.closest('form')!); });

    expect(updateIdentity).toHaveBeenCalledWith('i1', { name: 'Sam Lee' });
    expect(useAuthStore.getState().primaryIdentity?.name).toBe('Sam Lee');
    // The switcher and the avatar follow the name people see.
    await vi.waitFor(() => expect(useAccountStore.getState().getAccountById('a')?.displayName).toBe('Sam Lee'));
  });
});

describe('Account: signed-in accounts', () => {
  it('shows no server line and no drag hint for one account', () => {
    signIn([entry('a', 'sam@x.test')]);
    render(<AccountSettings />);
    expect(screen.queryByTestId('account-server')).toBeNull();
    expect(screen.queryByText('mail.x.test')).toBeNull();
    expect(screen.queryByText('accounts.description')).toBeNull();
    expect(screen.queryByRole('button', { name: 'accounts.move_up' })).toBeNull();
  });

  it('shows the server only when two accounts share an address', () => {
    signIn([entry('a', 'sam@x.test'), entry('b', 'sam@y.test', 'https://mail.y.test')]);
    const { unmount } = render(<AccountSettings />);
    expect(screen.queryByTestId('account-server')).toBeNull();
    expect(screen.getByText('accounts.description')).toBeTruthy();
    unmount();

    signIn([entry('a', 'sam@x.test'), entry('b', 'sam@x.test', 'https://mail.y.test')]);
    render(<AccountSettings />);
    expect(screen.getAllByTestId('account-server').map((el) => el.textContent)).toEqual(['mail.x.test', 'mail.y.test']);
  });

  it('removes an account you are not in after asking', async () => {
    signIn([entry('a', 'sam@x.test'), entry('b', 'sam@y.test')]);
    render(<AccountSettings />);
    // Only the other account has a remove button.
    const buttons = screen.getAllByRole('button', { name: 'remove_account' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    const dialog = await screen.findByRole('alertdialog');
    expect(removeAccount).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'remove_account' })); });
    expect(removeAccount).toHaveBeenCalledWith('b');
  });
});
