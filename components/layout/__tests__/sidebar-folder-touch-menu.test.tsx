import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

const pointer = vi.hoisted(() => ({coarse:true}));

// Touch has no right-click: a folder's menu (rename, delete, new subfolder,
// empty, mark read) opens on a long-press and from the row's ⋮ (R7).

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
// A touch screen: the folder rows show their ⋮.
vi.mock('@/hooks/use-media-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-media-query')>()),
  useMediaQuery: (query: string) => query === '(pointer: coarse)' && pointer.coarse,
}));

const { Sidebar } = await import('../sidebar');
const { useAuthStore } = await import('@/stores/auth-store');
const { useSettingsStore } = await import('@/stores/settings-store');

const box = (id: string, name: string, role: string | null) => ({
  id, name, role, parentId: null, totalEmails: 0, unreadEmails: 0,
  myRights: { mayAddItems: true, mayRename: true, mayDelete: true, mayCreateChild: true },
}) as unknown as Mailbox;

const mailboxes: Mailbox[] = [box('inbox', 'Inbox', 'inbox'), box('travel', 'Travel', null)];
const row = (mailboxId: string) =>
  screen.getAllByTestId('folder-row').find((el) => el.getAttribute('data-mailbox-id') === mailboxId)!;

describe('folder menu access', () => {
  beforeEach(() => {
    pointer.coarse = true;
    vi.useFakeTimers();
    useAuthStore.setState({ activeAccountId: 'login-a', client: { getAccountId: () => 'me', getCapabilities: () => ({}) } } as never);
    useSettingsStore.setState({ hideAccountSwitcher: true } as never);
  });
  afterEach(() => vi.useRealTimers());

  it('opens on a long-press without opening the folder', () => {
    const onMailboxSelect = vi.fn();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onMailboxSelect={onMailboxSelect} />);
    fireEvent.touchStart(row('travel'), { touches: [{ clientX: 40, clientY: 200 }] });
    act(() => { vi.advanceTimersByTime(600); });
    fireEvent.touchEnd(row('travel'));
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByText('rename')).toBeTruthy();
    expect(onMailboxSelect).not.toHaveBeenCalled();
  });

  it('opens options with a mouse or keyboard without navigating to the folder', () => {
    pointer.coarse = false;
    const onMailboxSelect = vi.fn();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onMailboxSelect={onMailboxSelect} />);
    const options = row('travel').querySelector<HTMLButtonElement>('[data-testid="folder-row-menu"]')!;
    options.focus();
    expect(options).toHaveFocus();
    fireEvent.click(options);
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(onMailboxSelect).not.toHaveBeenCalled();
  });

  it('opens the folder menu with ArrowDown without selecting the folder', () => {
    pointer.coarse = false;
    const onMailboxSelect = vi.fn();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onMailboxSelect={onMailboxSelect} />);
    const options = row('travel').querySelector<HTMLButtonElement>('[data-testid="folder-row-menu"]')!;
    fireEvent.keyDown(options, { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(onMailboxSelect).not.toHaveBeenCalled();
  });

  it('opens from the row’s options button', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    fireEvent.click(row('travel').querySelector('[data-testid="folder-row-menu"]')!);
    expect(screen.getByRole('menu')).toBeTruthy();
  });
});

describe('folder list from the keyboard', () => {
  it('has no button inside another button', () => {
    useSettingsStore.setState({ hideAccountSwitcher: true } as never);
    const withUnread = mailboxes.map((m) => ({ ...m, unreadEmails: 3, totalEmails: 5 }) as Mailbox);
    const { container } = render(<Sidebar mailboxes={withUnread} selectedMailbox="inbox" onUnreadFilterClick={() => {}} onCreateFolder={() => {}} />);
    expect(container.querySelectorAll('button button, button [role="button"]')).toHaveLength(0);
  });

  it('keeps a one-digit unread count next to the total in its 24px target', () => {
    useSettingsStore.setState({ hideAccountSwitcher: true } as never);
    const withUnread = mailboxes.map((m) => ({ ...m, unreadEmails: 4, totalEmails: 7 }) as Mailbox);
    render(<Sidebar mailboxes={withUnread} selectedMailbox="inbox" onUnreadFilterClick={() => {}} />);
    const unread = row('travel').querySelector<HTMLElement>('[data-testid="folder-counts"] button')!;
    expect(unread.textContent).toBe('4');
    expect(unread.className).toContain('min-w-6');
    expect(unread.className).toContain('justify-end');
    expect(unread.className).not.toContain('justify-center');
  });
});

describe('folder list on touch', () => {
  it('gives the expand chevron a 44px hit area and a name', () => {
    useSettingsStore.setState({ hideAccountSwitcher: true } as never);
    const withChild = [...mailboxes, { ...box('trips', 'Trips', null), parentId: 'travel' } as Mailbox];
    render(<Sidebar mailboxes={withChild} selectedMailbox="inbox" />);
    const toggle = row('travel').querySelector('[data-testid="folder-expand-toggle"]')!;
    expect(toggle.className).toContain('large-targets:after:min-h-11');
    expect(toggle.getAttribute('aria-label')).toBeTruthy();
  });

  it('gives the chevron a 24px target with a mouse too, in its 20px slot', () => {
    useSettingsStore.setState({ hideAccountSwitcher: true } as never);
    const withChild = [...mailboxes, { ...box('trips', 'Trips', null), parentId: 'travel' } as Mailbox];
    render(<Sidebar mailboxes={withChild} selectedMailbox="inbox" />);
    const toggle = row('travel').querySelector<HTMLElement>('[data-testid="folder-expand-toggle"]')!;
    expect(toggle.style.width).toBe('24px');
    expect(toggle.style.height).toBe('24px');
    expect(toggle.style.margin).toBe('-2px');
  });
});
