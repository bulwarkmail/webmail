import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import type { Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Regression coverage for #788: the Advanced Search folder filter used to be
// bound straight to `selectedMailbox`, so a search started inside "Sent Items"
// was silently narrowed to that folder and the dropdown snapped back to the
// open folder every time the panel was reopened. The scope now lives in its own
// `searchMailboxId` ("" = all folders), independent of the mail list.

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

function makeClient() {
  return {
    searchEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 0 }),
    advancedSearchEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 0 }),
    getSomeEmails: vi.fn().mockResolvedValue([]),
    getEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 0, state: 'email-state' }),
    getThreads: vi.fn().mockResolvedValue([]),
    getAccountId: () => 'me',
  } as unknown as IJMAPClient;
}

describe('search folder scope (#788)', () => {
  let client: IJMAPClient;

  beforeEach(() => {
    client = makeClient();

    useAuthStore.setState({
      activeAccountId: 'account-a',
      getClientForAccount: (id: string) => (id === 'account-a' ? client : undefined) as never,
    } as never);

    useSettingsStore.setState({ emailsPerPage: 50 } as never);

    // The user is looking at Sent Items, the case from the bug report.
    useEmailStore.setState({
      isUnifiedView: false,
      unifiedRole: null,
      crossView: null,
      viewingAccountId: null,
      selectedMailbox: 'sent',
      searchMailboxId: '',
      searchQuery: '',
      searchFilters: { ...DEFAULT_SEARCH_FILTERS },
      searchAbortController: null,
      emails: [],
      mailboxes: [
        makeMailbox({ id: 'inbox', role: 'inbox' }),
        makeMailbox({ id: 'sent', name: 'Sent Items', role: 'sent' }),
        makeMailbox({ id: 'owner-x:x-inbox', originalId: 'x-inbox', name: 'Shared Inbox', role: 'inbox', isShared: true, accountId: 'owner-x' }),
      ],
      accountMailboxes: {},
    });
  });

  it('defaults to all folders instead of the open one', () => {
    expect(useEmailStore.getState().searchMailboxId).toBe('');
  });

  it('quick search from within a folder queries every folder of every account', async () => {
    await useEmailStore.getState().searchEmails(client, 'invoice');

    // No mailbox id -> the JMAP client omits the inMailbox constraint; the
    // shared folder's owner is asked as well (#1082).
    expect(client.searchEmails).toHaveBeenCalledTimes(2);
    expect(client.searchEmails).toHaveBeenCalledWith('invoice', undefined, undefined, 50, 0, { deferSnippets: true });
    expect(client.searchEmails).toHaveBeenCalledWith('invoice', undefined, 'owner-x', 50, 0, { deferSnippets: true });
  });

  it('advanced search from within a folder does not add an inMailbox condition', async () => {
    useEmailStore.setState({ searchFilters: { ...DEFAULT_SEARCH_FILTERS, from: 'bob@example.com' } });

    await useEmailStore.getState().advancedSearch(client);

    const calls = (client.advancedSearchEmails as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [filter] of calls) {
      expect(filter).toEqual({ from: 'bob@example.com' });
      expect(JSON.stringify(filter)).not.toContain('inMailbox');
    }
    expect(calls.map(([, accountId]) => accountId)).toEqual([undefined, 'owner-x']);
  });

  it('honours an explicitly chosen folder that differs from the open one', async () => {
    useEmailStore.getState().setSearchMailboxId('inbox');
    useEmailStore.setState({ searchFilters: { ...DEFAULT_SEARCH_FILTERS, from: 'bob@example.com' } });

    await useEmailStore.getState().advancedSearch(client);

    const [filter] = (client.advancedSearchEmails as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(filter).toEqual({
      operator: 'AND',
      conditions: [{ from: 'bob@example.com' }, { inMailbox: 'inbox' }],
    });
  });

  it('resolves a shared folder scope to its owner account and original id', async () => {
    useEmailStore.getState().setSearchMailboxId('owner-x:x-inbox');

    await useEmailStore.getState().advancedSearch(client);

    const [filter, accountId] = (client.advancedSearchEmails as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(filter).toEqual({ inMailbox: 'x-inbox' });
    expect(accountId).toBe('owner-x');
  });

  it('puts the folder next to the phrase conditions, not into an operator object', async () => {
    useEmailStore.getState().setSearchMailboxId('owner-x:x-inbox');
    useEmailStore.setState({
      searchQuery: '"annual report" 2024',
      searchFilters: { ...DEFAULT_SEARCH_FILTERS, from: 'bob@example.com' },
    });

    await useEmailStore.getState().advancedSearch(client);

    // Stalwart rejects an operator object that also carries inMailbox.
    const [filter, accountId] = (client.advancedSearchEmails as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(filter).toEqual({
      operator: 'AND',
      conditions: [
        { text: '"annual report"' },
        { text: '2024' },
        { from: 'bob@example.com' },
        { inMailbox: 'x-inbox' },
      ],
    });
    expect(accountId).toBe('owner-x');
  });

  it('keeps the chosen scope when the user navigates the mail list', () => {
    useEmailStore.getState().setSearchMailboxId('inbox');
    useEmailStore.getState().selectMailbox('sent');

    expect(useEmailStore.getState().searchMailboxId).toBe('inbox');
  });

  it('paginates search results under the search scope, not the open folder', async () => {
    useEmailStore.getState().setSearchMailboxId('inbox');
    useEmailStore.setState({
      searchQuery: 'invoice',
      searchFilters: { ...DEFAULT_SEARCH_FILTERS, from: 'bob@example.com' },
      hasMoreEmails: true,
      isLoadingMore: false,
      emails: [],
    });

    await useEmailStore.getState().loadMoreEmails(client);

    const [filter] = (client.advancedSearchEmails as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.stringify(filter)).toContain('"inMailbox":"inbox"');
    expect(JSON.stringify(filter)).not.toContain('"inMailbox":"sent"');
  });

  it('clearing the filters resets the scope back to all folders', () => {
    useEmailStore.getState().setSearchMailboxId('inbox');
    useEmailStore.getState().clearSearchFilters();

    expect(useEmailStore.getState().searchMailboxId).toBe('');
  });

  // #1430: "Clear" in the filter panel re-runs the search with nothing left
  // to search for, which listed every message of the account in the folder.
  it('shows the open folder again when the filters are cleared', async () => {
    useEmailStore.setState({ searchFilters: { ...DEFAULT_SEARCH_FILTERS, from: 'bob@example.com' } });
    await useEmailStore.getState().advancedSearch(client);
    (client.advancedSearchEmails as ReturnType<typeof vi.fn>).mockClear();

    useEmailStore.getState().clearSearchFilters();
    await useEmailStore.getState().advancedSearch(client);

    expect(client.advancedSearchEmails).not.toHaveBeenCalled();
    expect(client.getEmails).toHaveBeenCalledTimes(1);
    expect((client.getEmails as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('sent');
  });
});

// #1485: "Search in" set to the open folder makes a new search look only in
// the folder that is open, without picking it in the filters first.
describe('"Search in: the open folder" setting (#1485)', () => {
  let client: IJMAPClient;

  beforeEach(() => {
    client = makeClient();
    useAuthStore.setState({
      activeAccountId: 'account-a',
      getClientForAccount: (id: string) => (id === 'account-a' ? client : undefined) as never,
    } as never);
    useSettingsStore.setState({ emailsPerPage: 50, searchDefaultScope: 'folder' } as never);
    useEmailStore.setState({
      isUnifiedView: false,
      unifiedRole: null,
      crossView: null,
      viewingAccountId: null,
      selectedKeyword: null,
      selectedMailbox: 'inbox',
      searchMailboxId: 'inbox',
      searchScopeFollowsFolder: false,
      searchQuery: '',
      searchFilters: { ...DEFAULT_SEARCH_FILTERS },
      searchAbortController: null,
      emails: [],
      mailboxes: [
        makeMailbox({ id: 'inbox', role: 'inbox' }),
        makeMailbox({ id: 'sent', name: 'Sent Items', role: 'sent' }),
        makeMailbox({ id: 'owner-x:x-inbox', originalId: 'x-inbox', name: 'Shared Inbox', role: 'inbox', isShared: true, accountId: 'owner-x' }),
      ],
      accountMailboxes: {},
    });
  });

  afterEach(() => {
    useSettingsStore.setState({ searchDefaultScope: 'all' } as never);
  });

  it('quick search looks only in the folder that is open', async () => {
    useEmailStore.getState().selectMailbox('sent');
    expect(useEmailStore.getState().searchMailboxId).toBe('sent');

    await useEmailStore.getState().searchEmails(client, 'invoice');

    expect(client.searchEmails).toHaveBeenCalledTimes(1);
    expect(client.searchEmails).toHaveBeenCalledWith('invoice', 'sent', undefined, 50, 0, { deferSnippets: true });
  });

  it('searches a shared folder in its owner account', async () => {
    useEmailStore.getState().selectMailbox('owner-x:x-inbox');
    useEmailStore.setState({ searchFilters: { ...DEFAULT_SEARCH_FILTERS, from: 'bob@example.com' } });

    await useEmailStore.getState().advancedSearch(client);

    const calls = (client.advancedSearchEmails as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual({ operator: 'AND', conditions: [{ from: 'bob@example.com' }, { inMailbox: 'x-inbox' }] });
    expect(calls[0][1]).toBe('owner-x');
  });

  it('keeps a scope picked in the filters when another folder is opened', () => {
    useEmailStore.getState().setSearchMailboxId('');
    useEmailStore.getState().selectMailbox('sent');

    expect(useEmailStore.getState().searchMailboxId).toBe('');
  });

  it('clearing the filters goes back to the open folder', () => {
    useEmailStore.getState().setSearchMailboxId('*');
    useEmailStore.getState().clearSearchFilters();

    expect(useEmailStore.getState().searchMailboxId).toBe('inbox');
  });

  it('a view that is not a folder searches all folders', () => {
    useEmailStore.getState().selectMailbox('__unified_inbox');

    expect(useEmailStore.getState().searchMailboxId).toBe('');
  });

  it('changing the setting moves the open folder\'s scope with it', () => {
    useSettingsStore.setState({ searchDefaultScope: 'all' } as never);
    expect(useEmailStore.getState().searchMailboxId).toBe('');

    useSettingsStore.setState({ searchDefaultScope: 'folder' } as never);
    expect(useEmailStore.getState().searchMailboxId).toBe('inbox');

    // Then it follows the folders the user opens.
    useEmailStore.getState().selectMailbox('sent');
    expect(useEmailStore.getState().searchMailboxId).toBe('sent');
  });

  it('changing the setting leaves a scope picked in the filters alone', () => {
    useEmailStore.getState().setSearchMailboxId('sent');
    useSettingsStore.setState({ searchDefaultScope: 'all' } as never);

    expect(useEmailStore.getState().searchMailboxId).toBe('sent');
  });

  it('scopes the inbox the app opens with once the folder list arrives', async () => {
    useEmailStore.setState({ mailboxes: [], selectedMailbox: '', searchMailboxId: '' });
    const folders = [makeMailbox({ id: 'inbox', role: 'inbox' }), makeMailbox({ id: 'sent', role: 'sent' })];
    const listClient = { ...makeClient(), getAllMailboxes: vi.fn().mockResolvedValue(folders) } as unknown as IJMAPClient;

    await useEmailStore.getState().fetchMailboxes(listClient);

    expect(useEmailStore.getState().selectedMailbox).toBe('inbox');
    expect(useEmailStore.getState().searchMailboxId).toBe('inbox');
  });

  it('scopes a folder opened before the folder list arrived', async () => {
    useEmailStore.setState({ mailboxes: [], selectedMailbox: '', searchMailboxId: '' });
    useEmailStore.getState().selectMailbox('sent');
    const folders = [makeMailbox({ id: 'inbox', role: 'inbox' }), makeMailbox({ id: 'sent', role: 'sent' })];
    const listClient = { ...makeClient(), getAllMailboxes: vi.fn().mockResolvedValue(folders) } as unknown as IJMAPClient;

    await useEmailStore.getState().fetchMailboxes(listClient);

    expect(useEmailStore.getState().selectedMailbox).toBe('sent');
    expect(useEmailStore.getState().searchMailboxId).toBe('sent');
  });
});

describe('unread badge scope', () => {
  let client: IJMAPClient;

  beforeEach(() => {
    client = makeClient();
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
      selectedKeyword: null,
      selectedMailbox: 'sent',
      searchMailboxId: '',
      searchScopeFollowsFolder: false,
      searchQuery: '',
      searchFilters: { ...DEFAULT_SEARCH_FILTERS },
      searchAbortController: null,
      emails: [],
      mailboxes: [
        makeMailbox({ id: 'inbox', role: 'inbox' }),
        makeMailbox({ id: 'sent', name: 'Sent Items', role: 'sent' }),
        makeMailbox({ id: 'owner-x:x-inbox', originalId: 'x-inbox', name: 'Shared Inbox', role: 'inbox', isShared: true, accountId: 'owner-x' }),
      ],
      accountMailboxes: {},
    });
  });

  // What mail-app's handleUnreadFilterClick does with the store.
  async function clickUnreadBadge(mailboxId: string) {
    const store = useEmailStore.getState();
    store.selectMailbox(mailboxId);
    store.clearSearchFilters();
    store.scopeSearchToOpenFolder();
    store.setSearchFilters({ isUnread: true });
    await useEmailStore.getState().advancedSearch(client);
  }

  const searchCalls = () => (client.advancedSearchEmails as ReturnType<typeof vi.fn>).mock.calls;

  it('lists the unread mail of that folder, not of every folder and account', async () => {
    await clickUnreadBadge('inbox');

    expect(searchCalls()).toHaveLength(1);
    const [filter, accountId] = searchCalls()[0];
    expect(filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$seen' }, { inMailbox: 'inbox' }],
    });
    expect(accountId).toBeUndefined();
  });

  it('lists a shared folder in its owner account', async () => {
    await clickUnreadBadge('owner-x:x-inbox');

    expect(searchCalls()).toHaveLength(1);
    const [filter, accountId] = searchCalls()[0];
    expect(JSON.stringify(filter)).toContain('"inMailbox":"x-inbox"');
    expect(accountId).toBe('owner-x');
  });

  it('moves to the next folder the user opens instead of listing the old one there', async () => {
    await clickUnreadBadge('inbox');
    useEmailStore.getState().selectMailbox('sent');

    expect(useEmailStore.getState().searchMailboxId).toBe('sent');

    await useEmailStore.getState().advancedSearch(client);
    const [filter] = searchCalls()[1];
    expect(JSON.stringify(filter)).toContain('"inMailbox":"sent"');
    expect(JSON.stringify(filter)).not.toContain('"inMailbox":"inbox"');
  });

  it('stops following once the user picks a scope', async () => {
    await clickUnreadBadge('inbox');
    useEmailStore.getState().setSearchMailboxId('owner-x:x-inbox');
    useEmailStore.getState().selectMailbox('sent');

    expect(useEmailStore.getState().searchMailboxId).toBe('owner-x:x-inbox');
  });

  it('stops following once the filters are cleared', async () => {
    await clickUnreadBadge('inbox');
    useEmailStore.getState().clearSearchFilters();
    useEmailStore.getState().selectMailbox('sent');

    expect(useEmailStore.getState().searchMailboxId).toBe('');
  });
});
