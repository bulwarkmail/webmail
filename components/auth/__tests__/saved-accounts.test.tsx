import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SavedAccounts } from '../saved-accounts';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountListPreferencesStore } from '@/stores/account-list-preferences-store';

const account = {
  id: 'gmail', username: 'user@gmail.com', email: 'user@gmail.com', serverUrl: 'https://gmail.example.com',
  label: 'Personal Gmail', displayName: 'Personal Gmail', awaitingSignIn: true,
};

beforeEach(() => {
  useAccountStore.setState({ accounts: [account] } as never);
  useAccountListPreferencesStore.setState({ rememberAccountList: true });
});

it('offers a saved account for sign-in without showing any mail', () => {
  const select = vi.fn();
  useAuthStore.setState({ switchAccount: select });
  render(<SavedAccounts />);
  expect(screen.getByText('user@gmail.com')).toBeInTheDocument();
  expect(screen.getByText('https://gmail.example.com')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Personal Gmail.*sign_in/ }));
  expect(select).toHaveBeenCalledWith('gmail');
});

it('requires confirmation before explicitly removing a saved account', () => {
  const remove = vi.fn();
  useAuthStore.setState({ removeAccount: remove });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  render(<SavedAccounts />);
  const button = screen.getByRole('button', { name: 'remove_account: user@gmail.com' });
  fireEvent.click(button);
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(remove).toHaveBeenCalledWith('gmail');
  confirm.mockRestore();
});

it('does not offer a live account as a saved signed-out identity', () => {
  useAccountStore.setState({ accounts: [{ ...account, awaitingSignIn: false }] } as never);
  const { container } = render(<SavedAccounts />);
  expect(container).toBeEmptyDOMElement();
});

it('does not display saved accounts when the feature is disabled', () => {
  useAccountListPreferencesStore.setState({ rememberAccountList: false });
  const { container } = render(<SavedAccounts />);
  expect(container).toBeEmptyDOMElement();
});
