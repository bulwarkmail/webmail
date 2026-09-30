import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A push refresh re-queries the list and merges the page in. Deleting mails in
 * quick succession overlaps those refreshes: the query for the previous
 * delete's push can reach the server before the next delete does, and its
 * page still carries that mail. The delete had already dropped the row, so
 * merging the page put it back until the next push (#966). Rows that left the
 * list while the query was out must stay gone.
 */

const { buildMock, fetchCrossViewMock } = vi.hoisted(() => ({
  buildMock: vi.fn(async () => [] as unknown[]),
  fetchCrossViewMock: vi.fn(),
}));

vi.mock('@/lib/unified-mailbox', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/unified-mailbox')>();
  return {
    ...actual,
    buildUnifiedAccountClients: buildMock,
    fetchCrossViewEmails: fetchCrossViewMock,
  };
});

import { useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';
import { CROSS_ALL } from '@/lib/jmap/types';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

const makeEmail = (id: string, receivedAt = '2026-09-01T10:00:00Z'): Email =>
  ({
    id,
    threadId: `t-${id}`,
    mailboxIds: { inbox: true },
    keywords: { $seen: true },
    from: [{ email: 'a@example.com' }],
    to: [{ email: 'b@example.com' }],
    subject: `mail ${id}`,
    receivedAt,
    preview: '',
    hasAttachment: false,
    size: 1,
  }) as unknown as Email;

const inbox = {
  id: 'inbox',
  name: 'Inbox',
  role: 'inbox',
  totalEmails: 3,
  unreadEmails: 0,
  totalThreads: 3,
  unreadThreads: 0,
} as unknown as Mailbox;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** What deleteEmail / moveToMailbox do once the server confirmed the move. */
function dropRow(id: string) {
  useEmailStore.setState((s) => ({ emails: s.emails.filter((e) => e.id !== id) }));
}

const ids = () => useEmailStore.getState().emails.map((e) => e.id);

describe('refreshCurrentMailbox with rows removed while the query was out (#966)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildMock.mockResolvedValue([]);
    useSettingsStore.setState({ emailsPerPage: 25 });
    useEmailStore.setState({
      emails: [],
      totalEmails: 0,
      searchQuery: '',
      selectedKeyword: null,
      isUnifiedView: false,
      unifiedRole: null,
      crossView: null,
      mailboxes: [inbox],
      accountMailboxes: {},
      viewingAccountId: null,
      emailListSync: null,
      newEmailNotification: null,
    });
  });

  it('All mail: a mail deleted during the refresh does not come back from its stale page', async () => {
    useEmailStore.setState({
      selectedMailbox: CROSS_ALL,
      isUnifiedView: true,
      crossView: 'all',
      emails: [makeEmail('a'), makeEmail('b'), makeEmail('c')],
      totalEmails: 3,
    });
    const page = deferred<unknown>();
    fetchCrossViewMock.mockReturnValue(page.promise);

    const refresh = useEmailStore.getState().refreshCurrentMailbox({} as IJMAPClient);
    await vi.waitFor(() => expect(fetchCrossViewMock).toHaveBeenCalled());
    // The server answered before b's move landed (d had just arrived); the
    // move then completes.
    dropRow('b');
    page.resolve({
      emails: [makeEmail('d'), makeEmail('a'), makeEmail('b'), makeEmail('c')],
      total: 4,
      hasMore: false,
      errors: new Map(),
    });
    await refresh;

    expect(ids()).toEqual(['d', 'a', 'c']);
    expect(useEmailStore.getState().totalEmails).toBe(3);
    expect(useEmailStore.getState().hasMoreEmails).toBe(false);
  });

  it('All mail: a refresh started after the removal shows the row if the server lists it', async () => {
    // E.g. the mail was moved back: only rows that left during THIS query are held back.
    useEmailStore.setState({
      selectedMailbox: CROSS_ALL,
      isUnifiedView: true,
      crossView: 'all',
      emails: [makeEmail('a'), makeEmail('c')],
      totalEmails: 2,
    });
    fetchCrossViewMock.mockResolvedValue({
      emails: [makeEmail('a'), makeEmail('b'), makeEmail('c')],
      total: 3,
      hasMore: false,
      errors: new Map(),
    });

    await useEmailStore.getState().refreshCurrentMailbox({} as IJMAPClient);

    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('folder: the stale row neither returns nor raises a new-mail notification', async () => {
    useEmailStore.setState({
      selectedMailbox: 'inbox',
      emails: [makeEmail('b', '2026-09-02T10:00:00Z'), makeEmail('a'), makeEmail('c')],
      totalEmails: 3,
    });
    const page = deferred<unknown>();
    const client = {
      getAccountId: () => 'acct',
      getEmails: vi.fn(() => page.promise),
    } as unknown as IJMAPClient;

    const refresh = useEmailStore.getState().refreshCurrentMailbox(client);
    await vi.waitFor(() => expect(client.getEmails).toHaveBeenCalled());
    dropRow('b');
    page.resolve({
      emails: [makeEmail('b', '2026-09-02T10:00:00Z'), makeEmail('a'), makeEmail('c')],
      total: 3,
      hasMore: false,
    });
    await refresh;

    expect(ids()).toEqual(['a', 'c']);
    expect(useEmailStore.getState().newEmailNotification).toBeNull();
  });
});
