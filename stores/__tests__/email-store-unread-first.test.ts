import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';
import { useAuthStore } from '../auth-store';
import { useMessageListTabsStore } from '../message-list-tabs-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Mountain View's "Unread first" inbox: the newest unread mail in a section
// of its own above "Everything else", which is the inbox's read mail.

const inbox = { id: 'inbox', role: 'inbox', isShared: false } as Mailbox;

function email(id: string, minute: number, read: boolean): Email {
  return {
    id, threadId: `thread-${id}`, mailboxIds: { inbox: true }, keywords: read ? { $seen: true } : {},
    subject: id, receivedAt: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(),
    from: [{ email: 'sender@example.com' }], to: [], preview: '', size: 1, hasAttachment: false,
  } as Email;
}

/** A server holding `rows` (newest first) that honours the $seen filters, limits and positions. */
function server(rows: Email[]) {
  const getEmails = vi.fn(async (...args: unknown[]) => {
    const [, , limit, position, , , filter] = args as [string, string, number, number, unknown, unknown, Record<string, unknown> | undefined];
    const matching = rows.filter((e) => {
      if (filter?.hasKeyword === '$seen') return !!e.keywords.$seen;
      if (filter?.notKeyword === '$seen') return !e.keywords.$seen;
      return true;
    });
    const page = matching.slice(position, position + limit).map((e) => ({ ...e, keywords: { ...e.keywords } }));
    return { emails: page, total: matching.length, hasMore: position + limit < matching.length, state: 's' };
  });
  return {
    getEmails,
    getThreads: vi.fn(async () => []),
    getThread: vi.fn(async (threadId: string) => ({ id: threadId, emailIds: [threadId.replace('thread-', '')] })),
    markAsRead: vi.fn(async (id: string, read: boolean) => {
      const row = rows.find((e) => e.id === id)!;
      row.keywords = read ? { $seen: true } : {};
    }),
    moveEmail: vi.fn(async (id: string) => {
      rows.splice(rows.findIndex((e) => e.id === id), 1);
    }),
    getAccountId: () => 'me',
  } as unknown as IJMAPClient & { getEmails: typeof getEmails };
}

// 3 unread and 30 read messages, newest first, the unread ones in between.
function inboxRows(): Email[] {
  const rows: Email[] = [];
  for (let i = 0; i < 33; i++) rows.push(email(`m${i}`, 100 - i, ![1, 5, 9].includes(i)));
  return rows;
}

const ids = () => useEmailStore.getState().emails.map((e) => e.id);

