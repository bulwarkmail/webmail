import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// A folder's menu opened from the folded folder column (600 to 1024 px) or
// the tree floated out of it. The pointer crossing the page on its way into
// the menu or into Rules › folded the tree away, and the scroll that put the
// column back closed the menu; from All folders, the focus moving into the
// menu closed the drawer; a hover that floated the tree out under a menu
// opened on the column closed the menu too.
// A hover now shows the names beside the folded items instead of floating
// the tree out (sidebar-folded-rail-hover.test.tsx); the menu holds them
// the same way.

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
// Rules › as a real submenu, without the Sieve client behind it.
vi.mock('@/components/email/rules-menu', async () => {
  const { ContextMenuSubMenu } = await import('@/components/ui/context-menu');
  return {
    FolderRulesSubMenu: () => (
      <ContextMenuSubMenu label="rules" testId="mailbox-rules">
        <button type="button" role="menuitem" data-testid="rule-one">rule one</button>
      </ContextMenuSubMenu>
    ),
  };
});

const { Sidebar } = await import('../sidebar');
const { useAuthStore } = await import('@/stores/auth-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { useUIStore } = await import('@/stores/ui-store');

const box = (id: string, name: string, role: string | null, extra: Partial<Mailbox> = {}) => ({
  id, name, role, parentId: null, totalEmails: 4, unreadEmails: 0,
  myRights: { mayAddItems: true, mayRename: true, mayDelete: true, mayCreateChild: true }, ...extra,
}) as unknown as Mailbox;

const mailboxes = [
  box('inbox', 'Inbox', 'inbox'),
  box('travel', 'Travel', null),
  box('news', 'Newsletters', null),
];

const root = () => document.querySelector<HTMLElement>('[data-folder-nav]')!.parentElement!;
const nav = () => document.querySelector<HTMLElement>('[data-folder-nav]')!;
const drawer = () => document.querySelector<HTMLElement>('[data-folder-drawer]');
const labels = () => root().hasAttribute('data-folder-rail-labels');
const item = (key: string) => document.querySelector<HTMLElement>(`[data-rail-key="${key}"] > button`)!;
const menu = () => document.querySelector<HTMLElement>('body > [role="menu"]');
const submenu = () => document.querySelector<HTMLElement>('[data-submenu-panel]');
const key = (k: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key: k });
const pointerAt = (x: number, y: number) =>
  act(() => { document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y })); });

/** A right-click: the press focuses the folder's button, then the menu opens at the pointer. */
const rightClick = (el: HTMLElement, x: number, y: number) => {
  el.focus();
  fireEvent.contextMenu(el, { clientX: x, clientY: y });
};

// jsdom keeps no scroll offset and sends no scroll event; a browser does both,
// and the menu closes on a scroll outside it.
let scrollTop = 0;
const trackScroll = () => Object.defineProperty(nav(), 'scrollTop', {
  configurable: true,
  get: () => scrollTop,
  set: (v: number) => {
    if (v === scrollTop) return;
    scrollTop = v;
    nav().dispatchEvent(new Event('scroll'));
  },
});

/** Keys down the menu to Rules ›. */
const downToRules = () => {
  for (let i = 0; i < 20 && document.activeElement?.getAttribute('data-testid') !== 'mailbox-rules'; i++) key('ArrowDown');
  expect(document.activeElement?.getAttribute('data-testid')).toBe('mailbox-rules');
};

