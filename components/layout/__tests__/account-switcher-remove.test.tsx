import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

// The popover's rows: no remove button (settings-p2-11), whole addresses,
// and sign-out rows in the menu's plain text colour.

const { AccountSwitcher } = await import('../account-switcher');
const { useAccountStore } = await import('@/stores/account-store');
const { useAuthStore } = await import('@/stores/auth-store');
const { useSettingsStore } = await import('@/stores/settings-store');

function account(id: string) {
  return {
    id, label: `${id}@example.com`, email: `${id}@example.com`, username: `${id}@example.com`,
    displayName: id.toUpperCase(), serverUrl: 'https://mail.example.com', avatarColor: '#336699',
    cookieSlot: 0, isConnected: true, isDefault: id === 'a',
  };
}

beforeEach(() => {
  useAccountStore.setState({ accounts: [account('a'), account('b')] } as never);
  useAuthStore.setState({ activeAccountId: 'a' } as never);
  useSettingsStore.setState({ interfaceLayout: 'default' } as never);
});

describe('removing an account from the popover', () => {
  // settings-p2-11: each row had a hidden X next to "Sign out of …" below.
  // An account you're not in is removed under Settings > Account, where
  // "Manage accounts…" leads.
  it('has no remove button on the rows', () => {
    render(<AccountSwitcher variant="rail" />);
    fireEvent.click(screen.getByTestId('account-switcher'));
    expect(screen.queryByRole('menuitem', { name: 'remove_account' })).toBeNull();
    expect(screen.getAllByTestId('account-option')).toHaveLength(2);
  });

  // The address is what tells two same-named accounts apart, and it was cut
  // ("dso-ux-settings@example…").
  it('shows the whole address, wrapped, with the full text as a tooltip', () => {
    const long = (id: string, email: string) => ({ ...account(id), email, username: email, label: 'Sam', displayName: 'Sam' });
    useAccountStore.setState({ accounts: [long('a', 'dso-ux-settings@example.org'), long('b', 'dso-ux-settings-b@example.org')] } as never);
    render(<AccountSwitcher variant="rail" />);
    fireEvent.click(screen.getByTestId('account-switcher'));
    const title = screen.getByText('dso-ux-settings-b@example.org');
    expect(title.className).not.toContain('truncate');
    expect(title.className).toContain('wrap-anywhere');
    expect(title.getAttribute('title')).toBe('dso-ux-settings-b@example.org');
  });

  it('draws "sign out of all accounts" like the other rows, start-aligned', () => {
    render(<AccountSwitcher variant="rail" />);
    fireEvent.click(screen.getByTestId('account-switcher'));
    const all = screen.getByRole('menuitem', { name: 'sign_out_all' });
    expect(all.className).not.toContain('text-destructive');
    expect(all.className).toContain('text-start');
  });
});
