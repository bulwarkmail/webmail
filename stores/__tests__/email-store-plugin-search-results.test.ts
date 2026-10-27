import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import type { ExternalSearchResult } from '@/lib/plugin-types';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// onProvideSearchResults: plugins' results from elsewhere, asked beside the
// search, never before its list is shown.

const hit = (id: string): Email => ({
  id, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: {}, subject: `Subject ${id}`,
  receivedAt: '2026-10-01T00:00:00Z', from: [], to: [], preview: '', size: 1, hasAttachment: false,
} as Email);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const entry = (key: string): ExternalSearchResult => ({ key, title: `Title ${key}`, snippet: 'text', source: 'CRM' });

let client: IJMAPClient;

beforeEach(() => {
  clearAllHooks();
  client = {
    getAccountId: () => 'me',
    searchEmails: vi.fn().mockResolvedValue({ emails: [hit('e1')], hasMore: false, total: 1 }),
    advancedSearchEmails: vi.fn().mockResolvedValue({ emails: [hit('e1')], hasMore: false, total: 1 }),
    getSomeEmails: vi.fn().mockResolvedValue([]),
  } as unknown as IJMAPClient;
  useAuthStore.setState({ activeAccountId: 'acct', getClientForAccount: () => client as never } as never);
  useSettingsStore.setState({ emailsPerPage: 50 } as never);
  useEmailStore.setState({
    mailboxes: [{ id: 'inbox', name: 'Inbox', role: 'inbox', isShared: false } as Mailbox],
    accountMailboxes: {},
    viewingAccountId: null,
    selectedMailbox: 'inbox',
    searchMailboxId: 'inbox',
    selectedKeyword: null,
    isUnifiedView: false,
    unifiedRole: null,
    crossView: null,
    searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS },
    searchAbortController: null,
    externalSearchResults: [],
    emails: [],
  });
});

afterEach(() => clearAllHooks());

describe('onProvideSearchResults', () => {
  it('lists the messages before a slow plugin answers, then shows its entries with the plugin', async () => {
    const answer = deferred<ExternalSearchResult[]>();
    const handler = vi.fn(() => answer.promise);
    emailHooks.onProvideSearchResults.register('crm', handler);

    await useEmailStore.getState().searchEmails(client, 'resolution');

    expect(handler).toHaveBeenCalledWith([], { query: 'resolution', filters: DEFAULT_SEARCH_FILTERS });
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['e1']);
    expect(useEmailStore.getState().externalSearchResults).toEqual([]);

    answer.resolve([entry('m1')]);
    await vi.waitFor(() => expect(useEmailStore.getState().externalSearchResults).toHaveLength(1));
    expect(useEmailStore.getState().externalSearchResults[0]).toEqual({ ...entry('m1'), pluginId: 'crm' });
  });

  it('asks every plugin on its own and keeps each entry with the plugin that gave it', async () => {
    emailHooks.onProvideSearchResults.register('a', (results: ExternalSearchResult[]) => [...results, entry('x')]);
    emailHooks.onProvideSearchResults.register('b', (results: ExternalSearchResult[]) => [...results, entry('x')]);

    await useEmailStore.getState().searchEmails(client, 'resolution');

    await vi.waitFor(() => expect(useEmailStore.getState().externalSearchResults).toHaveLength(2));
    expect(useEmailStore.getState().externalSearchResults.map((r) => r.pluginId)).toEqual(['a', 'b']);
  });

  it('drops the answer to a search that was replaced', async () => {
    const first = deferred<ExternalSearchResult[]>();
    const second = deferred<ExternalSearchResult[]>();
    const answers = [first, second];
    emailHooks.onProvideSearchResults.register('crm', () => answers.shift()!.promise);

    await useEmailStore.getState().searchEmails(client, 'one');
    await useEmailStore.getState().searchEmails(client, 'two');
    second.resolve([entry('two')]);
    await vi.waitFor(() => expect(useEmailStore.getState().externalSearchResults).toHaveLength(1));
    first.resolve([entry('one')]);
    await first.promise;
    await new Promise((r) => setTimeout(r, 0));

    expect(useEmailStore.getState().externalSearchResults.map((r) => r.key)).toEqual(['two']);
  });

  it('clears the last search\'s entries when a new search starts', async () => {
    emailHooks.onProvideSearchResults.register('crm', (_results: ExternalSearchResult[], { query }: { query: string }) =>
      (query === 'one' ? [entry('one')] : new Promise(() => {})));

    await useEmailStore.getState().searchEmails(client, 'one');
    await vi.waitFor(() => expect(useEmailStore.getState().externalSearchResults).toHaveLength(1));
    await useEmailStore.getState().searchEmails(client, 'two');

    expect(useEmailStore.getState().externalSearchResults).toEqual([]);
  });

  it('does the same on the advanced search', async () => {
    const answer = deferred<ExternalSearchResult[]>();
    emailHooks.onProvideSearchResults.register('crm', () => answer.promise);
    useEmailStore.setState({ searchQuery: 'resolution', searchFilters: { ...DEFAULT_SEARCH_FILTERS, from: 'bob@x.test' } });

    await useEmailStore.getState().advancedSearch(client);

    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['e1']);
    answer.resolve([entry('m1')]);
    await vi.waitFor(() => expect(useEmailStore.getState().externalSearchResults).toHaveLength(1));
    expect(useEmailStore.getState().externalSearchResults[0].pluginId).toBe('crm');
  });
});