describe('a folder menu from the folded column', () => {
  beforeEach(() => {
    localStorage.clear();
    scrollTop = 0;
    useAuthStore.setState({ activeAccountId: 'login-a', client: { getAccountId: () => 'me', getCapabilities: () => ({}) } } as never);
    useSettingsStore.setState({
      hideAccountSwitcher: true, interfaceLayout: 'default', openOnHover: true, unreadCountStyle: 'count',
    } as never);
    useUIStore.setState({ sidebarCollapsed: true, compactSidebarExpanded: false } as never);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    useUIStore.setState({ sidebarCollapsed: false } as never);
  });

  it('keeps the names a hover showed and the menu open while the pointer crosses the page into the menu and Rules', () => {
    vi.useFakeTimers();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    trackScroll();
    scrollTop = 120;
    fireEvent.mouseEnter(root(), { clientX: 20, clientY: 80 });
    act(() => { vi.advanceTimersByTime(400); });
    expect(labels()).toBe(true);

    rightClick(item('travel'), 60, 80);
    act(() => { vi.advanceTimersByTime(10); });
    expect(menu()).not.toBeNull();

    // Out of the column, over the page, into the menu.
    fireEvent.mouseLeave(root());
    pointerAt(500, 300);
    act(() => { vi.advanceTimersByTime(400); });
    expect(labels()).toBe(true);
    expect(menu()).not.toBeNull();

    // Rules › opens on hover; into its panel, across the gap beside it.
    fireEvent.mouseEnter(screen.getByTestId('mailbox-rules').parentElement!);
    act(() => { vi.advanceTimersByTime(400); });
    expect(submenu()).not.toBeNull();
    pointerAt(520, 320);
    act(() => { vi.advanceTimersByTime(400); });
    expect(menu()).not.toBeNull();
    expect(submenu()).not.toBeNull();
    expect(labels()).toBe(true);
    expect(scrollTop).toBe(120);
  });

  it('closes on Escape, gives the focus back to the folder, and folds the names the pointer has left', () => {
    vi.useFakeTimers();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    fireEvent.mouseEnter(root(), { clientX: 20, clientY: 80 });
    act(() => { vi.advanceTimersByTime(400); });
    const travel = item('travel');
    rightClick(travel, 60, 80);
    act(() => { vi.advanceTimersByTime(10); });
    fireEvent.mouseLeave(root());
    pointerAt(500, 300);
    expect(menu()!.contains(document.activeElement)).toBe(true);
    expect(labels()).toBe(true);

    key('Escape');
    act(() => { vi.advanceTimersByTime(10); });
    expect(menu()).toBeNull();
    expect(labels()).toBe(false);
    // The same item: the names come and go around the items, which stay.
    expect(item('travel')).toBe(travel);
    expect(document.activeElement).toBe(travel);
  });

  it('keeps the names after the menu closes when the pointer is back on the column', () => {
    vi.useFakeTimers();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    fireEvent.mouseEnter(root(), { clientX: 20, clientY: 80 });
    act(() => { vi.advanceTimersByTime(400); });
    rightClick(item('travel'), 60, 80);
    act(() => { vi.advanceTimersByTime(10); });
    const rect = { left: 0, top: 0, right: 256, bottom: 700, width: 256, height: 700, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    vi.spyOn(root(), 'getBoundingClientRect').mockReturnValue(rect);
    fireEvent.mouseLeave(root());
    pointerAt(500, 300);
    // Back over the column.
    fireEvent.mouseEnter(root(), { clientX: 100, clientY: 120 });
    pointerAt(100, 120);
    act(() => { vi.advanceTimersByTime(400); });
    expect(labels()).toBe(true);
    key('Escape');
    act(() => { vi.advanceTimersByTime(10); });
    expect(menu()).toBeNull();
    expect(labels()).toBe(true);
    expect(document.activeElement).toBe(item('travel'));
  });

  it('keeps the drawer All folders opened and its menu open when Right arrow goes into Rules', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    fireEvent.click(screen.getByTestId('folded-all-folders'));
    expect(drawer()).not.toBeNull();
    const travel = item('travel');
    travel.focus();
    // Shift+F10: a contextmenu event without a point.
    fireEvent.contextMenu(travel, { clientX: 0, clientY: 0 });
    expect(menu()!.contains(document.activeElement)).toBe(true);
    expect(drawer()).not.toBeNull();

    downToRules();
    key('ArrowRight');
    expect(submenu()).not.toBeNull();
    expect(submenu()!.contains(document.activeElement)).toBe(true);
    expect(menu()).not.toBeNull();
    expect(drawer()).not.toBeNull();

    // Escape closes Rules, then the menu; the focus is back on the folder.
    key('Escape');
    expect(submenu()).toBeNull();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('mailbox-rules');
    key('Escape');
    expect(menu()).toBeNull();
    expect(drawer()).not.toBeNull();
    expect(document.activeElement).toBe(item('travel'));
  });

  it('keeps the drawer when a press goes into the menu', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    fireEvent.click(screen.getByTestId('folded-all-folders'));
    rightClick(item('travel'), 60, 80);
    fireEvent.pointerDown(screen.getByTestId('mailbox-rules'));
    fireEvent.click(screen.getByTestId('mailbox-rules'));
    expect(drawer()).not.toBeNull();
    expect(submenu()).not.toBeNull();
  });

  it('does not float the tree out under a menu opened on the column', () => {
    vi.useFakeTimers();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    trackScroll();
    scrollTop = 120;
    // The hover's delay is still running when the right-click comes.
    fireEvent.mouseEnter(root(), { clientX: 20, clientY: 80 });
    rightClick(item('travel'), 24, 80);
    act(() => { vi.advanceTimersByTime(10); });
    expect(menu()).not.toBeNull();
    fireEvent.mouseMove(root(), { clientX: 22, clientY: 82 });
    act(() => { vi.advanceTimersByTime(800); });
    expect(drawer()).toBeNull();
    expect(labels()).toBe(false);
    expect(menu()).not.toBeNull();

    downToRules();
    key('ArrowRight');
    act(() => { vi.advanceTimersByTime(400); });
    expect(menu()).not.toBeNull();
    expect(submenu()!.contains(document.activeElement)).toBe(true);
    expect(scrollTop).toBe(120);
  });
});
