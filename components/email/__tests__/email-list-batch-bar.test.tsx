import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { EmailList } from '../email-list';

// The selection bar offers what the selection's context menu offers (R6):
// Archive, Delete, Tag, Report spam and Mark read/unread as buttons, the rest
// (Move to, Forward as attachments, ...) in its ⋮, which is that menu.

vi.mock('@/stores/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-email-drag', () => ({ useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }) }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));

const initial = useEmailStore.getState();
const folder = (id: string, role: string): Mailbox => ({ id, name: id, role, accountId: 'c',
  totalEmails: 2, unreadEmails: 0, totalThreads: 2, unreadThreads: 0,
  myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true } } as Mailbox);

beforeEach(() => {
  useAuthStore.setState({ activeAccountId: 'test', client: { getAccountId: () => 'c', getSieveAccountId: () => null, getCapabilities: () => ({}) }, getClientForAccount: () => undefined } as never);
  useSettingsStore.setState({ confirmBulkDelete: false, deleteAction: 'trash', interfaceLayout: 'default' } as never);
  useEmailStore.setState(initial, true);
  const emails = ['one', 'two'].map(id => ({ id, threadId: 't-' + id, blobId: 'b-' + id,
    mailboxIds: { inbox: true }, keywords: { $seen: true }, subject: id, receivedAt: '2026-10-01T00:00:00Z',
    from: [{ email: 'someone@example.invalid' }], size: 1, hasAttachment: false } as Email));
  useEmailStore.setState({ emails, mailboxes: [folder('inbox', 'inbox'), folder('work', '')],
    selectedMailbox: 'inbox', selectedEmailKeys: new Set(['one', 'two']), totalEmails: 2 });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('selection bar', () => {
  it('archives and reports spam from its own buttons', async () => {
    const batchArchive = vi.fn().mockResolvedValue(true);
    const batchMarkAsSpam = vi.fn().mockResolvedValue(true);
    useEmailStore.setState({ batchArchive, batchMarkAsSpam });
    render(<EmailList emails={useEmailStore.getState().emails} />);

    fireEvent.click(screen.getByTestId('batch-archive'));
    await waitFor(() => expect(batchArchive).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 600));
    fireEvent.click(screen.getByTestId('batch-spam'));
    await waitFor(() => expect(batchMarkAsSpam).toHaveBeenCalledWith(expect.anything(), ['one', 'two']));
  });

  it('counts conversations in its toasts, as its title does (mail-18)', async () => {
    const { toast } = await import('@/stores/toast-store');
    const batchArchive = vi.fn().mockResolvedValue(true);
    useEmailStore.setState({ batchArchive });
    render(<EmailList emails={useEmailStore.getState().emails} />);
    fireEvent.click(screen.getByTestId('batch-archive'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('mail_p2_list.conversations_archived', expect.anything()));
  });

  it('opens the selection’s menu from ⋮, with Move to and Forward as attachments', () => {
    render(<EmailList emails={useEmailStore.getState().emails} />);
    fireEvent.click(screen.getByTestId('batch-more'));
    expect(screen.getByText('items_selected')).toBeTruthy();
    expect(screen.getByTestId('ctx-move-to')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ctx-more'));
    expect(screen.getByTestId('ctx-batch-forward-as-attachment')).toBeTruthy();
  });
});

// mail-10: Move on the bar, one read/unread button that offers "Mark as read"
// while anything selected is unread, and the same buttons in the reading pane.
describe('selection bar: Move, read state and the reading pane', () => {
  it('moves the selection from its Move button', async () => {
    const batchMoveToMailbox = vi.fn().mockResolvedValue(true);
    useEmailStore.setState({ batchMoveToMailbox });
    render(<EmailList emails={useEmailStore.getState().emails} />);
    fireEvent.click(screen.getByTestId('batch-move'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /work/ }));
    await waitFor(() => expect(batchMoveToMailbox).toHaveBeenCalledWith(expect.anything(), 'work', undefined, expect.any(Array)));
  });

  it('offers Mark as read while one selected message is unread', async () => {
    const emails = useEmailStore.getState().emails.map((email, i) => (i === 0 ? { ...email, keywords: {} } : email));
    useEmailStore.setState({ emails });
    render(<EmailList emails={emails} />);
    expect(screen.getByTestId('batch-mark-read').getAttribute('aria-label')).toBe('batch_actions.mark_read');
    expect(screen.queryByRole('button', { name: 'batch_actions.mark_unread' })).toBeNull();
  });

  it('offers Mark as unread when everything selected is read', () => {
    render(<EmailList emails={useEmailStore.getState().emails} />);
    expect(screen.getByTestId('batch-mark-read').getAttribute('aria-label')).toBe('batch_actions.mark_unread');
  });

  it('draws the count and the same buttons into the reading pane', async () => {
    const batchArchive = vi.fn().mockResolvedValue(true);
    useEmailStore.setState({ batchArchive });
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(<EmailList emails={useEmailStore.getState().emails} selectionPaneHost={host} />);
    const pane = host.querySelector('[data-testid="selection-pane"]') as HTMLElement;
    expect(pane).not.toBeNull();
    expect(pane.textContent).toContain('selected_conversations');
    // All read: the pane offers Mark as unread, as the selection's menu does.
    for (const id of ['archive', 'delete', 'move', 'mark-unread', 'star', 'tag', 'spam', 'more']) {
      expect(pane.querySelector(`[data-testid="pane-batch-${id}"]`)).not.toBeNull();
    }
    fireEvent.click(pane.querySelector('[data-testid="pane-batch-archive"]')!);
    await waitFor(() => expect(batchArchive).toHaveBeenCalled());
    host.remove();
  });
});

describe('select all in the folder (mail-p2-11)', () => {
  it('offers the rest of the folder once every loaded row is ticked, and ticks it', async () => {
    const third = { ...useEmailStore.getState().emails[0], id: 'three', threadId: 't-three', blobId: 'b-three' } as Email;
    const loadMoreEmails = vi.fn(async () => {
      useEmailStore.setState({ emails: [...useEmailStore.getState().emails, third], hasMoreEmails: false });
    });
    useEmailStore.setState({ hasMoreEmails: true, loadMoreEmails, totalEmails: 3 });
    render(<EmailList emails={useEmailStore.getState().emails} />);
    const offer = screen.getByTestId('select-all-in-view');
    expect(offer.textContent).toBe('mail_p2_list.select_all_in_folder');
    fireEvent.click(offer.querySelector('button')!);
    await waitFor(() => expect([...useEmailStore.getState().selectedEmailKeys].sort()).toEqual(['one', 'three', 'two']));
    expect(loadMoreEmails).toHaveBeenCalledTimes(1);
  });

  it('offers nothing while only some loaded rows are ticked', () => {
    useEmailStore.setState({ hasMoreEmails: true, selectedEmailKeys: new Set(['one']) });
    render(<EmailList emails={useEmailStore.getState().emails} />);
    expect(screen.queryByTestId('select-all-in-view')).toBeNull();
  });
});

describe('the reading pane for a selection (mail-p2-15)', () => {
  it('names its buttons in words, while the bar beside the list keeps icons', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(<EmailList emails={useEmailStore.getState().emails} selectionPaneHost={host} />);
    const pane = host.querySelector('[data-testid="selection-pane"]') as HTMLElement;
    for (const button of Array.from(pane.querySelectorAll('button'))) {
      expect(button.textContent?.trim()).not.toBe('');
    }
    expect(screen.getByTestId('batch-archive').textContent).toBe('');
    host.remove();
  });
});

// The selection view shows the selection menu's top level as buttons, in its order,
// with More actions as a labelled button, not a bare icon.
describe('the selection view', () => {
  const paneLabels = (pane: HTMLElement) =>
    Array.from(pane.querySelectorAll('[data-testid="selection-actions"] button'))
      .map((button) => button.querySelector('[data-selection-label]')?.textContent ?? '');

  it('has the same buttons as the selection menu has entries, in the same order', () => {
    const emails = useEmailStore.getState().emails.map((email, i) => (i === 0 ? { ...email, keywords: {} } : email));
    useEmailStore.setState({ emails });
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(<EmailList emails={emails} selectionPaneHost={host} />);
    const pane = host.querySelector('[data-testid="selection-pane"]') as HTMLElement;
    fireEvent.click(screen.getByTestId('batch-more'));
    const menu = screen.getAllByRole('menu').find((m) => m.textContent?.includes('items_selected'))!;
    const menuTop = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .filter((row) => row.parentElement?.closest('[role="menu"]') === menu)
      .map((row) => row.querySelector('[data-menu-label]')?.textContent ?? '');
    expect(paneLabels(pane)).toEqual(menuTop);
    expect(paneLabels(pane)).toEqual(['archive', 'delete', 'move_to', 'mark_read', 'mark_unread', 'star', 'tag', 'mark_as_spam', 'more_actions']);
    host.remove();
  });

  it('opens what the menu has under More actions from its More actions button', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(<EmailList emails={useEmailStore.getState().emails} selectionPaneHost={host} />);
    fireEvent.click(host.querySelector('[data-testid="pane-batch-more"]')!);
    const menu = screen.getByRole('menu', { name: 'more_actions' });
    expect(within(menu).getByTestId('ctx-batch-forward-as-attachment')).toBeTruthy();
    expect(within(menu).queryByTestId('ctx-archive')).toBeNull();
    host.remove();
  });

  const lineLengths = (width: number) => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
    const emails = useEmailStore.getState().emails.map((email, i) => (i === 0 ? { ...email, keywords: {} } : email));
    useEmailStore.setState({ emails });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const { unmount } = render(<EmailList emails={emails} selectionPaneHost={host} />);
    const lengths = Array.from(host.querySelectorAll('[data-selection-line]')).map((line) => line.querySelectorAll('button').length);
    unmount();
    host.remove();
    vi.restoreAllMocks();
    return lengths;
  };

  it('leaves no button alone on a line in a narrow pane', () => {
    // Nine buttons, room for three a line: three even lines, not 3 + 3 + 2 + 1.
    expect(lineLengths(560)).toEqual([3, 3, 3]);
    // Room for two: pairs, and More actions across the width at the end.
    expect(lineLengths(360)).toEqual([2, 2, 2, 2, 1]);
  });
});

