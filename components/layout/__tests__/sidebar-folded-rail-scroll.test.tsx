import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// The folded folder column (600 to 1024 px) of a mailbox with many folders,
// scrolled: shared accounts left only their headings' rules behind, stacked
// into a ladder of lines; the unread counter sat on the icon; one folder of
// one's own was a letter in a box; and the drawer a hover opened kept the
// column's scroll offset, so the hovered folder was somewhere else.

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

const shared = (id: string, name: string, role: string | null, extra: Partial<Mailbox> = {}) =>
  box(`g1:${id}`, name, role, { originalId: id, accountId: 'g1', accountName: 'Sam Ortega', isShared: true, ...extra });

const own = [
  box('inbox', 'Inbox', 'inbox', { totalEmails: 120, unreadEmails: 9 }),
  box('clients', 'Clients', null, { parentId: 'inbox', unreadEmails: 132 }),
  box('trash', 'Trash', 'trash', { unreadEmails: 3 }),
  box('news', 'Newsletters', null, { unreadEmails: 150 }),
];
// A shared account without an inbox: two folders someone shared.
const sharedNoInbox = [shared('team', 'Team', null, { unreadEmails: 2 }), shared('board', 'Board', null, { unreadEmails: 1 })];

const nav = () => document.querySelector<HTMLElement>('[data-folder-nav]')!;
const drawer = () => document.querySelector<HTMLElement>('[data-folder-drawer]');
const row = (key: string) => document.querySelector<HTMLElement>(`[data-rail-key="${key}"]`)!;
const railButtons = () => Array.from(nav().querySelectorAll<HTMLElement>('[data-testid="folder-row"] > button'));

