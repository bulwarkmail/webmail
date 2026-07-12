import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '../settings-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Sidebar tag badges render from `tagCounts`, which is fetched from the server
// (`fetchTagCounts` -> `client.getTagCounts`) rather than derived from
// `state.emails`. Read/unread mutations therefore have to keep it in step the
// same way they keep `mailboxes[].unreadEmails` in step, or the tag unread
// count (and the bold tag name) stays stale until a full page reload.

function makeMailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: 'inbox',
    name: 'Inbox',
    role: 'inbox',
    sortOrder: 0,
    totalEmails: 10,
    unreadEmails: 5,
    totalThreads: 10,
    unreadThreads: 5,
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
    mailboxIds: { inbox: true },
    ...overrides,
  } as Email;
}

function makeClient() {
  return {
    markAsRead: vi.fn().mockResolvedValue(undefined),
    batchMarkAsRead: vi.fn().mockResolvedValue(undefined),
    markMailboxAsRead: vi.fn().mockResolvedValue(3),
    getTagCounts: vi.fn().mockResolvedValue({}),
    getAccountId: vi.fn().mockReturnValue('account-a'),
  } as unknown as IJMAPClient;
}

describe('email-store tag counts stay in step with read state', () => {
  let client: IJMAPClient;

  beforeEach(() => {
    client = makeClient();

    useAuthStore.setState({
      activeAccountId: 'account-a',
      getClientForAccount: (() => client) as never,
    } as never);

    useSettingsStore.setState({
      emailKeywords: [
        { id: 'ingsel', label: 'Ingsel', color: 'red' },
        { id: 'work', label: 'Work', color: 'blue' },
      ],
    } as never);

    useEmailStore.setState({
      isUnifiedView: false,
      viewingAccountId: null,
      selectedMailbox: 'inbox',
      mailboxes: [makeMailbox()],
      accountMailboxes: {},
      emails: [],
      selectedEmail: null,
      selectedEmailIds: new Set(),
      processingReadStatus: new Set(),
      threadEmailsCache: new Map(),
      tagCounts: {
        ingsel: { total: 1658, unread: 47 },
        work: { total: 200, unread: 9 },
      },
    } as never);
  });

  it('decrements only the matching tag when a tagged email is marked read', async () => {
    useEmailStore.setState({
      emails: [makeEmail({ keywords: { '$label:ingsel': true } })],
    } as never);

    await useEmailStore.getState().markAsRead(client, 'email-1', true);

    expect(useEmailStore.getState().tagCounts).toEqual({
      ingsel: { total: 1658, unread: 46 },
      work: { total: 200, unread: 9 },
    });
  });

  it('increments the tag again when the email is marked unread', async () => {
    useEmailStore.setState({
      emails: [makeEmail({ keywords: { '$label:ingsel': true, $seen: true } })],
    } as never);

    await useEmailStore.getState().markAsRead(client, 'email-1', false);

    expect(useEmailStore.getState().tagCounts.ingsel).toEqual({ total: 1658, unread: 48 });
  });

  it('updates both tags when an email carries two tags', async () => {
    useEmailStore.setState({
      emails: [makeEmail({ keywords: { '$label:ingsel': true, '$label:work': true } })],
    } as never);

    await useEmailStore.getState().markAsRead(client, 'email-1', true);

    expect(useEmailStore.getState().tagCounts).toEqual({
      ingsel: { total: 1658, unread: 46 },
      work: { total: 200, unread: 8 },
    });
  });

  it('leaves tag counts alone for an untagged email', async () => {
    useEmailStore.setState({ emails: [makeEmail({ keywords: {} })] } as never);

    await useEmailStore.getState().markAsRead(client, 'email-1', true);

    expect(useEmailStore.getState().tagCounts).toEqual({
      ingsel: { total: 1658, unread: 47 },
      work: { total: 200, unread: 9 },
    });
  });

  it('does not double-decrement when an already-read email is marked read', async () => {
    useEmailStore.setState({
      emails: [makeEmail({ keywords: { '$label:ingsel': true, $seen: true } })],
    } as never);

    await useEmailStore.getState().markAsRead(client, 'email-1', true);

    expect(useEmailStore.getState().tagCounts.ingsel).toEqual({ total: 1658, unread: 47 });
  });

  it('never drives a tag unread count negative', async () => {
    useEmailStore.setState({
      emails: [makeEmail({ keywords: { '$label:ingsel': true } })],
      tagCounts: { ingsel: { total: 3, unread: 0 } },
    } as never);

    await useEmailStore.getState().markAsRead(client, 'email-1', true);

    expect(useEmailStore.getState().tagCounts.ingsel).toEqual({ total: 3, unread: 0 });
  });

  it('never alters `total` on a read-state change', async () => {
    useEmailStore.setState({
      emails: [makeEmail({ keywords: { '$label:ingsel': true } })],
    } as never);

    await useEmailStore.getState().markAsRead(client, 'email-1', true);
    await useEmailStore.getState().markAsRead(client, 'email-1', false);

    expect(useEmailStore.getState().tagCounts.ingsel.total).toBe(1658);
    expect(useEmailStore.getState().tagCounts.work.total).toBe(200);
  });

  describe('batchMarkAsRead', () => {
    it('applies the delta once per tag per changed email', async () => {
      useEmailStore.setState({
        emails: [
          makeEmail({ id: 'e1', keywords: { '$label:ingsel': true } }),
          makeEmail({ id: 'e2', keywords: { '$label:ingsel': true, '$label:work': true } }),
          // Already read: must not contribute a delta.
          makeEmail({ id: 'e3', keywords: { '$label:work': true, $seen: true } }),
          // Untagged: must not contribute a delta.
          makeEmail({ id: 'e4', keywords: {} }),
        ],
        selectedEmailIds: new Set(['e1', 'e2', 'e3', 'e4']),
      } as never);

      await useEmailStore.getState().batchMarkAsRead(client, true);

      expect(useEmailStore.getState().tagCounts).toEqual({
        ingsel: { total: 1658, unread: 45 },
        work: { total: 200, unread: 8 },
      });
    });
  });

  describe('markMailboxAsRead', () => {
    it('refetches tag counts from the server rather than applying a local delta', async () => {
      (client.getTagCounts as ReturnType<typeof vi.fn>).mockResolvedValue({
        ingsel: { total: 1658, unread: 0 },
        work: { total: 200, unread: 4 },
      });

      useEmailStore.setState({
        emails: [makeEmail({ keywords: { '$label:ingsel': true } })],
      } as never);

      const count = await useEmailStore.getState().markMailboxAsRead(client, 'inbox');
      expect(count).toBe(3);

      // The server bulk-marks emails that are not in `state.emails`, so a local
      // delta would under-count: it has to refetch.
      expect(client.getTagCounts).toHaveBeenCalledWith(['ingsel', 'work']);

      await vi.waitFor(() => {
        expect(useEmailStore.getState().tagCounts).toEqual({
          ingsel: { total: 1658, unread: 0 },
          work: { total: 200, unread: 4 },
        });
      });
    });
  });

  describe('setEmailKeywordsLocal', () => {
    it('adjusts tag unread counts when the local keyword patch flips $seen', () => {
      useEmailStore.setState({
        emails: [makeEmail({ keywords: { '$label:ingsel': true } })],
      } as never);

      useEmailStore.getState().setEmailKeywordsLocal('email-1', {
        '$label:ingsel': true,
        $seen: true,
      });

      expect(useEmailStore.getState().tagCounts.ingsel).toEqual({ total: 1658, unread: 46 });
    });

    it('leaves tag unread counts alone when $seen is unchanged', () => {
      useEmailStore.setState({
        emails: [makeEmail({ keywords: { '$label:ingsel': true } })],
      } as never);

      // Pin toggle: labels/pin change, read state does not.
      useEmailStore.getState().setEmailKeywordsLocal('email-1', {
        '$label:ingsel': true,
        $pinned: true,
      });

      expect(useEmailStore.getState().tagCounts.ingsel).toEqual({ total: 1658, unread: 47 });
    });
  });
});
