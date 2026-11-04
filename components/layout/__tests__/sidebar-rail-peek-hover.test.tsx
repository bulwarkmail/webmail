import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// MO-17: the collapsed Mountain View rail peeks open on hover, but not with
// "open on hover" turned off.

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

const box = (id: string, name: string, role: string | null, extra: Partial<Mailbox> = {}) => ({
  id, name, role, parentId: null, totalEmails: 0, unreadEmails: 0, myRights: { mayAddItems: true }, ...extra,
}) as unknown as Mailbox;

const mailboxes: Mailbox[] = [
  box('inbox', 'Inbox', 'inbox', { totalEmails: 120, unreadEmails: 4 }),
  box('drafts', 'Drafts', 'drafts', { totalEmails: 7 }),
  box('news', 'News', null, { totalEmails: 30, unreadEmails: 2 }),
];


const { useUIStore } = await import('@/stores/ui-store');
const { fireEvent: fire } = await import('@testing-library/react');

describe('Mountain View rail peek', () => {
  beforeEach(() => {
    useAuthStore.setState({ activeAccountId: 'login-a', client: { getAccountId: () => 'me', getCapabilities: () => ({}) } } as never);
    useSettingsStore.setState({ hideAccountSwitcher: true, interfaceLayout: 'mountain-view', openOnHover: true } as never);
    useUIStore.setState({ sidebarCollapsed: true } as never);
  });
  afterEach(() => {
    useUIStore.setState({ sidebarCollapsed: false } as never);
    useSettingsStore.setState({ interfaceLayout: 'default', openOnHover: true } as never);
  });

  const peek = (container: HTMLElement) => container.querySelector('[data-mv-rail-peek]');

  it('shows folder names in the drawer of a narrow window, even when collapsed on a wider one', () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(width < 37.5rem)', media: query, addEventListener() {}, removeEventListener() {},
    })) as never;
    try {
      render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
      expect(screen.getByText('News')).toBeTruthy();
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  it('keeps the icon rail on a wide window', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    expect(screen.queryByText('News')).toBeNull();
  });

  it('peeks on hover by default', () => {
    const { container } = render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" mvShell />);
    fire.mouseEnter(container.firstElementChild!);
    expect(peek(container)).not.toBeNull();
  });

  it('stays collapsed on hover with the setting off', () => {
    useSettingsStore.setState({ openOnHover: false } as never);
    const { container } = render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" mvShell />);
    fire.mouseEnter(container.firstElementChild!);
    expect(peek(container)).toBeNull();
  });
});
