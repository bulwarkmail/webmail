import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { MultipleAccountsSection } from '../layout-settings';

// The shared mailboxes under Appearance > Accounts are listed in the order the
// sidebar shows them: by name, then the login's saved order.

vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const sharedInbox = (accountId: string, accountName: string) =>
  ({
    id: `${accountId}-inbox`, name: 'Inbox', role: 'inbox', sortOrder: 0, totalEmails: 0, unreadEmails: 0,
    isShared: true, accountId, accountName, myRights: {},
  } as unknown as Mailbox);

const initial = {
  account: useAccountStore.getState(),
  email: useEmailStore.getState(),
  policy: usePolicyStore.getState(),
  settings: useSettingsStore.getState(),
};

beforeEach(() => {
  useAccountStore.setState({
    accounts: [{ id: 'a', email: 'a@example.org', displayName: 'A', isConnected: true }],
    activeAccountId: 'a',
  } as never);
  // Not in name order, as the server may list them.
  useEmailStore.setState({
    mailboxes: [sharedInbox('g3', 'Charlie'), sharedInbox('g1', 'Alpha'), sharedInbox('g2', 'Bravo')],
  } as never);
  usePolicyStore.setState({
    isSettingLocked: () => false,
    isSettingHidden: () => false,
    isFeatureEnabled: () => true,
  } as never);
  useSettingsStore.setState({ showSharedMailAccounts: true, hiddenSharedMailAccounts: {}, sharedMailAccountOrder: {} });
});

afterEach(() => {
  cleanup();
  useAccountStore.setState(initial.account, true);
  useEmailStore.setState(initial.email, true);
  usePolicyStore.setState(initial.policy, true);
  useSettingsStore.setState(initial.settings, true);
});

const listed = () => {
  const text = within(screen.getByTestId('shared-mail-account-list')).getByText;
  return ['Alpha', 'Bravo', 'Charlie']
    .map((name) => ({ name, el: text(name) }))
    .sort((x, y) => (x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .map(({ name }) => name);
};

describe('the shared mailbox list in Appearance > Accounts', () => {
  it('lists the accounts by name without a saved order', () => {
    render(<MultipleAccountsSection />);
    expect(listed()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('follows the active login\'s saved order', () => {
    useSettingsStore.setState({ sharedMailAccountOrder: { a: ['g3', 'g1'], b: ['g2'] } });
    render(<MultipleAccountsSection />);
    expect(listed()).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });
});
