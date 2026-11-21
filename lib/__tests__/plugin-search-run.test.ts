import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import type { Mailbox } from '../jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { DEFAULT_SEARCH_FILTERS, buildJMAPFilter, isFilterEmpty } from '../jmap/search-utils';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';

function plugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'related',
    name: 'Related mail',
    version: '1.0.0',
    author: 'test',
    description: '',
    type: 'hook',
    permissions: ['email:read'],
    grantedPermissions: ['email:read'],
    entrypoint: 'index.js',
    enabled: true,
    status: 'running',
    settings: {},
    ...overrides,
  };
}

const inbox = {
  id: 'mb-inbox', name: 'Inbox', role: 'inbox', sortOrder: 0,
  totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
} as unknown as Mailbox;

const QUERY = {
  operator: 'AND',
  conditions: [
    { from: 'alice@example.com' },
    { header: ['List-Id'] },
    { notKeyword: '$seen' },
  ],
};

let advancedSearchEmails: ReturnType<typeof vi.fn>;

beforeEach(() => {
  advancedSearchEmails = vi.fn(async () => ({
    emails: [{ id: 'e1', threadId: 't1', mailboxIds: { 'mb-inbox': true }, keywords: {} }],
    hasMore: false,
    total: 1,
  }));
  const client = { advancedSearchEmails } as unknown as IJMAPClient;
  useAuthStore.setState({ client });
  useEmailStore.setState({
    mailboxes: [inbox],
    selectedMailbox: 'mb-inbox',
    // A folder picked in the search panel: the search stays in it.
    searchMailboxId: 'mb-inbox',
    searchQuery: 'typed text',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS, subject: 'old' },
    emails: [],
  });
});

afterEach(() => {
  useAuthStore.setState({ client: null });
  useEmailStore.setState({
    searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS },
    searchMailboxId: '',
    emails: [],
    mailboxes: [],
  });
});

describe('api.search.run (#1024)', () => {
  it('needs email:read', async () => {
    await expect(dispatchApiCall(plugin({ permissions: [], grantedPermissions: [] }), 'search.run', [QUERY]))
      .rejects.toThrow(/lacks permission "email:read"/);
  });

  it('runs the filter as the list search, replacing the user search', async () => {
    await dispatchApiCall(plugin(), 'search.run', [QUERY]);

    expect(advancedSearchEmails).toHaveBeenCalledTimes(1);
    expect(advancedSearchEmails.mock.calls[0][0]).toEqual({
      operator: 'AND',
      conditions: [QUERY, { inMailbox: 'mb-inbox' }],
    });

    const state = useEmailStore.getState();
    expect(state.searchQuery).toBe('');
    expect(state.searchFilters.subject).toBe('');
    expect(state.searchFilters.pluginFilter).toEqual({ pluginId: 'related', label: 'Related mail', filter: QUERY });
    expect(state.emails.map((e) => e.id)).toEqual(['e1']);
  });

  it('uses the label the plugin passes for the chip', async () => {
    await dispatchApiCall(plugin(), 'search.run', [QUERY, { label: '  From Alice  ' }]);
    expect(useEmailStore.getState().searchFilters.pluginFilter?.label).toBe('From Alice');
  });

  it('stores a plain copy, so later changes to the object do not reach the request', async () => {
    const query = { from: 'alice@example.com' };
    await dispatchApiCall(plugin(), 'search.run', [query]);
    query.from = 'mallory@example.com';
    expect(useEmailStore.getState().searchFilters.pluginFilter?.filter).toEqual({ from: 'alice@example.com' });
  });

  it.each([
    ['an array', [[{ from: 'a' }]], /must be a JMAP filter object/],
    ['a string', ['from:alice'], /must be a JMAP filter object/],
    ['an empty filter', [{}], /must not be empty/],
    ['an oversized filter', [{ text: 'x'.repeat(17 * 1024) }], /exceeds/],
    ['a non-string label', [{ from: 'a' }, { label: 5 }], /label must be a string/],
  ])('rejects %s without touching the search', async (_name, args, error) => {
    await expect(dispatchApiCall(plugin(), 'search.run', args)).rejects.toThrow(error);
    expect(advancedSearchEmails).not.toHaveBeenCalled();
    expect(useEmailStore.getState().searchQuery).toBe('typed text');
  });
});

