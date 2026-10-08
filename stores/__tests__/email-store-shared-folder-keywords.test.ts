import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Regression coverage for keyword writes (tags, $pinned, $answered/$forwarded,
// $mdnsent) performed while viewing a shared/group mailbox DIRECTLY from the
// "Shared" sidebar section, rather than through the unified inbox.
//
// Same shape as email-store-shared-folder-actions.test.ts: in this view the
// emails are undecorated (no `sourceAccountId`) because they are fetched from
// the owner account through the active login client. The keyword call sites
// resolved the target account as `isUnifiedView ? email.sourceAccountId :
// undefined`, so outside the unified view the write went to the reaching
// client's own account. Stalwart answers that with `notUpdated` / an unchanged
// state and no error, so the UI showed the tag until the next reload and then
// silently lost it.
//
// `toggleStar` never had the bug because it routes through
// `resolveEmailActionContext`, which resolves the owner from the selected
// mailbox when the email carries no source reference. These tests pin the
// keyword paths to that same resolver.

function makeMailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: 'inbox',
    name: 'Inbox',
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

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'email-1',
    threadId: 'thread-1',
    subject: 'Hi',
    receivedAt: new Date().toISOString(),
    keywords: {},
    mailboxIds: {},
    ...overrides,
  } as Email;
}

function makeClient() {
  return {
    updateEmailKeywords: vi.fn().mockResolvedValue(undefined),
    batchUpdateKeywords: vi.fn().mockResolvedValue(undefined),
    setKeyword: vi.fn().mockResolvedValue(undefined),
    toggleStar: vi.fn().mockResolvedValue(undefined),
  } as unknown as IJMAPClient;
}

