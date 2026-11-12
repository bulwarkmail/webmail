import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { KEYWORD_PREFIX } from '@/lib/thread-utils';

// "Move to" and "Labels" were reachable only from a row's context menu, so a
// selection could be archived or deleted from the toolbar but not filed. Both
// now sit in the batch half of the Mountain View list toolbar.

const { MvListToolbar } = await import('../mv-list-toolbar');
const { useEmailStore } = await import('@/stores/email-store');
const { useAuthStore } = await import('@/stores/auth-store');
const { useSettingsStore } = await import('@/stores/settings-store');

const rights = {
  mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true,
  maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true,
};

const mailbox = (id: string, name: string, role?: string): Mailbox =>
  ({ id, name, role, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0,
     unreadThreads: 0, isSubscribed: true, myRights: rights }) as Mailbox;

const message = (id: string, keywords: Record<string, boolean> = {}): Email =>
  ({ id, threadId: id, keywords, mailboxIds: { inbox: true } }) as unknown as Email;

const mailboxes = [mailbox('inbox', 'Inbox', 'inbox'), mailbox('receipts', 'Receipts')];

describe('MvListToolbar filing actions', () => {
  const batchMoveToMailbox = vi.fn().mockResolvedValue(undefined);
  const batchSetTag = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    batchMoveToMailbox.mockClear();
    batchSetTag.mockClear();
    const emails = [message('a', { [KEYWORD_PREFIX + 'work']: true }), message('b')];
    useAuthStore.setState({ client: {} as never } as never);
    useSettingsStore.setState({
      emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }],
      nestedTags: false,
    } as never);
    useEmailStore.setState({
      emails,
      mailboxes,
      selectedMailbox: 'inbox',
      selectedEmailKeys: new Set(emails.map((email) => email.id)),
      isUnifiedView: false,
      unifiedRole: null,
      batchMoveToMailbox,
      batchSetTag,
    } as never);
  });

  const toolbar = () =>
    render(<MvListToolbar loadedCount={2} onRefresh={() => {}} />);

  it('files the selection into a folder that will take it', async () => {
    toolbar();

    fireEvent.click(screen.getByLabelText('move_to'));
    fireEvent.click(screen.getByText('Receipts'));

    await waitFor(() => expect(batchMoveToMailbox).toHaveBeenCalledWith({}, 'receipts', undefined, []));
  });

  it('does not offer the folder you are already in as a destination', () => {
    toolbar();

    fireEvent.click(screen.getByLabelText('move_to'));
    // Shown greyed, where the sidebar has it.
    expect(screen.getByText('mailboxes.inbox').closest('button')).toBeDisabled();
  });

  it('puts a tag on the whole selection when only some of it carries the tag', async () => {
    toolbar();

    fireEvent.click(screen.getByLabelText('tag'));
    fireEvent.click(screen.getByText('Work'));

    await waitFor(() => expect(batchSetTag).toHaveBeenCalledTimes(1));
    expect(batchSetTag).toHaveBeenCalledWith({}, 'work', true);
  });

  it('takes a tag off once the whole selection carries it', async () => {
    const emails = [
      message('a', { [KEYWORD_PREFIX + 'work']: true }),
      message('b', { [KEYWORD_PREFIX + 'work']: true }),
    ];
    useEmailStore.setState({
      emails,
      selectedEmailKeys: new Set(emails.map((email) => email.id)),
    } as never);
    toolbar();

    fireEvent.click(screen.getByLabelText('tag'));
    fireEvent.click(screen.getByText('Work'));

    await waitFor(() => expect(batchSetTag).toHaveBeenCalledTimes(1));
    expect(batchSetTag).toHaveBeenCalledWith({}, 'work', false);
  });

  it('narrows the folders to the ones matching what is typed, and offers to create one', () => {
    const onCreateFolder = vi.fn();
    useEmailStore.setState({ mailboxes: [...mailboxes, mailbox('travel', 'Travel')] } as never);
    render(<MvListToolbar loadedCount={2} onRefresh={() => {}} onCreateFolder={onCreateFolder} />);

    fireEvent.click(screen.getByRole('button', { name: 'move_to' }));
    expect(screen.getByText('Travel')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'filter_placeholder' }), { target: { value: 'rec' } });
    expect(screen.getByText('Receipts')).toBeInTheDocument();
    expect(screen.queryByText('Travel')).toBeNull();

    fireEvent.click(screen.getByText('create_label'));
    expect(onCreateFolder).toHaveBeenCalledTimes(1);
  });

  it('shows neither control until something is selected', () => {
    useEmailStore.setState({ selectedEmailKeys: new Set() } as never);
    toolbar();

    expect(screen.queryByLabelText('move_to')).toBeNull();
    expect(screen.queryByLabelText('tag')).toBeNull();
  });
});

