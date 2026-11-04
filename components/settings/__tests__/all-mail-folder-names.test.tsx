import { render, screen } from '@testing-library/react';
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
