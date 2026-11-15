import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useAuthStore } from '@/stores/auth-store';
import { useMessageListTabsStore } from '@/stores/message-list-tabs-store';
import { forgetFolderLists } from '@/lib/folder-list-cache';
import { refreshMailView } from '../manual-mail-refresh';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

const inbox = { id: 'inbox', role: 'inbox', isShared: false } as Mailbox;

function email(id: string): Email {
  return {
    id, threadId: `thread-${id}`, mailboxIds: { inbox: true }, keywords: {},
    subject: id, receivedAt: '2026-11-15T00:00:00Z',
    from: [{ email: 'sender@example.com' }], to: [],
    preview: '', size: 1, hasAttachment: false,
  } as Email;
}

function clientFor(rows: Email[], hits: Email[] = []) {
  return {
    getEmails: vi.fn<IJMAPClient['getEmails']>(async (_mailboxId, _accountId, limit = 2, position = 0) => ({
      emails: rows.slice(position, position + limit),
      total: rows.length,
      hasMore: position + limit < rows.length,
    })),
    advancedSearchEmails: vi.fn(async () => ({ emails: hits, total: hits.length, hasMore: false })),
    getThreads: vi.fn(async () => []),
    getAccountId: () => 'account',
    getMaxObjectsInGet: () => 500,
  } as unknown as IJMAPClient;
}

/** Every value isLoading takes while the refresh runs. */
function watchLoading() {
  const seen: boolean[] = [];
  const stop = useEmailStore.subscribe((s) => seen.push(s.isLoading));
  return { seen, stop };
}

describe('refreshMailView (#1716)', () => {
  beforeEach(() => {
    forgetFolderLists();
    useAuthStore.setState(useAuthStore.getInitialState());
    useMessageListTabsStore.setState(useMessageListTabsStore.getInitialState());
    useSettingsStore.setState({ emailsPerPage: 2, emailKeywords: [], messageListOrder: [], messageListOrderScope: 'inbox' });
    useEmailStore.setState({
      ...useEmailStore.getInitialState(),
      selectedMailbox: 'inbox', mailboxes: [inbox],
      fetchMailboxes: vi.fn(async () => {}),
      refreshScheduledMetadata: vi.fn(async () => {}),
    });
  });

  it('keeps the loaded pages on screen without the loading overlay', async () => {
    const rows = ['a', 'b', 'c'].map(email);
    const client = clientFor(rows);
    await useEmailStore.getState().fetchEmails(client);
    await useEmailStore.getState().loadMoreEmails(client);
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['a', 'b', 'c']);

    const loading = watchLoading();
    await refreshMailView(client);
    loading.stop();

    expect(loading.seen).not.toContain(true);
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('refreshes the search results instead of replacing them with the folder', async () => {
    const hit = email('hit');
    const client = clientFor(['a', 'b'].map(email), [hit]);
    useEmailStore.setState({ searchQuery: 'invoice', searchMailboxId: 'inbox', emails: [hit], totalEmails: 1 });

    const loading = watchLoading();
    await refreshMailView(client);
    loading.stop();

    expect(loading.seen).not.toContain(true);
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['hit']);
    expect(useEmailStore.getState().searchQuery).toBe('invoice');
  });
});
