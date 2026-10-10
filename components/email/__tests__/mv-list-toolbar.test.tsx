import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
      selectedEmailIds: new Set(emails.map((email) => email.id)),
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

    await waitFor(() => expect(batchMoveToMailbox).toHaveBeenCalledWith({}, 'receipts'));
  });

  it('does not offer the folder you are already in as a destination', () => {
    toolbar();

    fireEvent.click(screen.getByLabelText('move_to'));
    expect(screen.queryByText('mailboxes.inbox')).toBeNull();
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
      selectedEmailIds: new Set(emails.map((email) => email.id)),
    } as never);
    toolbar();

    fireEvent.click(screen.getByLabelText('tag'));
    fireEvent.click(screen.getByText('Work'));

    await waitFor(() => expect(batchSetTag).toHaveBeenCalledTimes(1));
    expect(batchSetTag).toHaveBeenCalledWith({}, 'work', false);
  });

  it('shows neither control until something is selected', () => {
    useEmailStore.setState({ selectedEmailIds: new Set() } as never);
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
      selectedEmailIds: new Set(),
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
  });

  it('withholds emptying the folder outside spam and the bin', () => {
    render(<MvListToolbar loadedCount={1} onRefresh={() => {}} onEmptyFolder={() => {}} />);
    open();

    expect(screen.queryByText('empty_folder')).toBeNull();
  });

  it('offers it in the bin', () => {
    useEmailStore.setState({
      mailboxes: [mailbox('trash', 'Trash', 'trash')],
      selectedMailbox: 'trash',
    } as never);
    const onEmptyFolder = vi.fn();
    render(<MvListToolbar loadedCount={1} onRefresh={() => {}} onEmptyFolder={onEmptyFolder} />);
    open();

    fireEvent.click(screen.getByText('empty_folder'));
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
      selectedEmailIds: new Set(['a', 'b']),
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
