import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

/**
 * "Move to" between an own folder and a team mailbox's folder of the same
 * login is a copy between two JMAP accounts of one server, through the login
 * whose folder list the destination was picked from. Account ids are only
 * unique per server: Stalwart numbers accounts b, c, d, ... on every install,
 * so a second login on another server often has the team mailbox's id, or the
 * own account's, as its own. That login is never the destination.
 *
 * Two fake logins on two servers whose account ids collide. The move must
 * stay on the server of the login it started from.
 */

const OWN = 'c';
const TEAM = 'd';

function folder(id: string, role: string | null, accountId: string, shared: boolean): Mailbox {
  return {
    id: shared ? `${accountId}:${id}` : id, originalId: id, name: role ?? id, role, accountId, isShared: shared,
    accountName: shared ? 'Team' : undefined, sortOrder: 0, totalEmails: 1, unreadEmails: 0, totalThreads: 1, unreadThreads: 0,
    isSubscribed: true, myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true },
  } as unknown as Mailbox;
}

const WORK_FOLDERS = [
  folder('a', 'inbox', OWN, false), folder('b', 'trash', OWN, false), folder('f', null, OWN, false),
  folder('a', 'inbox', TEAM, true), folder('b', 'trash', TEAM, true),
];

const row = { id: 'eaaaaab', threadId: 't', subject: 'Contract draft', receivedAt: '2026-11-11T10:00:00Z', keywords: {}, mailboxIds: { a: true }, blobId: 'blob1' } as unknown as Email;

function makeClient(accountId: string, serverUrl: string) {
  return {
    getAccountId: () => accountId,
    getServerUrl: () => serverUrl,
    getEmail: vi.fn().mockResolvedValue({ ...row }),
    fetchBlob: vi.fn().mockResolvedValue(new Blob(['raw'])),
    importRawEmail: vi.fn().mockResolvedValue('imported1'),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
    copyEmailAcrossAccounts: vi.fn().mockResolvedValue('copied1'),
    moveEmail: vi.fn().mockResolvedValue(undefined),
    batchMoveEmails: vi.fn().mockResolvedValue(undefined),
    getMailboxes: vi.fn().mockResolvedValue([]),
    getAllMailboxes: vi.fn().mockResolvedValue([]),
  };
}

const initial = { auth: useAuthStore.getState(), email: useEmailStore.getState() };

function signIn(work: ReturnType<typeof makeClient>, personal: ReturnType<typeof makeClient>, personalFirst = true) {
  // The personal login was signed in first, so it is listed first.
  const clients = new Map<string, unknown>(personalFirst
    ? [['me@personal.example', personal], ['me@work.example', work]]
    : [['me@work.example', work], ['me@personal.example', personal]]);
  useAuthStore.setState({
    isAuthenticated: true, activeAccountId: 'me@work.example', client: work as never,
    getClientForAccount: (id: string) => clients.get(id) as never,
    getAllConnectedClients: () => new Map(clients) as never,
  } as never);
}

