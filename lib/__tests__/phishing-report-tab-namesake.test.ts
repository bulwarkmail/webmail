import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// "Report phishing" on a message that is open in its own Pro tab (an own
// message of the active login, which the tab leaves unstamped) while the Mail
// tab lists the team mailbox's Inbox, which holds a message with the same id.
// The report is about the tab's message and the move to Junk is that
// message's: the team's message stays where it is.

const sent = vi.hoisted(() => ({ reports: [] as Array<{ sourceAccountId: string }> }));
vi.mock('@/lib/phishing-report', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/phishing-report')>()),
  phishingReportSetup: () => ({ address: 'abuse@example.org', format: 'forward' }),
  sendPhishingReport: vi.fn(async (_email: unknown, ctx: { sourceAccountId: string }) => { sent.reports.push({ sourceAccountId: ctx.sourceAccountId }); }),
}));

import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { stampProSource } from '@/components/pro/pro-email-tab-body';
import { reportEmailsAsPhishing } from '@/lib/phishing-report-flow';

const OWN = 'ee';
const TEAM = 'ed';
const ID = 'eaaaaab';

function folder(id: string, role: string, accountId: string, shared: boolean): Mailbox {
  return {
    id: shared ? `${accountId}:${id}` : id, originalId: shared ? id : undefined, name: role, role, accountId, isShared: shared,
    sortOrder: 0, totalEmails: 1, unreadEmails: 1, totalThreads: 1, unreadThreads: 1, isSubscribed: true,
    myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true },
  } as unknown as Mailbox;
}
const MAILBOXES = [
  folder('a', 'inbox', OWN, false), folder('c', 'junk', OWN, false),
  folder('a', 'inbox', TEAM, true), folder('c', 'junk', TEAM, true),
];
const message = (subject: string, mailboxId: string) => ({
  id: ID, blobId: `blob-${subject}`, threadId: 't', subject, receivedAt: '2026-11-11T10:00:00Z', keywords: {}, mailboxIds: { [mailboxId]: true },
} as unknown as Email);

const initial = { auth: useAuthStore.getState(), email: useEmailStore.getState(), settings: useSettingsStore.getState() };

describe('Report phishing from a Pro message tab while another account\'s folder lists the same id', () => {
  let client: { getAccountId: () => string; getServerUrl: () => string; markAsSpam: ReturnType<typeof vi.fn>; getSharedAccounts: () => unknown[] };

  beforeEach(() => {
    sent.reports.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    client = {
      getAccountId: () => OWN, getServerUrl: () => 'https://work.example',
      markAsSpam: vi.fn().mockResolvedValue(undefined), getSharedAccounts: () => [],
    };
    useAuthStore.setState({
      isAuthenticated: true, activeAccountId: 'login-a', client: client as never,
      getClientForAccount: (id: string) => (id === 'login-a' ? client : undefined) as never,
      getAllConnectedClients: () => new Map([['login-a', client]]) as never,
    } as never);
    useSettingsStore.setState({ deleteAction: 'trash' } as never);
    // The Mail tab behind the message tab: the team's Inbox, rows unstamped.
    useEmailStore.setState({
      viewingAccountId: null, selectedMailbox: `${TEAM}:a`, isUnifiedView: false, selectedKeyword: null, searchQuery: '',
      mailboxes: MAILBOXES, accountMailboxes: {},
      emails: [message('TEAM customer order', `${TEAM}:a`)], selectedEmail: null, selectedEmailKeys: new Set(),
      processingReadStatus: new Set(), threadEmailsCache: new Map(), expandedThreadIds: new Set(), spamUndoCache: new Map(),
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.setState(initial.auth);
    useEmailStore.setState(initial.email);
    useSettingsStore.setState(initial.settings);
  });

  it('reports and moves the own message, not the team message', async () => {
    // What the tab holds: read through the active login from its own account.
    const tabEmail = stampProSource(message('OWN private note', 'a'), { client: client as never, accountId: OWN }, 'login-a');
    await reportEmailsAsPhishing([tabEmail]);

    expect({
      // The account the report's copy of the message is taken from.
      reportedFrom: sent.reports.map((report) => report.sourceAccountId),
      // The account of the move to Junk (undefined: the login's own).
      movedIn: client.markAsSpam.mock.calls.map((call: unknown[]) => call[1] ?? OWN),
      // The Mail tab's list.
      listed: useEmailStore.getState().emails.map((e) => e.subject),
    }).toEqual({ reportedFrom: [OWN], movedIn: [OWN], listed: ['TEAM customer order'] });
  });
});
