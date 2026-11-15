import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// In the macOS app the traffic lights sit over the folder sidebar's top row,
// where « shared the row with the account switcher, which cut the address
// off; folded, » and the green light were squeezed into the 48px column. The
// switcher has the top row to itself now, and the collapse button is at the
// column's bottom start, in both states.

const embedded = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/use-is-embedded', () => ({ useIsEmbedded: () => embedded.value }));
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

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, totalEmails: 9, unreadEmails: 4, sortOrder: 0, myRights: { mayAddItems: true } },
  { id: 'trash', name: 'Trash', role: 'trash', parentId: null, totalEmails: 0, unreadEmails: 0, sortOrder: 1, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

const realMatchMedia = window.matchMedia;
function narrowWindow(narrow: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: narrow && query === '(width < 37.5rem)',
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const head = () => document.querySelector<HTMLElement>('[data-sidebar-head]');
const foot = () => document.querySelector<HTMLElement>('[data-sidebar-foot]');
const collapse = () => screen.queryByTestId('sidebar-collapse');
const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('the folder sidebar\'s collapse button (default layout)', () => {
  beforeEach(() => {
    localStorage.clear();
    embedded.value = false;
    useAuthStore.setState({ activeAccountId: 'login-a', client: { getAccountId: () => 'me', getCapabilities: () => ({}) } } as never);
    useSettingsStore.setState({
      interfaceLayout: 'default', enableUnifiedMailbox: false, sidebarAccountSwitcher: true, openOnHover: true,
    } as never);
    useUIStore.setState({ sidebarCollapsed: false, compactSidebarExpanded: false } as never);
    narrowWindow(false);
  });
  afterEach(() => {
    cleanup();
    window.matchMedia = realMatchMedia;
    useUIStore.setState({ sidebarCollapsed: false } as never);
  });

  it('is at the bottom, after the folders, and leaves the header row to the account switcher', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onCompose={vi.fn()} />);
    const button = collapse()!;
    expect(head()!.contains(button)).toBe(false);
    expect(foot()!.contains(button)).toBe(true);
    expect(foot()!.className.split(/\s+/)).toEqual(expect.arrayContaining(['border-t', 'border-border', 'px-2', 'py-2']));
    expect(follows(document.querySelector('[data-folder-nav]')!, button)).toBe(true);
    // The header row: the phone's X, which a desktop hides, and the switcher.
    const row = screen.getByTestId('account-switcher-stub').parentElement!;
    expect(row.className).toContain('h-14');
    const desktopControls = Array.from(row.children).filter((el) => !el.className.split(/\s+/).includes('desk:hidden'));
    expect(desktopControls).toEqual([screen.getByTestId('account-switcher-stub')]);
    expect(button.getAttribute('title')).toBe('collapse_tooltip');
  });

  it('collapses the sidebar from there', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    fireEvent.click(collapse()!);
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
  });

  it('is the last item of the folded column, under All folders, and expands it', () => {
    useUIStore.setState({ sidebarCollapsed: true } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onCompose={vi.fn()} />);
    const button = collapse()!;
    expect(follows(screen.getByTestId('folded-all-folders'), button)).toBe(true);
    expect(foot()!.contains(button)).toBe(true);
    expect(button.getAttribute('title')).toBe('expand_tooltip');
    // Only the compose icon up top, with no row left over from the button.
    expect(head()!.contains(button)).toBe(false);
    expect(head()!.querySelector('.h-14')).toBeNull();
    expect(head()!.querySelectorAll('button')).toHaveLength(1);
    expect(head()!.querySelector('[data-sidebar-compose]')).not.toBeNull();
    fireEvent.click(button);
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it('has no header at all when folded without Compose', () => {
    useUIStore.setState({ sidebarCollapsed: true } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    expect(head()).toBeNull();
    expect(collapse()).not.toBeNull();
  });

  it('keeps the X and the switcher on a phone, with no collapse button', () => {
    narrowWindow(true);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    expect(head()!.querySelector('[aria-label="close"]')).not.toBeNull();
    expect(head()!.contains(screen.getByTestId('account-switcher-stub'))).toBe(true);
    // Rendered for the desktop widths only.
    expect(collapse()!.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'desk:flex']));
    expect(foot()!.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'desk:flex']));
  });

  it('marks the sidebar for the macOS band, but not the drawer from All folders', () => {
    useUIStore.setState({ sidebarCollapsed: true } as never);
    const { container } = render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    const root = container.firstElementChild!;
    expect(root.hasAttribute('data-window-sidebar')).toBe(true);
    fireEvent.click(screen.getByTestId('folded-all-folders'));
    expect(root.hasAttribute('data-window-sidebar')).toBe(false);
    expect(root.hasAttribute('data-window-drawer')).toBe(true);
  });

  it('leaves Mountain View alone', () => {
    useSettingsStore.setState({ interfaceLayout: 'mountain-view' } as never);
    const { container } = render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" mvShell onCompose={vi.fn()} />);
    expect(collapse()).toBeNull();
    expect(head()).toBeNull();
    expect(foot()).toBeNull();
    expect(container.firstElementChild!.hasAttribute('data-window-sidebar')).toBe(false);
  });

  it.each([false, true])('leaves Pro\'s embedded sidebar alone (collapsed: %s)', (collapsed) => {
    embedded.value = true;
    useUIStore.setState({ sidebarCollapsed: collapsed } as never);
    const { container } = render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" multiAccountMode />);
    expect(collapse()).toBeNull();
    expect(head()).toBeNull();
    expect(container.firstElementChild!.hasAttribute('data-window-sidebar')).toBe(false);
    if (collapsed) expect(screen.getByTestId('folded-all-folders')).toBeInTheDocument();
  });
});
