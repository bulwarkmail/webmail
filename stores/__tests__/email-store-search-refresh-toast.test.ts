import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';
import { useAuthStore } from '../auth-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// A refresh during a search in the Inbox can bring a row only the local store
// found, for example once an old message's body has arrived. It isn't new mail,
// even when it's the newest row on the page and not in the list yet.

const inbox = { id: 'inbox', role: 'inbox', isShared: false } as Mailbox;

function email(id: string, receivedAt: string, extra: Partial<Email> = {}): Email {
  return {
    id, threadId: `thread-${id}`, mailboxIds: { inbox: true }, keywords: {},
    subject: id, receivedAt, from: [{ email: 'sender@example.com' }], to: [],
    preview: '', size: 1, hasAttachment: false, ...extra,
  } as Email;
}

function client(rows: Email[]) {
  return {
    advancedSearchEmails: vi.fn(async () => ({ emails: rows, total: rows.length, hasMore: false })),
    getThreads: vi.fn(async () => []),
    getAccountId: () => 'me',
  } as unknown as IJMAPClient;
}

async function refreshWith(row: Email) {
  const listed = email('listed', '2026-10-01T00:00:00Z');
  useEmailStore.setState({ emails: [listed], totalEmails: 1 });
  await useEmailStore.getState().refreshCurrentMailbox(client([row, listed]));
  return useEmailStore.getState();
}

describe('the new-mail notification during a search', () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
    useSettingsStore.setState({
      emailsPerPage: 25, messageListOrder: [], messageListOrderScope: 'inbox',
      notificationMutes: { accounts: [], mailboxes: {} },
    });
    useEmailStore.setState({
      ...useEmailStore.getInitialState(),
      selectedMailbox: 'inbox', mailboxes: [inbox], searchQuery: 'rechnung', searchMailboxId: 'inbox',
    });
  });

  it('stays quiet for a row only the local store found, and lists it', async () => {
    const state = await refreshWith(email('old-find', '2026-10-15T00:00:00Z', { foundLocally: true }));
    expect(state.newEmailNotification).toBeNull();
    expect(state.emails.map((row) => row.id)).toContain('old-find');
  });

  it('still notifies for a new row from the server', async () => {
    const state = await refreshWith(email('new', '2026-10-15T00:00:00Z'));
    expect(state.newEmailNotification?.id).toBe('new');
  });
});
