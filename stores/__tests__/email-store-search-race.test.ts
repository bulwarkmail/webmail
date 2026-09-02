import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Quick search fired an unguarded request per keystroke: no AbortController and
// no staleness check, so whichever response landed LAST won regardless of which
// query it belonged to. advancedSearch already guarded every write with
// `controller.signal.aborted`; searchEmails did not.
//
// The visible symptom is nasty because it looks like a server bug: type an
// address slowly and a short-prefix response arrives after the full-query one
// and repaints the list, so the box and the results disagree. Retype the same
// string in one go and you get the (correct) empty result, which reads as "the
// same search works sometimes and not others".

function makeMailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: 'inbox',
    name: 'Inbox',
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    isSubscribed: true,
    isShared: false,
    ...overrides,
  } as Mailbox;
}

function makeEmail(id: string): Email {
  return { id, subject: id, receivedAt: '2026-01-01T00:00:00Z', mailboxIds: { inbox: true } } as unknown as Email;
}

describe('quick search staleness', () => {
  let client: IJMAPClient;
  type Pending = {
    resolve: (value: { emails: Email[]; hasMore: boolean; total: number }) => void;
    reject: (reason: unknown) => void;
  };
  let pending: Pending[];

  beforeEach(() => {
    pending = [];

    client = {
      // Hand back a promise per call that the test settles by hand, so the
      // responses can be made to arrive out of order.
      searchEmails: vi.fn().mockImplementation(
        () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); })
      ),
      advancedSearchEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 0 }),
      getSomeEmails: vi.fn().mockResolvedValue([]),
    } as unknown as IJMAPClient;

    useAuthStore.setState({
      activeAccountId: 'account-a',
      getClientForAccount: (id: string) => (id === 'account-a' ? client : undefined) as never,
    } as never);

    useSettingsStore.setState({ emailsPerPage: 50 } as never);

    useEmailStore.setState({
      isUnifiedView: false,
      unifiedRole: null,
      crossView: null,
      viewingAccountId: null,
      selectedMailbox: 'inbox',
      searchMailboxId: '',
      searchQuery: '',
      searchFilters: { ...DEFAULT_SEARCH_FILTERS },
      searchAbortController: null,
      emails: [],
      mailboxes: [makeMailbox({ id: 'inbox', role: 'inbox' })],
      accountMailboxes: {},
    });
  });

  it('discards a slow response once a newer query has been started', async () => {
    // Keystroke 1 goes out and stalls.
    const first = useEmailStore.getState().searchEmails(client, 'qeti');
    // Keystroke 2 goes out before the first came back.
    const second = useEmailStore.getState().searchEmails(client, 'qeti@smartchoice.ge');

    expect(client.searchEmails).toHaveBeenCalledTimes(2);

    // The newer query legitimately matches nothing.
    pending[1].resolve({ emails: [], hasMore: false, total: 0 });
    await second;

    // The older, broader query now answers late with hits.
    pending[0].resolve({ emails: [makeEmail('stale-1'), makeEmail('stale-2')], hasMore: false, total: 2 });
    await first;

    const state = useEmailStore.getState();
    expect(state.searchQuery).toBe('qeti@smartchoice.ge');
    // Without the guard the late response repaints the list and the user sees
    // two results for a query that matched none.
    expect(state.emails).toEqual([]);
    expect(state.totalEmails).toBe(0);
  });

  it('aborts the in-flight request when a new search starts', async () => {
    const first = useEmailStore.getState().searchEmails(client, 'qeti');
    const controllerForFirst = useEmailStore.getState().searchAbortController;
    expect(controllerForFirst?.signal.aborted).toBe(false);

    const second = useEmailStore.getState().searchEmails(client, 'qeti@smartchoice.ge');
    expect(controllerForFirst?.signal.aborted).toBe(true);

    pending.forEach(p => p.resolve({ emails: [], hasMore: false, total: 0 }));
    await Promise.all([first, second]);
  });

  it('does not let a stale failure wipe the current results', async () => {
    const first = useEmailStore.getState().searchEmails(client, 'qeti');
    const second = useEmailStore.getState().searchEmails(client, 'qeti@smartchoice.ge');

    pending[1].resolve({ emails: [makeEmail('good-1')], hasMore: false, total: 1 });
    await second;

    // The superseded request rejects after the fact.
    pending[0].reject(new Error("network blip"));
    await first;

    const state = useEmailStore.getState();
    expect(state.error).toBeNull();
    expect(state.emails.map(e => e.id)).toEqual(['good-1']);
  });
});
