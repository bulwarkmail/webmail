import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { threadKeyFor } from '@/lib/thread-utils';
import { CROSS_ALL } from '@/lib/jmap/types';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

/**
 * #1012: JMAP thread ids are only unique within their account - Stalwart hands
 * out per-account counters such as "b" - so in the cross-account views two
 * accounts routinely list a thread "b" that has nothing in common. Thread state
 * has to be keyed by the account-scoped thread key, and thread fetches routed
 * to the account that owns the thread.
 */

const makeMailbox = (overrides: Partial<Mailbox> = {}): Mailbox => ({
  id: 'inbox',
  name: 'Inbox',
  role: 'inbox',
  sortOrder: 0,
  totalEmails: 0,
  unreadEmails: 0,
  totalThreads: 0,
  unreadThreads: 0,
  myRights: {
    mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true,
    maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true,
  },
  isSubscribed: true,
  isShared: false,
  ...overrides,
});

type Login = 'a' | 'b';

// Both accounts have a thread "b"; only the source stamps tell them apart.
const inAccount = (login: Login, id: string, overrides: Partial<Email> = {}): Email =>
  ({
    id,
    threadId: 'b',
    mailboxIds: { inbox: true },
    keywords: {},
    size: 1,
    receivedAt: '2026-09-10T10:00:00Z',
    from: [{ email: `${login}@example.com` }],
    subject: id,
    preview: '',
    hasAttachment: false,
    accountId: `login-${login}`,
    accountLabel: `${login}@example.com`,
    sourceClientAccountId: `login-${login}`,
    sourceAccountId: `acct-${login}`,
    ...overrides,
  }) as unknown as Email;

function makeClient(login: Login, threadSize: number) {
  return {
    getAccountId: () => `acct-${login}`,
    getThreads: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, emailIds: Array.from({ length: threadSize }, (_, i) => `${login}-${id}-${i}`) })),
    ),
    batchMarkAsRead: vi.fn(async () => {}),
    getThreadEmails: vi.fn(async (threadId: string) => [
      inAccount(login, `${login}-full-1`, { threadId, sourceClientAccountId: undefined, sourceAccountId: undefined }),
      inAccount(login, `${login}-full-2`, { threadId, sourceClientAccountId: undefined, sourceAccountId: undefined }),
    ]),
  } as unknown as IJMAPClient & {
    getThreads: ReturnType<typeof vi.fn>;
    getThreadEmails: ReturnType<typeof vi.fn>;
    batchMarkAsRead: ReturnType<typeof vi.fn>;
  };
}

describe('thread identity across accounts (#1012)', () => {
  let clientA: ReturnType<typeof makeClient>;
  let clientB: ReturnType<typeof makeClient>;
  const a1 = inAccount('a', 'a1');
  const b1 = inAccount('b', 'b1');

  beforeEach(() => {
    clientA = makeClient('a', 3);
    clientB = makeClient('b', 1);
    useAuthStore.setState({
      activeAccountId: 'login-a',
      getClientForAccount: (id: string) =>
        (id === 'login-a' ? clientA : id === 'login-b' ? clientB : undefined) as never,
    } as never);
    useEmailStore.setState({
      isUnifiedView: true,
      unifiedRole: null,
      crossView: 'all',
      selectedMailbox: CROSS_ALL,
      viewingAccountId: null,
      mailboxes: [makeMailbox()],
      accountMailboxes: { 'acct-a': [makeMailbox()], 'acct-b': [makeMailbox()] },
      emails: [a1, b1],
      expandedThreadIds: new Set(),
      threadEmailsCache: new Map(),
      threadEmailCounts: new Map(),
      isLoadingThread: null,
      processingReadStatus: new Set(),
    });
  });

  it('asks each account for its own threads and files the counts under the scoped key', async () => {
    await useEmailStore.getState().fetchThreadEmailCounts(clientA);

    expect(clientA.getThreads).toHaveBeenCalledWith(['b'], 'acct-a');
    expect(clientB.getThreads).toHaveBeenCalledWith(['b'], 'acct-b');
    const counts = useEmailStore.getState().threadEmailCounts;
    expect(counts.get(threadKeyFor(a1))).toBe(3);
    expect(counts.get(threadKeyFor(b1))).toBe(1);
    // The bare id must not be a key any more: it could only ever hold one
    // account's answer.
    expect(counts.has('b')).toBe(false);
  });

  it('fetches a thread from the account that owns it and caches it under the scoped key', async () => {
    const emails = await useEmailStore.getState().fetchThreadEmails(clientA, threadKeyFor(b1));

    expect(clientB.getThreadEmails).toHaveBeenCalledWith('b', 'acct-b');
    expect(clientA.getThreadEmails).not.toHaveBeenCalled();
    expect(emails.map((e) => e.id)).toEqual(['b-full-1', 'b-full-2']);
    // Re-stamped with the owning account so later actions route correctly.
    expect(emails.every((e) => e.sourceAccountId === 'acct-b' && e.sourceClientAccountId === 'login-b')).toBe(true);

    const cache = useEmailStore.getState().threadEmailsCache;
    expect(cache.has(threadKeyFor(b1))).toBe(true);
    expect(cache.has(threadKeyFor(a1))).toBe(false);
    expect(cache.has('b')).toBe(false);
  });

  it('marks only the owning account\'s messages read when a thread is expanded', async () => {
    await useEmailStore.getState().markThreadAsRead(clientA, threadKeyFor(a1));

    expect(clientA.batchMarkAsRead).toHaveBeenCalledWith(['a1'], true);
    expect(clientB.batchMarkAsRead).not.toHaveBeenCalled();
    const byId = new Map(useEmailStore.getState().emails.map((e) => [e.id, e]));
    expect(byId.get('a1')?.keywords?.$seen).toBe(true);
    expect(byId.get('b1')?.keywords?.$seen).toBeUndefined();
  });

  it('keeps expansion state apart for same-id threads of different accounts', () => {
    useEmailStore.getState().toggleThreadExpansion(threadKeyFor(a1));

    const expanded = useEmailStore.getState().expandedThreadIds;
    expect(expanded.has(threadKeyFor(a1))).toBe(true);
    expect(expanded.has(threadKeyFor(b1))).toBe(false);
  });
});
