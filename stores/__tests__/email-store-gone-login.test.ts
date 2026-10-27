import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore, resolveEmailActionContext } from '../email-store';
import { useAuthStore } from '../auth-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// A row stamped with a login that is no longer connected must not be written
// through another login: email and account ids repeat across logins and
// servers, so the active login's client would act on its own message with
// the same id (GHSA-8x23 class).

function mailbox(id: string, role: string, accountId: string): Mailbox {
  return { id, originalId: id, name: id, role, accountId, isShared: false, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true } as Mailbox;
}

function makeClient(accountId: string) {
  return {
    getAccountId: () => accountId,
    markAsRead: vi.fn().mockResolvedValue(undefined),
    toggleStar: vi.fn().mockResolvedValue(undefined),
    moveEmail: vi.fn().mockResolvedValue(undefined),
    moveToTrash: vi.fn().mockResolvedValue(undefined),
    setKeyword: vi.fn().mockResolvedValue(undefined),
    batchUpdateKeywords: vi.fn().mockResolvedValue(undefined),
    batchMarkAsRead: vi.fn().mockResolvedValue(undefined),
  } as unknown as IJMAPClient;
}

// A message of login B (gone), with the same id and account id as one of the
// active login A's own messages.
const goneRow = {
  id: 'eaaaaab', threadId: 't', subject: 'B', receivedAt: '2026-10-26T10:00:00Z',
  keywords: {}, mailboxIds: { a: true },
  sourceClientAccountId: 'login-b', sourceAccountId: 'cf',
} as unknown as Email;

describe('a row of a login that is no longer connected', () => {
  let active: IJMAPClient;

  beforeEach(() => {
    active = makeClient('cf');
    useAuthStore.setState({
      activeAccountId: 'login-a',
      client: active as never,
      getClientForAccount: (id: string) => (id === 'login-a' ? active : undefined) as never,
    } as never);
    useEmailStore.setState({
      isUnifiedView: true, viewingAccountId: null, selectedMailbox: '',
      mailboxes: [mailbox('a', 'inbox', 'cf'), mailbox('b', 'trash', 'cf')],
      accountMailboxes: {},
      emails: [goneRow], selectedEmail: null, selectedEmailKeys: new Set(),
      processingReadStatus: new Set(),
      threadEmailsCache: new Map(), expandedThreadIds: new Set(),
    } as never);
  });

  it('resolves to no client instead of the active one', () => {
    expect(() => resolveEmailActionContext(goneRow, active)).toThrow('Not connected');
  });

  it('is not marked read through the active login', async () => {
    await expect(useEmailStore.getState().markAsRead(active, 'eaaaaab', true)).rejects.toThrow('Not connected');
    expect(active.markAsRead).not.toHaveBeenCalled();
  });

  it('is not starred through the active login', async () => {
    await expect(useEmailStore.getState().toggleStar(active, 'eaaaaab')).rejects.toThrow('Not connected');
    expect(active.toggleStar).not.toHaveBeenCalled();
  });

  it('is not moved through the active login', async () => {
    await expect(useEmailStore.getState().moveToMailbox(active, 'eaaaaab', 'b')).rejects.toThrow('Not connected');
    expect(active.moveEmail).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails).toEqual([goneRow]);
  });

  it('gets no keyword through the active login', async () => {
    await expect(useEmailStore.getState().markEmailKeyword(active, 'eaaaaab', '$answered')).rejects.toThrow('Not connected');
    expect(active.setKeyword).not.toHaveBeenCalled();
  });

  it('is not moved back to the Inbox through the active login', async () => {
    (active as unknown as { undoSpam: unknown }).undoSpam = vi.fn().mockResolvedValue(undefined);
    await expect(useEmailStore.getState().undoSpam(active, 'eaaaaab')).rejects.toThrow('Not connected');
    expect((active as unknown as { undoSpam: ReturnType<typeof vi.fn> }).undoSpam).not.toHaveBeenCalled();
  });

  it('is not marked read with its expanded thread through the active login', async () => {
    useEmailStore.setState({ emails: [{ ...goneRow, threadId: 't' }] } as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await useEmailStore.getState().markThreadAsRead(active, 'login-b/cf:t');
    expect(active.batchMarkAsRead).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails[0].keywords.$seen).toBeUndefined();
  });
});
