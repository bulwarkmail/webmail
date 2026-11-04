import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// Usability test 2026-11-04, pass 2 p2-9: folded to icons (600 to 1024 px),
// the folder column showed eight identical folder icons, no unread marks,
// and no way to reach subfolders without unfolding it.

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
const { useSettingsStore } = await import('@/stores/settings-store');
const { useUIStore } = await import('@/stores/ui-store');

const box = (id: string, name: string, role: string | null, extra: Partial<Mailbox> = {}) => ({
  id, name, role, parentId: null, totalEmails: 0, unreadEmails: 0, myRights: { mayAddItems: true }, ...extra,
}) as unknown as Mailbox;

const mailboxes: Mailbox[] = [
  box('inbox', 'Inbox', 'inbox', { totalEmails: 120, unreadEmails: 4 }),
  box('trash', 'Trash', 'trash'),
  box('news', 'Newsletters', null, { totalEmails: 30, unreadEmails: 2 }),
  box('receipts', 'Receipts', null, { totalEmails: 5 }),
  box('y2026', '2026', null, { parentId: 'receipts', totalEmails: 3 }),
];

const peek = () => document.querySelector('[data-folder-peek]');

describe('folded folder column (default layout)', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({ activeAccountId: 'login-a', client: { getAccountId: () => 'me', getCapabilities: () => ({}) } } as never);
    useSettingsStore.setState({ hideAccountSwitcher: true, interfaceLayout: 'default', openOnHover: true, unreadCountStyle: 'count' } as never);
    useUIStore.setState({ sidebarCollapsed: true } as never);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useUIStore.setState({ sidebarCollapsed: false } as never);
  });

  it('tells folders of one\'s own apart by their first letter', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    const initials = screen.getAllByTestId('folder-initial').map((el) => el.textContent);
    expect(initials).toEqual(expect.arrayContaining(['N', 'R']));
    // System folders keep their own icons.
    expect(initials).toHaveLength(2);
  });

  it('shows the unread count on the icon', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    const inbox = document.querySelector('[data-mailbox-id="inbox"]')!;
    expect(inbox.querySelector('[data-testid="folded-unread"]')?.textContent).toBe('4');
    const trash = document.querySelector('[data-mailbox-id="trash"]')!;
    expect(trash.querySelector('[data-testid="folded-unread"]')).toBeNull();
  });

  it('shows a dot when counts are dots', () => {
    useSettingsStore.setState({ unreadCountStyle: 'dot' } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    const mark = document.querySelector('[data-mailbox-id="news"] [data-testid="folded-unread"]');
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe('');
  });

  it('opens the whole tree from All folders, keyboard included, and Escape folds it back', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    expect(screen.queryByText('Receipts')).toBeNull();
    fireEvent.click(screen.getByTestId('folded-all-folders'));
    expect(peek()).not.toBeNull();
    expect(screen.getByText('Receipts')).toBeTruthy();
    // The focus is in the tree, on the open folder.
    expect(document.activeElement?.closest('[data-mailbox-id]')?.getAttribute('data-mailbox-id')).toBe('inbox');
    // Subfolders are reachable: Receipts > 2026.
    expect(screen.getByText('2026')).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(peek()).toBeNull();
  });

  it('folds the tree away after a pick', () => {
    const { rerender } = render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    fireEvent.click(screen.getByTestId('folded-all-folders'));
    expect(peek()).not.toBeNull();
    rerender(<Sidebar mailboxes={mailboxes} selectedMailbox="news" />);
    expect(peek()).toBeNull();
  });

  it('folds it away on a press outside', () => {
    render(<><Sidebar mailboxes={mailboxes} selectedMailbox="inbox" /><button type="button">elsewhere</button></>);
    fireEvent.click(screen.getByTestId('folded-all-folders'));
    fireEvent.pointerDown(screen.getByText('elsewhere'));
    expect(peek()).toBeNull();
  });

  it('floats out after the pointer rests on it, not at once, and not with hover opening off', () => {
    vi.useFakeTimers();
    const { container } = render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    fireEvent.mouseEnter(container.firstElementChild!);
    expect(peek()).toBeNull();
    act(() => { vi.advanceTimersByTime(400); });
    expect(peek()).not.toBeNull();
    fireEvent.mouseLeave(container.firstElementChild!);
    expect(peek()).toBeNull();

    useSettingsStore.setState({ openOnHover: false } as never);
    fireEvent.mouseEnter(container.firstElementChild!);
    act(() => { vi.advanceTimersByTime(400); });
    expect(peek()).toBeNull();
  });
});
