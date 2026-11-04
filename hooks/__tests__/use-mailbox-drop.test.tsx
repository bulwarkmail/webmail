import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { DragEvent } from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';

const drag = vi.hoisted(() => ({
  isDragging: true,
  sourceMailboxId: '' as string | null,
  draggedEmails: [] as Email[],
  endDrag: () => {},
  markDropped: () => {},
}));
vi.mock('@/contexts/drag-drop-context', () => ({ useDragDropContext: () => drag }));

const { useMailboxDrop } = await import('../use-mailbox-drop');

// userb is logged in to a Stalwart 0.16.23 and a 1.0 server and is account `e`
// on both: a folder's account id can't say which login it belongs to, only
// the sidebar list it is shown in can. Both have their own Archive as `f`.

function mailbox(overrides: Partial<Mailbox>): Mailbox {
  return {
    id: 'f', name: 'Archive', role: 'archive', sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
    myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true },
    isSubscribed: true, isShared: false, accountId: 'e',
    ...overrides,
  };
}

function email(overrides: Partial<Email>): Email {
  return { id: 'x', threadId: 't', subject: 's', receivedAt: '2026-09-01T08:00:00Z', keywords: {}, mailboxIds: { a: true }, ...overrides } as Email;
}

function dropEvent(ids: string[]): DragEvent<HTMLDivElement> {
  return {
    preventDefault: () => {},
    stopPropagation: () => {},
    dataTransfer: { getData: () => JSON.stringify(ids) },
  } as unknown as DragEvent<HTMLDivElement>;
}

describe('useMailboxDrop', () => {
  const client016 = { getAccountId: () => 'e' } as unknown as IJMAPClient;
  const client10 = { getAccountId: () => 'e' } as unknown as IJMAPClient;
  let moveEmailsToMailbox: ReturnType<typeof vi.fn>;
  let crossAccountMoveEmails: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    moveEmailsToMailbox = vi.fn().mockResolvedValue(true);
    crossAccountMoveEmails = vi.fn().mockResolvedValue(true);
    useAuthStore.setState({
      client: client016,
      activeAccountId: 'userb@v016',
      getClientForAccount: (id: string) => (id === 'userb@v016' ? client016 : id === 'userb@v10' ? client10 : undefined),
      // The 1.0 login first: matching the folder's account id against each
      // login's own used to pick it for the 0.16.23 login's folders too.
      getAllConnectedClients: () => new Map([['userb@v10', client10], ['userb@v016', client016]]),
    } as never);
    useEmailStore.setState({
      isUnifiedView: false,
      selectedKeyword: null,
      searchQuery: '',
      viewingAccountId: null,
      selectedMailbox: 'a',
      mailboxes: [mailbox({ id: 'a', name: 'Inbox', role: 'inbox' }), mailbox({})],
      selectedEmailKeys: new Set(),
      moveEmailsToMailbox: moveEmailsToMailbox as never,
      crossAccountMoveEmails: crossAccountMoveEmails as never,
      refreshCurrentMailbox: vi.fn().mockResolvedValue(undefined) as never,
    });
    drag.sourceMailboxId = 'a';
    drag.draggedEmails = [email({ id: 'm1' })];
  });

  const drop = async (target: Mailbox, ids: string[], accountId?: string) => {
    const { result } = renderHook(() => useMailboxDrop({ mailbox: target, accountId, onSuccess: () => {}, onError: () => {} }));
    await act(async () => { result.current.dropHandlers.onDrop(dropEvent(ids)); });
  };

  it('lets the store move a drop from the unified view, into the folder of the login it is listed under', async () => {
    useEmailStore.setState({ isUnifiedView: true, selectedMailbox: '__unified_inbox' });
    drag.sourceMailboxId = '__unified_inbox';
    drag.draggedEmails = [
      email({ id: 'm016', accountId: 'userb@v016', sourceClientAccountId: 'userb@v016', sourceAccountId: 'e' }),
      email({ id: 't016', accountId: 'c', sourceClientAccountId: 'userb@v016', sourceAccountId: 'c' }),
    ];

    await drop(mailbox({}), ['m016', 't016'], 'userb@v10');
    await drop(mailbox({}), ['m016', 't016']);

    expect(moveEmailsToMailbox.mock.calls).toEqual([
      [client016, ['m016', 't016'], 'f', 'userb@v10', drag.draggedEmails, []],
      [client016, ['m016', 't016'], 'f', 'userb@v016', drag.draggedEmails, []],
    ]);
    expect(crossAccountMoveEmails).not.toHaveBeenCalled();
  });

  // The team's `x` and usera's own `x` are unrelated messages; one of them
  // is dragged.
  it('hands the store the dragged row, not only its id, in a list that mixes accounts', async () => {
    useEmailStore.setState({ isUnifiedView: true, selectedMailbox: '__unified_inbox' });
    drag.sourceMailboxId = '__unified_inbox';
    const dragged = email({ id: 'x', sourceClientAccountId: 'userb@v016', sourceAccountId: 'c' });
    drag.draggedEmails = [dragged];

    await drop(mailbox({}), ['x']);

    expect(moveEmailsToMailbox).toHaveBeenCalledWith(client016, ['x'], 'f', 'userb@v016', [dragged], []);
  });

  it('moves a drop onto another login\'s folder across accounts, although both logins are account `e`', async () => {
    useAuthStore.setState({
      getAllConnectedClients: () => new Map([['userb@v016', client016], ['userb@v10', client10]]),
    } as never);

    await drop(mailbox({}), ['m1'], 'userb@v10');

    expect(crossAccountMoveEmails).toHaveBeenCalledWith(new Map([['userb@v016', ['m1']]]), 'userb@v10', 'f', undefined, undefined, { receipts: [] });
    expect(moveEmailsToMailbox).not.toHaveBeenCalled();
  });

  it('moves a drop onto the active login\'s own folder in place', async () => {
    await drop(mailbox({}), ['m1']);

    expect(moveEmailsToMailbox).toHaveBeenCalledWith(client016, ['m1'], 'f');
    expect(crossAccountMoveEmails).not.toHaveBeenCalled();
  });

  // mail-p3-7: the toast counts what the list shows, conversations when it groups them.
  it('counts the conversations dropped, or the emails with conversations off', async () => {
    drag.draggedEmails = [
      email({ id: 'a1', threadId: 'ta' }), email({ id: 'a2', threadId: 'ta' }),
      email({ id: 'b1', threadId: 'tb' }), email({ id: 'b2', threadId: 'tb' }),
    ];
    const counts: number[] = [];
    const dropCounting = async () => {
      const { result } = renderHook(() => useMailboxDrop({ mailbox: mailbox({}), onSuccess: (count) => { counts.push(count); }, onError: () => {} }));
      await act(async () => { result.current.dropHandlers.onDrop(dropEvent(['a1', 'a2', 'b1', 'b2'])); });
    };
    useSettingsStore.setState({ disableThreading: false });
    await dropCounting();
    useSettingsStore.setState({ disableThreading: true });
    await dropCounting();
    expect(counts).toEqual([2, 4]);
  });
});
