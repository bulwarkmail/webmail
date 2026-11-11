import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { applyDesktopServerPolicy, useAuthStore } from '../auth-store';
import { useSettingsStore } from '../settings-store';
import { emailKeyFor } from '@/lib/thread-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

/**
 * The Pro sidebar shows login B's folder (`viewingAccountId` is B, the rows
 * carry no source stamps), and B's client goes away without B being removed:
 * the desktop server policy refuses its server (applyDesktopServerPolicy), or
 * the device-only clients are swapped for real ones after a start without the
 * server (reconnectOfflineClients drops every one of them first). Every action
 * on its rows and folders is refused then: folder ids (`a`, `b`) and message
 * ids (`eaaaaab`) are the same in both logins, so through the active login
 * they would name its own mail.
 *
 * Two fake logins whose ids collide. Nothing may be written through the
 * active login for a row or a folder of the viewed login.
 */

const refusal = vi.hoisted(() => ({ stop: [] as string[] }));
vi.mock('@/lib/desktop/refused-accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/desktop/refused-accounts')>()),
  planForRefusedAccounts: () => ({ refused: refusal.stop, stop: refusal.stop, activeRefused: false, next: null }),
}));

const folders = (accountId: string): Mailbox[] => [
  { id: 'a', name: 'Inbox', role: 'inbox', accountId },
  { id: 'b', name: 'Deleted Items', role: 'trash', accountId },
  { id: 'f', name: 'Projects', role: null, accountId },
].map((m) => ({
  ...m, sortOrder: 0, totalEmails: 3, unreadEmails: 1, totalThreads: 3, unreadThreads: 1,
  myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayRename: true, mayDelete: true },
  isSubscribed: true, isShared: false,
}) as unknown as Mailbox);

const row = { id: 'eaaaaab', threadId: 't', subject: 'B payroll', receivedAt: '2026-11-11T10:00:00Z', keywords: {}, mailboxIds: { a: true } } as unknown as Email;

function makeClient(accountId: string) {
  const ok = () => vi.fn().mockResolvedValue(undefined);
  return {
    getAccountId: () => accountId,
    getServerUrl: () => `https://${accountId}.example.org`,
    moveToTrash: ok(), deleteEmail: ok(), moveEmail: ok(), markAsRead: ok(), toggleStar: ok(),
    batchMoveEmails: ok(), batchDeleteEmails: ok(), batchMarkAsRead: ok(), batchUpdateKeywords: ok(),
    setKeyword: ok(), removeKeyword: ok(), updateEmailKeywords: ok(),
    emptyMailbox: vi.fn().mockResolvedValue(0), deleteMailbox: ok(), updateMailbox: ok(), renameMailbox: ok(),
    createMailbox: vi.fn().mockResolvedValue({ id: 'g' }), markMailboxAsRead: vi.fn().mockResolvedValue(0),
    markAsSpam: ok(), getMailboxes: vi.fn().mockResolvedValue(folders(accountId)), getAllMailboxes: vi.fn().mockResolvedValue(folders(accountId)),
    getEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 0 }),
  };
}

/** Every method that writes, with how often it ran. */
function writes(client: ReturnType<typeof makeClient>): string[] {
  const reads = new Set(['getAccountId', 'getServerUrl', 'getMailboxes', 'getAllMailboxes', 'getEmails']);
  return Object.entries(client)
    .filter(([name, fn]) => !reads.has(name) && (fn as ReturnType<typeof vi.fn>).mock?.calls.length > 0)
    .map(([name]) => name);
}

const initial = { auth: useAuthStore.getState(), email: useEmailStore.getState(), settings: useSettingsStore.getState() };

