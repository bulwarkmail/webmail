import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moveFoldersFor, useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

/**
 * "Move to" files a message in a folder of the login it is in: the Move
 * pickers offer that login's folders (moveFoldersFor), and the move looks the
 * folder up there and nowhere else. Folder ids repeat across logins (on
 * Stalwart `a` is every Inbox and the first custom folders line up too): a
 * folder of the active login's list, picked for a message of another login,
 * names that login's folder with the same id. Such a move is refused.
 */

function folder(id: string, role: string | null, accountId: string, name?: string): Mailbox {
  return {
    id, originalId: id, name: name ?? role ?? id, role, accountId, isShared: false,
    sortOrder: 0, totalEmails: 1, unreadEmails: 0, totalThreads: 1, unreadThreads: 0,
    isSubscribed: true, myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true },
  } as unknown as Mailbox;
}

// The active login a (account `ee`): "Projects" is `c`, "Clients" is `z`.
const A_FOLDERS = [folder('a', 'inbox', 'ee'), folder('c', null, 'ee', 'Projects'), folder('z', null, 'ee', 'Clients')];
// Login b (account `ef`): "Payroll" is `c`.
const B_FOLDERS = [folder('a', 'inbox', 'ef'), folder('c', null, 'ef', 'Payroll')];

const row = { id: 'eaaaaab', threadId: 't', subject: 'B payroll', receivedAt: '2026-11-11T10:00:00Z', keywords: {}, mailboxIds: { a: true } } as unknown as Email;

function makeClient(accountId: string) {
  return {
    getAccountId: () => accountId,
    getServerUrl: () => 'https://mail.example',
    moveEmail: vi.fn().mockResolvedValue(undefined),
    batchMoveEmails: vi.fn().mockResolvedValue(undefined),
    getEmail: vi.fn().mockResolvedValue({ ...row }),
    fetchBlob: vi.fn().mockResolvedValue(new Blob(['raw'])),
    importRawEmail: vi.fn().mockResolvedValue('imported1'),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
    copyEmailAcrossAccounts: vi.fn().mockResolvedValue('copied1'),
    getMailboxes: vi.fn().mockResolvedValue([]),
    getAllMailboxes: vi.fn().mockResolvedValue([]),
  };
}

const initial = { auth: useAuthStore.getState(), email: useEmailStore.getState() };
let a: ReturnType<typeof makeClient>;
let b: ReturnType<typeof makeClient>;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  a = makeClient('ee');
  b = makeClient('ef');
  const clients = new Map<string, unknown>([['login-a', a], ['login-b', b]]);
  useAuthStore.setState({
    isAuthenticated: true, activeAccountId: 'login-a', client: a as never,
    getClientForAccount: (id: string) => clients.get(id) as never,
    getAllConnectedClients: () => new Map(clients) as never,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState(initial.auth);
  useEmailStore.setState(initial.email);
});

describe('a move of a message of another login browsed in the sidebar', () => {
  beforeEach(() => {
    useEmailStore.setState({
      isUnifiedView: false, selectedKeyword: null, searchQuery: '', crossView: null,
      viewingAccountId: 'login-b', selectedMailbox: 'a', mailboxes: A_FOLDERS, accountMailboxes: { 'login-b': B_FOLDERS },
      emails: [row], selectedEmail: row,
    } as never);
  });

  it('is offered that login\'s folders', () => {
    expect(moveFoldersFor([row]).mailboxes.map((m) => m.name)).toEqual(['inbox', 'Payroll']);
  });

  it('is offered them named by that login\'s address; the active login\'s own folders by none', () => {
    const original = useAccountStore.getState().accounts;
    useAccountStore.setState({ accounts: [{ id: 'login-a', email: 'a@example.org' }, { id: 'login-b', email: 'b@example.org' }] } as never);
    try {
      expect(moveFoldersFor([row]).owner).toBe('b@example.org');
      useEmailStore.setState({ viewingAccountId: null } as never);
      expect(moveFoldersFor([row]).owner).toBeUndefined();
    } finally {
      useAccountStore.setState({ accounts: original } as never);
    }
  });

  it('goes into that login\'s folder, through that login', async () => {
    await useEmailStore.getState().moveToMailboxCrossAware(a as unknown as IJMAPClient, row.id, 'c');
    expect(b.moveEmail).toHaveBeenCalledWith(row.id, 'c', undefined);
    expect(a.moveEmail).not.toHaveBeenCalled();
  });

  it('is refused for a folder only the active login lists, and moves nothing', async () => {
    await expect(useEmailStore.getState().moveToMailboxCrossAware(a as unknown as IJMAPClient, row.id, 'z')).rejects.toThrow();
    expect(b.moveEmail).not.toHaveBeenCalled();
    expect(a.moveEmail).not.toHaveBeenCalled();
    expect(b.importRawEmail).not.toHaveBeenCalled();
    expect(a.importRawEmail).not.toHaveBeenCalled();
  });

  it('is refused while that login\'s folder list is not loaded, and moves nothing', async () => {
    useEmailStore.setState({ accountMailboxes: {} } as never);
    expect(moveFoldersFor([row]).unavailable).toBe('not_connected');
    await expect(useEmailStore.getState().moveToMailboxCrossAware(a as unknown as IJMAPClient, row.id, 'c')).rejects.toThrow();
    expect(b.moveEmail).not.toHaveBeenCalled();
    expect(a.moveEmail).not.toHaveBeenCalled();
  });
});

