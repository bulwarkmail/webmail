import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// The folder sidebar's header holds the account switcher. Compose floats over
// the message list by default; with composePlacement 'sidebar' it sits under
// the switcher on a desktop, or in its place with sidebarAccountSwitcher off
// (usability test 2026-11-04: the switcher was a second one beside the rail's
// avatar, mail-27).

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

const { Sidebar } = await import('../sidebar');
const { useSettingsStore } = await import('@/stores/settings-store');
const { useUIStore } = await import('@/stores/ui-store');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, totalEmails: 9, unreadEmails: 4, sortOrder: 0, myRights: { mayAddItems: true } },
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

describe('folder sidebar header, by default', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      interfaceLayout: 'default',
      enableUnifiedMailbox: false,
      sidebarAccountSwitcher: useSettingsStore.getInitialState().sidebarAccountSwitcher,
      composePlacement: useSettingsStore.getInitialState().composePlacement,
    } as never);
    useUIStore.setState({ sidebarCollapsed: false } as never);
    narrowWindow(false);
  });
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it('has the account switcher and leaves Compose to the button over the list', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onCompose={vi.fn()} />);
    expect(screen.getByTestId('account-switcher')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'compose' })).toBeNull();
  });

  it('has no Compose icon when the sidebar is collapsed', () => {
    useUIStore.setState({ sidebarCollapsed: true } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onCompose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'compose' })).toBeNull();
  });

  it('has no Compose either with Compose set to the app rail', () => {
    useSettingsStore.setState({ composePlacement: 'rail' } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onCompose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'compose' })).toBeNull();
  });
});

describe('folder sidebar header, with Compose set to the sidebar', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      interfaceLayout: 'default',
      enableUnifiedMailbox: false,
      sidebarAccountSwitcher: true,
      composePlacement: 'sidebar',
    } as never);
    useUIStore.setState({ sidebarCollapsed: false } as never);
    narrowWindow(false);
  });
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it('starts with the account switcher and Compose under it', () => {
    const onCompose = vi.fn();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onCompose={onCompose} />);
    const switcher = screen.getByTestId('account-switcher');
    const compose = screen.getByRole('button', { name: 'compose' });
    expect(switcher.compareDocumentPosition(compose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(compose);
    expect(onCompose).toHaveBeenCalledTimes(1);
  });

  it('keeps Compose as an icon when the sidebar is collapsed', () => {
    useUIStore.setState({ sidebarCollapsed: true } as never);
    const onCompose = vi.fn();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onCompose={onCompose} />);
    fireEvent.click(screen.getByRole('button', { name: 'compose' }));
    expect(onCompose).toHaveBeenCalledTimes(1);
  });

  it('leaves Compose to the round button where the sidebar is a drawer', () => {
    narrowWindow(true);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onCompose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'compose' })).toBeNull();
  });
});

describe('folder sidebar header, with Compose set to the sidebar and the switcher off', () => {
  beforeEach(() => {
    useSettingsStore.setState({ interfaceLayout: 'default', enableUnifiedMailbox: false, sidebarAccountSwitcher: false, composePlacement: 'sidebar' } as never);
    useUIStore.setState({ sidebarCollapsed: false } as never);
    narrowWindow(false);
  });
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it('starts with Compose on a desktop', () => {
    const onCompose = vi.fn();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onCompose={onCompose} />);
    fireEvent.click(screen.getByRole('button', { name: 'compose' }));
    expect(onCompose).toHaveBeenCalledTimes(1);
  });

  it('keeps Compose as an icon when the sidebar is collapsed', () => {
    useUIStore.setState({ sidebarCollapsed: true } as never);
    const onCompose = vi.fn();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onCompose={onCompose} />);
    fireEvent.click(screen.getByRole('button', { name: 'compose' }));
    expect(onCompose).toHaveBeenCalledTimes(1);
  });

  it('has no account switcher of its own: the rail has the one', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onCompose={vi.fn()} />);
    expect(screen.queryByTestId('account-switcher')).toBeNull();
  });

  it('names the account the folders belong to when several are signed in, and only then', async () => {
    const { useAccountStore } = await import('@/stores/account-store');
    const { useAuthStore } = await import('@/stores/auth-store');
    const entry = (id: string, email: string) => ({ id, label: email, serverUrl: 'https://mail.example.org', username: email, email, authMode: 'basic', cookieSlot: 0, rememberMe: true, displayName: '', avatarColor: '#000', lastLoginAt: 0, isConnected: true, hasError: false, isDefault: false });
    useAuthStore.setState({ activeAccountId: 'b' } as never);
    useAccountStore.setState({ accounts: [entry('a', 'ann@example.org'), entry('b', 'bob@example.org')] } as never);
    const { unmount } = render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onCompose={vi.fn()} />);
    expect(screen.getByTestId('sidebar-account-line')).toHaveTextContent('bob@example.org');
    unmount();
    useAccountStore.setState({ accounts: [entry('b', 'bob@example.org')] } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onCompose={vi.fn()} />);
    expect(screen.queryByTestId('sidebar-account-line')).toBeNull();
    useAccountStore.setState({ accounts: [] } as never);
  });

  it('leaves Compose to the round button where the sidebar is a drawer', () => {
    narrowWindow(true);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onCompose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'compose' })).toBeNull();
  });
});
