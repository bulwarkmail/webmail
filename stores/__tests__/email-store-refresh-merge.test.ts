import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

/**
 * refreshCurrentMailbox merges the refreshed first page with the already
 * loaded list. The append cutoff must derive from the page size, not from
 * the refreshed list's length: when the folder shrank (a deletion - e.g.
 * the draft of a just-sent mail), a length-based cutoff re-appends the
 * deleted rows from stale local state. That ghost row is how "sent mail
 * still shows as draft" reports happen (#592) - and re-sending the ghost
 * delivers the mail again.
 */

const makeEmail = (id: string): Email =>
  ({
    id,
    threadId: `t-${id}`,
    mailboxIds: { d: true },
    keywords: {},
    from: [{ email: 'a@example.com' }],
    to: [{ email: 'b@example.com' }],
    subject: `mail ${id}`,
    receivedAt: '2026-07-23T10:00:00Z',
    preview: '',
    hasAttachment: false,
    size: 1,
  }) as unknown as Email;

const draftsMailbox = {
  id: 'd',
  name: 'Drafts',
  role: 'drafts',
  totalEmails: 1,
  unreadEmails: 0,
  totalThreads: 1,
  unreadThreads: 0,
} as unknown as Mailbox;

function makeClient(page: Email[], total: number): IJMAPClient {
  return {
    getEmails: vi.fn(async () => ({ emails: page, hasMore: false, total })),
  } as unknown as IJMAPClient;
}

describe('refreshCurrentMailbox merge', () => {
  beforeEach(() => {
    useSettingsStore.setState({ emailsPerPage: 3 });
    // Only override what the tests need - the store's initial state already
    // carries the correct empty search filters, view flags and caches.
    useEmailStore.setState({
      selectedMailbox: 'd',
      mailboxes: [draftsMailbox],
      accountMailboxes: {},
      emails: [],
      totalEmails: 0,
    });
  });

  it('drops a deleted row when the folder shrank below a full page (#592 ghost draft)', async () => {
    // Client state still lists the old draft; the server already deleted it.
    useEmailStore.setState({ emails: [makeEmail('ghost')], totalEmails: 1 });
    const client = makeClient([], 0);

    await useEmailStore.getState().refreshCurrentMailbox(client);

    expect(useEmailStore.getState().emails).toEqual([]);
    expect(useEmailStore.getState().totalEmails).toBe(0);
  });

  it('still preserves the item a new arrival pushes off the first page', async () => {
    const a = makeEmail('a');
    const b = makeEmail('b');
    const c = makeEmail('c');
    const fresh = makeEmail('new');
    useEmailStore.setState({ emails: [a, b, c], totalEmails: 3 });
    // New mail arrived: first page (size 3) now starts with it, c fell off.
    const client = makeClient([fresh, a, b], 4);

    await useEmailStore.getState().refreshCurrentMailbox(client);

    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['new', 'a', 'b', 'c']);
  });

  it('keeps loaded deeper pages while dropping a first-page deletion', async () => {
    const a = makeEmail('a');
    const b = makeEmail('b');
    const c = makeEmail('c');
    const d2 = makeEmail('d2');
    // Two loaded pages (page size 3); server deleted b from page one.
    useEmailStore.setState({ emails: [a, b, c, d2], totalEmails: 4 });
    const client = makeClient([a, c, d2], 3);

    await useEmailStore.getState().refreshCurrentMailbox(client);

    const ids = useEmailStore.getState().emails.map((e) => e.id);
    expect(ids).toContain('d2');
    expect(ids).not.toContain('b');
  });

  // Regression #780: a sidebar drop awaits refreshCurrentMailbox while the
  // move's push echo fires another one. Both must share a single in-flight
  // query (plus one follow-up) instead of racing the server's concurrency cap.
  it('coalesces concurrent refreshes into one in-flight query and one follow-up', async () => {
    const a = makeEmail('a');
    let resolveFirst!: (value: { emails: Email[]; hasMore: boolean; total: number }) => void;
    const getEmails = vi.fn()
      .mockImplementationOnce(() => new Promise<{ emails: Email[]; hasMore: boolean; total: number }>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({ emails: [a], hasMore: false, total: 1 });
    const client = { getEmails } as unknown as IJMAPClient;

    const store = useEmailStore.getState();
    const runs = [store.refreshCurrentMailbox(client), store.refreshCurrentMailbox(client)];
    expect(getEmails).toHaveBeenCalledTimes(1);

    resolveFirst({ emails: [], hasMore: false, total: 0 });
    await Promise.all(runs);

    expect(getEmails).toHaveBeenCalledTimes(2);
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['a']);
  });
});

describe('refreshCurrentMailbox when the server fails', () => {
  it('keeps the list on screen instead of emptying it', async () => {
    useSettingsStore.setState({ emailsPerPage: 3 });
    const a = makeEmail('a');
    useEmailStore.setState({
      selectedMailbox: 'd', mailboxes: [draftsMailbox], accountMailboxes: {}, emails: [a], totalEmails: 1,
    });
    const client = { getEmails: vi.fn(async () => { throw new Error('backend down'); }) } as unknown as IJMAPClient;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await useEmailStore.getState().refreshCurrentMailbox(client);

    expect(useEmailStore.getState().emails).toEqual([a]);
    expect(useEmailStore.getState().totalEmails).toBe(1);
  });
});