describe('api.search.clear', () => {
  const own = { pluginId: 'related', label: 'Related mail', filter: { from: 'alice@example.com' } };

  it('needs email:read', async () => {
    await expect(dispatchApiCall(plugin({ permissions: [], grantedPermissions: [] }), 'search.clear', []))
      .rejects.toThrow(/lacks permission "email:read"/);
  });

  it("ends the plugin's own search as clearing the chips does", async () => {
    useEmailStore.setState({ searchQuery: '', searchFilters: { ...DEFAULT_SEARCH_FILTERS, pluginFilter: own } });

    const { fetchEmails } = useEmailStore.getState();
    const loadFolder = vi.fn(async () => {});
    useEmailStore.setState({ fetchEmails: loadFolder });
    try {
      await expect(dispatchApiCall(plugin(), 'search.clear', [])).resolves.toBe(true);
    } finally {
      useEmailStore.setState({ fetchEmails });
    }

    expect(isFilterEmpty(useEmailStore.getState().searchFilters)).toBe(true);
    // Nothing left to search for: the open folder's list again (#1430).
    expect(advancedSearchEmails).not.toHaveBeenCalled();
    expect(loadFolder).toHaveBeenCalledTimes(1);
  });

  it('keeps filters the user added on top and searches again with them', async () => {
    useEmailStore.setState({ searchQuery: '', searchFilters: { ...DEFAULT_SEARCH_FILTERS, pluginFilter: own, hasAttachment: true } });
    await expect(dispatchApiCall(plugin(), 'search.clear', [])).resolves.toBe(true);
    const { searchFilters } = useEmailStore.getState();
    expect(searchFilters.pluginFilter).toBeNull();
    expect(searchFilters.hasAttachment).toBe(true);
    expect(advancedSearchEmails).toHaveBeenCalledTimes(1);
  });

  it('leaves a search the user typed', async () => {
    await expect(dispatchApiCall(plugin(), 'search.clear', [])).resolves.toBe(false);
    const state = useEmailStore.getState();
    expect(state.searchQuery).toBe('typed text');
    expect(state.searchFilters.subject).toBe('old');
    expect(advancedSearchEmails).not.toHaveBeenCalled();
  });

  it("leaves another plugin's search", async () => {
    const other = { ...own, pluginId: 'other' };
    useEmailStore.setState({ searchQuery: '', searchFilters: { ...DEFAULT_SEARCH_FILTERS, pluginFilter: other } });
    await expect(dispatchApiCall(plugin(), 'search.clear', [])).resolves.toBe(false);
    expect(useEmailStore.getState().searchFilters.pluginFilter).toEqual(other);
    expect(advancedSearchEmails).not.toHaveBeenCalled();
  });

  it('ends a search the plugin ran with search.run', async () => {
    await dispatchApiCall(plugin(), 'search.run', [QUERY]);
    await expect(dispatchApiCall(plugin(), 'search.clear', [])).resolves.toBe(true);
    expect(isFilterEmpty(useEmailStore.getState().searchFilters)).toBe(true);
  });
});

describe('plugin filter in SearchFilters', () => {
  const pluginFilter = { pluginId: 'related', label: 'Related', filter: { from: 'alice@example.com' } };

  it('counts as an active search and is ANDed with the other fields', () => {
    const filters = { ...DEFAULT_SEARCH_FILTERS, isUnread: true, pluginFilter };
    expect(isFilterEmpty(filters)).toBe(false);
    expect(buildJMAPFilter('', filters, undefined)).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$seen' }, { from: 'alice@example.com' }],
    });
  });

  it('is gone after the filters are cleared', () => {
    useEmailStore.setState({ searchFilters: { ...DEFAULT_SEARCH_FILTERS, pluginFilter } });
    useEmailStore.getState().clearSearchFilters();
    expect(isFilterEmpty(useEmailStore.getState().searchFilters)).toBe(true);
  });
});
