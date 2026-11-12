import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { threadKeyFor } from '@/lib/thread-utils';
import { useAuthStore } from '@/stores/auth-store';
import { resolveEmailActionContext, useEmailStore } from '@/stores/email-store';
import { refreshRepliedThread } from '../replied-thread';

// After a reply in a list that mixes logins (the unified inbox), the
// answered message's conversation is read again through its own login and
// put into the thread cache. The expanded conversation's rows are those
// cached messages, and actions on them route by their stamps
// (resolveEmailActionContext): fetchThreadEmails restamps what it reads for
// that reason. Messages put in by refreshRepliedThread must carry the
// conversation's login and account too; unstamped, an action on one of them
// in the unified inbox goes to the active login's own account, where the
// same id is another message. A row of a folder of one account carries no
// stamps, and its conversation's messages get none: the folder decides.
//
// Harness of replied-thread.test.ts.

const ID = 'eaaaaab';
const THREAD = 'c';
const row = (stamps: Partial<Email> = {}): Email => ({
  id: ID, threadId: THREAD, subject: 'Hello', receivedAt: '2026-11-11T10:00:00Z', keywords: {}, mailboxIds: { a: true }, ...stamps,
}) as Email;
const folder = (id: string, accountId: string): Mailbox => ({
  id, originalId: id, name: 'Inbox', role: 'inbox', accountId, isShared: false,
}) as Mailbox;
const makeClient = (account: string) => ({
  getAccountId: () => account,
  getThreadEmails: vi.fn(async () => [
    { ...row(), subject: 'answered' } as Email,
    { ...row(), id: 'iaaaaac', subject: 'the reply' } as Email,
  ]),
});

const original = { auth: useAuthStore.getState(), email: useEmailStore.getState() };
let a: ReturnType<typeof makeClient>;
let b: ReturnType<typeof makeClient>;

beforeEach(() => {
  a = makeClient('ee');
  b = makeClient('ef');
  const connected = new Map([['login-a', a], ['login-b', b]]);
  useAuthStore.setState({
    activeAccountId: 'login-a', client: a as never,
    getClientForAccount: ((id: string) => connected.get(id)) as never,
  } as never);
});
afterEach(() => {
  useAuthStore.setState(original.auth);
  useEmailStore.setState(original.email);
});

describe('the conversation refreshed after a reply in the unified inbox', () => {
  it('keeps its messages on the conversation\'s login and account', async () => {
    const ofB = row({ sourceClientAccountId: 'login-b', sourceAccountId: 'ef' });
    useEmailStore.setState({
      isUnifiedView: true, viewingAccountId: null, selectedMailbox: '__unified_inbox__', mailboxes: [folder('a', 'ee')], accountMailboxes: {},
      searchQuery: '', emails: [ofB],
      expandedThreadIds: new Set([threadKeyFor(ofB)]), threadEmailsCache: new Map(),
    } as never);

    await refreshRepliedThread(ID, { clientAccountId: 'login-b', accountId: 'ef' }, a as never);

    const members = useEmailStore.getState().threadEmailsCache.get(threadKeyFor(ofB)) ?? [];
    expect(members.map((m) => m.subject)).toEqual(['answered', 'the reply']);
    for (const member of members) {
      // Where an action on that row of the expanded conversation goes.
      const target = resolveEmailActionContext(member, a as never);
      expect(target.client).toBe(b);
      expect(target.accountId ?? 'ee').toBe('ef');
    }
  });

  it('a message of it opened from the conversation and tagged in the reader is tagged in its own login, not the active one', async () => {
    const ofB = row({ sourceClientAccountId: 'login-b', sourceAccountId: 'ef' });
    const writeA = vi.fn(async () => {});
    const writeB = vi.fn(async () => {});
    Object.assign(a, { batchUpdateKeywords: writeA });
    Object.assign(b, { batchUpdateKeywords: writeB });
    useEmailStore.setState({
      isUnifiedView: true, viewingAccountId: null, selectedMailbox: '__unified_inbox__', mailboxes: [folder('a', 'ee')], accountMailboxes: {},
      searchQuery: '', emails: [ofB], selectedEmail: null, processingReadStatus: new Set(),
      expandedThreadIds: new Set([threadKeyFor(ofB)]), threadEmailsCache: new Map(),
    } as never);

    await refreshRepliedThread(ID, { clientAccountId: 'login-b', accountId: 'ef' }, a as never);
    const reply = (useEmailStore.getState().threadEmailsCache.get(threadKeyFor(ofB)) ?? []).find((m) => m.id === 'iaaaaac')!;
    // The list's click on a row of the expanded conversation selects it.
    useEmailStore.setState({ selectedEmail: reply } as never);
    // The reader's tag menu: patchEmailKeywords for the open message.
    await useEmailStore.getState().patchEmailKeywords(a as never, reply.id, { '$label:work': true }).catch(() => {});

    expect(writeA).not.toHaveBeenCalled();
  });
});

describe('the conversation refreshed after a reply in a folder of one account', () => {
  it('of a login browsed in the sidebar stays unstamped, and its messages act through that login', async () => {
    const browsed = row();
    useEmailStore.setState({
      isUnifiedView: false, viewingAccountId: 'login-b', selectedMailbox: 'a', mailboxes: [folder('a', 'ee')], accountMailboxes: { 'login-b': [folder('a', 'ef')] },
      searchQuery: '', emails: [browsed],
      expandedThreadIds: new Set([threadKeyFor(browsed)]), threadEmailsCache: new Map(),
    } as never);

    await refreshRepliedThread(ID, { clientAccountId: 'login-b', accountId: 'ef' }, a as never);

    const members = useEmailStore.getState().threadEmailsCache.get(threadKeyFor(browsed)) ?? [];
    expect(members).toHaveLength(2);
    for (const member of members) {
      expect(member.sourceClientAccountId).toBeUndefined();
      expect(resolveEmailActionContext(member, a as never).client).toBe(b);
    }
  });

  it('of the own Inbox stays unstamped, and its messages act through the active login, as before', async () => {
    const ownRow = row();
    useEmailStore.setState({
      isUnifiedView: false, viewingAccountId: null, selectedMailbox: 'a', mailboxes: [folder('a', 'ee')], accountMailboxes: {},
      searchQuery: '', emails: [ownRow],
      expandedThreadIds: new Set([threadKeyFor(ownRow)]), threadEmailsCache: new Map(),
    } as never);

    await refreshRepliedThread(ID, { clientAccountId: 'login-a', accountId: undefined }, a as never);

    const members = useEmailStore.getState().threadEmailsCache.get(threadKeyFor(ownRow)) ?? [];
    expect(members).toHaveLength(2);
    for (const member of members) {
      expect(member.sourceClientAccountId).toBeUndefined();
      expect(member.sourceAccountId).toBeUndefined();
      expect(resolveEmailActionContext(member, a as never).client).toBe(a);
    }
  });
});
