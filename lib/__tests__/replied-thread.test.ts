import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { threadKeyFor } from '@/lib/thread-utils';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { refreshRepliedThread } from '../replied-thread';

// After a reply, the answered message's conversation is read again if it is
// expanded in the list. Message and thread ids repeat across accounts and
// logins (`eaaaaab` in thread `c` is everybody's first message), so the
// conversation has to be the answered message's own: read through its login,
// in its account, and kept under its own row's key.

const ID = 'eaaaaab';
const THREAD = 'c';
const row = (stamps: Partial<Email> = {}): Email => ({
  id: ID, threadId: THREAD, subject: 'Hello', receivedAt: '2026-11-11T10:00:00Z', keywords: {}, mailboxIds: { a: true }, ...stamps,
}) as Email;
const folder = (id: string, accountId: string, shared = false): Mailbox => ({
  id: shared ? `${accountId}:${id}` : id, originalId: id, name: 'Inbox', role: 'inbox', accountId, isShared: shared,
}) as Mailbox;
const makeClient = (account: string) => ({
  getAccountId: () => account,
  getThreadEmails: vi.fn(async (_threadId: string, accountId?: string) => [{ ...row(), subject: `thread of ${accountId}` } as Email]),
});

const original = { auth: useAuthStore.getState(), email: useEmailStore.getState() };
let a: ReturnType<typeof makeClient>;
let b: ReturnType<typeof makeClient>;
let connected: Map<string, ReturnType<typeof makeClient>>;

beforeEach(() => {
  a = makeClient('ee');
  b = makeClient('ef');
  connected = new Map([['login-a', a], ['login-b', b]]);
  useAuthStore.setState({
    activeAccountId: 'login-a', client: a as never,
    getClientForAccount: ((id: string) => connected.get(id)) as never,
  } as never);
});
afterEach(() => {
  useAuthStore.setState(original.auth);
  useEmailStore.setState(original.email);
});

const cached = (key: string) => useEmailStore.getState().threadEmailsCache.get(key)?.[0]?.subject;

describe('the conversation refreshed after a reply', () => {
  it('in a list that mixes logins is the answered row\'s, read through its login', async () => {
    const ofA = row({ sourceClientAccountId: 'login-a', sourceAccountId: 'ee' });
    const ofB = row({ sourceClientAccountId: 'login-b', sourceAccountId: 'ef' });
    useEmailStore.setState({
      isUnifiedView: true, viewingAccountId: null, selectedMailbox: '__unified_inbox__', mailboxes: [folder('a', 'ee')], accountMailboxes: {},
      searchQuery: '', emails: [ofA, ofB],
      expandedThreadIds: new Set([threadKeyFor(ofA), threadKeyFor(ofB)]), threadEmailsCache: new Map(),
    } as never);

    await refreshRepliedThread(ID, { clientAccountId: 'login-b', accountId: 'ef' }, a as never);

    expect(b.getThreadEmails).toHaveBeenCalledWith(THREAD, 'ef');
    expect(a.getThreadEmails).not.toHaveBeenCalled();
    expect(cached(threadKeyFor(ofB))).toBe('thread of ef');
    expect(cached(threadKeyFor(ofA))).toBeUndefined();
  });

  it('is not read for a listed row of another account with the same id', async () => {
    // The reply answered the own message (a Pro tab); the Mail tab lists the team's Inbox.
    const teamRow = row();
    useEmailStore.setState({
      isUnifiedView: false, viewingAccountId: null, selectedMailbox: 'ed:a', mailboxes: [folder('a', 'ee'), folder('a', 'ed', true)], accountMailboxes: {},
      searchQuery: '', emails: [teamRow],
      expandedThreadIds: new Set([threadKeyFor(teamRow)]), threadEmailsCache: new Map(),
    } as never);

    await refreshRepliedThread(ID, { clientAccountId: 'login-a', accountId: 'ee' }, a as never);

    expect(a.getThreadEmails).not.toHaveBeenCalled();
    expect(useEmailStore.getState().threadEmailsCache.size).toBe(0);
  });

  it('of a row in a folder of another login browsed in the sidebar is read through that login, not the active one', async () => {
    const browsed = row();
    useEmailStore.setState({
      isUnifiedView: false, viewingAccountId: 'login-b', selectedMailbox: 'a', mailboxes: [folder('a', 'ee')], accountMailboxes: { 'login-b': [folder('a', 'ef')] },
      searchQuery: '', emails: [browsed],
      expandedThreadIds: new Set([threadKeyFor(browsed)]), threadEmailsCache: new Map(),
    } as never);

    await refreshRepliedThread(ID, { clientAccountId: 'login-b', accountId: 'ef' }, a as never);

    expect(b.getThreadEmails).toHaveBeenCalledWith(THREAD, 'ef');
    expect(a.getThreadEmails).not.toHaveBeenCalled();
  });

  it('is not read through the active login while the row\'s login has no client', async () => {
    connected.delete('login-b');
    const ofB = row({ sourceClientAccountId: 'login-b', sourceAccountId: 'ef' });
    useEmailStore.setState({
      isUnifiedView: true, viewingAccountId: null, selectedMailbox: '__unified_inbox__', mailboxes: [folder('a', 'ee')], accountMailboxes: {},
      searchQuery: '', emails: [ofB],
      expandedThreadIds: new Set([threadKeyFor(ofB)]), threadEmailsCache: new Map(),
    } as never);

    await refreshRepliedThread(ID, { clientAccountId: 'login-b', accountId: 'ef' }, a as never);

    expect(a.getThreadEmails).not.toHaveBeenCalled();
    expect(useEmailStore.getState().threadEmailsCache.size).toBe(0);
  });

  it('of the own message in its own folder is read as before', async () => {
    const ownRow = row();
    useEmailStore.setState({
      isUnifiedView: false, viewingAccountId: null, selectedMailbox: 'a', mailboxes: [folder('a', 'ee')], accountMailboxes: {},
      searchQuery: '', emails: [ownRow],
      expandedThreadIds: new Set([threadKeyFor(ownRow)]), threadEmailsCache: new Map(),
    } as never);

    await refreshRepliedThread(ID, { clientAccountId: 'login-a', accountId: undefined }, a as never);

    expect(a.getThreadEmails).toHaveBeenCalledWith(THREAD, 'ee');
    expect(cached(threadKeyFor(ownRow))).toBe('thread of ee');
  });

  it('is left alone while it is not expanded', async () => {
    useEmailStore.setState({
      isUnifiedView: false, viewingAccountId: null, selectedMailbox: 'a', mailboxes: [folder('a', 'ee')], accountMailboxes: {},
      searchQuery: '', emails: [row()], expandedThreadIds: new Set(), threadEmailsCache: new Map(),
    } as never);

    await refreshRepliedThread(ID, { clientAccountId: 'login-a' }, a as never);

    expect(a.getThreadEmails).not.toHaveBeenCalled();
  });
});
