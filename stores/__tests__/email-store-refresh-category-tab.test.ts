import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';
import { useAuthStore } from '../auth-store';
import { useMessageListTabsStore } from '../message-list-tabs-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// #1264: refreshing the open folder re-queries it with the active category
// tab's filter, as the first load and pagination do. Without it the refresh
// merged other tabs' mail into the list and took it for new mail.

const inbox = { id: 'inbox', role: 'inbox', isShared: false } as Mailbox;
const RECEIPTS = { subject: 'receipt' };

function email(id: string, receivedAt: string): Email {
  return {
    id, threadId: `thread-${id}`, mailboxIds: { inbox: true }, keywords: {},
    subject: id, receivedAt, from: [{ email: 'sender@example.com' }], to: [],
    preview: '', size: 1, hasAttachment: false,
  } as Email;
}

function client(rows: Email[]) {
  return {
    getEmails: vi.fn(async () => ({ emails: rows, total: rows.length, hasMore: false, state: 's' })),
    getThreads: vi.fn(async () => []),
    getAccountId: () => 'me',
  } as unknown as IJMAPClient;
}

describe('refreshing a folder with a category tab open (#1264)', () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
    useMessageListTabsStore.setState(useMessageListTabsStore.getInitialState());
    useSettingsStore.setState({
      emailsPerPage: 25, messageListOrder: [], messageListOrderScope: 'inbox',
      notificationMutes: { accounts: [], mailboxes: {} },
    });
    useEmailStore.setState({
      ...useEmailStore.getInitialState(),
      selectedMailbox: 'inbox', mailboxes: [inbox],
    });
    useMessageListTabsStore.getState().registerTabs('receipts-plugin', {
      tabs: [
        { id: 'other', label: 'Inbox', order: 1 },
        { id: 'receipts', label: 'Receipts', order: 2, query: RECEIPTS },
      ],
    });
  });

  it('queries the folder with the active tab filter', async () => {
    useMessageListTabsStore.getState().setActiveTab('receipts', 'inbox');
    const c = client([]);
    await useEmailStore.getState().refreshCurrentMailbox(c);
    expect(vi.mocked(c.getEmails).mock.calls[0][6]).toEqual(RECEIPTS);
  });

  it('queries the default tab as everything the other tabs leave out', async () => {
    const c = client([]);
    await useEmailStore.getState().refreshCurrentMailbox(c);
    expect(vi.mocked(c.getEmails).mock.calls[0][6]).toEqual({ operator: 'NOT', conditions: [RECEIPTS] });
  });

  it('does not take mail from another tab for new mail', async () => {
    useMessageListTabsStore.getState().setActiveTab('receipts', 'inbox');
    const receipt = email('receipt', '2026-10-01T00:00:00Z');
    useEmailStore.setState({ emails: [receipt], totalEmails: 1 });
    // A server that honours the filter answers with the tab's own mail only.
    const c = {
      ...client([]),
      getEmails: vi.fn(async (...args: unknown[]) => {
        const rows = args[6] ? [receipt] : [email('newsletter', '2026-10-15T00:00:00Z'), receipt];
        return { emails: rows, total: rows.length, hasMore: false, state: 's' };
      }),
    } as unknown as IJMAPClient;
    await useEmailStore.getState().refreshCurrentMailbox(c);
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['receipt']);
    expect(useEmailStore.getState().newEmailNotification).toBeNull();
  });
});