describe('non-unified shared-folder keyword routing', () => {
  let activeClient: IJMAPClient; // account-a, the logged-in user, also reaches owner-x

  beforeEach(() => {
    activeClient = makeClient();

    // Only the active login exists; the shared owner 'owner-x' is reached
    // THROUGH it (a group mailbox has no separate login client).
    useAuthStore.setState({
      activeAccountId: 'account-a',
      getClientForAccount: (id: string) => (id === 'account-a' ? activeClient : undefined) as never,
    } as never);

    // Viewing the shared inbox directly: not unified, no viewingAccountId.
    useEmailStore.setState({
      isUnifiedView: false,
      unifiedRole: null,
      viewingAccountId: null,
      selectedMailbox: 'owner-x:x-inbox',
      mailboxes: [
        makeMailbox({ id: 'a-inbox', role: 'inbox' }),
        makeMailbox({
          id: 'owner-x:x-inbox',
          originalId: 'x-inbox',
          name: 'Shared Inbox',
          role: 'inbox',
          isShared: true,
          accountId: 'owner-x',
        }),
      ],
      accountMailboxes: {},
      selectedEmail: null,
      emails: [makeEmail({ id: 'e1', keywords: {}, mailboxIds: { 'owner-x:x-inbox': true } })],
      selectedEmailKeys: new Set<string>(),
    } as never);
  });

  it('setEmailKeywords writes tags to the OWNER account, not the reaching account', async () => {
    await useEmailStore.getState().setEmailKeywords(activeClient, 'e1', { '$label:work': true });

    expect(activeClient.batchUpdateKeywords).toHaveBeenCalledWith(
      ['e1'],
      { 'keywords/$label:work': true },
      'owner-x',
    );
  });

  it('writes only the keywords that change, not the whole set from the row', async () => {
    // The row is stale: another client has since marked the mail read. A
    // whole-map write from this row would clear $seen again.
    useEmailStore.setState({
      emails: [makeEmail({ id: 'e1', keywords: { $flagged: true }, mailboxIds: { 'owner-x:x-inbox': true } })],
    } as never);

    await useEmailStore.getState().setEmailKeywords(activeClient, 'e1', { $flagged: true, '$label:work': true });

    expect(activeClient.updateEmailKeywords).not.toHaveBeenCalled();
    expect(activeClient.batchUpdateKeywords).toHaveBeenCalledWith(['e1'], { 'keywords/$label:work': true }, 'owner-x');
  });

  it('clears a keyword with null rather than writing false', async () => {
    useEmailStore.setState({
      emails: [makeEmail({ id: 'e1', keywords: { '$label:work': true }, mailboxIds: { 'owner-x:x-inbox': true } })],
    } as never);

    await useEmailStore.getState().patchEmailKeywords(activeClient, 'e1', { '$label:work': false });

    expect(activeClient.batchUpdateKeywords).toHaveBeenCalledWith(['e1'], { 'keywords/$label:work': null }, 'owner-x');
    expect(useEmailStore.getState().emails.find(e => e.id === 'e1')?.keywords).toEqual({});
  });

  it('setEmailKeywords patches local state so the tag shows immediately', async () => {
    await useEmailStore.getState().setEmailKeywords(activeClient, 'e1', { '$label:work': true });

    expect(useEmailStore.getState().emails.find(e => e.id === 'e1')?.keywords).toEqual({
      '$label:work': true,
    });
  });

  it('markEmailKeyword writes $answered to the OWNER account', async () => {
    await useEmailStore.getState().markEmailKeyword(activeClient, 'e1', '$answered');

    expect(activeClient.setKeyword).toHaveBeenCalledWith('e1', '$answered', 'owner-x');
  });

  it('routes a keyword write for an email that is only the selected email', async () => {
    // The read-receipt ($mdnsent) path acts on the open message, which is not
    // necessarily in the current `emails` page.
    useEmailStore.setState({
      emails: [],
      selectedEmail: makeEmail({ id: 'open-1', mailboxIds: { 'owner-x:x-inbox': true } }),
    } as never);

    await useEmailStore.getState().markEmailKeyword(activeClient, 'open-1', '$mdnsent');

    expect(activeClient.setKeyword).toHaveBeenCalledWith('open-1', '$mdnsent', 'owner-x');
  });

  it('does NOT guess an owner for an email the store does not know', async () => {
    // A Pro tab fetches its own email and never puts it in `emails` or
    // `selectedEmail`. The selected mailbox says nothing about that message's
    // owner, so routing by it would send an own-account write to the shared
    // account merely because a shared folder happened to be open. Such a write
    // must keep the previous behaviour: no explicit accountId.
    useEmailStore.setState({ emails: [], selectedEmail: null } as never);

    await useEmailStore.getState().markEmailKeyword(activeClient, 'tab-only', '$mdnsent');

    expect(activeClient.setKeyword).toHaveBeenCalledWith('tab-only', '$mdnsent', undefined);
  });

  it('leaves own-account keyword writes untouched (no JMAP accountId)', async () => {
    // Selecting the user's own inbox must still write to the own account with
    // no explicit accountId, exactly as before.
    useEmailStore.setState({
      selectedMailbox: 'a-inbox',
      emails: [makeEmail({ id: 'o1', keywords: {}, mailboxIds: { 'a-inbox': true } })],
    } as never);

    await useEmailStore.getState().setEmailKeywords(activeClient, 'o1', { '$label:work': true });

    expect(activeClient.batchUpdateKeywords).toHaveBeenCalledWith(
      ['o1'],
      { 'keywords/$label:work': true },
      undefined,
    );
  });

  it('still routes by the email source in the unified view', async () => {
    // The aggregate path keeps precedence: a decorated email routes to its own
    // source account even though a different mailbox is selected.
    useEmailStore.setState({
      isUnifiedView: true,
      selectedMailbox: 'a-inbox',
      emails: [
        makeEmail({
          id: 'u1',
          sourceClientAccountId: 'account-a',
          sourceAccountId: 'owner-y',
          mailboxIds: {},
        }),
      ],
    } as never);

    await useEmailStore.getState().setEmailKeywords(activeClient, 'u1', { '$label:work': true });

    expect(activeClient.batchUpdateKeywords).toHaveBeenCalledWith(
      ['u1'],
      { 'keywords/$label:work': true },
      'owner-y',
    );
  });
});

