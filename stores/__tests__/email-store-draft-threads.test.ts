import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore, withDraftChanges } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// #1798: the drafts' conversations come with the folder page and stay with
// the folder; the rows of those conversations show "Draft".

const row = (id: string, threadId: string, keywords: Record<string, boolean> = {}): Email => ({
  id, threadId, mailboxIds: { inbox: true }, keywords, subject: id,
  receivedAt: '2026-10-01T00:00:00Z', from: [], to: [], preview: '', size: 1, hasAttachment: false,
} as Email);

function makeClient(draftThreads?: Record<string, string>) {
  return {
    getEmails: vi.fn(async () => ({ emails: [row('e1', 't1'), row('e2', 't2')], hasMore: false, total: 2, state: 's1', threadCounts: { t1: 2, t2: 1 }, draftThreads })),
    getThreads: vi.fn(async () => []),
    getAccountId: () => 'me',
  } as unknown as IJMAPClient;
}

describe('draft conversations with the folder page', () => {
  beforeEach(() => {
    useSettingsStore.setState({ emailsPerPage: 50 } as never);
    useEmailStore.setState({
      isUnifiedView: false, unifiedRole: null, crossView: null, viewingAccountId: null, selectedKeyword: null,
      selectedMailbox: 'inbox', searchQuery: '', searchFilters: { ...DEFAULT_SEARCH_FILTERS },
      emails: [], threadEmailCounts: new Map(), draftThreads: new Map(),
      mailboxes: [
        { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 2, unreadEmails: 0 } as Mailbox,
        { id: 'sent', name: 'Sent', role: 'sent', totalEmails: 0, unreadEmails: 0 } as Mailbox,
      ],
      accountMailboxes: {},
    });
  });

  function connect(client: IJMAPClient) {
    useAuthStore.setState({
      activeAccountId: 'account-a', client,
      getClientForAccount: (id: string) => (id === 'account-a' ? client : undefined) as never,
    } as never);
  }

  it('stores the drafts the page brought', async () => {
    const client = makeClient({ d1: 't1' });
    connect(client);
    await useEmailStore.getState().fetchEmails(client, 'inbox');
    expect(Object.fromEntries(useEmailStore.getState().draftThreads)).toEqual({ d1: 't1' });
  });

  it('forgets them on a switch to another folder, until its page comes', () => {
    useEmailStore.setState({ draftThreads: new Map([['d1', 't1']]) });
    useEmailStore.getState().selectMailbox('sent');
    expect(useEmailStore.getState().draftThreads.size).toBe(0);
  });
});

describe('withDraftChanges', () => {
  const current = new Map([['d1', 't1'], ['d2', 't2']]);

  it('adds a draft saved since, and drops one sent or deleted', () => {
    const next = withDraftChanges(current, [
      row('d3', 't3', { $draft: true }),
      // Sent: the same id, no longer a draft.
      row('d2', 't2', { $seen: true }),
    ], ['d1']);
    expect(next && Object.fromEntries(next)).toEqual({ d3: 't3' });
  });

  it('is null when no draft changed, so the list is not drawn again', () => {
    expect(withDraftChanges(current, [row('e9', 't1', { $seen: true }), row('d1', 't1', { $draft: true })], ['x'])).toBeNull();
  });

  it('leaves the map it was given alone', () => {
    withDraftChanges(current, [], ['d1']);
    expect(current.has('d1')).toBe(true);
  });
});
