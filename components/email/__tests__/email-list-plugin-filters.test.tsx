import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EmailList } from '../email-list';
import { useEmailStore } from '@/stores/email-store';
import { resetListFilters, setPluginListFilters } from '@/lib/plugin-sandbox/list-filters';
import { confirmGroups, resetConfirmedGroups } from '@/lib/plugin-sandbox/account-kind';
import type { Mailbox } from '@/lib/jmap/types';

// The plugins' list filter chips in the message list: shown in a team
// folder's own list, loading the list again when one is turned on, and not
// in a search, a tag view or the merged views.

const client = vi.hoisted(() => ({
  getAccountId: () => 'ci',
  getAccountInfo: (id: string) => (id === 'ch' ? { name: 'org-team@example.org', isPersonal: false, isReadOnly: false, accountCapabilities: {} } : null),
  getSharedAccounts: () => [
    { id: 'ci', name: 'org-alice@example.org', isPrimary: true, capabilities: { mail: true } },
    { id: 'ch', name: 'org-team@example.org', isPrimary: false, capabilities: { mail: true } },
  ],
  getPrincipalTypes: async () => ({ ch: 'group' }),
}));

vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/stores/auth-store', async () => {
  const { create } = await import('zustand');
  return {
    useAuthStore: create(() => ({
      client, identities: [], username: null, activeAccountId: 'acct-1',
      getClientForAccount: () => client, getAllConnectedClients: () => new Map(),
    })),
  };
});
vi.mock('@/stores/account-store', () => {
  const state = { accounts: [], getAccountById: () => undefined };
  return {
    useAccountStore: Object.assign(
      (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
      { getState: () => state },
    ),
  };
});

const teamInbox = { id: 'ch:a', originalId: 'a', name: 'Inbox', role: 'inbox', isShared: true, accountId: 'ch', totalEmails: 0, unreadEmails: 0, sortOrder: 0 } as unknown as Mailbox;
const initialEmailState = useEmailStore.getState();
const fetchEmails = vi.fn(async () => {});

beforeEach(async () => {
  resetListFilters();
  resetConfirmedGroups();
  fetchEmails.mockClear();
  useEmailStore.setState(initialEmailState, true);
  useEmailStore.setState({ selectedMailbox: 'ch:a', mailboxes: [teamInbox], fetchEmails });
  setPluginListFilters('team-inbox', 'Team inbox', [{ id: 'open', label: 'Open', notKeyword: '$done', accounts: ['group'] }]);
  await confirmGroups(client as never);
});

describe('plugin list filters in the message list', () => {
  it('shows the chip in a team folder and loads the list when it is turned on and off', async () => {
    render(<EmailList emails={[]} />);
    const chip = await screen.findByRole('button', { name: 'Open' });
    expect(fetchEmails).not.toHaveBeenCalled();
    act(() => { fireEvent.click(chip); });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(fetchEmails).toHaveBeenCalledTimes(1);
    expect(fetchEmails).toHaveBeenCalledWith(client);
    act(() => { fireEvent.click(chip); });
    expect(fetchEmails).toHaveBeenCalledTimes(2);
  });

  it('does not call the folder empty while a filter hides its mail', async () => {
    render(<EmailList emails={[]} />);
    expect(await screen.findByText('no_emails_description')).toBeInTheDocument();
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Open' })); });
    expect(screen.getByText('no_emails')).toBeInTheDocument();
    expect(screen.queryByText('no_emails_description')).toBeNull();
  });

  it.each([
    ['a search', { searchQuery: 'invoice' }],
    ['a tag view', { selectedKeyword: 'work' }],
    ['the merged views', { isUnifiedView: true }],
  ])('leaves %s without chips', async (_name, state) => {
    useEmailStore.setState(state);
    render(<EmailList emails={[]} />);
    await act(async () => {});
    expect(screen.queryByTestId('plugin-list-filters')).toBeNull();
  });
});
