import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';
import { useAuthStore } from '../auth-store';
import { useMessageListTabsStore } from '../message-list-tabs-store';
import { compareEmails, type SortLevel } from '@/lib/message-list-order';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

/**
 * A folder sorted "unread first" (#718) holds the head of the server order.
 * Reading a loaded mail moves it down at once, so the unread mails from beyond
 * the loaded page must move up: reading the top mail over and over used to run
 * out of unread mail after the first page while more waited on the server.
 */

const UNREAD_FIRST: SortLevel[] = [{ criterion: 'unread', direction: 'desc' }];
const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox', isShared: false, unreadEmails: 5, unreadThreads: 5 } as unknown as Mailbox;

function mail(id: string, hour: number, read: boolean): Email {
  return {
    id, threadId: `t-${id}`, mailboxIds: { inbox: true },
    keywords: read ? { $seen: true } : {},
    subject: id, receivedAt: new Date(Date.UTC(2026, 8, 1, hour)).toISOString(),
    from: [{ email: 'sender@example.com' }], to: [],
    preview: '', size: 1, hasAttachment: false,
  } as Email;
}

/** A server that sorts and pages like Email/query and applies read changes. */
function fakeServer(rows: Email[]) {
  const copy = (e: Email) => ({ ...e, keywords: { ...e.keywords } });
  const getEmails = vi.fn<IJMAPClient['getEmails']>(async (
    _mailboxId, _accountId, limit = 50, position = 0, _hasKeyword, _pinnedFirst, _extraFilter, order = [],
  ) => {
    const sorted = [...rows].sort(compareEmails(order));
    return {
      emails: sorted.slice(position, position + limit).map(copy),
      total: sorted.length,
      hasMore: position + limit < sorted.length,
      state: 'email-state',
    };
  });
  const setSeen = (id: string, read: boolean) => {
    const row = rows.find(r => r.id === id)!;
    row.keywords = { ...row.keywords, $seen: read };
  };
  const client = {
    getEmails,
    markAsRead: vi.fn(async (id: string, read = true) => setSeen(id, read)),
    getMaxObjectsInGet: () => 500,
    getAccountId: () => 'acct',
    getThreads: vi.fn(async () => []),
  } as unknown as IJMAPClient & { getEmails: typeof getEmails };
  return { client, setSeen };
}

/** The mail at the top of the list as the user sees it. */
function topMail(): Email {
  const { emails, listOrder } = useEmailStore.getState();
  return [...emails].sort(compareEmails(listOrder))[0];
}

async function readTopMail(client: IJMAPClient): Promise<Email> {
  const top = topMail();
  useEmailStore.getState().selectEmail(top);
  await useEmailStore.getState().markAsRead(client, top.id, true);
  // The refill runs in the background.
  await vi.waitFor(() => expect(useEmailStore.getState().emails.some(e => e.id === top.id && e.keywords.$seen)).toBe(true));
  await new Promise(resolve => setTimeout(resolve, 0));
  return top;
}

const ids = () => useEmailStore.getState().emails.map(e => e.id);

