import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useEmailStore } from '@/stores/email-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('../rules-menu', () => ({ RulesContextSubMenu: () => null }));
vi.mock('@/hooks/use-copy-link', () => ({ useCopyLink: () => vi.fn() }));

const { EmailContextMenu } = await import('../email-context-menu');

// "Remove from this folder" (#615): only for a message that is in the open
// folder and in at least one other, and only while one folder is open.

function mailbox(id: string, extra: Partial<Mailbox> = {}): Mailbox {
  return {
    id, name: id, role: undefined, parentId: undefined, totalEmails: 0, unreadEmails: 0,
    myRights: { mayAddItems: true }, ...extra,
  } as unknown as Mailbox;
}

const mailboxes = [mailbox('inbox', { role: 'inbox', name: 'Inbox' }), mailbox('work', { name: 'Work' })];
const inBoth = { id: 'e1', keywords: { $seen: true }, mailboxIds: { inbox: true, work: true } } as unknown as Email;
const inboxOnly = { id: 'e2', keywords: { $seen: true }, mailboxIds: { inbox: true } } as unknown as Email;

function openFolder(id: string, extra: Partial<ReturnType<typeof useEmailStore.getState>> = {}) {
  useEmailStore.setState({
    mailboxes,
    accountMailboxes: {},
    viewingAccountId: null,
    selectedMailbox: id,
    selectedKeyword: null,
    isUnifiedView: false,
    crossView: null,
    isScheduledView: false,
    searchQuery: '',
    searchFilters: DEFAULT_SEARCH_FILTERS,
    searchMailboxId: '',
    ...extra,
  });
}

function renderMenu(props: Partial<React.ComponentProps<typeof EmailContextMenu>> = {}) {
  return render(
    <EmailContextMenu
      email={inBoth}
      position={{ x: 0, y: 0 }}
      isOpen
      onClose={() => {}}
      menuRef={{ current: null }}
      mailboxes={mailboxes}
      selectedMailbox="inbox"
      onMoveToMailbox={vi.fn()}
      onRemoveFromFolder={vi.fn()}
      {...props}
    />,
  );
}

beforeEach(() => openFolder('inbox'));

describe('Remove from this folder in the message menu', () => {
  it('is offered for a message that is also in another folder, and runs', () => {
    const onRemoveFromFolder = vi.fn();
    renderMenu({ onRemoveFromFolder });
    fireEvent.click(screen.getByTestId('ctx-remove-from-folder'));
    expect(onRemoveFromFolder).toHaveBeenCalledTimes(1);
  });

  it('is hidden for a message that is only in the open folder', () => {
    renderMenu({ email: inboxOnly });
    expect(screen.queryByTestId('ctx-remove-from-folder')).toBeNull();
  });

  it('is hidden for a message that is not in the open folder', () => {
    openFolder('work');
    renderMenu({ email: { ...inboxOnly, mailboxIds: { inbox: true, other: true } } as unknown as Email, selectedMailbox: 'work' });
    expect(screen.queryByTestId('ctx-remove-from-folder')).toBeNull();
  });

  it('is hidden where no single folder is open', () => {
    openFolder('inbox', { isUnifiedView: true });
    const { unmount } = renderMenu();
    expect(screen.queryByTestId('ctx-remove-from-folder')).toBeNull();
    unmount();

    openFolder('inbox', { selectedKeyword: '$label:red' });
    const second = renderMenu();
    expect(screen.queryByTestId('ctx-remove-from-folder')).toBeNull();
    second.unmount();

    // A search across all folders has no folder to leave either.
    openFolder('inbox', { searchQuery: 'invoice', searchMailboxId: '' });
    renderMenu();
    expect(screen.queryByTestId('ctx-remove-from-folder')).toBeNull();
  });

  it('is offered in a search scoped to the open folder', () => {
    openFolder('inbox', { searchQuery: 'invoice', searchMailboxId: 'inbox' });
    renderMenu();
    expect(screen.getByTestId('ctx-remove-from-folder')).toBeTruthy();
  });

  it('offers it for a selection only when every message is in another folder too', () => {
    const onBatchRemoveFromFolder = vi.fn();
    const batch = { isMultiSelect: true, selectedCount: 2, onBatchRemoveFromFolder };
    const { unmount } = renderMenu({ ...batch, batchEmails: [inBoth, inboxOnly] });
    fireEvent.click(screen.getByTestId('ctx-more'));
    expect(screen.queryByTestId('ctx-remove-from-folder')).toBeNull();
    unmount();

    const both = { ...inBoth, id: 'e3' } as Email;
    renderMenu({ ...batch, batchEmails: [inBoth, both] });
    fireEvent.click(screen.getByTestId('ctx-more'));
    fireEvent.click(screen.getByTestId('ctx-remove-from-folder'));
    expect(onBatchRemoveFromFolder).toHaveBeenCalledTimes(1);
  });
});
