import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '../settings-store';
import { emailKeyFor } from '@/lib/thread-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// "Move to" for a selection in a plain folder view, to a folder of another
// account of the same login (own Inbox to a team folder, or back). Folder ids
// repeat across accounts: the team's "Projects" and the own "Archive" are both
// `f`. The selection must arrive in the folder that was picked, or the move is
// refused. It must not be filed in the folder of the messages' own account
// that happens to have the picked folder's id.

const OWN = 'ee';
const TEAM = 'ed';

function folder(id: string, name: string, role: string | null, accountId: string, shared: boolean): Mailbox {
  return {
    id: shared ? `${accountId}:${id}` : id, originalId: shared ? id : undefined, name, role, accountId, isShared: shared,
    sortOrder: 0, totalEmails: 2, unreadEmails: 0, totalThreads: 2, unreadThreads: 0, isSubscribed: true,
    myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true },
  } as unknown as Mailbox;
}

const MAILBOXES = [
  folder('a', 'Inbox', 'inbox', OWN, false), folder('f', 'Archive', 'archive', OWN, false),
  folder('a', 'Inbox', 'inbox', TEAM, true), folder('f', 'Projects', null, TEAM, true),
];

const row = (id: string, mailboxId: string) => ({ id, threadId: `t-${id}`, subject: id, receivedAt: '2026-11-11T10:00:00Z', keywords: {}, mailboxIds: { [mailboxId]: true } } as unknown as Email);

const initial = { auth: useAuthStore.getState(), email: useEmailStore.getState(), settings: useSettingsStore.getState() };

describe('a bulk move from a plain folder view to a folder of another account', () => {
  let client: Record<string, ReturnType<typeof vi.fn>> & { getAccountId: () => string; getServerUrl: () => string };

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = () => vi.fn().mockResolvedValue(undefined);
    client = {
      getAccountId: () => OWN, getServerUrl: () => 'https://work.example',
      batchMoveEmails: ok(), moveEmail: ok(), copyEmails: vi.fn().mockResolvedValue({}), copyEmailsBetweenAccounts: vi.fn().mockResolvedValue({}),
      getMailboxes: vi.fn().mockResolvedValue(MAILBOXES), getAllMailboxes: vi.fn().mockResolvedValue(MAILBOXES),
      getEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 0 }),
      getSharedAccounts: vi.fn(() => []),
    } as never;
    useAuthStore.setState({
      isAuthenticated: true, activeAccountId: 'login-a', client: client as never,
      getClientForAccount: (id: string) => (id === 'login-a' ? client : undefined) as never,
      getAllConnectedClients: () => new Map([['login-a', client]]) as never,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.setState(initial.auth);
    useEmailStore.setState(initial.email);
    useSettingsStore.setState(initial.settings);
  });

  function open(selectedMailbox: string, rows: Email[]) {
    useEmailStore.setState({
      viewingAccountId: null, selectedMailbox, isUnifiedView: false, selectedKeyword: null, searchQuery: '',
      mailboxes: MAILBOXES, accountMailboxes: {},
      emails: rows, selectedEmail: null, selectedEmailKeys: new Set(rows.map(emailKeyFor)),
      processingReadStatus: new Set(), threadEmailsCache: new Map(), expandedThreadIds: new Set(),
    } as never);
  }

  /** In-place moves the client was asked for: [destination folder id, JMAP account]. */
  const inPlace = () => client.batchMoveEmails.mock.calls.map((call: unknown[]) => [call[1], call[2] ?? OWN]);

  it('own Inbox to the team\'s Projects does not file the selection in the own Archive', async () => {
    open('a', [row('m1', 'a'), row('m2', 'a')]);
    await useEmailStore.getState().batchMoveToMailbox(client as unknown as IJMAPClient, `${TEAM}:f`);
    // `f` in the own account is the own Archive.
    expect(inPlace()).not.toContainEqual(['f', OWN]);
  });

  it('team Inbox to the own Archive does not file the selection in the team\'s Projects', async () => {
    open(`${TEAM}:a`, [row('m1', `${TEAM}:a`), row('m2', `${TEAM}:a`)]);
    await useEmailStore.getState().batchMoveToMailbox(client as unknown as IJMAPClient, 'f');
    // `f` in the team account is the team's Projects.
    expect(inPlace()).not.toContainEqual(['f', TEAM]);
  });

  it('own Inbox to the team\'s Projects copies the selection into Projects, across the accounts', async () => {
    client.copyEmailAcrossAccounts = vi.fn(async (id: string) => `copy-${id}`);
    open('a', [row('m1', 'a'), row('m2', 'a')]);
    expect(await useEmailStore.getState().batchMoveToMailbox(client as unknown as IJMAPClient, `${TEAM}:f`)).toBe(true);
    expect(client.copyEmailAcrossAccounts.mock.calls.map((call: unknown[]) => call.slice(0, 4)))
      .toEqual([['m1', OWN, TEAM, 'f'], ['m2', OWN, TEAM, 'f']]);
    expect(useEmailStore.getState().emails).toEqual([]);
  });
});