describe('keyword-ordered folder list refill (#718)', () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
    useMessageListTabsStore.setState(useMessageListTabsStore.getInitialState());
    useSettingsStore.setState({ emailsPerPage: 3, emailKeywords: [], messageListOrder: UNREAD_FIRST, messageListOrderScope: 'inbox' });
    useEmailStore.setState({
      ...useEmailStore.getInitialState(),
      selectedMailbox: 'inbox', mailboxes: [inbox],
    });
  });

  it('keeps unread mail on top past the first page when reading the top mail over and over', async () => {
    const { client } = fakeServer([
      mail('u1', 20, false), mail('r1', 19, true), mail('u2', 18, false), mail('u3', 17, false),
      mail('r2', 16, true), mail('u4', 15, false), mail('u5', 14, false), mail('r3', 13, true),
    ]);
    await useEmailStore.getState().fetchEmails(client);
    expect(ids()).toEqual(['u1', 'u2', 'u3']);

    const opened: string[] = [];
    for (let i = 0; i < 5; i++) opened.push((await readTopMail(client)).id);

    expect(opened).toEqual(['u1', 'u2', 'u3', 'u4', 'u5']);
    // All read now: the head of the server order is newest first, plus the
    // open mail, which sorts further down.
    expect(ids()).toEqual(['u1', 'r1', 'u2', 'u5']);
    expect(useEmailStore.getState().retainedInViewIds).toEqual(new Set(['u5']));
  });

  it('keeps the open mail listed after it moved past the loaded rows, and drops it once another is opened', async () => {
    const { client } = fakeServer([
      mail('r1', 22, true), mail('r2', 21, true),
      mail('u1', 20, false), mail('u2', 18, false), mail('u3', 17, false), mail('u4', 15, false),
    ]);
    await useEmailStore.getState().fetchEmails(client);

    await readTopMail(client);
    expect(ids()).toEqual(['u2', 'u3', 'u4', 'u1']);

    await readTopMail(client);
    expect(ids()).toEqual(['u3', 'u4', 'r1', 'u2']);
  });

  it('does not skip a mail when loading more after the open mail moved', async () => {
    const { client } = fakeServer([
      mail('u1', 20, false), mail('u2', 18, false), mail('u3', 17, false), mail('u4', 15, false),
      mail('u5', 14, false), mail('r1', 13, true), mail('r2', 12, true),
    ]);
    await useEmailStore.getState().fetchEmails(client);
    await readTopMail(client);
    expect(ids()).toEqual(['u2', 'u3', 'u4', 'u1']);

    await useEmailStore.getState().loadMoreEmails(client);

    // Server order is now u2 u3 u4 u5 u1 r1 r2: the page starts at u5.
    expect(client.getEmails.mock.lastCall?.[3]).toBe(3);
    expect(ids()).toEqual(['u2', 'u3', 'u4', 'u1', 'u5', 'r1']);
    // u1 came back in order with that page.
    expect(useEmailStore.getState().retainedInViewIds.size).toBe(0);
  });

  it('does not announce a newer read mail the refill moved up as new mail', async () => {
    const { client } = fakeServer([
      mail('r-newest', 23, true), mail('u1', 20, false), mail('u2', 18, false), mail('u3', 17, false),
    ]);
    await useEmailStore.getState().fetchEmails(client);
    expect(ids()).toEqual(['u1', 'u2', 'u3']);

    await readTopMail(client);

    expect(ids()).toContain('r-newest');
    expect(useEmailStore.getState().newEmailNotification).toBeNull();
  });

  it('re-queries the loaded rows when another client reads a listed mail', async () => {
    const { client, setSeen } = fakeServer([
      mail('u1', 20, false), mail('u2', 18, false), mail('u3', 17, false), mail('u4', 15, false),
    ]);
    Object.assign(client, {
      getEmailChanges: vi.fn(async () => ({ oldState: 'email-state', newState: 's2', hasMoreChanges: false, created: [], updated: ['u1'], destroyed: [] })),
      getSomeEmails: vi.fn(async () => [{ ...mail('u1', 20, true) }]),
    });
    await useEmailStore.getState().fetchEmails(client);
    setSeen('u1', true);

    await useEmailStore.getState().handleStateChange({ '@type': 'StateChange', changed: { acct: { Email: 's2' } } }, client);

    expect(ids()).toEqual(['u2', 'u3', 'u4']);
  });

  it('does not re-query a chronological list after a read', async () => {
    useSettingsStore.setState({ messageListOrder: [] });
    const { client } = fakeServer([mail('u1', 20, false), mail('u2', 18, false), mail('u3', 17, false), mail('u4', 15, false)]);
    await useEmailStore.getState().fetchEmails(client);

    await readTopMail(client);

    expect(client.getEmails).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual(['u1', 'u2', 'u3']);
  });
});
