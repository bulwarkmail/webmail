import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// A folder row opens its folder wherever it is clicked, not only on the
// button inside it. Mountain View draws a 32px pill around a ~20px button,
// and clicks on the pill's padding, the chevron slot or the count did
// nothing (#1501). The row's own controls keep their click.

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
const { useSettingsStore } = await import('@/stores/settings-store');
const { useUIStore } = await import('@/stores/ui-store');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, totalEmails: 9, unreadEmails: 4, sortOrder: 0, myRights: { mayAddItems: true } },
  { id: 'receipts', name: 'Receipts', role: null, parentId: null, totalEmails: 5, unreadEmails: 3, sortOrder: 1, myRights: { mayAddItems: true } },
  { id: 'shops', name: 'Shops', role: null, parentId: 'receipts', totalEmails: 0, unreadEmails: 0, sortOrder: 0, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

const row = (id: string) => document.querySelector<HTMLElement>(`[data-testid="folder-row"][data-mailbox-id="${id}"]`)!;

describe.each([
  ['Mountain View', 'mountain-view', true],
  ['the default layout', 'default', false],
] as const)('folder row click area in %s', (_name, interfaceLayout, mvShell) => {
  beforeEach(() => {
    useUIStore.setState({ sidebarCollapsed: false } as never);
    useSettingsStore.setState({ interfaceLayout, hideAccountSwitcher: true, enableUnifiedMailbox: false } as never);
  });

  it('opens the folder from a click on the row outside its button', () => {
    const onMailboxSelect = vi.fn();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onMailboxSelect={onMailboxSelect} mvShell={mvShell} />);
    fireEvent.click(row('receipts'));
    expect(onMailboxSelect).toHaveBeenCalledWith('receipts');
  });

  it('opens the folder from a click on its count', () => {
    const onMailboxSelect = vi.fn();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onMailboxSelect={onMailboxSelect} mvShell={mvShell} />);
    fireEvent.click(row('receipts').querySelector('[data-testid="folder-counts"]')!);
    expect(onMailboxSelect).toHaveBeenCalledWith('receipts');
  });

  it('shows the pointer over the whole row', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onMailboxSelect={() => {}} mvShell={mvShell} />);
    expect(row('receipts').className).toContain('cursor-pointer');
  });

  it('only expands or collapses the folder from its chevron', () => {
    const onMailboxSelect = vi.fn();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onMailboxSelect={onMailboxSelect} mvShell={mvShell} />);
    const shownBefore = row('shops') !== null;
    fireEvent.click(row('receipts').querySelector('[data-testid="folder-expand-toggle"]')!);
    expect(row('shops') !== null).toBe(!shownBefore);
    expect(onMailboxSelect).not.toHaveBeenCalled();
  });
});

// Usability test 2026-11-04, mail-8: the count was a button of its own that
// turned on an Unread filter and an "Inbox" search scope, both of which stayed
// and broke later searches. It is part of the row now and opens the folder.
describe('folder row click area on the unread count', () => {
  it('opens the folder from the unread count', () => {
    useSettingsStore.setState({ interfaceLayout: 'default', hideAccountSwitcher: true, enableUnifiedMailbox: false } as never);
    const onMailboxSelect = vi.fn();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onMailboxSelect={onMailboxSelect} />);
    const counts = row('receipts').querySelector('[data-testid="folder-counts"]')!;
    expect(counts.querySelector('button')).toBeNull();
    fireEvent.click(counts.firstElementChild!);
    expect(onMailboxSelect).toHaveBeenCalledWith('receipts');
  });
});