describe('the folder of a login whose client is gone stays open in the sidebar', () => {
  let active: ReturnType<typeof makeClient>;
  const asClient = () => active as unknown as IJMAPClient;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    active = makeClient('br');
    // login-b is still registered, but has no client any more.
    useAuthStore.setState({
      isAuthenticated: true, activeAccountId: 'login-a', client: active as never,
      getClientForAccount: (id: string) => (id === 'login-a' ? active : undefined) as never,
      getAllConnectedClients: () => new Map([['login-a', active]]) as never,
    } as never);
    useSettingsStore.setState({ deleteAction: 'trash' } as never);
    useEmailStore.setState({
      viewingAccountId: 'login-b', selectedMailbox: 'a', isUnifiedView: false, selectedKeyword: null, searchQuery: '',
      mailboxes: folders('br'), accountMailboxes: { 'login-b': folders('bs') },
      emails: [row], selectedEmail: row, selectedEmailKeys: new Set([emailKeyFor(row)]),
      processingReadStatus: new Set(), threadEmailsCache: new Map(), expandedThreadIds: new Set(),
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.setState(initial.auth);
    useEmailStore.setState(initial.email);
    useSettingsStore.setState(initial.settings);
  });

  const attempt = async (run: () => Promise<unknown>) => { try { await run(); } catch { /* refusing is fine */ } };

  it('Delete on its row does not move the active login\'s message to Trash', async () => {
    await attempt(() => useEmailStore.getState().deleteEmail(asClient(), 'eaaaaab'));
    expect(writes(active)).toEqual([]);
  });

  it('Delete forever on its row does not destroy the active login\'s message', async () => {
    await attempt(() => useEmailStore.getState().deleteEmail(asClient(), 'eaaaaab', true));
    expect(writes(active)).toEqual([]);
  });

  it('a bulk delete of its rows does not reach the active login', async () => {
    await attempt(() => useEmailStore.getState().batchDelete(asClient()));
    await attempt(() => useEmailStore.getState().batchDelete(asClient(), true));
    expect(writes(active)).toEqual([]);
  });

  it('Mark read and Star on its row do not reach the active login', async () => {
    await attempt(() => useEmailStore.getState().markAsRead(asClient(), 'eaaaaab', true));
    await attempt(() => useEmailStore.getState().toggleStar(asClient(), 'eaaaaab'));
    expect(writes(active)).toEqual([]);
  });

  it('moving its row does not move the active login\'s message', async () => {
    await attempt(() => useEmailStore.getState().moveToMailbox(asClient(), 'eaaaaab', 'f'));
    await attempt(() => useEmailStore.getState().batchMoveToMailbox(asClient(), 'f'));
    expect(writes(active)).toEqual([]);
  });

  it('Empty folder on its Deleted Items does not empty the active login\'s', async () => {
    await attempt(() => useEmailStore.getState().emptyMailbox(asClient(), 'b'));
    expect(writes(active)).toEqual([]);
  });

  it('deleting or renaming its folder does not touch the active login\'s folder with the same id', async () => {
    await attempt(() => useEmailStore.getState().deleteMailbox(asClient(), 'f', { removeEmails: true }));
    await attempt(() => useEmailStore.getState().renameMailbox(asClient(), 'f', 'Renamed'));
    expect(writes(active)).toEqual([]);
  });

  it('Mark all as read on its folder does not mark the active login\'s folder', async () => {
    await attempt(() => useEmailStore.getState().markMailboxAsRead(asClient(), 'a'));
    expect(writes(active)).toEqual([]);
  });

  it('the conversation of its row is not read through the active login', async () => {
    const getThreadEmails = vi.fn().mockResolvedValue([]);
    (active as unknown as Record<string, unknown>).getThreadEmails = getThreadEmails;
    useEmailStore.setState({ expandedThreadIds: new Set() } as never);
    await attempt(() => useEmailStore.getState().fetchThreadEmails(asClient(), 't'));
    expect(getThreadEmails).not.toHaveBeenCalled();
  });

  it('when the desktop policy refuses its server, its folder and rows leave the screen', () => {
    refusal.stop = ['login-b'];
    try {
      applyDesktopServerPolicy();
    } finally {
      refusal.stop = [];
    }
    const state = useEmailStore.getState();
    expect(state.viewingAccountId).toBeNull();
    expect(state.emails).toEqual([]);
    expect(writes(active)).toEqual([]);
  });

  it('when the desktop policy refuses a login, its rows in a list of several logins go', () => {
    const mine = { ...row, subject: 'A note', sourceClientAccountId: 'login-a', sourceAccountId: 'br' } as Email;
    const theirs = { ...row, sourceClientAccountId: 'login-b', sourceAccountId: 'bs' } as Email;
    useEmailStore.setState({
      viewingAccountId: null, isUnifiedView: true, selectedMailbox: null,
      emails: [mine, theirs], selectedEmail: theirs, selectedEmailKeys: new Set([emailKeyFor(mine), emailKeyFor(theirs)]),
    } as never);
    refusal.stop = ['login-b'];
    try {
      applyDesktopServerPolicy();
    } finally {
      refusal.stop = [];
    }
    const state = useEmailStore.getState();
    expect(state.emails.map((e) => e.subject)).toEqual(['A note']);
    expect(state.selectedEmail).toBeNull();
    expect([...state.selectedEmailKeys]).toEqual([emailKeyFor(mine)]);
  });
});
