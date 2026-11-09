import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// "It jumps when hovering": a hover on the folded folder column floated the
// whole tree out as a drawer from the window's edge, over the app rail, with
// the account, the section headings and the subfolders added above the
// hovered rows. The Inbox moved down by the rows added above it and the
// item under the pointer changed. A hover now shows the names beside the
// same items, in the column's own place; the tree stays All folders'.

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
vi.mock('../account-switcher', () => ({ AccountSwitcher: () => <div data-testid="account-switcher-stub" /> }));

const { Sidebar } = await import('../sidebar');
const { useAuthStore } = await import('@/stores/auth-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { useUIStore } = await import('@/stores/ui-store');

const box = (id: string, name: string, role: string | null, extra: Partial<Mailbox> = {}) => ({
  id, name, role, parentId: null, totalEmails: 0, unreadEmails: 0, myRights: { mayAddItems: true }, ...extra,
}) as unknown as Mailbox;

const mailboxes: Mailbox[] = [
  box('inbox', 'Inbox', 'inbox', { totalEmails: 120, unreadEmails: 4 }),
  box('clients', 'Clients', null, { parentId: 'inbox', unreadEmails: 7 }),
  box('sent', 'Sent', 'sent'),
  box('trash', 'Trash', 'trash'),
  box('news', 'Newsletters', null, { totalEmails: 30, unreadEmails: 2 }),
  box('receipts', 'Receipts', null, { totalEmails: 5 }),
];

const root = () => document.querySelector<HTMLElement>('[data-folder-nav]')!.parentElement!;
const nav = () => document.querySelector<HTMLElement>('[data-folder-nav]')!;
const drawer = () => document.querySelector('[data-folder-drawer]');
const labelsShown = () => root().hasAttribute('data-folder-rail-labels');
/** Everything in the column, top to bottom: items by key, rules, headings, rows of any kind. */
const layout = () => Array.from(nav().querySelectorAll<HTMLElement>('[data-rail-key], [data-rail-separator], [data-section-name], [data-testid="folders-loading"]'))
  .map((el) => el.dataset.railKey ?? (el.hasAttribute('data-rail-separator') ? '--' : `heading:${el.dataset.sectionName ?? 'loading'}`));
const rest = (x: number, y: number) => {
  fireEvent.mouseEnter(root(), { clientX: x, clientY: y });
  act(() => { vi.advanceTimersByTime(400); });
};

describe('hovering the folded folder column (default layout)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    useAuthStore.setState({ activeAccountId: 'login-a', client: { getAccountId: () => 'me', getCapabilities: () => ({}) } } as never);
    useSettingsStore.setState({
      hideAccountSwitcher: true, sidebarAccountSwitcher: true, interfaceLayout: 'default', openOnHover: true, unreadCountStyle: 'count',
    } as never);
    useUIStore.setState({ sidebarCollapsed: true, compactSidebarExpanded: false } as never);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useUIStore.setState({ sidebarCollapsed: false } as never);
  });

  it('keeps every item in its place: same rows in the same order, nothing added above or between them', () => {
    const onDrawerChange = vi.fn();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onDrawerChange={onDrawerChange} />);
    const folded = layout();
    const foldedNav = nav();
    rest(20, 120);
    expect(labelsShown()).toBe(true);
    expect(layout()).toEqual(folded);
    // The same list, not a new one: its scroll offset maps to the same rows.
    expect(nav()).toBe(foldedNav);
    expect(nav().hasAttribute('data-folder-rail')).toBe(true);
    // No account header, no section headings, no subfolders.
    expect(screen.queryByTestId('account-switcher-stub')).toBeNull();
    expect(document.querySelector('[data-section-name]')).toBeNull();
    expect(document.querySelector('[data-mailbox-id="clients"]')).toBeNull();
    // Nothing for the page to dim, and no drawer.
    expect(drawer()).toBeNull();
    expect(onDrawerChange).not.toHaveBeenCalled();
  });

  it('grows from the column\'s own edge over the list, not from the window\'s edge over the app rail', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    rest(20, 120);
    const classes = root().className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['desk:absolute', 'desk:start-0', 'desk:inset-y-0', 'desk:w-64']));
    expect(classes).not.toContain('fixed');
    expect(classes).not.toContain('desk:w-12');
  });

  it('opens and folds the names at once, without sliding the icons through a width transition', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    expect(root().className).not.toContain('transition-none');
    rest(20, 120);
    expect(root().className.split(/\s+/)).toContain('transition-none');
    fireEvent.mouseLeave(root());
    act(() => { vi.advanceTimersByTime(250); });
    expect(labelsShown()).toBe(false);
    expect(root().className.split(/\s+/)).toEqual(expect.arrayContaining(['desk:w-12', 'transition-none']));
    // Unfolding with » keeps its transition.
    act(() => { useUIStore.setState({ sidebarCollapsed: false } as never); });
    expect(root().className).not.toContain('transition-none');
  });

  it('keeps each icon where it was and puts the name and count after it', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    const inbox = () => document.querySelector<HTMLElement>('[data-rail-key="inbox"] > button')!;
    expect(inbox().className).toContain('justify-center');
    expect(inbox().querySelector('[data-testid="rail-label"]')).toBeNull();
    expect(inbox().getAttribute('title')).toBe('name_unread_sub');
    rest(20, 120);
    // Centred in the folded square before; now padded by the same amount:
    // (min(folded width, 40px) - 16px) / 2, the folded width being this
    // column's less the 13rem it grew by.
    expect(inbox().className).toContain('ps-[calc((min(100%-13rem,2.5rem)-1rem)/2)]');
    expect(inbox().className).not.toContain('justify-center');
    expect(inbox().querySelector('[data-testid="rail-label"]')?.textContent).toBe('mailboxes.inbox');
    expect(inbox().querySelector('[data-testid="folder-counts"]')).not.toBeNull();
    // The name is on screen now: no tooltip repeating it, and no corner counter.
    expect(inbox().getAttribute('title')).toBeNull();
    expect(inbox().querySelector('[data-testid="folded-unread"]')).toBeNull();
    // The buttons above and below keep the folded column's width.
    const head = screen.getByTestId('sidebar-collapse').parentElement!;
    expect(head.className).toContain('w-[calc(100%-13rem)]');
    expect(screen.getByTestId('folded-all-folders').parentElement!.className).toContain('w-[calc(100%-13rem)]');
  });

  it('waits before showing the names, and folds them a moment after the pointer leaves', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    fireEvent.mouseEnter(root(), { clientX: 20, clientY: 120 });
    act(() => { vi.advanceTimersByTime(200); });
    expect(labelsShown()).toBe(false);
    act(() => { vi.advanceTimersByTime(200); });
    expect(labelsShown()).toBe(true);
    // Off and straight back: they stay.
    fireEvent.mouseLeave(root());
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.mouseEnter(root(), { clientX: 20, clientY: 120 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(labelsShown()).toBe(true);
    fireEvent.mouseLeave(root());
    expect(labelsShown()).toBe(true);
    act(() => { vi.advanceTimersByTime(250); });
    expect(labelsShown()).toBe(false);
  });

  it('stays after a pick, with the pointer still on it', () => {
    const { rerender } = render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    rest(20, 120);
    rerender(<Sidebar mailboxes={mailboxes} selectedMailbox="news" />);
    expect(labelsShown()).toBe(true);
  });

  it('shows the names to the keyboard as well, and Escape hides them with the focus left where it is', () => {
    render(<><button type="button">before</button><Sidebar mailboxes={mailboxes} selectedMailbox="inbox" /><button type="button">after</button></>);
    const inbox = document.querySelector<HTMLElement>('[data-rail-key="inbox"] > button')!;
    // A click's focus isn't the keyboard's.
    inbox.matches = ((sel: string) => sel === ':focus-visible' ? false : Element.prototype.matches.call(inbox, sel)) as typeof inbox.matches;
    act(() => { inbox.focus(); });
    expect(labelsShown()).toBe(false);
    act(() => { inbox.blur(); });
    inbox.matches = ((sel: string) => sel === ':focus-visible' ? true : Element.prototype.matches.call(inbox, sel)) as typeof inbox.matches;
    act(() => { inbox.focus(); });
    expect(labelsShown()).toBe(true);
    fireEvent.keyDown(inbox, { key: 'Escape' });
    expect(labelsShown()).toBe(false);
    expect(document.activeElement).toBe(inbox);
    // Out of the column and back in: they show again.
    act(() => { screen.getByText('after').focus(); });
    act(() => { inbox.focus(); });
    expect(labelsShown()).toBe(true);
    act(() => { screen.getByText('after').focus(); });
    expect(labelsShown()).toBe(false);
  });

  it('leaves the whole tree to All folders', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    rest(20, 120);
    fireEvent.click(screen.getByTestId('folded-all-folders'));
    expect(drawer()).not.toBeNull();
    expect(labelsShown()).toBe(false);
    expect(document.querySelector('[data-mailbox-id="clients"]')).not.toBeNull();
  });

  it('doesn\'t show them with hover opening off, nor under Mountain View, which keeps its peek', () => {
    useSettingsStore.setState({ openOnHover: false } as never);
    const { unmount } = render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    rest(20, 120);
    expect(labelsShown()).toBe(false);
    unmount();
    useSettingsStore.setState({ openOnHover: true, interfaceLayout: 'mountain-view' } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" mvShell />);
    rest(20, 120);
    expect(document.querySelector('[data-folder-rail-labels]')).toBeNull();
    expect(document.querySelector('[data-mv-rail-peek]')).not.toBeNull();
  });
});
