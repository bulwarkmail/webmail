import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import type { Email, Mailbox } from '../jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { DEFAULT_SEARCH_FILTERS, buildJMAPFilter, isPluginMessageList } from '../jmap/search-utils';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';

function plugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'finder',
    name: 'Finder',
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
const teamInbox = {
  id: 'team:mb-1', originalId: 'mb-1', name: 'Inbox', role: 'inbox', sortOrder: 0, isShared: true, accountId: 'team',
  accountName: 'Team', totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
} as unknown as Mailbox;

const mail = (id: string, day: number) =>
  ({ id, threadId: `t-${id}`, mailboxIds: { 'mb-inbox': true }, keywords: {}, receivedAt: `2026-11-${10 + day}T10:00:00Z` }) as unknown as Email;

const stored: Record<string, Email[]> = {
  own: [mail('e1', 1), mail('e2', 2), mail('e3', 3)],
  team: [mail('t1', 4)],
};

let getSomeEmails: ReturnType<typeof vi.fn>;
let advancedSearchEmails: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getSomeEmails = vi.fn(async (ids: string[], accountId?: string) =>
    stored[accountId ?? 'own'].filter((e) => ids.includes(e.id)));
  advancedSearchEmails = vi.fn(async () => ({ emails: [], hasMore: false, total: 0 }));
  const client = {
    getSomeEmails,
    advancedSearchEmails,
    getAccountId: () => 'own',
  } as unknown as IJMAPClient;
  useAuthStore.setState({ client });
  useEmailStore.setState({
    mailboxes: [inbox, teamInbox],
    selectedMailbox: 'mb-inbox',
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

describe('api.search.showMessages (#954)', () => {
  it('needs email:read', async () => {
    await expect(dispatchApiCall(plugin({ permissions: [], grantedPermissions: [] }), 'search.showMessages', [['e1']]))
      .rejects.toThrow(/lacks permission "email:read"/);
  });

  it("lists exactly the plugin's messages in its order, under its chip, in place of the user's search", async () => {
    await dispatchApiCall(plugin(), 'search.showMessages', [['e3', 'e1', 'gone'], { label: ' Answers ' }]);

    const state = useEmailStore.getState();
    expect(state.emails.map((e) => e.id)).toEqual(['e3', 'e1']);
    expect(state.totalEmails).toBe(2);
    expect(state.hasMoreEmails).toBe(false);
    expect(state.searchQuery).toBe('');
    expect(state.searchFilters.subject).toBe('');
    expect(state.searchFilters.pluginFilter?.label).toBe('Answers');
    // Read by id, never through a query.
    expect(advancedSearchEmails).not.toHaveBeenCalled();
  });

  it("reads a shared account's message from that account and stamps it with it", async () => {
    await dispatchApiCall(plugin(), 'search.showMessages', [[{ id: 't1', accountId: 'team' }, 'e2']]);

    expect(getSomeEmails).toHaveBeenCalledWith(['t1'], 'team');
    const [team, own] = useEmailStore.getState().emails;
    expect([team.id, own.id]).toEqual(['t1', 'e2']);
    expect(team.sourceAccountId).toBe('team');
    expect(own.sourceAccountId).toBe('own');
  });

  it("leaves out messages of accounts the user can't reach", async () => {
    await dispatchApiCall(plugin(), 'search.showMessages', [[{ id: 'x1', accountId: 'stranger' }, 'e1']]);
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['e1']);
    expect(getSomeEmails).not.toHaveBeenCalledWith(expect.anything(), 'stranger');
  });

  it.each([
    ['no array', ['e1'], /emails must be an array/],
    ['too many', [Array.from({ length: 201 }, (_, i) => `e${i}`)], /at most 200/],
    ['an empty id', [['']], /id must be a string/],
    ['an unknown field', [[{ id: 'e1', mailboxId: 'x' }]], /unknown property "mailboxId"/],
    ['a non-string label', [['e1'], { label: 5 }], /label must be a string/],
  ])('rejects %s without touching the search', async (_name, args, error) => {
    await expect(dispatchApiCall(plugin(), 'search.showMessages', args)).rejects.toThrow(error);
    expect(getSomeEmails).not.toHaveBeenCalled();
    expect(useEmailStore.getState().searchQuery).toBe('typed text');
  });

  it('is ended by search.clear', async () => {
    await dispatchApiCall(plugin(), 'search.showMessages', [['e1']]);
    const { fetchEmails } = useEmailStore.getState();
    useEmailStore.setState({ fetchEmails: vi.fn(async () => {}) });
    try {
      await expect(dispatchApiCall(plugin(), 'search.clear', [])).resolves.toBe(true);
    } finally {
      useEmailStore.setState({ fetchEmails });
    }
    expect(useEmailStore.getState().searchFilters.pluginFilter).toBeNull();
  });
});

describe("the user's own search replaces a plugin's list", () => {
  beforeEach(async () => {
    await dispatchApiCall(plugin(), 'search.showMessages', [['e1']]);
  });

  it('when the user types a search', () => {
    useEmailStore.getState().setSearchQuery('invoice');
    expect(useEmailStore.getState().searchFilters.pluginFilter).toBeNull();
  });

  it('when the user adds a filter', () => {
    useEmailStore.getState().setSearchFilters({ isUnread: true });
    const { searchFilters } = useEmailStore.getState();
    expect(searchFilters.pluginFilter).toBeNull();
    expect(searchFilters.isUnread).toBe(true);
  });

  it('but not when the search text is only emptied', () => {
    useEmailStore.getState().setSearchQuery('');
    expect(isPluginMessageList(useEmailStore.getState().searchFilters)).toBe(true);
  });

  it('while a query from search.run stays under added filters', async () => {
    await dispatchApiCall(plugin(), 'search.run', [{ from: 'alice@example.com' }]);
    useEmailStore.getState().setSearchFilters({ isUnread: true });
    expect(useEmailStore.getState().searchFilters.pluginFilter?.filter).toEqual({ from: 'alice@example.com' });
  });

  it('and the list adds nothing to a JMAP filter', () => {
    expect(buildJMAPFilter('', useEmailStore.getState().searchFilters, 'mb-inbox')).toEqual({ inMailbox: 'mb-inbox' });
  });
});