describe('MvListToolbar overflow menu', () => {
  beforeEach(() => {
    useAuthStore.setState({ client: {} as never } as never);
    useEmailStore.setState({
      emails: [message('a')],
      mailboxes,
      selectedMailbox: 'inbox',
      selectedEmailKeys: new Set(),
      isUnifiedView: false,
      unifiedRole: null,
    } as never);
  });

  const open = () => fireEvent.click(screen.getByLabelText('more_actions'));

  it('offers marking every folder read, not just this one', () => {
    render(
      <MvListToolbar
        loadedCount={1}
        onRefresh={() => {}}
        onMarkFolderRead={() => {}}
        onMarkAllFoldersRead={() => {}}
      />
    );
    open();

    expect(screen.getByText('mark_all_folders_read')).toBeInTheDocument();
    // The app's one menu (R6): the ContextMenu, in a portal, with its rows.
    const menu = screen.getByRole('menu');
    expect(menu.parentElement).toBe(document.body);
    expect(screen.getByRole('menuitem', { name: 'mark_all_folders_read' }).className).toContain('pointer-coarse:min-h-11');
  });

  it('offers Group by date, ticked while the setting is on', () => {
    useSettingsStore.setState({ groupListByDate: false } as never);
    render(<MvListToolbar loadedCount={1} onRefresh={() => {}} />);
    open();

    const item = screen.getByTestId('mail-group-by-date');
    expect(item.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(item);
    expect(useSettingsStore.getState().groupListByDate).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('withholds emptying the folder outside spam and the bin', () => {
    render(<MvListToolbar loadedCount={1} onRefresh={() => {}} onEmptyFolder={() => {}} />);
    open();

    for (const label of ['empty_folder', 'empty_trash', 'empty_spam']) expect(screen.queryByText(label)).toBeNull();
  });

  it('offers it in the bin, as Empty Trash', () => {
    useEmailStore.setState({
      mailboxes: [mailbox('trash', 'Trash', 'trash')],
      selectedMailbox: 'trash',
    } as never);
    const onEmptyFolder = vi.fn();
    render(<MvListToolbar loadedCount={1} onRefresh={() => {}} onEmptyFolder={onEmptyFolder} />);
    open();

    fireEvent.click(screen.getByText('empty_trash'));
    expect(onEmptyFolder).toHaveBeenCalledOnce();
  });
});

const { toast } = await import('@/stores/toast-store');
const { ArchiveMailboxNotFoundError } = await import('@/stores/email-store');

describe('MvListToolbar failure feedback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAuthStore.setState({ client: {} as never } as never);
    useSettingsStore.setState({
      emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }],
      nestedTags: false,
    } as never);
    useEmailStore.setState({
      emails: [message('a'), message('b')],
      mailboxes,
      selectedMailbox: 'inbox',
      selectedEmailKeys: new Set(['a', 'b']),
      isUnifiedView: false,
      unifiedRole: null,
      error: null,
    } as never);
  });

  it('says why archiving failed instead of failing silently', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '' as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useEmailStore.setState({
      batchArchive: vi.fn().mockRejectedValue(new ArchiveMailboxNotFoundError()),
    } as never);
    render(<MvListToolbar loadedCount={2} onRefresh={() => {}} />);

    fireEvent.click(screen.getByLabelText('archive'));

    await waitFor(() => expect(error).toHaveBeenCalledWith('error_archiving', 'archive_mailbox_not_found'));
  });

  it('reports a tag write that the server refused', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '' as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useEmailStore.setState({ batchSetTag: vi.fn().mockRejectedValue(new Error('forbidden')) } as never);
    render(<MvListToolbar loadedCount={2} onRefresh={() => {}} />);

    fireEvent.click(screen.getByLabelText('tag'));
    fireEvent.click(screen.getByText('Work'));

    await waitFor(() => expect(error).toHaveBeenCalledWith('error_updating'));
  });
});

