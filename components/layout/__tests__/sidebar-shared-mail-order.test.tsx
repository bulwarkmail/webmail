import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// The shared accounts in the Shared section can be put in any order by
// dragging them or with Move up / Move down; the order is kept per login.

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
const { useAuthStore } = await import('@/stores/auth-store');
const { useAccountStore } = await import('@/stores/account-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { useUIStore } = await import('@/stores/ui-store');
const { SHARED_ACCOUNT_DRAG_MIME } = await import('@/lib/shared-mail-order');

function sharedInbox(accountId: string, accountName: string): Mailbox {
  return {
    id: `${accountId}-inbox`, name: 'Inbox', role: 'inbox', parentId: null, totalEmails: 0, unreadEmails: 0,
    myRights: { mayAddItems: true }, accountId, accountName, isShared: true,
  } as unknown as Mailbox;
}

const ownInbox = { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, totalEmails: 0, unreadEmails: 0, myRights: { mayAddItems: true } } as unknown as Mailbox;
const mailboxes: Mailbox[] = [
  ownInbox,
  sharedInbox('g1', 'Alpha'),
  sharedInbox('g2', 'Bravo'),
  sharedInbox('g3', 'Charlie'),
];

const names = (els: HTMLElement[]) => els.map((el) => el.textContent?.match(/Alpha|Bravo|Charlie/)?.[0]);
const sharedHeaders = () => names(screen.queryAllByTestId('section-shared-account'));
const compactRows = () => names(screen.queryAllByTestId('compact-shared-mailbox'));
const header = (name: string) => screen.getAllByTestId('section-shared-account').find((el) => el.textContent?.includes(name))!;

/** A DataTransfer good enough for jsdom: types and data shared across events. */
function dataTransfer() {
  const data = new Map<string, string>();
  return {
    get types() { return Array.from(data.keys()); },
    setData: (type: string, value: string) => { data.set(type, value); },
    getData: (type: string) => data.get(type) ?? '',
    effectAllowed: '',
    dropEffect: '',
  };
}

function drag(from: HTMLElement, to: HTMLElement) {
  const dt = dataTransfer();
  fireEvent.dragStart(from, { dataTransfer: dt });
  fireEvent.dragOver(to, { dataTransfer: dt });
  fireEvent.drop(to, { dataTransfer: dt });
  fireEvent.dragEnd(from, { dataTransfer: dt });
  return dt;
}

describe('Sidebar shared account order', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('sidebarSharedExpanded', 'true');
    localStorage.setItem('expandedMailboxes', '[]');
    useUIStore.setState({ sidebarCollapsed: false } as never);
    useAccountStore.setState({ accounts: [] } as never);
    useAuthStore.setState({ activeAccountId: 'login-a' } as never);
    useSettingsStore.setState({
      hideAccountSwitcher: true,
      showSharedMailAccounts: true,
      hiddenSharedMailAccounts: {},
      sharedMailAccountOrder: {},
      compactSharedMailboxes: false,
      emailKeywords: [],
      enableUnifiedMailbox: false,
    } as never);
  });

  it('lists the accounts alphabetically without a saved order', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    expect(sharedHeaders()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('follows the active login\'s saved order, with the others after it', () => {
    useSettingsStore.setState({ sharedMailAccountOrder: { 'login-a': ['g3', 'g1'], 'login-b': ['g2'] } } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    expect(sharedHeaders()).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('moves an account by dragging its header onto another', () => {
    useSettingsStore.setState({ sharedMailAccountOrder: { 'login-b': ['g2'] } } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);

    const dt = drag(header('Charlie'), header('Alpha'));

    expect(dt.getData(SHARED_ACCOUNT_DRAG_MIME)).toBe('g3');
    expect(useSettingsStore.getState().sharedMailAccountOrder).toEqual({
      'login-a': ['g3', 'g1', 'g2'],
      'login-b': ['g2'],
    });
    expect(sharedHeaders()).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('marks the dragged account and the side it lands on', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    const block = (name: string) => header(name).parentElement!.parentElement!;
    const dt = dataTransfer();

    fireEvent.dragStart(header('Alpha'), { dataTransfer: dt });
    fireEvent.dragOver(header('Charlie'), { dataTransfer: dt });
    expect(block('Alpha').className).toContain('opacity-50');
    expect(block('Charlie').className).toContain('border-b-2');

    fireEvent.dragEnd(header('Alpha'), { dataTransfer: dt });
    expect(block('Alpha').className).not.toContain('opacity-50');
    expect(block('Charlie').className).not.toContain('border-b-2');
    expect(useSettingsStore.getState().sharedMailAccountOrder).toEqual({});
  });

  it('ignores drops without the shared account payload and drops on itself', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);

    const emails = dataTransfer();
    emails.setData('application/x-email-ids', '["e1"]');
    fireEvent.dragOver(header('Alpha'), { dataTransfer: emails });
    fireEvent.drop(header('Alpha'), { dataTransfer: emails });
    drag(header('Bravo'), header('Bravo'));

    expect(useSettingsStore.getState().sharedMailAccountOrder).toEqual({});
    expect(sharedHeaders()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('keeps a hidden account\'s place when it is shown again', () => {
    useSettingsStore.setState({ hiddenSharedMailAccounts: { 'login-a': ['g2'] } } as never);
    const { rerender } = render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    expect(sharedHeaders()).toEqual(['Alpha', 'Charlie']);

    drag(header('Charlie'), header('Alpha'));
    expect(sharedHeaders()).toEqual(['Charlie', 'Alpha']);

    useSettingsStore.setState({ hiddenSharedMailAccounts: {} } as never);
    rerender(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    expect(sharedHeaders()).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('moves an account up and down from its context menu, with no entry past the ends', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);

    fireEvent.contextMenu(header('Alpha'));
    expect(screen.queryByTestId('mailbox-move-shared-account-up')).toBeNull();
    fireEvent.click(screen.getByTestId('mailbox-move-shared-account-down'));
    expect(sharedHeaders()).toEqual(['Bravo', 'Alpha', 'Charlie']);
    expect(useSettingsStore.getState().sharedMailAccountOrder).toEqual({ 'login-a': ['g2', 'g1', 'g3'] });

    fireEvent.contextMenu(header('Charlie'));
    expect(screen.queryByTestId('mailbox-move-shared-account-down')).toBeNull();
    fireEvent.click(screen.getByTestId('mailbox-move-shared-account-up'));
    expect(sharedHeaders()).toEqual(['Bravo', 'Charlie', 'Alpha']);
  });

  it('offers neither move nor drag with one shared account', () => {
    render(<Sidebar mailboxes={[ownInbox, sharedInbox('g1', 'Alpha')]} selectedMailbox="inbox" />);

    expect(header('Alpha').parentElement!.getAttribute('draggable')).toBeNull();
    fireEvent.contextMenu(header('Alpha'));
    expect(screen.getByTestId('mailbox-hide-shared-account')).toBeTruthy();
    expect(screen.queryByTestId('mailbox-move-shared-account-up')).toBeNull();
    expect(screen.queryByTestId('mailbox-move-shared-account-down')).toBeNull();
  });

  it('applies the order to compact shared mailboxes and reorders them by dragging', () => {
    useSettingsStore.setState({ compactSharedMailboxes: true, sharedMailAccountOrder: { 'login-a': ['g2'] } } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    expect(compactRows()).toEqual(['Bravo', 'Alpha', 'Charlie']);

    const row = (name: string) => within(
      screen.getAllByTestId('compact-shared-mailbox').find((el) => el.textContent?.includes(name))!,
    ).getAllByTestId('folder-row')[0];
    drag(row('Alpha'), row('Charlie'));

    expect(compactRows()).toEqual(['Bravo', 'Charlie', 'Alpha']);
    expect(useSettingsStore.getState().sharedMailAccountOrder).toEqual({ 'login-a': ['g2', 'g3', 'g1'] });
  });

  it('applies the order to the folded rail, without dragging', () => {
    useUIStore.setState({ sidebarCollapsed: true, compactSidebarExpanded: false } as never);
    useSettingsStore.setState({ sharedMailAccountOrder: { 'login-a': ['g3', 'g2'] } } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);

    const rail = Array.from(document.querySelectorAll<HTMLElement>('[data-rail-key^="shared-account-"]'));
    expect(rail.map((el) => el.getAttribute('data-rail-key'))).toEqual([
      'shared-account-g3', 'shared-account-g2', 'shared-account-g1',
    ]);
    expect(rail.every((el) => el.getAttribute('draggable') === null)).toBe(true);
  });
});

describe('Pro sidebar shared account order with several logins', () => {
  const account = (id: string) => ({
    id, label: `${id}@example.com`, email: `${id}@example.com`, username: `${id}@example.com`,
    cookieSlot: id === 'a' ? 0 : 1, isConnected: true,
  });

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
      sharedMailAccountOrder: { b: ['g3', 'g2'] },
    } as never);
  });

  it('orders another login\'s shared accounts by that login\'s entry, without dragging', () => {
    render(
      <Sidebar
        mailboxes={[{ ...ownInbox, id: 'a-inbox' } as Mailbox]}
        selectedMailbox="a-inbox"
        multiAccountMode
        accountMailboxes={{ b: [{ ...ownInbox, id: 'b-inbox' } as Mailbox] }}
        accountSharedMailboxes={{ b: [sharedInbox('g1', 'Alpha'), sharedInbox('g2', 'Bravo'), sharedInbox('g3', 'Charlie')] }}
      />,
    );

    const section = screen.getByTestId('section-shared-in-account');
    const headers = within(section).queryAllByTestId('section-shared-account');
    expect(names(headers)).toEqual(['Charlie', 'Bravo', 'Alpha']);
    expect(headers[0].parentElement!.getAttribute('draggable')).toBeNull();
  });
});
