import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import type { Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

function makeMailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: overrides.id ?? 'inbox',
    name: overrides.name ?? 'Inbox',
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: true,
      mayDelete: true,
      maySubmit: true,
    },
    isSubscribed: true,
    isShared: false,
    ...overrides,
  };
}

describe('useEmailStore multi-account state', () => {
  beforeEach(() => {
    useEmailStore.setState({
      accountMailboxes: {},
      viewingAccountId: null,
      selectedMailbox: '',
      selectedEmail: null,
      selectedEmailIds: new Set(),
      selectedKeyword: null,
      expandedThreadIds: new Set(),
      threadEmailsCache: new Map(),
      isLoadingThread: null,
    });
  });

  it('caches mailboxes per account via setAccountMailboxes', () => {
    const accountA = [makeMailbox({ id: 'a-inbox', name: 'A Inbox' })];
    const accountB = [makeMailbox({ id: 'b-inbox', name: 'B Inbox' })];

    useEmailStore.getState().setAccountMailboxes('account-a', accountA);
    useEmailStore.getState().setAccountMailboxes('account-b', accountB);

    expect(useEmailStore.getState().accountMailboxes).toEqual({
      'account-a': accountA,
      'account-b': accountB,
    });
  });

  it('replaces the cached entry when setAccountMailboxes is called again', () => {
    const initial = [makeMailbox({ id: 'a-inbox' })];
    const updated = [makeMailbox({ id: 'a-inbox' }), makeMailbox({ id: 'a-sent', name: 'Sent' })];

    useEmailStore.getState().setAccountMailboxes('account-a', initial);
    useEmailStore.getState().setAccountMailboxes('account-a', updated);

    expect(useEmailStore.getState().accountMailboxes['account-a']).toEqual(updated);
  });

  it('clearAccountMailboxes wipes the entire cache', () => {
    useEmailStore.getState().setAccountMailboxes('account-a', [makeMailbox()]);
    useEmailStore.getState().setAccountMailboxes('account-b', [makeMailbox()]);

    useEmailStore.getState().clearAccountMailboxes();

    expect(useEmailStore.getState().accountMailboxes).toEqual({});
  });

  it('setViewingAccount updates viewingAccountId without touching the mailbox cache', () => {
    useEmailStore.getState().setAccountMailboxes('account-a', [makeMailbox()]);
    useEmailStore.getState().setViewingAccount('account-a');
    expect(useEmailStore.getState().viewingAccountId).toBe('account-a');
    expect(useEmailStore.getState().accountMailboxes['account-a']).toBeDefined();

    useEmailStore.getState().setViewingAccount(null);
    expect(useEmailStore.getState().viewingAccountId).toBeNull();
  });

  it('selectAccountMailbox sets viewing and selected together, and clears email selection state', () => {
    useEmailStore.setState({
      selectedEmail: { id: 'e1' } as unknown as ReturnType<typeof useEmailStore.getState>['selectedEmail'],
      selectedEmailIds: new Set(['e1', 'e2']),
      selectedKeyword: 'work',
      expandedThreadIds: new Set(['thread-1']),
    });

    useEmailStore.getState().selectAccountMailbox('account-b', 'b-inbox');

    const state = useEmailStore.getState();
    expect(state.viewingAccountId).toBe('account-b');
    expect(state.selectedMailbox).toBe('b-inbox');
    expect(state.selectedEmail).toBeNull();
    expect(state.selectedEmailIds.size).toBe(0);
    expect(state.selectedKeyword).toBeNull();
    expect(state.expandedThreadIds.size).toBe(0);
  });

  it('selectAccountMailbox drops a search scope belonging to the account being left', () => {
    // The scope names a folder of the previous account and resolves against
    // resolveActionMailboxes(), which now returns the new account's list. Kept,
    // it would query that foreign folder id against the wrong account and come
    // back empty, while the dropdown has no matching option and reads "All
    // folders". (#1082)
    useEmailStore.setState({ searchMailboxId: 'a-archive' });

    useEmailStore.getState().selectAccountMailbox('account-b', 'b-inbox');

    expect(useEmailStore.getState().searchMailboxId).toBe('');
  });

  it('selectAccountMailbox with null accountId switches back to the active account', () => {
    useEmailStore.getState().selectAccountMailbox('account-b', 'b-inbox');
    expect(useEmailStore.getState().viewingAccountId).toBe('account-b');

    useEmailStore.getState().selectAccountMailbox(null, 'a-inbox');
    expect(useEmailStore.getState().viewingAccountId).toBeNull();
    expect(useEmailStore.getState().selectedMailbox).toBe('a-inbox');
  });

  it('fetchAccountMailboxes caches the result keyed by accountId', async () => {
    const mailboxes = [makeMailbox({ id: 'a-inbox' }), makeMailbox({ id: 'a-sent', name: 'Sent' })];
    const client = {
      getMailboxes: vi.fn().mockResolvedValue(mailboxes),
    } as unknown as IJMAPClient;

    await useEmailStore.getState().fetchAccountMailboxes(client, 'account-a');

    expect(client.getMailboxes).toHaveBeenCalledTimes(1);
    expect(useEmailStore.getState().accountMailboxes['account-a']).toEqual(mailboxes);
  });

  it('fetchAccountMailboxes leaves the cache untouched when the client throws', async () => {
    useEmailStore.getState().setAccountMailboxes('account-a', [makeMailbox({ id: 'a-inbox' })]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const client = {
      getMailboxes: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as IJMAPClient;

    await useEmailStore.getState().fetchAccountMailboxes(client, 'account-a');

    expect(useEmailStore.getState().accountMailboxes['account-a']).toEqual([
      makeMailbox({ id: 'a-inbox' }),
    ]);
    consoleError.mockRestore();
  });
});
