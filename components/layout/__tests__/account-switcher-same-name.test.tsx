import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

// One person signed in to two mailboxes: same name, same picture, same server.
// The rows have to differ in their bold line, not only in the small one.

const { AccountSwitcher } = await import('../account-switcher');
const { useAccountStore } = await import('@/stores/account-store');
const { useAuthStore } = await import('@/stores/auth-store');
const { useSettingsStore } = await import('@/stores/settings-store');

function account(id: string, displayName: string, email: string) {
  return {
    id, label: email, email, username: email, displayName,
    serverUrl: 'https://demo.example.com', avatarColor: '#336699',
    cookieSlot: 0, isConnected: true, isDefault: id === 'work',
  };
}

beforeEach(() => {
  useAccountStore.setState({
    accounts: [
      account('work', 'Nora Lindqvist', 'nora@meridianlabs.example'),
      account('home', 'Nora Lindqvist', 'nora@lindqvist.example'),
      account('team', 'Sarah Kim', 'sarah@meridianlabs.example'),
    ],
  } as never);
  useAuthStore.setState({ activeAccountId: 'work' } as never);
  useSettingsStore.setState({ interfaceLayout: 'default' } as never);
});

function rowFor(id: string) {
  return screen.getAllByTestId('account-option').find((row) => row.dataset.accountId === id)!;
}

describe('account switcher with two accounts of the same name', () => {
  it('titles each of them with its address and drops the shared name', () => {
    render(<AccountSwitcher variant="expanded" />);
    fireEvent.click(screen.getByTestId('account-switcher'));

    for (const [id, email] of [['work', 'nora@meridianlabs.example'], ['home', 'nora@lindqvist.example']]) {
      const row = rowFor(id);
      expect(within(row).getByText(email).className).toContain('font-medium');
      expect(within(row).queryByText('Nora Lindqvist')).toBeNull();
    }
  });

  it('keeps name over address for an account whose name is its own', () => {
    render(<AccountSwitcher variant="expanded" />);
    fireEvent.click(screen.getByTestId('account-switcher'));

    const row = rowFor('team');
    expect(within(row).getByText('Sarah Kim').className).toContain('font-medium');
    expect(within(row).getByText('sarah@meridianlabs.example')).toBeInTheDocument();
  });

  // settings-14: the button names one account, with its address under it, so
  // its name doesn't jump to the address when a second account is added.
  it("keeps the open account's name in the sidebar button, with the address under it", () => {
    render(<AccountSwitcher variant="expanded" />);
    const button = screen.getByTestId('account-switcher');
    expect(within(button).getByText('Nora Lindqvist').className).toContain('font-medium');
    expect(within(button).getByText('nora@meridianlabs.example')).toBeInTheDocument();
  });
});
