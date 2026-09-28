import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';
import { useAuthStore } from '../auth-store';
import { useMessageListTabsStore } from '../message-list-tabs-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Issue #1082: in the standard interface the search scoped to "All folders"
// (searchMailboxId "") issued a single Email/query against the login's own
// JMAP account. A group account delegated to the same login - its folders in
// the sidebar and in the Folder dropdown - was never queried, so its mail was
// missing from every unscoped search with nothing but "No results found" to
// show for it; picking the group's folder in the dropdown found the same mail.
// "All folders" now fans out over the own + group accounts like the tag
// views (#1038), and the hits carry their source stamps so opening and
// acting on them routes to the owning account.

const ownInbox = { id: 'inbox', name: 'Inbox', role: 'inbox', isShared: false } as Mailbox;
const ownSent = { id: 'sent', name: 'Sent', role: 'sent', isShared: false } as Mailbox;
const groupInbox = {
  id: 'group:inbox', originalId: 'inbox', name: 'Abrir Chamados', role: 'inbox',
  isShared: true, accountId: 'group', accountName: 'chamados@server.tld',
} as Mailbox;

function email(id: string, mailbox: string, receivedAt: string, subject: string, seen = true): Email {
  return {
    id, threadId: `thread-${id}`, mailboxIds: { [mailbox]: true },
    keywords: seen ? { $seen: true } : {},
    subject, preview: subject, receivedAt,
    from: [{ email: 'sender@example.com' }], to: [], size: 1, hasAttachment: false,
  } as Email;
}

// "acesso" occurs only in the group account, "fatura" only in the own one.
const own = [
  email('own-1', 'inbox', '2026-09-14T00:00:00Z', 'fatura de setembro'),
  email('own-2', 'sent', '2026-09-12T00:00:00Z', 'fatura enviada'),
];
const group = [
  email('grp-1', 'group:inbox', '2026-09-13T00:00:00Z', 'acesso liberado', false),
  email('grp-2', 'group:inbox', '2026-09-11T00:00:00Z', 'acesso negado'),
];

function makeClient() {
  const rowsFor = (accountId?: string) => (accountId === 'group' ? group : own);
  const matching = (accountId: string | undefined, term: string) =>
    rowsFor(accountId).filter(row => (row.subject ?? '').includes(term.replace(/\*$/, '')));
  const page = (rows: Email[], limit: number, position: number) => ({
    emails: rows.slice(position, position + limit),
    total: rows.length,
    hasMore: position + limit < rows.length,
  });
  const searchEmails = vi.fn<IJMAPClient['searchEmails']>(async (
    query: string, _mailboxId?: string, accountId?: string, limit = 50, position = 0,
  ) => page(matching(accountId, query), limit, position));
  const advancedSearchEmails = vi.fn<IJMAPClient['advancedSearchEmails']>(async (
    filter: Record<string, unknown>, accountId?: string, limit = 50, position = 0,
  ) => {
    const text = JSON.stringify(filter).match(/"text":"([^"*]+)/)?.[1] ?? '';
    return page(matching(accountId, text), limit, position);
  });
  const client = {
    searchEmails,
    advancedSearchEmails,
    getSomeEmails: vi.fn(async () => []),
    getThreads: vi.fn(async () => []),
    batchMarkAsRead: vi.fn(async () => undefined),
    getAccountId: () => 'me',
  } as unknown as IJMAPClient & {
    searchEmails: typeof searchEmails;
    advancedSearchEmails: typeof advancedSearchEmails;
    batchMarkAsRead: ReturnType<typeof vi.fn>;
  };
  return client;
}