describe('a move in the unified inbox', () => {
  const ofB = { ...row, sourceClientAccountId: 'login-b', sourceAccountId: 'ef', accountId: 'login-b' } as Email;
  const ofA = { ...row, id: 'iaaaaac', sourceClientAccountId: 'login-a', sourceAccountId: 'ee', accountId: 'login-a' } as Email;
  beforeEach(() => {
    useEmailStore.setState({
      isUnifiedView: true, selectedKeyword: null, searchQuery: '', crossView: null, unifiedRole: 'inbox',
      viewingAccountId: null, selectedMailbox: '__unified_inbox__', mailboxes: A_FOLDERS, accountMailboxes: { 'login-b': B_FOLDERS },
      emails: [ofB, ofA], selectedEmail: ofB, selectedEmailKeys: new Set(),
    } as never);
  });

  it('of another login\'s message goes into that login\'s folder, in place', async () => {
    await useEmailStore.getState().moveToMailboxCrossAware(a as unknown as IJMAPClient, ofB.id, 'c', 'login-b/ef:eaaaaab');
    expect(b.batchMoveEmails).toHaveBeenCalledWith([ofB.id], 'c', 'ef');
    expect(a.batchMoveEmails).not.toHaveBeenCalled();
    expect(a.importRawEmail).not.toHaveBeenCalled();
  });

  it('of the active login\'s own message goes into its own folder, as before', async () => {
    await useEmailStore.getState().moveToMailboxCrossAware(a as unknown as IJMAPClient, ofA.id, 'c', 'login-a/ee:iaaaaac');
    expect(a.batchMoveEmails).toHaveBeenCalledWith([ofA.id], 'c', 'ee');
    expect(b.batchMoveEmails).not.toHaveBeenCalled();
  });

  it('a selection of two logins is offered no folders, and its move is refused', async () => {
    expect(moveFoldersFor([ofA, ofB]).unavailable).toBe('several_logins');
    useEmailStore.setState({ selectedEmailKeys: new Set(['login-b/ef:eaaaaab', 'login-a/ee:iaaaaac']) } as never);
    expect(await useEmailStore.getState().batchMoveToMailbox(a as unknown as IJMAPClient, 'c')).toBe(false);
    expect(a.batchMoveEmails).not.toHaveBeenCalled();
    expect(b.batchMoveEmails).not.toHaveBeenCalled();
    expect(a.importRawEmail).not.toHaveBeenCalled();
  });
});

describe('a move with one login', () => {
  it('is offered the login\'s folders and goes there, as before', async () => {
    const clients = new Map<string, unknown>([['login-a', a]]);
    useAuthStore.setState({
      getClientForAccount: (id: string) => clients.get(id) as never,
      getAllConnectedClients: () => new Map(clients) as never,
    } as never);
    useEmailStore.setState({
      isUnifiedView: false, selectedKeyword: null, searchQuery: '', crossView: null,
      viewingAccountId: null, selectedMailbox: 'a', mailboxes: A_FOLDERS, accountMailboxes: {},
      emails: [row], selectedEmail: row,
    } as never);
    expect(moveFoldersFor([row]).mailboxes).toBe(A_FOLDERS);
    await useEmailStore.getState().moveToMailboxCrossAware(a as unknown as IJMAPClient, row.id, 'z');
    expect(a.moveEmail).toHaveBeenCalledWith(row.id, 'z', undefined);
  });
});
