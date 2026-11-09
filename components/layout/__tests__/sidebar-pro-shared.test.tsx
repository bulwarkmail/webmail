import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// #1486: with two logins the Pro sidebar shows one folder group per login,
// and the shared mailboxes were left out of it altogether. Each group now has
// its own Shared section with the mailboxes that login can reach.

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ startTour: vi.fn(), resetTourCompletion: vi.fn(), activeTour: null, endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/contexts/drag-drop-context', () => ({
  useDragDropContext: () => ({ isDragging: false }),
}));
vi.mock('@/hooks/use-mailbox-drop', () => ({
  useMailboxDrop: () => ({ dropHandlers: {}, isValidDropTarget: false, isInvalidDropTarget: false }),
}));
vi.mock('@/hooks/use-tag-drop', () => ({
  useTagDrop: () => ({ dropHandlers: {}, isValidDropTarget: false }),
}));
vi.mock('../account-switcher', () => ({ AccountSwitcher: () => null }));

const { Sidebar } = await import('../sidebar');
const { useSettingsStore } = await import('@/stores/settings-store');
const { useUIStore } = await import('@/stores/ui-store');
const { useAccountStore } = await import('@/stores/account-store');
const { useAuthStore } = await import('@/stores/auth-store');

const own = (id: string, name: string, role: string | null) =>
  ({ id, name, role, parentId: null, totalEmails: 0, unreadEmails: 0, sortOrder: 0, myRights: { mayAddItems: true } }) as unknown as Mailbox;
const shared = (accountId: string, accountName: string) =>
  ({
    id: `${accountId}-inbox`, name: 'Inbox', role: 'inbox', parentId: null, totalEmails: 0, unreadEmails: 0,
    sortOrder: 0, myRights: { mayAddItems: true }, accountId, accountName, isShared: true,
  }) as unknown as Mailbox;

const account = (id: string) => ({
  id, label: `${id}@example.com`, email: `${id}@example.com`, username: `${id}@example.com`,
  cookieSlot: id === 'a' ? 0 : 1, isConnected: true,
});

// Login a is active and has no shared mailbox; login b has one.
const activeMailboxes = [own('a-inbox', 'Inbox', 'inbox')];
const otherOwn = { b: [own('b-inbox', 'Inbox', 'inbox')] };
const otherShared = { b: [shared('team', 'Team mailbox')] };

const sharedHeaders = () => screen.queryAllByTestId('section-shared-account').map((el) => el.textContent);

describe('Pro sidebar shared mailboxes with several logins (#1486)', () => {
  beforeEach(() => {
    localStorage.clear();
    useUIStore.setState({ sidebarCollapsed: false } as never);
    useAccountStore.setState({ accounts: [account('a'), account('b')] } as never);
    useAuthStore.setState({ activeAccountId: 'a' } as never);
    useSettingsStore.setState({
      emailKeywords: [],
      enableUnifiedMailbox: false,
      hideAccountSwitcher: true,
      showSharedMailAccounts: true,
      hiddenSharedMailAccounts: {},
      compactSharedMailboxes: false,
    } as never);
  });

  it('lists the shared mailboxes of a login that is not the active one', () => {
    render(
      <Sidebar
        mailboxes={activeMailboxes}
        selectedMailbox="a-inbox"
        multiAccountMode
        accountMailboxes={otherOwn}
        accountSharedMailboxes={otherShared}
      />,
    );

    expect(screen.getAllByTestId('section-shared-in-account')).toHaveLength(1);
    expect(sharedHeaders()).toEqual([expect.stringContaining('Team mailbox')]);
  });

  it('lists the active login\'s shared mailboxes inside its group', () => {
    useAuthStore.setState({ activeAccountId: 'b' } as never);
    render(
      <Sidebar
        mailboxes={[own('b-inbox', 'Inbox', 'inbox'), shared('team', 'Team mailbox')]}
        selectedMailbox="b-inbox"
        multiAccountMode
        accountMailboxes={{ a: activeMailboxes }}
      />,
    );

    expect(sharedHeaders()).toEqual([expect.stringContaining('Team mailbox')]);
  });

  it('opens another login\'s shared mailbox through that login', () => {
    const onLoginSharedMailboxSelect = vi.fn();
    const onAccountMailboxSelect = vi.fn();
    render(
      <Sidebar
        mailboxes={activeMailboxes}
        selectedMailbox="a-inbox"
        multiAccountMode
        accountMailboxes={otherOwn}
        accountSharedMailboxes={otherShared}
        onAccountMailboxSelect={onAccountMailboxSelect}
        onLoginSharedMailboxSelect={onLoginSharedMailboxSelect}
      />,
    );

    const section = screen.getByTestId('section-shared-in-account');
    fireEvent.click(within(section).getByText('Team mailbox'));
    fireEvent.click(section.querySelector('[data-mailbox-id="team-inbox"] > button')!);

    expect(onLoginSharedMailboxSelect).toHaveBeenCalledWith('b', 'team-inbox');
    expect(onAccountMailboxSelect).not.toHaveBeenCalled();
  });

  it('opens the active login\'s shared mailbox like its other folders', () => {
    useAuthStore.setState({ activeAccountId: 'b' } as never);
    const onAccountMailboxSelect = vi.fn();
    render(
      <Sidebar
        mailboxes={[own('b-inbox', 'Inbox', 'inbox'), shared('team', 'Team mailbox')]}
        selectedMailbox="b-inbox"
        multiAccountMode
        accountMailboxes={{ a: activeMailboxes }}
        onAccountMailboxSelect={onAccountMailboxSelect}
      />,
    );

    const section = screen.getByTestId('section-shared-in-account');
    fireEvent.click(within(section).getByText('Team mailbox'));
    fireEvent.click(section.querySelector('[data-mailbox-id="team-inbox"] > button')!);

    expect(onAccountMailboxSelect).toHaveBeenCalledWith(null, 'team-inbox');
  });

  it('hides a shared account hidden for that login only', () => {
    useSettingsStore.setState({ hiddenSharedMailAccounts: { b: ['team'] } } as never);
    render(
      <Sidebar
        mailboxes={activeMailboxes}
        selectedMailbox="a-inbox"
        multiAccountMode
        accountMailboxes={otherOwn}
        accountSharedMailboxes={otherShared}
      />,
    );

    expect(screen.queryByTestId('section-shared-in-account')).toBeNull();
  });
});