describe('selection bar and rows from the keyboard', () => {
  it('keeps the collapsed bar out of the Tab order', () => {
    useEmailStore.setState({ selectedEmailKeys: new Set() });
    render(<EmailList emails={useEmailStore.getState().emails} />);
    expect(screen.queryByTestId('batch-delete')).toBeNull();
  });

  it('names each row checkbox after its message', () => {
    // Give jsdom's virtualized rows a layout so they render.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600);
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(600);
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const height = this.hasAttribute('data-index') ? 60 : 300;
      return { x: 0, y: 0, width: 600, height, top: 0, left: 0, right: 600, bottom: height, toJSON: () => ({}) } as DOMRect;
    });
    useEmailStore.setState({ selectedEmailKeys: new Set() });
    render(<EmailList emails={useEmailStore.getState().emails} />);
    // The i18n mock renders the key: "Select {sender}: {subject}".
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) expect(box.getAttribute('aria-label')).toBe('select_row');
  });
});

describe('empty list', () => {
  it('offers Clear search when a search found nothing', () => {
    const onClearSearch = vi.fn();
    useEmailStore.setState({ emails: [], selectedEmailKeys: new Set(), searchQuery: 'zebra' });
    render(<EmailList emails={[]} onClearSearch={onClearSearch} />);
    fireEvent.click(screen.getByRole('button', { name: 'clear_search' }));
    expect(onClearSearch).toHaveBeenCalled();
  });

  it('offers Compose in an empty Drafts folder', () => {
    const onCompose = vi.fn();
    useEmailStore.setState({ emails: [], selectedEmailKeys: new Set(), searchQuery: '', mailboxes: [folder('drafts', 'drafts')], selectedMailbox: 'drafts' });
    render(<EmailList emails={[]} onCompose={onCompose} />);
    fireEvent.click(screen.getByRole('button', { name: 'compose' }));
    expect(onCompose).toHaveBeenCalled();
  });
});
