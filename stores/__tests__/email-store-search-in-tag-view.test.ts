import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';
import { useAuthStore } from '../auth-store';
import { useMessageListTabsStore } from '../message-list-tabs-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Selecting a tag does not clear an active search (`handleTagSelect` leaves
// searchQuery/searchFilters alone, and `selectKeyword` leaves selectedMailbox),
// so a tag view and a search can be active together. The paths disagreed about
// which one wins: fetchEmails and refreshCurrentMailbox tested `selectedKeyword`
// first (tag fan-out, query dropped), while searchEmails / advancedSearch /
// loadMoreEmails tested the search first (all-folders fan-out, tag dropped).
// A push-triggered refresh therefore silently replaced a search result list
// with the whole tag, and page 2 appended rows the tag did not contain.
//
// A search inside a tag view now NARROWS the tag everywhere.

const ownInbox = { id: 'inbox', name: 'Inbox', role: 'inbox', isShared: false } as Mailbox;
const groupInbox = {
  id: 'group:inbox', originalId: 'inbox', name: 'Team', role: 'inbox',
  isShared: true, accountId: 'group', accountName: 'team@example.org',
} as Mailbox;

function email(id: string, mailbox: string, receivedAt: string, subject: string): Email {
  return {
    id, threadId: `thread-${id}`, mailboxIds: { [mailbox]: true },
    keywords: { $seen: true, '$label:red': true },
    subject, preview: subject, receivedAt,
    from: [{ email: 'sender@example.com' }], to: [], size: 1, hasAttachment: false,
  } as Email;
}

const tagged: Record<string, Email[]> = {
  me: [email('own-1', 'inbox', '2026-09-14T00:00:00Z', 'invoice red')],
  group: [email('grp-1', 'group:inbox', '2026-09-13T00:00:00Z', 'invoice team')],
};

function makeClient() {
  // getEmails is the tag-view call: (mailboxId, accountId, limit, position,
  // hasKeyword, pinnedFirst, extraFilter, order).
  const getEmails = vi.fn<IJMAPClient['getEmails']>(async (
    _mailboxId?: string, accountId?: string, limit = 50, position = 0,
    hasKeyword?: string, _pinnedFirst?: boolean, extraFilter?: Record<string, unknown>,
  ) => {
    let rows = hasKeyword ? (tagged[accountId ?? 'me'] ?? []) : [];
    if (extraFilter) {
      // Match either a free-text condition or a `subject` field filter.
      const blob = JSON.stringify(extraFilter);
      const term = (blob.match(/"text":"([^"*]+)/) ?? blob.match(/"subject":"([^"*]+)/))?.[1] ?? '';
      if (term) rows = rows.filter(r => (r.subject ?? '').includes(term));
    }
    return {
      emails: rows.slice(position, position + limit),
      total: rows.length,
      hasMore: position + limit < rows.length,
    };
  });
  return {
    getEmails,
    searchEmails: vi.fn(async () => ({ emails: [], total: 0, hasMore: false })),
    advancedSearchEmails: vi.fn(async () => ({ emails: [], total: 0, hasMore: false })),
    getSomeEmails: vi.fn(async () => []),
    getThreads: vi.fn(async () => []),
    getAccountId: () => 'me',
  } as unknown as IJMAPClient & { getEmails: typeof getEmails };
}

/** The `extraFilter` of every tag-view getEmails call. */
const filtersOf = (c: ReturnType<typeof makeClient>) =>
  c.getEmails.mock.calls.filter(args => !!args[4]).map(args => args[6]);

describe('searching inside a tag view narrows the tag', () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
    useAuthStore.setState({
      activeAccountId: 'login',
      getClientForAccount: ((id: string) => (id === 'login' ? client : undefined)) as never,
      getAllConnectedClients: (() => new Map([['login', client]])) as never,
    } as never);
    useMessageListTabsStore.setState(useMessageListTabsStore.getInitialState());
    useSettingsStore.setState({
      emailsPerPage: 50, messageListOrder: [], messageListOrderScope: 'inbox', emailKeywords: [],
    } as never);
    useEmailStore.setState({
      ...useEmailStore.getInitialState(),
      selectedMailbox: ownInbox.id,
      selectedKeyword: 'red',
      searchMailboxId: '',
      searchFilters: { ...DEFAULT_SEARCH_FILTERS },
      mailboxes: [ownInbox, groupInbox],
    });
  });

  it('keeps the keyword and applies the query, instead of searching all folders', async () => {
    await useEmailStore.getState().searchEmails(client, 'team');

    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['grp-1']);
    // The tag fan-out ran (one keyword query per account), not a folder search.
    expect(client.searchEmails).not.toHaveBeenCalled();
    expect(client.getEmails).toHaveBeenCalled();
    for (const f of filtersOf(client)) expect(JSON.stringify(f)).toContain('team');
  });

  it('carries the query into a field-filter search too', async () => {
    useEmailStore.setState({
      searchQuery: '',
      searchFilters: { ...DEFAULT_SEARCH_FILTERS, subject: 'team' },
    });
    await useEmailStore.getState().advancedSearch(client);

    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['grp-1']);
    expect(client.advancedSearchEmails).not.toHaveBeenCalled();
  });

  it('carries the query into a refresh, so a push does not widen the list', async () => {
    useEmailStore.setState({ searchQuery: 'team' });
    await useEmailStore.getState().refreshCurrentMailbox(client);

    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['grp-1']);
    const applied = filtersOf(client);
    expect(applied.length).toBeGreaterThan(0);
    for (const f of applied) expect(JSON.stringify(f)).toContain('team');
  });

  it('still lists the whole tag when no search is active', async () => {
    await useEmailStore.getState().refreshCurrentMailbox(client);

    expect(useEmailStore.getState().emails.map(e => e.id).sort()).toEqual(['grp-1', 'own-1']);
    for (const f of filtersOf(client)) expect(f).toBeUndefined();
  });
});
