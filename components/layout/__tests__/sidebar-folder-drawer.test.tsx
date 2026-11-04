import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// The folded folder column (600 to 1024 px, or folded by hand) floated its
// tree out beside the app rail, with nothing dimming the list it covered: the
// rail showed at its side, the list was cut off at its edge, and the collapse
// button in it lit up blue under the pointer that opened it. It is a drawer
// now, as in Outlook and Thunderbird: from the window's edge, over the rail,
// the page dimmed by the caller (mail-app), the focus kept inside.

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
];

const drawer = () => document.querySelector<HTMLElement>('[data-folder-drawer]');
const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
const openFromAllFolders = () => fireEvent.click(screen.getByTestId('folded-all-folders'));

describe('the folded column\'s drawer (default layout)', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({ activeAccountId: 'login-a', client: { getAccountId: () => 'me', getCapabilities: () => ({}) } } as never);
    useSettingsStore.setState({ hideAccountSwitcher: true, interfaceLayout: 'default', openOnHover: true, unreadCountStyle: 'count' } as never);
    useUIStore.setState({ sidebarCollapsed: true, compactSidebarExpanded: false } as never);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useUIStore.setState({ sidebarCollapsed: false } as never);
  });

  it('opens at the window\'s start edge, from under the top bar to the bottom, over the app rail', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    openFromAllFolders();
    const classes = drawer()!.className.split(/\s+/);
    // Fixed to the window, not placed in the folded column beside the rail.
    expect(classes).toEqual(expect.arrayContaining(['fixed', 'start-0', 'bottom-0', 'top-[var(--drawer-top)]', 'z-50']));
    expect(classes).not.toContain('desk:absolute');
    expect(classes).not.toContain('h-full');
    // Where the window's controls are over the page, app/globals.css places it by this.
    expect(drawer()).toHaveAttribute('data-window-drawer');
  });

  it('asks the caller to dim the page while it is open, and closes from there', () => {
    const onDrawerChange = vi.fn();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onDrawerChange={onDrawerChange} />);
    expect(onDrawerChange).not.toHaveBeenCalled();
    openFromAllFolders();
    const close = onDrawerChange.mock.calls.at(-1)![0];
    expect(typeof close).toBe('function');
    act(() => close());
    expect(drawer()).toBeNull();
    expect(onDrawerChange).toHaveBeenLastCalledWith(null);
  });

  it('closes on the collapse button, without docking the folders', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    openFromAllFolders();
    fireEvent.click(screen.getByTestId('sidebar-collapse'));
    expect(drawer()).toBeNull();
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    expect(useUIStore.getState().compactSidebarExpanded).toBe(false);
  });

  it('draws the collapse button with the sidebar\'s grey hover, in the drawer and docked alike', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    openFromAllFolders();
    const inDrawer = screen.getByTestId('sidebar-collapse').className;
    cleanup();
    useUIStore.setState({ sidebarCollapsed: false } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    const docked = screen.getByTestId('sidebar-collapse').className;
    for (const classes of [inDrawer, docked]) {
      expect(classes).toContain('hover:bg-muted');
      expect(classes).not.toContain('hover:bg-accent');
    }
    expect(inDrawer).toBe(docked);
  });

  // RTL: globals.css mirrors the chevrons icons; a flip of their own as well would turn them back.
  it('leaves the collapse arrows to the global RTL mirror, where the drawer comes from the right', () => {
    const arrow = () => screen.getByTestId('sidebar-collapse').querySelector('svg')!.getAttribute('class') ?? '';
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    expect(arrow()).toMatch(/tabler-icon-chevrons-(left|right)/);
    expect(arrow()).not.toMatch(/rtl:/);
    openFromAllFolders();
    expect(arrow()).toMatch(/tabler-icon-chevrons-(left|right)/);
    expect(arrow()).not.toMatch(/rtl:/);
  });

  it('keeps Tab and Shift+Tab inside while open', () => {
    render(<><Sidebar mailboxes={mailboxes} selectedMailbox="inbox" /><button type="button">after</button></>);
    openFromAllFolders();
    const root = drawer()!;
    const focusable = Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled)'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('gives the focus back to All folders when the scrim closes it', async () => {
    const onDrawerChange = vi.fn();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onDrawerChange={onDrawerChange} />);
    openFromAllFolders();
    expect(drawer()!.contains(document.activeElement)).toBe(true);
    // A press on the scrim drops the focus to the page; its click closes.
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => onDrawerChange.mock.calls.at(-1)![0]());
    await nextFrame();
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('folded-all-folders'));
  });

  it('stays open on the press on the scrim, so its click doesn\'t reach the message under it', () => {
    render(<><Sidebar mailboxes={mailboxes} selectedMailbox="inbox" /><div data-drawer-scrim="" data-testid="scrim" /></>);
    openFromAllFolders();
    fireEvent.pointerDown(screen.getByTestId('scrim'));
    expect(drawer()).not.toBeNull();
  });

  it('gives the focus back to All folders after a pick', async () => {
    const { rerender } = render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    openFromAllFolders();
    rerender(<Sidebar mailboxes={mailboxes} selectedMailbox="news" />);
    await nextFrame();
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('folded-all-folders'));
  });

  it('does not float out while the pointer is on the header\'s buttons', () => {
    vi.useFakeTimers();
    const { container } = render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    const root = container.firstElementChild!;
    fireEvent.mouseEnter(root);
    fireEvent.mouseMove(screen.getByTestId('sidebar-collapse'));
    act(() => { vi.advanceTimersByTime(400); });
    expect(drawer()).toBeNull();
    // On the folders it does.
    fireEvent.mouseMove(document.querySelector('[data-mailbox-id="inbox"]')!);
    act(() => { vi.advanceTimersByTime(400); });
    expect(drawer()).not.toBeNull();
  });

  it('keeps Mountain View\'s peek beside its rail', () => {
    vi.useFakeTimers();
    useSettingsStore.setState({ interfaceLayout: 'mountain-view' } as never);
    const onDrawerChange = vi.fn();
    const { container } = render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" mvShell onDrawerChange={onDrawerChange} />);
    fireEvent.mouseEnter(container.firstElementChild!);
    const peek = document.querySelector<HTMLElement>('[data-mv-rail-peek]')!;
    expect(peek.className).toContain('desk:absolute');
    expect(drawer()).toBeNull();
    expect(onDrawerChange).not.toHaveBeenCalled();
  });
});
