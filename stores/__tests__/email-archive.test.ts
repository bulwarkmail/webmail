import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
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

function makeEmail(id: string, threadId: string, mailboxId = 'inbox'): Email {
  return {
    id,
    threadId,
    mailboxIds: { [mailboxId]: true },
    keywords: {},
    size: 100,
    receivedAt: new Date().toISOString(),
    from: [{ name: 'Test', email: 'test@example.com' }],
    to: [{ name: 'User', email: 'user@example.com' }],
    subject: `Email ${id}`,
    preview: 'preview',
    hasAttachment: false,
    textBody: [],
    htmlBody: [],
    bodyValues: {},
  };
}

describe('email-store archive thread behavior', () => {
  beforeEach(() => {
    const inbox = makeMailbox({ id: 'shared-inbox', role: 'inbox', isShared: true, accountId: 'shared-account', originalId: 'server-inbox' });
    const archive = makeMailbox({ id: 'archive-local', role: 'archive', accountId: 'shared-account', originalId: 'server-archive' });
    const threadEmailA = makeEmail('email-1', 'thread-1', 'shared-inbox');
    const threadEmailB = makeEmail('email-2', 'thread-1', 'shared-inbox');
    const otherEmail = makeEmail('email-3', 'thread-2', 'shared-inbox');

    useEmailStore.setState({
      emails: [threadEmailA, threadEmailB, otherEmail],
      mailboxes: [inbox, archive],
      selectedMailbox: 'shared-inbox',
      selectedEmail: threadEmailA,
      selectedEmailKeys: new Set(['email-1', 'email-2']),
      expandedThreadIds: new Set(['thread-1']),
      threadEmailsCache: new Map([['thread-1', [threadEmailA, threadEmailB]]]),
      error: null,
    });
  });

  it("archives the thread's messages in the folder and removes cached thread state", async () => {
    const client = {
      getThread: vi.fn().mockResolvedValue({ id: 'thread-1', emailIds: ['email-1', 'email-2'] }),
      getEmailFields: vi.fn().mockResolvedValue([
        { id: 'email-1', mailboxIds: { 'server-inbox': true } },
        { id: 'email-2', mailboxIds: { 'server-inbox': true } },
      ]),
      batchMoveEmails: vi.fn().mockResolvedValue(undefined),
    } as unknown as IJMAPClient;

    await useEmailStore.getState().moveThreadToMailbox(client, 'email-1', 'archive-local');

    expect(client.getThread).toHaveBeenCalledWith('thread-1', 'shared-account');
    expect(client.batchMoveEmails).toHaveBeenCalledWith(['email-1', 'email-2'], 'server-archive', 'shared-account');

    const state = useEmailStore.getState();
    expect(state.emails.map(email => email.id)).toEqual(['email-3']);
    expect(state.selectedEmail?.id).toBe('email-3');
    expect(Array.from(state.selectedEmailKeys)).toEqual([]);
    expect(state.expandedThreadIds.has('thread-1')).toBe(false);
    expect(state.threadEmailsCache.has('thread-1')).toBe(false);
  });

  // Your own reply in Sent belongs to the conversation, but archiving the
  // Inbox copy leaves it in Sent, as Delete, Move and Spam do.
  it("leaves the conversation's message in Sent where it is", async () => {
    const client = {
      getThread: vi.fn().mockResolvedValue({ id: 'thread-1', emailIds: ['email-1', 'email-2', 'sent-1'] }),
      getEmailFields: vi.fn().mockResolvedValue([
        { id: 'email-1', mailboxIds: { 'server-inbox': true } },
        { id: 'email-2', mailboxIds: { 'server-inbox': true } },
        { id: 'sent-1', mailboxIds: { 'server-sent': true } },
      ]),
      batchMoveEmails: vi.fn().mockResolvedValue(undefined),
    } as unknown as IJMAPClient;

    await useEmailStore.getState().moveThreadToMailbox(client, 'email-1', 'archive-local');

    expect(client.batchMoveEmails).toHaveBeenCalledWith(['email-1', 'email-2'], 'server-archive', 'shared-account');
  });

  it('tells Undo where the archived messages were, and Undo puts them back', async () => {
    const client = {
      getThread: vi.fn().mockResolvedValue({ id: 'thread-1', emailIds: ['email-1', 'email-2', 'sent-1'] }),
      getEmailFields: vi.fn().mockResolvedValue([
        { id: 'email-1', mailboxIds: { 'server-inbox': true }, keywords: { $seen: true } },
        { id: 'email-2', mailboxIds: { 'server-inbox': true, 'server-work': true }, keywords: {} },
        { id: 'sent-1', mailboxIds: { 'server-sent': true }, keywords: { $seen: true } },
      ]),
      batchMoveEmails: vi.fn().mockResolvedValue(undefined),
      restoreEmails: vi.fn().mockResolvedValue(undefined),
    } as unknown as IJMAPClient;
    const onMoved = vi.fn();
    useEmailStore.setState({ refreshCurrentMailbox: vi.fn().mockResolvedValue(undefined), fetchMailboxes: vi.fn().mockResolvedValue(undefined) });

    await useEmailStore.getState().moveThreadToMailbox(client, 'email-1', 'archive-local', undefined, onMoved);

    expect(onMoved).toHaveBeenCalledTimes(1);
    const [batches] = onMoved.mock.calls[0];
    expect(batches).toEqual([expect.objectContaining({ client, accountId: 'shared-account', points: [
      { id: 'email-1', mailboxIds: { 'server-inbox': true }, seen: true },
      { id: 'email-2', mailboxIds: { 'server-inbox': true, 'server-work': true }, seen: false },
    ] })]);
    expect(Object.keys(batches[0].messages)).toEqual(['email-1', 'email-2']);

    await useEmailStore.getState().restoreEmails(client, batches);
    expect(client.restoreEmails).toHaveBeenCalledWith(batches[0].points, 'shared-account');
    expect(useEmailStore.getState().refreshCurrentMailbox).toHaveBeenCalled();
  });
});