describe('the folded folder column with many folders', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({ activeAccountId: 'login-a', client: { getAccountId: () => 'me', getCapabilities: () => ({}) } } as never);
    useSettingsStore.setState({
      hideAccountSwitcher: true, interfaceLayout: 'default', openOnHover: true, unreadCountStyle: 'count',
      showSharedMailAccounts: true, hiddenSharedMailAccounts: {}, compactSharedMailboxes: false,
    } as never);
    useUIStore.setState({ sidebarCollapsed: true, compactSidebarExpanded: false } as never);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    useUIStore.setState({ sidebarCollapsed: false } as never);
  });

  it('draws one rule between sections, never two in a row', () => {
    render(<Sidebar mailboxes={[...own, ...sharedNoInbox]} selectedMailbox="inbox" />);
    // Folders, Your folders, Shared (with its account inside), Tags.
    const rules = nav().querySelectorAll('[data-rail-separator]');
    expect(rules).toHaveLength(2 + 1);
    // Walk the column in order: something to click between any two rules.
    const order = Array.from(nav().querySelectorAll('[data-rail-separator], [data-testid="folder-row"]'));
    order.forEach((el, i) => {
      if (i === 0) return;
      const both = el.hasAttribute('data-rail-separator') && order[i - 1].hasAttribute('data-rail-separator');
      expect(both, `two rules in a row at ${i}`).toBe(false);
    });
  });

  it('lists a shared account as one item, which opens the drawer with it unfolded when it has no inbox', () => {
    render(<Sidebar mailboxes={[...own, ...sharedNoInbox]} selectedMailbox="inbox" />);
    const item = row('shared-account-g1');
    expect(item.getAttribute('data-testid')).toBe('folder-row');
    const button = item.querySelector('button')!;
    expect(button.getAttribute('title')).toBe('name_unread');
    expect(item.querySelector('[data-testid="folded-unread"]')?.textContent).toBe('3');
    fireEvent.click(button);
    expect(drawer()).not.toBeNull();
    expect(screen.getByText('Team')).toBeTruthy();
  });

  it('opens a shared account\'s inbox from its item, and marks it while one of its folders is open', () => {
    const onMailboxSelect = vi.fn();
    const mailboxes = [...own, shared('in', 'Inbox', 'inbox', { unreadEmails: 4 }), ...sharedNoInbox];
    const { rerender } = render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onMailboxSelect={onMailboxSelect} />);
    fireEvent.click(row('shared-account-g1').querySelector('button')!);
    expect(onMailboxSelect).toHaveBeenCalledWith('g1:in');
    rerender(<Sidebar mailboxes={mailboxes} selectedMailbox="g1:team" onMailboxSelect={onMailboxSelect} />);
    expect(row('shared-account-g1').querySelector('[data-testid="folded-selected"]')).not.toBeNull();
  });

  it('puts the counter at the icon\'s corner, beside the glyph, and says 99+ for more', () => {
    render(<Sidebar mailboxes={own} selectedMailbox="inbox" />);
    const badge = row('trash').querySelector<HTMLElement>('[data-testid="folded-unread"]')!;
    expect(badge.textContent).toBe('3');
    // On the 36px item, above the 16px icon's box, not inside it over the glyph.
    expect(badge.parentElement!.tagName).toBe('BUTTON');
    expect(badge.parentElement!.className).toContain('h-9');
    expect(badge.className.split(/\s+/)).toEqual(expect.arrayContaining(['absolute', 'top-0', 'end-0', 'h-3']));
    expect(badge.className).not.toContain('ring-2');
    expect(row('news').querySelector('[data-testid="folded-unread"]')!.textContent).toBe('99+');
  });

  it('gives every item a tooltip with its name and count', () => {
    render(<Sidebar mailboxes={[...own, ...sharedNoInbox]} selectedMailbox="inbox" />);
    for (const button of railButtons()) {
      const title = button.getAttribute('title');
      expect(title, button.outerHTML.slice(0, 120)).toBeTruthy();
      expect(title).toBe(button.getAttribute('aria-label'));
    }
    // With unread mail the name carries the count.
    expect(row('inbox').querySelector('button')!.getAttribute('title')).toBe('name_unread');
  });

  it('draws one folder of one\'s own as a plain folder, several with their first letter inside the folder', () => {
    render(<Sidebar mailboxes={own} selectedMailbox="inbox" />);
    expect(row('news').querySelector('[data-testid="folder-initial"]')).toBeNull();
    expect(row('news').querySelector('svg')).not.toBeNull();
    cleanup();
    render(<Sidebar mailboxes={[...own, box('receipts', 'receipts', null)]} selectedMailbox="inbox" />);
    const letter = row('receipts').querySelector('[data-testid="folder-initial"]')!;
    expect(letter.textContent).toBe('R');
    // Inside the folder glyph, an icon like the others, not a box of its own.
    expect(letter.closest('svg')?.querySelector('path')).not.toBeNull();
    expect(letter.closest('svg')!.getAttribute('class')).toContain('w-4');
  });

  it('marks the open folder with a bar at the edge and a filled item', () => {
    render(<Sidebar mailboxes={own} selectedMailbox="trash" />);
    // Over the filled item, not under it.
    expect(row('trash').querySelector('[data-testid="folded-selected"]')!.className).toContain('z-10');
    expect(row('trash').querySelector('button')!.className).toContain('bg-accent');
    expect(row('inbox').querySelector('[data-testid="folded-selected"]')).toBeNull();
    expect(row('inbox').querySelector('button')!.className).not.toContain('bg-accent');
  });

  it('scrolls on its own, never sideways, with a thin scrollbar', () => {
    render(<Sidebar mailboxes={own} selectedMailbox="inbox" />);
    expect(nav().hasAttribute('data-folder-rail')).toBe(true);
    expect(nav().className.split(/\s+/)).toEqual(expect.arrayContaining(['overflow-y-auto', 'overflow-x-hidden', 'min-h-0']));
  });

  it('moves through the items with the arrows, Home and End', () => {
    render(<Sidebar mailboxes={[...own, ...sharedNoInbox]} selectedMailbox="inbox" />);
    const buttons = railButtons().filter((b) => !(b as HTMLButtonElement).disabled);
    buttons[0].focus();
    fireEvent.keyDown(buttons[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(buttons[1], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0], { key: 'End' });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    fireEvent.keyDown(buttons[buttons.length - 1], { key: 'Home' });
    expect(document.activeElement).toBe(buttons[0]);
  });

  describe('the drawer opened from the scrolled column', () => {
    // jsdom has no layout: the list's items sit at fixed places in the
    // content, further down in the longer tree of the drawer.
    let scrollTop = 0;
    const NAV_TOP = 100;
    const place = (el: Element) => {
      const key = (el as HTMLElement).dataset?.railKey;
      if (key !== 'news') return null;
      return drawer() ? 900 : 500;
    };
    beforeEach(() => {
      scrollTop = 0;
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        // The list shows 600px; anything else is somewhere inside it.
        const isNav = this.hasAttribute('data-folder-nav');
        const at = place(this);
        const top = isNav ? NAV_TOP : at === null ? NAV_TOP + 10 : NAV_TOP + at - scrollTop;
        const height = isNav ? 600 : 36;
        return { top, bottom: top + height, left: 0, right: 48, width: 48, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
      });
    });
    const trackScroll = () => Object.defineProperty(nav(), 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => { scrollTop = v; },
    });

    it('puts the hovered item back under the pointer, and the column back where it was', () => {
      vi.useFakeTimers();
      const { container } = render(<Sidebar mailboxes={own} selectedMailbox="inbox" />);
      trackScroll();
      scrollTop = 200;
      const news = row('news');
      document.elementFromPoint = vi.fn(() => news.querySelector('button'));
      // At 400 on screen in the column: 100 + 500 - 200.
      fireEvent.mouseEnter(container.firstElementChild!, { clientX: 20, clientY: 410 });
      act(() => { vi.advanceTimersByTime(400); });
      expect(drawer()).not.toBeNull();
      // In the drawer it is 900 down the list: scrolled so it is at 400 again.
      expect(scrollTop).toBe(600);
      fireEvent.mouseLeave(container.firstElementChild!);
      expect(drawer()).toBeNull();
      expect(scrollTop).toBe(200);
    });

    it('starts at the top when All folders opens it', () => {
      render(<Sidebar mailboxes={own} selectedMailbox="inbox" />);
      trackScroll();
      scrollTop = 200;
      fireEvent.click(screen.getByTestId('folded-all-folders'));
      expect(drawer()).not.toBeNull();
      expect(scrollTop).toBe(0);
    });
  });
});
