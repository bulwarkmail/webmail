import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// Usability test 2026-11-04: on a desktop the round Compose button covered the
// list's rows (mail-13), and the folder sidebar's header held a second account
// switcher beside the rail's avatar (mail-27). The header now holds Compose.

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
    matches: narrow && query.includes('64rem') && query.includes('<'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

describe('folder sidebar header', () => {
  beforeEach(() => {
    useSettingsStore.setState({ interfaceLayout: 'default', enableUnifiedMailbox: false } as never);
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

  it('leaves Compose to the round button where the sidebar is a drawer', () => {
    narrowWindow(true);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onCompose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'compose' })).toBeNull();
  });
});