describe('batchSetTag (#1077)', () => {
  let client: IJMAPClient;
  const fetchTagCounts = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    client = makeClient();
    fetchTagCounts.mockClear();
    useAuthStore.setState({
      activeAccountId: 'account-a',
      getClientForAccount: (id: string) => (id === 'account-a' ? client : undefined) as never,
    } as never);
    useEmailStore.setState({
      isUnifiedView: false,
      unifiedRole: null,
      viewingAccountId: null,
      selectedKeyword: null,
      selectedMailbox: 'a-inbox',
      mailboxes: [makeMailbox({ id: 'a-inbox', role: 'inbox' })],
      accountMailboxes: {},
      selectedEmail: null,
      emails: [
        makeEmail({ id: 'e1', keywords: { $seen: true, '$label:home': true } }),
        makeEmail({ id: 'e2', keywords: { '$label:work': true } }),
        makeEmail({ id: 'e3', keywords: { '$color:work': true } }),
        makeEmail({ id: 'e4', keywords: {} }),
      ],
      selectedEmailKeys: new Set(['e1', 'e2', 'e3']),
      fetchTagCounts,
    } as never);
  });

  const keywordsOf = (id: string) => useEmailStore.getState().emails.find(e => e.id === id)?.keywords;

  it('adds the tag to the selected messages that lack it and keeps their other keywords', async () => {
    await useEmailStore.getState().batchSetTag(client, 'work', true);

    // e2 and e3 already carry it (e3 under the legacy prefix); e4 is not selected.
    expect(client.batchUpdateKeywords).toHaveBeenCalledTimes(1);
    expect(client.batchUpdateKeywords).toHaveBeenCalledWith(['e1'], { 'keywords/$label:work': true }, undefined);
    expect(keywordsOf('e1')).toEqual({ $seen: true, '$label:home': true, '$label:work': true });
    expect(keywordsOf('e4')).toEqual({});
    expect(useEmailStore.getState().selectedEmailKeys.size).toBe(3);
    expect(fetchTagCounts).toHaveBeenCalled();
  });

  it('removes the tag under either prefix and leaves other tags alone', async () => {
    await useEmailStore.getState().batchSetTag(client, 'work', false);

    expect(client.batchUpdateKeywords).toHaveBeenCalledWith(
      ['e2', 'e3'],
      { 'keywords/$label:work': null, 'keywords/$color:work': null },
      undefined,
    );
    expect(keywordsOf('e1')).toEqual({ $seen: true, '$label:home': true });
    expect(keywordsOf('e2')).toEqual({});
    expect(keywordsOf('e3')).toEqual({});
  });

  it('writes each message to its own account in an aggregate view', async () => {
    const other = makeClient();
    useAuthStore.setState({
      getClientForAccount: (id: string) => (id === 'account-a' ? client : id === 'account-b' ? other : undefined) as never,
    } as never);
    useEmailStore.setState({
      isUnifiedView: true,
      emails: [
        makeEmail({ id: 'e1', sourceClientAccountId: 'account-a', sourceAccountId: 'jmap-a' }),
        makeEmail({ id: 'e2', sourceClientAccountId: 'account-b', sourceAccountId: 'jmap-b' }),
      ],
      selectedEmailKeys: new Set(['account-a/jmap-a:e1', 'account-b/jmap-b:e2']),
    } as never);

    await useEmailStore.getState().batchSetTag(client, 'work', true);

    expect(client.batchUpdateKeywords).toHaveBeenCalledWith(['e1'], { 'keywords/$label:work': true }, 'jmap-a');
    expect(other.batchUpdateKeywords).toHaveBeenCalledWith(['e2'], { 'keywords/$label:work': true }, 'jmap-b');
  });

  it('leaves a namesake in another account alone', async () => {
    const other = makeClient();
    useAuthStore.setState({
      getClientForAccount: (id: string) => (id === 'account-a' ? client : id === 'account-b' ? other : undefined) as never,
    } as never);
    useEmailStore.setState({
      isUnifiedView: true,
      emails: [
        makeEmail({ id: 'e1', sourceClientAccountId: 'account-a', sourceAccountId: 'jmap-a' }),
        makeEmail({ id: 'e1', sourceClientAccountId: 'account-b', sourceAccountId: 'jmap-b' }),
      ],
      selectedEmailKeys: new Set(['account-a/jmap-a:e1']),
    } as never);

    await useEmailStore.getState().batchSetTag(client, 'work', true);

    expect(client.batchUpdateKeywords).toHaveBeenCalledWith(['e1'], { 'keywords/$label:work': true }, 'jmap-a');
    expect(other.batchUpdateKeywords).not.toHaveBeenCalled();
    const [mine, namesake] = useEmailStore.getState().emails;
    expect(mine.keywords).toEqual({ '$label:work': true });
    expect(namesake.keywords ?? {}).toEqual({});
  });

  it('rejects and leaves the rows untouched when the write fails', async () => {
    vi.mocked(client.batchUpdateKeywords).mockRejectedValueOnce(new Error('nope'));

    await expect(useEmailStore.getState().batchSetTag(client, 'work', true)).rejects.toThrow('nope');
    expect(keywordsOf('e1')).toEqual({ $seen: true, '$label:home': true });
  });
});
