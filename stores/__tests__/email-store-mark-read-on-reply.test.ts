import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '../settings-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// #1756: with "Mark as read: Never", a message replied to or forwarded kept
// $answered / $forwarded but stayed unread. "Mark as read after replying or
// forwarding" (on by default) sets $seen in the same Email/set, and the list row
// and the folder's unread count follow.

function mailbox(id: string, role: string, unread: number): Mailbox {
  return { id, originalId: id, name: id, role, accountId: 'acc', isShared: false, sortOrder: 0, totalEmails: 5, unreadEmails: unread, totalThreads: 5, unreadThreads: unread, isSubscribed: true } as Mailbox;
}

function makeClient() {
  return {
    getAccountId: () => 'acc',
    setKeyword: vi.fn().mockResolvedValue(undefined),
    batchUpdateKeywords: vi.fn().mockResolvedValue(undefined),
  } as unknown as IJMAPClient & { setKeyword: ReturnType<typeof vi.fn>; batchUpdateKeywords: ReturnType<typeof vi.fn> };
}

const unreadRow = {
  id: 'm1', threadId: 't1', subject: 'Hi', receivedAt: '2026-11-17T10:00:00Z',
  keywords: {}, mailboxIds: { inbox: true },
} as unknown as Email;

describe('marking a replied or forwarded message read (#1756)', () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
    useAuthStore.setState({ activeAccountId: 'login-a', client: client as never } as never);
    useSettingsStore.setState({ markReadOnReply: true, markAsReadDelay: -1 } as never);
    useEmailStore.setState({
      isUnifiedView: false, viewingAccountId: null, selectedMailbox: 'inbox',
      mailboxes: [mailbox('inbox', 'inbox', 3)],
      accountMailboxes: {},
      emails: [unreadRow], selectedEmail: null, selectedEmailKeys: new Set(),
      processingReadStatus: new Set(),
      threadEmailsCache: new Map(), expandedThreadIds: new Set(),
    } as never);
  });

  it.each(['$answered', '$forwarded'])('sets %s and $seen in one Email/set and counts the message read', async (keyword) => {
    await useEmailStore.getState().markEmailKeyword(client, 'm1', keyword);

    expect(client.setKeyword).not.toHaveBeenCalled();
    expect(client.batchUpdateKeywords).toHaveBeenCalledTimes(1);
    expect(client.batchUpdateKeywords).toHaveBeenCalledWith(['m1'], { [`keywords/${keyword}`]: true, 'keywords/$seen': true }, undefined);

    const state = useEmailStore.getState();
    expect(state.emails[0].keywords).toEqual({ [keyword]: true, $seen: true });
    expect(state.mailboxes[0].unreadEmails).toBe(2);
  });

  it('leaves the message unread when the setting is off', async () => {
    useSettingsStore.setState({ markReadOnReply: false } as never);

    await useEmailStore.getState().markEmailKeyword(client, 'm1', '$answered');

    expect(client.batchUpdateKeywords).not.toHaveBeenCalled();
    expect(client.setKeyword).toHaveBeenCalledWith('m1', '$answered', undefined);
    const state = useEmailStore.getState();
    expect(state.emails[0].keywords?.$seen).toBeFalsy();
    expect(state.mailboxes[0].unreadEmails).toBe(3);
  });

  it('does not read a message for a sent read receipt', async () => {
    await useEmailStore.getState().markEmailKeyword(client, 'm1', '$mdnsent');

    expect(client.batchUpdateKeywords).not.toHaveBeenCalled();
    expect(client.setKeyword).toHaveBeenCalledWith('m1', '$mdnsent', undefined);
    expect(useEmailStore.getState().mailboxes[0].unreadEmails).toBe(3);
  });

  it('does not count an already read message again', async () => {
    useEmailStore.setState({ emails: [{ ...unreadRow, keywords: { $seen: true } }] } as never);

    await useEmailStore.getState().markEmailKeyword(client, 'm1', '$answered');

    expect(useEmailStore.getState().mailboxes[0].unreadEmails).toBe(3);
    expect(useEmailStore.getState().emails[0].keywords).toEqual({ $seen: true, $answered: true });
  });
});
