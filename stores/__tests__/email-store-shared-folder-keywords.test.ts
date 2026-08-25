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
      selectedEmailIds: new Set<string>(),
    } as never);
  });

  it('setEmailKeywords writes tags to the OWNER account, not the reaching account', async () => {
    await useEmailStore.getState().setEmailKeywords(activeClient, 'e1', { '$label:work': true });

    expect(activeClient.updateEmailKeywords).toHaveBeenCalledWith(
      'e1',
      { '$label:work': true },
      'owner-x',
    );
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

    expect(activeClient.updateEmailKeywords).toHaveBeenCalledWith(
      'o1',
      { '$label:work': true },
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

    expect(activeClient.updateEmailKeywords).toHaveBeenCalledWith(
      'u1',
      { '$label:work': true },
      'owner-y',
    );
  });
});