describe('moving a message between an own folder and a team mailbox while another server\'s login has the same account id', () => {
  let work: ReturnType<typeof makeClient>;
  const asClient = () => work as unknown as IJMAPClient;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    work = makeClient(OWN, 'https://mail.work.example');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.setState(initial.auth);
    useEmailStore.setState(initial.email);
  });

  it('own Inbox to the team\'s Inbox: nothing is imported into the other server\'s login', async () => {
    // The personal server gave this user the id the work server gave the team mailbox.
    const personal = makeClient(TEAM, 'https://mail.personal.example');
    signIn(work, personal);
    useEmailStore.setState({
      viewingAccountId: null, isUnifiedView: false, selectedKeyword: null, searchQuery: '',
      mailboxes: WORK_FOLDERS, accountMailboxes: {}, selectedMailbox: 'a',
      emails: [row], selectedEmail: null, selectedEmailKeys: new Set(),
    } as never);

    try { await useEmailStore.getState().moveToMailboxCrossAware(asClient(), 'eaaaaab', `${TEAM}:a`); } catch { /* refusing is fine */ }

    expect(personal.importRawEmail).not.toHaveBeenCalled();
    expect(work.fetchBlob).not.toHaveBeenCalled();
    expect(work.deleteEmail).not.toHaveBeenCalled();
    // The move the user asked for: within the work server, own account to team account.
    expect(work.copyEmailAcrossAccounts).toHaveBeenCalledWith('eaaaaab', OWN, TEAM, 'a', undefined);
  });

  it('team Inbox to an own folder: nothing is imported into the other server\'s login', async () => {
    // The personal server gave this user the same id as the work server did.
    const personal = makeClient(OWN, 'https://mail.personal.example');
    signIn(work, personal);
    useEmailStore.setState({
      viewingAccountId: null, isUnifiedView: false, selectedKeyword: null, searchQuery: '',
      mailboxes: WORK_FOLDERS, accountMailboxes: {}, selectedMailbox: `${TEAM}:a`,
      emails: [row], selectedEmail: null, selectedEmailKeys: new Set(),
    } as never);

    try { await useEmailStore.getState().moveToMailboxCrossAware(asClient(), 'eaaaaab', 'f'); } catch { /* refusing is fine */ }

    expect(personal.importRawEmail).not.toHaveBeenCalled();
    expect(work.fetchBlob).not.toHaveBeenCalled();
    expect(work.deleteEmail).not.toHaveBeenCalled();
    expect(work.copyEmailAcrossAccounts).toHaveBeenCalledWith('eaaaaab', TEAM, OWN, 'f', undefined);
  });

  it.each([true, false])('stays on the work server with the other login listed first: %s', async (personalFirst) => {
    const personal = makeClient(TEAM, 'https://mail.personal.example');
    signIn(work, personal, personalFirst);
    useEmailStore.setState({
      viewingAccountId: null, isUnifiedView: false, selectedKeyword: null, searchQuery: '',
      mailboxes: WORK_FOLDERS, accountMailboxes: {}, selectedMailbox: 'a',
      emails: [row], selectedEmail: null, selectedEmailKeys: new Set(),
    } as never);

    try { await useEmailStore.getState().moveToMailboxCrossAware(asClient(), 'eaaaaab', `${TEAM}:a`); } catch { /* refusing is fine */ }

    expect(personal.importRawEmail).not.toHaveBeenCalled();
    expect(work.copyEmailAcrossAccounts).toHaveBeenCalledWith('eaaaaab', OWN, TEAM, 'a', undefined);
  });

  it('a login of the team account itself on the same server is still taken', async () => {
    const team = makeClient(TEAM, 'https://mail.work.example');
    signIn(work, team);
    useEmailStore.setState({
      viewingAccountId: null, isUnifiedView: false, selectedKeyword: null, searchQuery: '',
      mailboxes: WORK_FOLDERS, accountMailboxes: {}, selectedMailbox: 'a',
      emails: [row], selectedEmail: null, selectedEmailKeys: new Set(),
    } as never);

    await useEmailStore.getState().moveToMailboxCrossAware(asClient(), 'eaaaaab', `${TEAM}:a`);

    expect(team.importRawEmail).toHaveBeenCalledTimes(1);
    expect(work.copyEmailAcrossAccounts).not.toHaveBeenCalled();
  });

  it('only the row that moved leaves the list, not another account\'s row with its id', async () => {
    const personal = makeClient(TEAM, 'https://mail.personal.example');
    signIn(work, personal);
    // An all-folders view of the work login: its own message and the team's, both `eaaaaab`.
    const own = { ...row, subject: 'own', sourceClientAccountId: 'me@work.example', sourceAccountId: OWN } as Email;
    const team = { ...row, subject: 'team', mailboxIds: { a: true }, sourceClientAccountId: 'me@work.example', sourceAccountId: TEAM } as Email;
    useEmailStore.setState({
      viewingAccountId: null, isUnifiedView: false, selectedKeyword: null, searchQuery: '',
      mailboxes: WORK_FOLDERS, accountMailboxes: {}, selectedMailbox: 'a',
      emails: [own, team], selectedEmail: null, selectedEmailKeys: new Set(),
    } as never);

    await useEmailStore.getState().crossAccountMoveEmails(new Map([['me@work.example', ['eaaaaab']]]), 'me@work.example', 'f', undefined, TEAM);

    expect(work.copyEmailAcrossAccounts).toHaveBeenCalledWith('eaaaaab', TEAM, OWN, 'f', undefined);
    expect(useEmailStore.getState().emails.map((e) => e.subject)).toEqual(['own']);
  });
});
