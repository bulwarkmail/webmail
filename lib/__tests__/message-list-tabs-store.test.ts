// Contract tests for the plugin-facing message-list category tabs
// (api.tabs.set → stores/message-list-tabs-store.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useMessageListTabsStore,
  validateTabsConfig,
  resolveTabFilter,
} from '@/stores/message-list-tabs-store';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import { messageListTabHooks } from '@/lib/plugin-hooks';
import { jmapError } from '@/lib/jmap/jmap-error';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { MessageListTab } from '@/lib/plugin-types';

const GMAIL_STYLE = {
  tabs: [
    { id: 'primary', label: 'Primary', keyword: null },
    { id: 'promotions', label: 'Promotions', keyword: '$category-promotions' },
    { id: 'social', label: 'Social', query: { operator: 'OR', conditions: [{ from: 'reddit.com' }, { from: 'linkedin.com' }] } },
    { id: 'updates', label: 'Updates', keyword: '$category-updates' },
  ],
};

function resetStore() {
  useMessageListTabsStore.setState({
    registrations: {},
    tabs: [],
    mailboxRoles: [],
    activeTabId: null,
    tabCounts: {},
    isCountsLoading: false,
  });
}

beforeEach(resetStore);

describe('validateTabsConfig', () => {
  it('normalizes a valid config and defaults mailboxRoles to inbox', () => {
    const v = validateTabsConfig(GMAIL_STYLE);
    expect(v.tabs).toHaveLength(4);
    expect(v.mailboxRoles).toEqual(['inbox']);
    expect(v.tabs[1].keyword).toBe('$category-promotions');
    expect(v.tabs[2].query).toEqual(GMAIL_STYLE.tabs[2].query);
  });

  it('lowercases keywords (IMAP keywords are case-insensitive)', () => {
    const v = validateTabsConfig({
      tabs: [
        { id: 'a', label: 'A', keyword: '$Category-Promotions' },
        { id: 'b', label: 'B', keyword: null },
      ],
    });
    expect(v.tabs[0].keyword).toBe('$category-promotions');
  });

  it('rejects reserved and tag keywords', () => {
    expect(() => validateTabsConfig({
      tabs: [{ id: 'a', label: 'A', keyword: '$seen' }, { id: 'b', label: 'B' }],
    })).toThrow(/reserved/);
    expect(() => validateTabsConfig({
      tabs: [{ id: 'a', label: 'A', keyword: '$label.x' }, { id: 'b', label: 'B' }],
    })).toThrow(/reserved/);
  });

  // Stalwart 1.0 sets one of these on every message and derives hasAttachment
  // from it; a tab move would add or strip it.
  it.each(['$hasattachment', '$hasnoattachment', '$HasAttachment'])(
    'rejects the server-set attachment keyword %s (Stalwart 1.0)',
    (keyword) => {
      expect(() => validateTabsConfig({
        tabs: [{ id: 'a', label: 'A', keyword }, { id: 'b', label: 'B' }],
      })).toThrow(/reserved keyword "\$has(no)?attachment"/);
    },
  );

  it('rejects duplicate ids, multiple default tabs, and single-tab configs', () => {
    expect(() => validateTabsConfig({
      tabs: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B', keyword: '$x' }],
    })).toThrow(/duplicate/);
    expect(() => validateTabsConfig({
      tabs: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    })).toThrow(/default/);
    expect(() => validateTabsConfig({
      tabs: [{ id: 'a', label: 'A', keyword: '$x' }],
    })).toThrow(/at least 2/);
  });

  it('rejects non-object and oversized queries', () => {
    expect(() => validateTabsConfig({
      tabs: [{ id: 'a', label: 'A', query: 'from:x' as unknown as Record<string, unknown> }, { id: 'b', label: 'B' }],
    })).toThrow(/filter object/);
    const huge = { from: 'x'.repeat(20000) };
    expect(() => validateTabsConfig({
      tabs: [{ id: 'a', label: 'A', query: huge }, { id: 'b', label: 'B' }],
    })).toThrow(/exceeds/);
  });

  // Stalwart 1.0 parses JMAP Metadata filter conditions, then hits `todo!()`
  // in Email/query and panics; 0.16 answers `unsupportedFilter`.
  it('rejects JMAP Metadata filter conditions at any depth (they panic Stalwart 1.0)', () => {
    const tabsWith = (query: Record<string, unknown>) => ({
      tabs: [{ id: 'a', label: 'A', query }, { id: 'b', label: 'B' }],
    });
    expect(() => validateTabsConfig(tabsWith({ metadataExists: 'example.com/category' })))
      .toThrow('tab "a" query may not filter on JMAP Metadata ("metadataExists")');
    expect(() => validateTabsConfig(tabsWith({
      operator: 'OR',
      conditions: [
        { from: 'news@example.com' },
        { operator: 'NOT', conditions: [{ privateMetadataTextContains: { path: 'x/y', value: 'z' } }] },
      ],
    }))).toThrow(/JMAP Metadata \("privateMetadataTextContains"\)/);
    expect(() => validateTabsConfig(tabsWith({ MetadataTextEquals: 'x' }))).toThrow(/JMAP Metadata/);
  });

  it('accepts ordinary filters that only mention metadata in values', () => {
    const query = { operator: 'AND', conditions: [{ header: ['X-Metadata', 'yes'] }, { subject: 'metadata' }] };
    const v = validateTabsConfig({ tabs: [{ id: 'a', label: 'A', query }, { id: 'b', label: 'B' }] });
    expect(v.tabs[0].query).toEqual(query);
  });
});

