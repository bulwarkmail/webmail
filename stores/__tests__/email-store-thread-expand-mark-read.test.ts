import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '../settings-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

/**
 * Expanding a conversation in the message list (row click, expand chevron or
 * the `x` shortcut) marked its unread messages read straight away, even with
 * "Mark as read: Never". It must follow markAsReadDelay like the reading pane.
 */

const makeMailbox = (overrides: Partial<Mailbox> = {}): Mailbox => ({
  id: 'inbox',
  name: 'Inbox',
  role: 'inbox',
  sortOrder: 0,
  totalEmails: 2,
  unreadEmails: 1,
  totalThreads: 1,
  unreadThreads: 1,
  myRights: {
    mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true,
    maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true,
  },
  isSubscribed: true,
  isShared: false,
  ...overrides,
});

const makeEmail = (id: string, seen: boolean): Email =>
  ({
    id,
    threadId: 't1',
    mailboxIds: { inbox: true },
    keywords: seen ? { $seen: true } : {},
    size: 1,
    receivedAt: '2026-10-01T10:00:00Z',
    subject: id,
    preview: '',
    hasAttachment: false,
  }) as unknown as Email;

function makeClient() {
  return {
    getAccountId: () => 'acct-a',
    batchMarkAsRead: vi.fn(async () => {}),
  } as unknown as IJMAPClient & { batchMarkAsRead: ReturnType<typeof vi.fn> };
}

describe('autoMarkExpandedThreadAsRead follows markAsReadDelay', () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    client = makeClient();
    useAuthStore.setState({
      activeAccountId: 'login-a',
      getClientForAccount: () => client as never,
    } as never);
    useEmailStore.setState({
      isUnifiedView: false,
      unifiedRole: null,
      viewingAccountId: null,
      selectedMailbox: 'inbox',
      mailboxes: [makeMailbox()],
      accountMailboxes: {},
      emails: [makeEmail('m1', true), makeEmail('m2', false)],
      expandedThreadIds: new Set(),
      threadEmailsCache: new Map(),
      processingReadStatus: new Set(),
    });
  });

  afterEach(() => {
    useEmailStore.getState().collapseAllThreads();
    vi.useRealTimers();
  });

  const expand = () => {
    useEmailStore.getState().toggleThreadExpansion('t1');
    useEmailStore.getState().autoMarkExpandedThreadAsRead(client, 't1');
  };

  it('leaves the conversation unread with "Never" (-1)', async () => {
    useSettingsStore.setState({ markAsReadDelay: -1 });
    expand();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(client.batchMarkAsRead).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails.find((e) => e.id === 'm2')?.keywords?.$seen).toBeFalsy();
  });

  it('marks the unread messages read at once with "Instantly" (0)', async () => {
    useSettingsStore.setState({ markAsReadDelay: 0 });
    expand();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.batchMarkAsRead).toHaveBeenCalledWith(['m2'], true, undefined);
  });

  it('marks the unread messages read after the configured delay', async () => {
    useSettingsStore.setState({ markAsReadDelay: 3000 });
    expand();
    await vi.advanceTimersByTimeAsync(2999);
    expect(client.batchMarkAsRead).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(client.batchMarkAsRead).toHaveBeenCalledWith(['m2'], true, undefined);
  });

  it('drops the delayed mark when the conversation is collapsed first', async () => {
    useSettingsStore.setState({ markAsReadDelay: 3000 });
    expand();
    await vi.advanceTimersByTimeAsync(1000);
    useEmailStore.getState().toggleThreadExpansion('t1');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(client.batchMarkAsRead).not.toHaveBeenCalled();
  });

  it('drops the delayed mark when cancelled, and leaves the thread expanded', async () => {
    useSettingsStore.setState({ markAsReadDelay: 3000 });
    expand();
    await vi.advanceTimersByTimeAsync(1000);
    useEmailStore.getState().cancelAutoMarkThreadAsRead('t1');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(client.batchMarkAsRead).not.toHaveBeenCalled();
    expect(useEmailStore.getState().expandedThreadIds.has('t1')).toBe(true);
  });

  it('drops the delayed mark when every thread is collapsed', async () => {
    useSettingsStore.setState({ markAsReadDelay: 3000 });
    expand();
    useEmailStore.getState().collapseAllThreads();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(client.batchMarkAsRead).not.toHaveBeenCalled();
  });
});