describe('the "Unread first" inbox', () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
    useMessageListTabsStore.setState(useMessageListTabsStore.getInitialState());
    useSettingsStore.setState({
      emailsPerPage: 25, messageListOrder: [], messageListOrderScope: 'inbox',
      notificationMutes: { accounts: [], mailboxes: {} },
      interfaceLayout: 'mountain-view', mvInboxType: 'unread-first',
    });
    useEmailStore.setState({
      ...useEmailStore.getInitialState(),
      selectedMailbox: 'inbox', mailboxes: [inbox],
    });
  });

  it('loads the unread mail into its section ahead of the read mail', async () => {
    const c = server(inboxRows());
    await useEmailStore.getState().fetchEmails(c, 'inbox');

    const state = useEmailStore.getState();
    expect(ids().slice(0, 3)).toEqual(['m1', 'm5', 'm9']);
    expect([...state.unreadSection!.ids]).toEqual(['m1', 'm5', 'm9']);
    expect(state.unreadSection!.total).toBe(3);
    // Everything else is the read mail, a page of it.
    expect(ids().slice(3)).toHaveLength(25);
    expect(state.emails.slice(3).every((e) => e.keywords.$seen)).toBe(true);
    expect(state.totalEmails).toBe(30);
    expect(state.hasMoreEmails).toBe(true);
  });

  it('pages the read mail from where it got to, not counting the section', async () => {
    const c = server(inboxRows());
    await useEmailStore.getState().fetchEmails(c, 'inbox');
    c.getEmails.mockClear();

    await useEmailStore.getState().loadMoreEmails(c);

    expect(c.getEmails.mock.calls[0][3]).toBe(25);
    expect(ids()).toHaveLength(33);
    expect(new Set(ids()).size).toBe(33);
    expect(useEmailStore.getState().hasMoreEmails).toBe(false);
  });

  it('keeps the section through a refresh, and still has more to load', async () => {
    const c = server(inboxRows());
    await useEmailStore.getState().fetchEmails(c, 'inbox');

    await useEmailStore.getState().refreshCurrentMailbox(c);

    expect(ids().slice(0, 3)).toEqual(['m1', 'm5', 'm9']);
    expect(ids()).toHaveLength(28);
    expect(useEmailStore.getState().hasMoreEmails).toBe(true);
  });

  it('keeps the section rows while the section cannot be loaded again', async () => {
    const c = server(inboxRows());
    await useEmailStore.getState().fetchEmails(c, 'inbox');

    const plain = c.getEmails.getMockImplementation()!;
    c.getEmails.mockImplementation(async (...args: unknown[]) => {
      if ((args[6] as Record<string, unknown> | undefined)?.notKeyword) throw new Error('offline');
      return plain(...args);
    });
    await useEmailStore.getState().refreshCurrentMailbox(c);

    expect(ids().slice(0, 3)).toEqual(['m1', 'm5', 'm9']);
    expect(ids()).toHaveLength(28);
  });

  it('moves a message read meanwhile from the section to everything else', async () => {
    const rows = inboxRows();
    const c = server(rows);
    await useEmailStore.getState().fetchEmails(c, 'inbox');

    rows[5].keywords = { $seen: true };
    await useEmailStore.getState().refreshCurrentMailbox(c);

    const state = useEmailStore.getState();
    expect([...state.unreadSection!.ids]).toEqual(['m1', 'm9']);
    expect(ids().slice(0, 2)).toEqual(['m1', 'm9']);
    expect(ids().slice(2)).toContain('m5');
    expect(ids().filter((id) => id === 'm5')).toHaveLength(1);
  });

  // Opening a message from the section, as a click does, and the push refresh
  // its read state raises on the server.
  async function openAndRead(c: ReturnType<typeof server>, id: string) {
    const row = useEmailStore.getState().emails.find((e) => e.id === id)!;
    useEmailStore.getState().selectEmail(row);
    await useEmailStore.getState().markAsRead(c, id, true);
    await useEmailStore.getState().refreshCurrentMailbox(c);
  }

  it('keeps the message opened in the section where it was, so archiving it opens the next unread one (#1453)', async () => {
    const c = server(inboxRows());
    await useEmailStore.getState().fetchEmails(c, 'inbox');

    await openAndRead(c, 'm5');

    expect(ids().slice(0, 3)).toEqual(['m1', 'm5', 'm9']);
    expect(ids().filter((id) => id === 'm5')).toHaveLength(1);
    expect(useEmailStore.getState().unreadSection!.ids.has('m5')).toBe(true);

    await useEmailStore.getState().moveThreadToMailbox(c, 'm5', 'archive');

    expect(useEmailStore.getState().selectedEmail?.id).toBe('m9');
  });

  it('opens the newest read message after archiving the last unread one', async () => {
    const c = server(inboxRows());
    await useEmailStore.getState().fetchEmails(c, 'inbox');

    await openAndRead(c, 'm9');
    await useEmailStore.getState().moveThreadToMailbox(c, 'm9', 'archive');

    expect(useEmailStore.getState().selectedEmail?.id).toBe('m0');
  });

  it('counts the open message the read page has as loaded', async () => {
    const rows = inboxRows();
    const c = server(rows);
    await useEmailStore.getState().fetchEmails(c, 'inbox');
    await useEmailStore.getState().loadMoreEmails(c);
    expect(useEmailStore.getState().hasMoreEmails).toBe(false);

    // Read elsewhere meanwhile, so the refresh changes the list.
    rows[9].keywords = { $seen: true };
    await openAndRead(c, 'm5');

    expect(useEmailStore.getState().hasMoreEmails).toBe(false);
    expect(new Set(ids()).size).toBe(33);
  });

  it('lets the message read go to everything else once another one is opened', async () => {
    const c = server(inboxRows());
    await useEmailStore.getState().fetchEmails(c, 'inbox');
    await openAndRead(c, 'm5');

    await openAndRead(c, 'm1');

    const state = useEmailStore.getState();
    expect(state.unreadSection!.ids.has('m5')).toBe(false);
    expect(ids().slice(0, 2)).toEqual(['m1', 'm9']);
    expect(ids().slice(2)).toContain('m5');
  });

  it('announces new mail, which only the section has', async () => {
    const rows = inboxRows();
    const c = server(rows);
    await useEmailStore.getState().fetchEmails(c, 'inbox');

    rows.unshift(email('new', 200, false));
    await useEmailStore.getState().refreshCurrentMailbox(c);

    expect(ids()[0]).toBe('new');
    expect(useEmailStore.getState().newEmailNotification?.id).toBe('new');
  });

  it('is the plain inbox with the default inbox type', async () => {
    useSettingsStore.setState({ mvInboxType: 'default' });
    const c = server(inboxRows());
    await useEmailStore.getState().fetchEmails(c, 'inbox');

    expect(c.getEmails).toHaveBeenCalledTimes(1);
    expect(c.getEmails.mock.calls[0][6]).toBeUndefined();
    expect(useEmailStore.getState().unreadSection).toBeNull();
    expect(ids().slice(0, 3)).toEqual(['m0', 'm1', 'm2']);
  });

  it('only applies to the inbox', async () => {
    const archive = { id: 'archive', role: 'archive', isShared: false } as Mailbox;
    useEmailStore.setState({ mailboxes: [inbox, archive], selectedMailbox: 'archive' });
    const c = server(inboxRows());
    await useEmailStore.getState().fetchEmails(c, 'archive');

    expect(c.getEmails).toHaveBeenCalledTimes(1);
    expect(c.getEmails.mock.calls[0][6]).toBeUndefined();
    expect(useEmailStore.getState().unreadSection).toBeNull();
  });
});