describe('resolveTabFilter', () => {
  const tabs = validateTabsConfig(GMAIL_STYLE).tabs as MessageListTab[];

  it('uses hasKeyword for keyword tabs and the raw query for search tabs', () => {
    expect(resolveTabFilter(tabs[1], tabs)).toEqual({ hasKeyword: '$category-promotions' });
    expect(resolveTabFilter(tabs[2], tabs)).toEqual(GMAIL_STYLE.tabs[2].query);
  });

  it('resolves the default tab to NOT(all other positive fragments)', () => {
    const filter = resolveTabFilter(tabs[0], tabs) as { operator: string; conditions: unknown[] };
    expect(filter.operator).toBe('NOT');
    expect(filter.conditions).toHaveLength(3);
    expect(filter.conditions).toContainEqual({ hasKeyword: '$category-promotions' });
    expect(filter.conditions).toContainEqual(GMAIL_STYLE.tabs[2].query);
  });
});

describe('store registration', () => {
  it('registers tabs, activates the default tab, and scopes to the inbox role', () => {
    const store = useMessageListTabsStore.getState();
    store.registerTabs('category-tabs', GMAIL_STYLE);

    const s = useMessageListTabsStore.getState();
    expect(s.tabs.map(t => t.id)).toEqual(['primary', 'promotions', 'social', 'updates']);
    expect(s.activeTabId).toBe('primary');
    expect(s.isEnabledForRole('inbox')).toBe(true);
    expect(s.isEnabledForRole('trash')).toBe(false);
    // Default tab active → NOT filter.
    const filter = s.getCategoryFilter('inbox') as { operator: string };
    expect(filter.operator).toBe('NOT');
    expect(s.getCategoryFilter('trash')).toBeNull();
  });

  it('keeps only the first default tab when two plugins both register one', () => {
    const store = useMessageListTabsStore.getState();
    store.registerTabs('p1', { tabs: [{ id: 'main', label: 'Main', order: 1 }, { id: 'x', label: 'X', keyword: '$x' }] });
    store.registerTabs('p2', { tabs: [{ id: 'other', label: 'Other', order: 2 }, { id: 'y', label: 'Y', keyword: '$y' }] });
    const defaults = useMessageListTabsStore.getState().tabs.filter(t => !t.query && !t.keyword);
    expect(defaults.map(t => t.id)).toEqual(['main']);
  });

  it('clears a plugin registration and resets counts when the strip empties', () => {
    const store = useMessageListTabsStore.getState();
    store.registerTabs('category-tabs', GMAIL_STYLE);
    useMessageListTabsStore.setState({ tabCounts: { promotions: 5 } });
    store.clearTabs('category-tabs');
    const s = useMessageListTabsStore.getState();
    expect(s.tabs).toHaveLength(0);
    expect(s.activeTabId).toBeNull();
    expect(s.tabCounts).toEqual({});
    expect(s.getCategoryFilter('inbox')).toBeNull();
  });

  it('switches the active tab and exposes its filter', () => {
    const store = useMessageListTabsStore.getState();
    store.registerTabs('category-tabs', GMAIL_STYLE);
    store.setActiveTab('promotions', 'inbox-id');
    expect(useMessageListTabsStore.getState().getCategoryFilter('inbox')).toEqual({ hasKeyword: '$category-promotions' });
  });
});

