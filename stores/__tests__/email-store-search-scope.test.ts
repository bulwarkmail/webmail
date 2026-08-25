import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('quick search from within a folder queries every folder', async () => {
    await useEmailStore.getState().searchEmails(client, 'invoice');

    // No mailbox id -> the JMAP client omits the inMailbox constraint.
    expect(client.searchEmails).toHaveBeenCalledWith('invoice', '', undefined, 50, 0);
  });

  it('advanced search from within a folder does not add an inMailbox condition', async () => {
    useEmailStore.setState({ searchFilters: { ...DEFAULT_SEARCH_FILTERS, from: 'bob@example.com' } });

    await useEmailStore.getState().advancedSearch(client);

    const [filter] = (client.advancedSearchEmails as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(filter).toEqual({ from: 'bob@example.com' });
    expect(JSON.stringify(filter)).not.toContain('inMailbox');
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
});