// #1225: deleting a selection asked every time. The prompt before moving it to
// the trash can now be turned off; a permanent delete still asks.
describe('MvListToolbar delete prompt', () => {
  const batchDelete = vi.fn().mockResolvedValue(undefined);

  const select = (folder: Mailbox) => {
    useEmailStore.setState({
      emails: [message('a'), message('b')],
      mailboxes: [folder],
      selectedMailbox: folder.id,
      selectedEmailKeys: new Set(['a', 'b']),
      isUnifiedView: false,
      unifiedRole: null,
      batchDelete,
    } as never);
  };

  beforeEach(() => {
    batchDelete.mockClear();
    useAuthStore.setState({ client: {} as never } as never);
  });

  const deleteSelection = () => {
    render(<MvListToolbar loadedCount={2} onRefresh={() => {}} />);
    fireEvent.click(screen.getByLabelText('delete'));
  };

  it('moves the selection to the trash straight away with the prompt off', async () => {
    useSettingsStore.setState({ confirmBulkDelete: false, permanentlyDeleteJunk: false } as never);
    select(mailbox('inbox', 'Inbox', 'inbox'));
    deleteSelection();

    await waitFor(() => expect(batchDelete).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('delete_confirm_title')).toBeNull();
  });

  it('asks first with the prompt on', async () => {
    useSettingsStore.setState({ confirmBulkDelete: true, permanentlyDeleteJunk: false } as never);
    select(mailbox('inbox', 'Inbox', 'inbox'));
    deleteSelection();

    expect(await screen.findByText('delete_confirm_title')).toBeInTheDocument();
    expect(batchDelete).not.toHaveBeenCalled();
  });

  it.each([
    ['in the bin', mailbox('trash', 'Trash', 'trash'), false],
    ['in spam when spam is deleted for good', mailbox('junk', 'Junk', 'junk'), true],
  ])('still asks before deleting for good %s', async (_where, folder, permanentlyDeleteJunk) => {
    useSettingsStore.setState({ confirmBulkDelete: false, permanentlyDeleteJunk } as never);
    select(folder);
    deleteSelection();

    // A selection: "Delete these emails permanently?", not the one-message title.
    expect(await screen.findByText('delete_forever_batch_title')).toBeInTheDocument();
    expect(batchDelete).not.toHaveBeenCalled();
  });
});

// Settings > Accessibility: "Confirm before deleting" and "Confirm before
// archiving" ask before the selection goes, also when the bulk-delete prompt
// is off (WCAG 3.3.4).
describe('MvListToolbar removal confirmations', () => {
  const batchDelete = vi.fn().mockResolvedValue(true);
  const batchArchive = vi.fn().mockResolvedValue(true);

  beforeEach(() => {
    batchDelete.mockClear();
    batchArchive.mockClear();
    useAuthStore.setState({ client: {} as never } as never);
    useEmailStore.setState({
      emails: [message('a'), message('b')],
      mailboxes,
      selectedMailbox: 'inbox',
      selectedEmailKeys: new Set(['a', 'b']),
      isUnifiedView: false,
      unifiedRole: null,
      error: null,
      batchDelete,
      batchArchive,
    } as never);
  });

  it('asks before deleting with "Confirm before deleting" on, and deletes after Delete', async () => {
    useSettingsStore.setState({ confirmBulkDelete: false, permanentlyDeleteJunk: false, confirmDelete: true } as never);
    render(<MvListToolbar loadedCount={2} onRefresh={() => {}} />);
    fireEvent.click(screen.getByLabelText('delete'));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('delete_title');
    expect(batchDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'delete' }).at(-1)!);
    await waitFor(() => expect(batchDelete).toHaveBeenCalledTimes(1));
  });

  it('asks before archiving with "Confirm before archiving" on, and keeps the mail on Cancel', async () => {
    useSettingsStore.setState({ confirmArchive: true } as never);
    render(<MvListToolbar loadedCount={2} onRefresh={() => {}} />);
    fireEvent.click(screen.getByLabelText('archive'));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('archive_title');
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(batchArchive).not.toHaveBeenCalled();
  });

  it('archives straight away with the setting off', async () => {
    useSettingsStore.setState({ confirmArchive: false } as never);
    render(<MvListToolbar loadedCount={2} onRefresh={() => {}} />);
    fireEvent.click(screen.getByLabelText('archive'));
    await waitFor(() => expect(batchArchive).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('leaves no timer running once it is gone', async () => {
    // The buttons stay disabled for a moment after an action. A bare timer
    // for that outlived the toolbar and reached React after the test
    // environment was torn down ("window is not defined", failing CI).
    vi.useFakeTimers();
    try {
      useSettingsStore.setState({ confirmArchive: false } as never);
      const { unmount } = render(<MvListToolbar loadedCount={2} onRefresh={() => {}} />);
      await act(async () => {
        fireEvent.click(screen.getByLabelText('archive'));
      });
      expect(batchArchive).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