describe('categorizeEmails', () => {
  // `sourceAccountId`: the JMAP account a unified-view message lives in, as
  // the list stamps it; the display-only `accountId` names the login.
  const email = (id: string, sourceAccountId?: string) => ({
    id, threadId: `t-${id}`, keywords: { $seen: true }, mailboxIds: { inbox: true },
    from: [{ email: `${id}@example.com` }],
    ...(sourceAccountId ? { accountId: 'login-1', sourceClientAccountId: 'login-1', sourceAccountId } : {}),
  }) as unknown as Email;
  // The stamped login is connected, through this client.
  const loginClient = (client: Partial<IJMAPClient>) => {
    useAuthStore.setState({ getClientForAccount: (id: string) => (id === 'login-1' ? client : undefined) } as never);
    return client as IJMAPClient;
  };
  const PATCH = { 'keywords/$category-updates': null, 'keywords/$category-promotions': true };

  beforeEach(() => {
    useEmailStore.setState({ emails: [email('m1'), email('m2', 'shared')], mailboxes: [], selectedMailbox: '' });
    useMessageListTabsStore.getState().registerTabs('category-tabs', GMAIL_STYLE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useEmailStore.setState({ emails: [] });
  });

  it('patches the category keywords and moves the messages locally', async () => {
    const batchUpdateKeywords = vi.fn().mockResolvedValue(undefined);
    const emitted = vi.spyOn(messageListTabHooks.onEmailCategorize, 'emit');

    await expect(useMessageListTabsStore.getState()
      .categorizeEmails({ batchUpdateKeywords } as unknown as IJMAPClient, ['m1'], 'promotions')).resolves.toBe(true);

    expect(batchUpdateKeywords).toHaveBeenCalledWith(
      ['m1'],
      { 'keywords/$category-updates': null, 'keywords/$category-promotions': true },
      undefined,
    );
    expect(useEmailStore.getState().emails[0].keywords).toEqual({ $seen: true, '$category-promotions': true });
    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it('rejects when Stalwart 1.0 refuses the keyword, leaving the refused messages as they were', async () => {
    // What batchUpdateKeywords throws for a `notUpdated` entry on 1.0, here
    // for a message that already has 100 keywords.
    const refusal = jmapError('Failed to update keywords: An email cannot have more than 100 keywords.', {
      type: 'tooManyKeywords', description: 'An email cannot have more than 100 keywords.', properties: ['keywords'],
    });
    const batchUpdateKeywords = vi.fn(async (_ids: string[], _patch: unknown, accountId?: string) => {
      if (accountId === 'shared') throw refusal;
    });
    const emitted = vi.spyOn(messageListTabHooks.onEmailCategorize, 'emit');

    await expect(useMessageListTabsStore.getState()
      .categorizeEmails(loginClient({ batchUpdateKeywords }), ['m1', 'm2'], 'promotions')).rejects.toBe(refusal);

    // Both accounts were written; only the one the server accepted moved.
    expect(batchUpdateKeywords).toHaveBeenCalledTimes(2);
    const [m1, m2] = useEmailStore.getState().emails;
    expect(m1.keywords).toEqual({ $seen: true, '$category-promotions': true });
    expect(m2.keywords).toEqual({ $seen: true });
    // No per-sender override is recorded for a move that did not happen.
    expect(emitted).not.toHaveBeenCalled();
  });

  it('moves what the server accepted of a partly refused batch on Stalwart 1.0', async () => {
    // batchUpdateKeywords names the refused messages on its error; the rest
    // of the batch was written.
    const refusal = jmapError('Failed to update keywords: An email cannot have more than 100 keywords.', {
      type: 'tooManyKeywords', description: 'An email cannot have more than 100 keywords.', properties: ['keywords'],
    });
    refusal.jmapFailedIds = ['m1'];
    useEmailStore.setState({ emails: [email('m1'), email('m3')] });
    const batchUpdateKeywords = vi.fn().mockRejectedValue(refusal);

    await expect(useMessageListTabsStore.getState()
      .categorizeEmails({ batchUpdateKeywords } as unknown as IJMAPClient, ['m1', 'm3'], 'promotions')).rejects.toBe(refusal);

    expect(batchUpdateKeywords).toHaveBeenCalledTimes(1);
    const [m1, m3] = useEmailStore.getState().emails;
    expect(m1.keywords).toEqual({ $seen: true });
    expect(m3.keywords).toEqual({ $seen: true, '$category-promotions': true });
  });

  it('writes a unified-view message to its own JMAP account, not the login named for display', async () => {
    const batchUpdateKeywords = vi.fn().mockResolvedValue(undefined);

    await useMessageListTabsStore.getState()
      .categorizeEmails(loginClient({ batchUpdateKeywords }), ['m2'], 'promotions');

    expect(batchUpdateKeywords).toHaveBeenCalledWith(['m2'], PATCH, 'shared');
    expect(batchUpdateKeywords).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'login-1');
  });

  it('writes to the group account whose inbox is open in the shared section', async () => {
    // Those messages carry no source stamps: the open folder names the
    // account. An unrouted write lands in the login's own account.
    const groupInbox = {
      id: 'team:inbox', originalId: 'inbox', accountId: 'team', isShared: true, role: 'inbox', name: 'Inbox',
    } as unknown as Mailbox;
    useEmailStore.setState({ emails: [email('g1'), email('g2')], mailboxes: [groupInbox], selectedMailbox: groupInbox.id });
    const batchUpdateKeywords = vi.fn().mockResolvedValue(undefined);

    await useMessageListTabsStore.getState()
      .categorizeEmails({ batchUpdateKeywords } as unknown as IJMAPClient, ['g1', 'g2'], 'promotions');

    expect(batchUpdateKeywords).toHaveBeenCalledTimes(1);
    expect(batchUpdateKeywords).toHaveBeenCalledWith(['g1', 'g2'], PATCH, 'team');
  });
});