describe('"All folders" search across the own and group accounts (#1082)', () => {
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
      searchMailboxId: '',
      searchFilters: { ...DEFAULT_SEARCH_FILTERS },
      mailboxes: [ownInbox, ownSent, groupInbox],
    });
  });

  it('finds mail that exists only in the group account', async () => {
    await useEmailStore.getState().searchEmails(client, 'acesso');

    const state = useEmailStore.getState();
    expect(state.emails.map(e => e.id)).toEqual(['grp-1', 'grp-2']);
    expect(state.totalEmails).toBe(2);
    expect(state.hasMoreEmails).toBe(false);
    // One folder-less query per account.
    expect(client.searchEmails).toHaveBeenCalledTimes(2);
    expect(client.searchEmails).toHaveBeenCalledWith('acesso', undefined, undefined, 50, 0);
    expect(client.searchEmails).toHaveBeenCalledWith('acesso', undefined, 'group', 50, 0);
  });

  it('merges own and group hits newest first and stamps each with its source', async () => {
    await useEmailStore.getState().searchEmails(client, 'a');

    const { emails } = useEmailStore.getState();
    expect(emails.map(e => e.id)).toEqual(['own-1', 'grp-1', 'own-2', 'grp-2']);
    const byId = Object.fromEntries(emails.map(e => [e.id, e]));
    expect(byId['own-1']).toMatchObject({ sourceClientAccountId: 'login', sourceAccountId: 'me', sourceFolder: 'Inbox' });
    expect(byId['own-2']).toMatchObject({ sourceAccountId: 'me', sourceFolder: 'Sent' });
    expect(byId['grp-1']).toMatchObject({
      sourceClientAccountId: 'login', sourceAccountId: 'group',
      accountLabel: 'chamados@server.tld', sourceFolder: 'Abrir Chamados',
    });
  });

  it('runs an advanced search with a folder-less filter in every account', async () => {
    useEmailStore.setState({ searchQuery: 'acesso', searchFilters: { ...DEFAULT_SEARCH_FILTERS, from: 'sender@example.com' } });

    await useEmailStore.getState().advancedSearch(client);

    const calls = client.advancedSearchEmails.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.map(([, accountId]) => accountId)).toEqual([undefined, 'group']);
    for (const [filter] of calls) {
      expect(filter).toEqual({
        operator: 'AND',
        conditions: [{ text: 'acesso' }, { from: 'sender@example.com' }],
      });
    }
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['grp-1', 'grp-2']);
  });

  it('still asks only the chosen account when the search is scoped to a group folder', async () => {
    useEmailStore.getState().setSearchMailboxId(groupInbox.id);

    await useEmailStore.getState().searchEmails(client, 'acesso');

    expect(client.searchEmails).toHaveBeenCalledTimes(1);
    expect(client.searchEmails).toHaveBeenCalledWith('acesso', 'inbox', 'group', 50, 0);
  });

  it('makes a single own-account query for a login without group folders', async () => {
    useEmailStore.setState({ mailboxes: [ownInbox, ownSent] });

    await useEmailStore.getState().searchEmails(client, 'fatura');

    expect(client.searchEmails).toHaveBeenCalledTimes(1);
    expect(client.searchEmails).toHaveBeenCalledWith('fatura', undefined, undefined, 50, 0);
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['own-1', 'own-2']);
  });

  it('paginates the fan-out from the loaded position in every account', async () => {
    useSettingsStore.setState({ emailsPerPage: 1 } as never);
    await useEmailStore.getState().searchEmails(client, 'a');
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['own-1', 'grp-1']);
    expect(useEmailStore.getState().hasMoreEmails).toBe(true);

    await useEmailStore.getState().loadMoreEmails(client);

    // Each account continues after its own rows, not at the merged length.
    expect(client.searchEmails).toHaveBeenCalledWith('a', undefined, undefined, 1, 1);
    expect(client.searchEmails).toHaveBeenCalledWith('a', undefined, 'group', 1, 1);
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['own-1', 'grp-1', 'own-2', 'grp-2']);
    expect(useEmailStore.getState().hasMoreEmails).toBe(false);
  });

  it('marks a mixed selection read in each owning account', async () => {
    await useEmailStore.getState().searchEmails(client, 'a');
    useEmailStore.setState({ selectedEmailIds: new Set(['own-1', 'grp-1']) });

    await useEmailStore.getState().batchMarkAsRead(client, true);

    expect(client.batchMarkAsRead).toHaveBeenCalledWith(['own-1'], true, 'me');
    expect(client.batchMarkAsRead).toHaveBeenCalledWith(['grp-1'], true, 'group');
  });

  it('re-runs the fan-out when a push reports a change in the group account only', async () => {
    await useEmailStore.getState().searchEmails(client, 'acesso');
    client.searchEmails.mockClear();
    client.advancedSearchEmails.mockClear();

    await useEmailStore.getState().handleStateChange({
      '@type': 'StateChange', changed: { group: { Email: '2' } },
    }, client);

    const calls = client.advancedSearchEmails.mock.calls;
    expect(calls.map(([, accountId]) => accountId)).toEqual([undefined, 'group']);
    expect(calls.every(([filter]) => !JSON.stringify(filter).includes('inMailbox'))).toBe(true);
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['grp-1', 'grp-2']);
  });
});
