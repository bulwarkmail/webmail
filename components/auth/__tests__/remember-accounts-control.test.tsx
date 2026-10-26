import { beforeEach, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RememberAccountsControl } from '../remember-accounts-control';
import { useAccountListPreferencesStore } from '@/stores/account-list-preferences-store';

beforeEach(() => useAccountListPreferencesStore.setState({ rememberAccountList: false }));

it('offers an unchecked device-level choice by default', () => {
  render(<RememberAccountsControl />);
  const checkbox = screen.getByRole('checkbox', { name: /remember_accounts/ });
  expect(checkbox).not.toBeChecked();
  fireEvent.click(checkbox);
  expect(checkbox).toBeChecked();
  expect(useAccountListPreferencesStore.getState().rememberAccountList).toBe(true);
});

it('lets a device opt out of an enabled deployment default', () => {
  useAccountListPreferencesStore.setState({ rememberAccountList: null });
  useAccountListPreferencesStore.getState().initialize(true);
  render(<RememberAccountsControl />);
  const checkbox = screen.getByRole('checkbox', { name: /remember_accounts/ });
  expect(checkbox).toBeChecked();
  fireEvent.click(checkbox);
  expect(checkbox).not.toBeChecked();
  expect(useAccountListPreferencesStore.getState().rememberAccountList).toBe(false);
});
