import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { MultipleAccountsSection } from '../layout-settings';

// settings-9 (usability pass 2026-11-04): the folders that feed All mail are
// named as in the sidebar, not by the server ("Sent Items", "Junk Mail").

vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const mailbox = (id: string, name: string, role?: string) =>
  ({ id, name, role, sortOrder: 0, totalEmails: 0, unreadEmails: 0, isShared: false, myRights: {} } as unknown as Mailbox);

const initial = {
  account: useAccountStore.getState(),
  email: useEmailStore.getState(),
  policy: usePolicyStore.getState(),
  settings: useSettingsStore.getState(),
};

beforeEach(() => {
  useAccountStore.setState({
    accounts: [
      { id: 'a', email: 'a@example.org', displayName: 'A', isConnected: true },
      { id: 'b', email: 'b@example.org', displayName: 'B', isConnected: true },
    ],
    activeAccountId: 'a',
  } as never);
  useEmailStore.setState({
    mailboxes: [mailbox('sent', 'Sent Items', 'sent'), mailbox('junk', 'Junk Mail', 'junk'), mailbox('work', 'Work')],
  } as never);
  usePolicyStore.setState({
    isSettingLocked: () => false,
    isSettingHidden: () => false,
    isFeatureEnabled: () => true,
  } as never);
  useSettingsStore.setState({ enableUnifiedMailbox: true, enableCrossAllView: true, allMailFolderIds: {} });
});

afterEach(() => {
  cleanup();
  useAccountStore.setState(initial.account, true);
  useEmailStore.setState(initial.email, true);
  usePolicyStore.setState(initial.policy, true);
  useSettingsStore.setState(initial.settings, true);
});

describe('the All mail folder list', () => {
  it('names role folders as the sidebar does', () => {
    render(<MultipleAccountsSection />);
    expect(screen.getByText('mailboxes.sent')).toBeInTheDocument();
    expect(screen.getByText('mailboxes.spam')).toBeInTheDocument();
    expect(screen.getByText('Work')).toBeInTheDocument();
    expect(screen.queryByText('Sent Items')).toBeNull();
    expect(screen.queryByText('Junk Mail')).toBeNull();
  });
});

describe('unified view settings visibility', () => {
  const views = [
    ['crossUnreadViewEnabled', 'cross_unread.label', 'enableCrossUnreadView'],
    ['crossStarredViewEnabled', 'cross_starred.label', 'enableCrossStarredView'],
    ['crossAllViewEnabled', 'cross_all.label', 'enableCrossAllView'],
  ] as const;

  const singleAccount = () => {
    useAccountStore.setState({ accounts: useAccountStore.getState().accounts.slice(0, 1) });
  };

  it.each(views)('shows and enables a single-account view with %s', (gate, label, setting) => {
    singleAccount();
    usePolicyStore.setState({ isFeatureEnabled: (feature) => feature === gate });
    useSettingsStore.setState({ [setting]: false });
    render(<MultipleAccountsSection />);

    const toggle = screen.getByRole('switch', { name: label });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(useSettingsStore.getState()[setting]).toBe(true);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    for (const [otherGate, otherLabel] of views) {
      if (otherGate !== gate) expect(screen.queryByRole('switch', { name: otherLabel })).toBeNull();
    }
  });

  it('lets a single account enable Unified Mailbox before choosing a view', () => {
    singleAccount();
    useSettingsStore.setState({ enableUnifiedMailbox: false });
    render(<MultipleAccountsSection />);
    expect(screen.queryByRole('switch', { name: 'cross_unread.label' })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'unified_mailbox.label' }));
    expect(screen.getByRole('switch', { name: 'cross_unread.label' })).toBeInTheDocument();
  });

  it('keeps cross-account and shared/group controls hidden without their accounts', () => {
    singleAccount();
    render(<MultipleAccountsSection />);
    for (const name of [
      'unified_mailbox.cross_account.label',
      'unified_mailbox.include_group.label',
      'show_shared_mail_accounts.label',
      'compact_shared_mailboxes.label',
    ]) expect(screen.queryByRole('switch', { name })).toBeNull();
  });

  it('shows the Unified Mailbox control for a single account even with no allowed views', () => {
    singleAccount();
    usePolicyStore.setState({ isFeatureEnabled: () => false });
    render(<MultipleAccountsSection />);
    expect(screen.getByRole('switch', { name: 'unified_mailbox.label' })).toBeInTheDocument();
  });

  it('hides the entire section when a single account has Unified Mailbox hidden and off', () => {
    singleAccount();
    useSettingsStore.setState({ enableUnifiedMailbox: false });
    usePolicyStore.setState({ isSettingHidden: (setting) => setting === 'enableUnifiedMailbox' });
    const { container } = render(<MultipleAccountsSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('preserves the multi-account controls and views', () => {
    render(<MultipleAccountsSection />);
    expect(screen.getByRole('switch', { name: 'unified_mailbox.cross_account.label' })).toBeInTheDocument();
    for (const [, label] of views) expect(screen.getByRole('switch', { name: label })).toBeInTheDocument();
  });
});
