import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { fetchUnifiedMock, fetchCrossViewMock } = vi.hoisted(() => ({
  fetchUnifiedMock: vi.fn(), fetchCrossViewMock: vi.fn(),
}));
vi.mock('@/lib/unified-mailbox', async (importActual) => ({
  ...await importActual<typeof import('@/lib/unified-mailbox')>(),
  fetchUnifiedEmails: fetchUnifiedMock,
  fetchCrossViewEmails: fetchCrossViewMock,
}));

import { ArchiveMailboxNotFoundError, useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '../settings-store';
import { ArchiveEmailsError } from '@/lib/jmap/archive-error';
import { runBatchEmailAction } from '@/lib/email-action-toast';
import { toast } from '@/stores/toast-store';
import { threadKeyFor } from '@/lib/thread-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

const originalRefresh = useEmailStore.getState().refreshCurrentMailbox;

const mailbox = (owner: string, role: 'inbox' | 'archive', shared = false) => ({
  id: shared ? `${owner}:${role}` : `${owner}-${role}`,
  originalId: shared ? role : undefined,
  accountId: owner, role, name: role,
  isShared: shared,
  myRights: { mayReadItems: true, mayAddItems: true },
}) as Mailbox;

const email = (id: string, owner: string, login = 'login-a') => ({
  id, threadId: `thread-${id}`, receivedAt: '2026-09-01T12:00:00Z',
  sourceClientAccountId: login, sourceAccountId: owner,
  mailboxIds: { inbox: true }, keywords: {}, size: 100, hasAttachment: false,
}) as Email;

function makeClient(folders: Record<string, Mailbox[]>) {
  return {
    batchArchiveEmails: vi.fn().mockResolvedValue(undefined),
    // Missing-folder fixtures leave the created Archive out of the reload,
    // exercising upstream's create-then-report-not-found behavior.
    createMailbox: vi.fn().mockResolvedValue({}),
    getMailboxes: vi.fn(async (owner: string) => folders[owner] ?? []),
    getAllMailboxes: vi.fn(async () => Object.values(folders).flat()),
    getAccountId: () => 'primary',
  } as unknown as IJMAPClient;
}

describe('bulk archive ownership and reconciliation', () => {
  let client: IJMAPClient;
  let folders: Record<string, Mailbox[]>;
  let refresh: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    folders = {
      primary: [mailbox('primary', 'inbox'), mailbox('primary', 'archive')],
      shared: [mailbox('shared', 'inbox', true), mailbox('shared', 'archive', true)],
    };
    client = makeClient(folders);
    useAuthStore.setState({
      activeAccountId: 'login-a',
      getClientForAccount: (id: string) => id === 'login-a' ? client as never : undefined,
    });
    useSettingsStore.setState({ archiveMode: 'single' });
    useEmailStore.setState({
      emails: [email('primary-email', 'primary'), email('shared-email', 'shared')],
      selectedEmailIds: new Set(['primary-email', 'shared-email']),
      selectedEmail: email('primary-email', 'primary'),
      selectedMailbox: '__unified_inbox__', viewingAccountId: null,
      isUnifiedView: true, unifiedRole: 'inbox', crossView: null,
      mailboxes: Object.values(folders).flat(), accountMailboxes: { ...folders },
      unifiedScope: [], error: null, isLoading: false,
      selectedKeyword: null, searchQuery: '', totalEmails: 2,
      threadEmailsCache: new Map(), expandedThreadIds: new Set(),
    });
    refresh = vi.spyOn(useEmailStore.getState(), 'refreshCurrentMailbox').mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useEmailStore.setState({ refreshCurrentMailbox: originalRefresh });
  });

  it('routes primary and shared IDs separately to each owner’s Archive', async () => {
    await useEmailStore.getState().batchArchive(client);

    expect(client.batchArchiveEmails).toHaveBeenCalledTimes(2);
    expect(client.batchArchiveEmails).toHaveBeenCalledWith(
      [{ id: 'primary-email', receivedAt: expect.any(String) }],
      'primary-archive', 'single', expect.any(Array), 'primary',
    );
    expect(client.batchArchiveEmails).toHaveBeenCalledWith(
      [{ id: 'shared-email', receivedAt: expect.any(String) }],
      'archive', 'single', expect.any(Array), 'shared',
    );
    expect(useEmailStore.getState().emails).toEqual([]);
    expect(useEmailStore.getState().selectedEmailIds.size).toBe(0);
    expect(useEmailStore.getState().selectedEmail).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('skips prohibited owner Archive creation while reconciling the valid primary group', async () => {
    folders.shared = [mailbox('shared', 'inbox', true)];
    const getAccountCapability = vi.fn((_capability: string, owner?: string) => ({
      mayCreateTopLevelMailbox: owner !== 'shared',
    }));
    Object.assign(client, { getAccountCapability });
    const failed = useEmailStore.getState().emails[1];

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);

    expect(getAccountCapability).toHaveBeenCalledWith('urn:ietf:params:jmap:mail', 'shared');
    expect(client.createMailbox).not.toHaveBeenCalled();
    expect(client.batchArchiveEmails).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.batchArchiveEmails).mock.calls[0][4]).toBe('primary');
    expect(useEmailStore.getState().emails).toEqual([failed]);
    expect([...useEmailStore.getState().selectedEmailIds]).toEqual(['shared-email']);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each(['single', 'year', 'month'] as const)('uses an existing Archive in %s mode despite prohibited top-level creation', async mode => {
    Object.assign(client, { getAccountCapability: vi.fn(() => ({ mayCreateTopLevelMailbox: false })) });
    folders.shared[1].myRights.mayCreateChild = true;
    useSettingsStore.setState({ archiveMode: mode });

    await useEmailStore.getState().batchArchive(client);

    expect(client.createMailbox).not.toHaveBeenCalled();
    expect(client.batchArchiveEmails).toHaveBeenCalledWith(
      [{ id: 'shared-email', receivedAt: expect.any(String) }], 'archive', mode,
      expect.arrayContaining([expect.objectContaining({ id: 'archive', myRights: expect.objectContaining({ mayCreateChild: true }) })]), 'shared',
    );
    expect(useEmailStore.getState().selectedEmailIds.size).toBe(0);
  });

  it('uses the reaching client’s capability for equal owner IDs on different logins', async () => {
    const otherFolders = { primary: [mailbox('primary', 'inbox')] };
    const otherClient = makeClient(otherFolders);
    const deniedCapability = vi.fn(() => ({ mayCreateTopLevelMailbox: false }));
    const allowedCapability = vi.fn(() => ({ mayCreateTopLevelMailbox: true }));
    Object.assign(client, { getAccountCapability: deniedCapability });
    Object.assign(otherClient, { getAccountCapability: allowedCapability });
    folders.primary = [mailbox('primary', 'inbox')];
    vi.mocked(otherClient.createMailbox).mockImplementation(async () => {
      const archive = { ...mailbox('primary', 'archive'), id: 'other-archive' };
      otherFolders.primary.push(archive);
      return archive;
    });
    useAuthStore.setState({
      getClientForAccount: (id: string) => (id === 'login-a' ? client : id === 'login-b' ? otherClient : undefined) as never,
    });
    const failed = email('failed-email', 'primary');
    useEmailStore.setState({
      emails: [failed, email('other-email', 'primary', 'login-b')], selectedEmailIds: new Set(['failed-email', 'other-email']),
    });

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);

    expect(deniedCapability).toHaveBeenCalledWith('urn:ietf:params:jmap:mail', 'primary');
    expect(allowedCapability).toHaveBeenCalledWith('urn:ietf:params:jmap:mail', 'primary');
    expect(client.createMailbox).not.toHaveBeenCalled();
    expect(client.batchArchiveEmails).not.toHaveBeenCalled();
    expect(otherClient.createMailbox).toHaveBeenCalledWith('Archive', undefined, 'primary', { role: 'archive' });
    expect(vi.mocked(otherClient.batchArchiveEmails).mock.calls[0][1]).toBe('other-archive');
    expect(useEmailStore.getState().emails).toEqual([failed]);
    expect([...useEmailStore.getState().selectedEmailIds]).toEqual(['failed-email']);
  });

  it.each(['single', 'year', 'month'] as const)('creates each missing owner’s Archive independently in %s mode', async mode => {
    folders.primary = [mailbox('primary', 'inbox')];
    folders.shared = [mailbox('shared', 'inbox', true)];
    useSettingsStore.setState({ archiveMode: mode });
    vi.mocked(client.createMailbox).mockImplementation(async (_name, _parent, owner) => {
      const archive = mailbox(owner!, 'archive', owner === 'shared');
      folders[owner!].push(archive);
      return archive;
    });

    await useEmailStore.getState().batchArchive(client);

    expect(client.createMailbox).toHaveBeenCalledTimes(2);
    expect(client.createMailbox).toHaveBeenCalledWith('Archive', undefined, 'primary', { role: 'archive' });
    expect(client.createMailbox).toHaveBeenCalledWith('Archive', undefined, 'shared', { role: 'archive' });
    expect(client.batchArchiveEmails).toHaveBeenCalledWith(
      [{ id: 'shared-email', receivedAt: expect.any(String) }], 'archive', mode, expect.any(Array), 'shared',
    );
    expect(useEmailStore.getState().emails).toEqual([]);
    expect(useEmailStore.getState().accountMailboxes.shared.map(m => m.id)).toContain('shared:archive');
  });

  it('keeps other groups valid when an owner refuses Archive creation', async () => {
    folders.shared = [mailbox('shared', 'inbox', true)];
    vi.mocked(client.createMailbox).mockRejectedValue(new Error('Archive creation forbidden'));

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toThrow('Archive creation forbidden');

    expect(client.createMailbox).toHaveBeenCalledWith('Archive', undefined, 'shared', { role: 'archive' });
    expect(client.batchArchiveEmails).toHaveBeenCalledTimes(1);
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['shared-email']);
    expect([...useEmailStore.getState().selectedEmailIds]).toEqual(['shared-email']);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('publishes a newly created Archive even when its email move fails', async () => {
    folders.primary = [mailbox('primary', 'inbox')];
    useEmailStore.setState({ emails: [email('primary-email', 'primary')], selectedEmailIds: new Set(['primary-email']) });
    vi.mocked(client.createMailbox).mockImplementation(async () => {
      const archive = mailbox('primary', 'archive');
      folders.primary.push(archive);
      return archive;
    });
    vi.mocked(client.batchArchiveEmails).mockRejectedValue(new Error('Email move forbidden'));

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toThrow('Email move forbidden');

    expect(useEmailStore.getState().accountMailboxes['login-a'].map(m => m.id)).toContain('primary-archive');
    expect([...useEmailStore.getState().selectedEmailIds]).toEqual(['primary-email']);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('groups stamped and unstamped rows of one owner and clears its stamped viewer', async () => {
    const unstamped = { ...email('own-email', 'primary'), sourceAccountId: undefined, sourceClientAccountId: undefined };
    useEmailStore.setState({
      emails: [unstamped, email('stamped-email', 'primary')],
      selectedEmail: email('own-email', 'primary'),
      selectedEmailIds: new Set(['own-email', 'stamped-email']),
      selectedMailbox: 'primary-inbox', isUnifiedView: false,
    });

    await useEmailStore.getState().batchArchive(client);

    expect(client.batchArchiveEmails).toHaveBeenCalledOnce();
    expect(vi.mocked(client.batchArchiveEmails).mock.calls[0][0].map(e => e.id)).toEqual(['own-email', 'stamped-email']);
    expect(useEmailStore.getState().selectedEmail).toBeNull();
  });

  it.each(['year', 'month'] as const)('passes bare shared folder and parent IDs for %s subfolder reuse', async mode => {
    folders.shared.push({ ...mailbox('shared', 'archive', true), id: 'shared:year', originalId: 'year', name: '2026', role: undefined, parentId: 'shared:archive' });
    useEmailStore.setState({
      emails: [email('shared-email', 'shared')], selectedEmailIds: new Set(['shared-email']),
    });
    useSettingsStore.setState({ archiveMode: mode });

    await useEmailStore.getState().batchArchive(client);

    expect(vi.mocked(client.batchArchiveEmails).mock.calls[0][3]).toContainEqual(
      expect.objectContaining({ id: 'year', parentId: 'archive', accountId: 'shared' }),
    );
  });

  it('removes confirmed pinned retention without changing a failed message’s keywords or thread', async () => {
    const archived = { ...email('accepted', 'primary'), keywords: { $pinned: true } };
    const failed = { ...email('refused', 'primary'), threadId: archived.threadId, keywords: { $pinned: true, $seen: true } };
    useEmailStore.setState({
      emails: [archived, failed], selectedEmail: failed,
      selectedEmailIds: new Set(['accepted', 'refused']), retainedInViewIds: new Set(['accepted', 'refused']),
      threadEmailsCache: new Map([[threadKeyFor(archived), [archived, failed]]]),
      expandedThreadIds: new Set([threadKeyFor(archived)]),
    });
    vi.mocked(client.batchArchiveEmails).mockRejectedValue(new ArchiveEmailsError('forbidden', ['accepted']));

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toThrow('forbidden');

    expect(useEmailStore.getState().emails).toEqual([failed]);
    expect(useEmailStore.getState().selectedEmail).toBe(failed);
    expect([...useEmailStore.getState().retainedInViewIds]).toEqual(['refused']);
    expect(useEmailStore.getState().threadEmailsCache.get(threadKeyFor(failed))).toEqual([failed]);
    expect(useEmailStore.getState().expandedThreadIds.has(threadKeyFor(failed))).toBe(true);
  });

  it('preserves a failed selected row when the actual refresh omits it', async () => {
    const failed = email('shared-email', 'shared');
    useEmailStore.setState({ selectedEmail: failed, refreshCurrentMailbox: originalRefresh });
    folders.shared = [mailbox('shared', 'inbox', true)];
    fetchUnifiedMock.mockResolvedValue({ emails: [], total: 0, hasMore: false, errors: new Map() });

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);

    expect(useEmailStore.getState().emails).toEqual([failed]);
    expect(useEmailStore.getState().selectedEmail).toBe(failed);
    expect([...useEmailStore.getState().selectedEmailIds]).toEqual(['shared-email']);
    expect(useEmailStore.getState().totalEmails).toBe(1);
  });

  it('leaves the shared row selected when its Archive is missing, while primary succeeds', async () => {
    folders.shared = [mailbox('shared', 'inbox', true)];
    useEmailStore.setState({ accountMailboxes: { ...folders }, mailboxes: Object.values(folders).flat() });

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);

    expect(client.batchArchiveEmails).toHaveBeenCalledTimes(1);
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['shared-email']);
    expect([...useEmailStore.getState().selectedEmailIds]).toEqual(['shared-email']);
    expect(useEmailStore.getState().error).toMatch(/archive mailbox not found/i);
    expect(refresh).toHaveBeenCalledOnce();
    expect(client.getMailboxes).toHaveBeenCalledWith('primary');
  });

  it('reconciles an owner request failure while another owner succeeds', async () => {
    vi.mocked(client.batchArchiveEmails).mockImplementation(async (_emails, _dest, _mode, _folders, owner) => {
      if (owner === 'primary') throw new Error('forbidden');
    });

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toThrow('forbidden');

    expect(client.batchArchiveEmails).toHaveBeenCalledTimes(2);
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['primary-email']);
    expect([...useEmailStore.getState().selectedEmailIds]).toEqual(['primary-email']);
    expect(useEmailStore.getState().selectedEmail?.id).toBe('primary-email');
    expect(useEmailStore.getState().error).toBe('forbidden');
    expect(useEmailStore.getState().isLoading).toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
    expect(client.getMailboxes).toHaveBeenCalledWith('shared');
  });
  it('removes only confirmed updates within one owner and reports the failure toast', async () => {
    const failed = email('rejected-email', 'primary');
    useEmailStore.setState({
      emails: [email('primary-email', 'primary'), failed],
      selectedEmailIds: new Set(['primary-email', 'rejected-email']),
    });
    vi.mocked(client.batchArchiveEmails).mockRejectedValue(
      new ArchiveEmailsError('Failed to archive emails: notFound', ['primary-email']),
    );
    const errorToast = vi.spyOn(toast, 'error');
    const successToast = vi.spyOn(toast, 'success');

    await runBatchEmailAction(() => useEmailStore.getState().batchArchive(client), {
      success: 'archived', error: 'archive failed',
    });

    expect(useEmailStore.getState().emails).toEqual([failed]);
    expect([...useEmailStore.getState().selectedEmailIds]).toEqual(['rejected-email']);
    expect(useEmailStore.getState().selectedEmail).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
    expect(vi.mocked(client.getMailboxes).mock.calls).toEqual([['primary'], ['primary']]);
    expect(errorToast).toHaveBeenCalledWith('archive failed', 'Failed to archive emails: notFound');
    expect(successToast).not.toHaveBeenCalled();
  });

  it.each(['single', 'year', 'month'] as const)('preserves ordinary single-owner %s archive', async mode => {
    const own = { ...email('own-email', 'primary'), sourceAccountId: undefined, sourceClientAccountId: undefined };
    useEmailStore.setState({
      emails: [own], selectedEmailIds: new Set([own.id]),
      isUnifiedView: false, selectedMailbox: 'primary-inbox',
      mailboxes: folders.primary,
    });
    useSettingsStore.setState({ archiveMode: mode });

    await useEmailStore.getState().batchArchive(client);

    expect(client.batchArchiveEmails).toHaveBeenCalledOnce();
    expect(client.batchArchiveEmails).toHaveBeenCalledWith(
      [{ id: own.id, receivedAt: own.receivedAt }],
      'primary-archive', mode, folders.primary, 'primary',
    );
    expect(useEmailStore.getState().selectedEmailIds.size).toBe(0);
    expect(useEmailStore.getState().error).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('keeps equal account IDs on different authenticated clients separate', async () => {
    const otherFolders = { primary: [mailbox('primary', 'inbox'), { ...mailbox('primary', 'archive'), id: 'other-archive' }] };
    const otherClient = makeClient(otherFolders);
    useAuthStore.setState({
      getClientForAccount: (id: string) => (id === 'login-a' ? client : id === 'login-b' ? otherClient : undefined) as never,
    });
    useEmailStore.setState({
      emails: [email('primary-email', 'primary'), email('other-email', 'primary', 'login-b')],
      selectedEmailIds: new Set(['primary-email', 'other-email']),
      // Deliberately ambiguous cache: the client must resolve its own folders.
      accountMailboxes: otherFolders,
    });

    await useEmailStore.getState().batchArchive(client);

    expect(client.batchArchiveEmails).toHaveBeenCalledWith(
      [{ id: 'primary-email', receivedAt: expect.any(String) }],
      'primary-archive', 'single', folders.primary, 'primary',
    );
    expect(otherClient.batchArchiveEmails).toHaveBeenCalledWith(
      [{ id: 'other-email', receivedAt: expect.any(String) }],
      'other-archive', 'single', otherFolders.primary, 'primary',
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each(['missing Archive', 'rejected request', 'different login'] as const)(
    'preserves the failed owner’s row, selection, viewer, and thread with colliding email IDs: %s',
    async failure => {
      const archived = email('same-email-id', 'primary');
      const failed = failure === 'different login'
        ? email('same-email-id', 'primary', 'login-b')
        : email('same-email-id', 'shared');
      if (failure === 'missing Archive') folders.shared = [mailbox('shared', 'inbox', true)];
      if (failure === 'rejected request') {
        vi.mocked(client.batchArchiveEmails).mockImplementation(async (_emails, _dest, _mode, _folders, owner) => {
          if (owner === 'shared') throw new Error('forbidden');
        });
      }
      if (failure === 'different login') {
        const otherClient = makeClient({ primary: folders.primary });
        vi.mocked(otherClient.batchArchiveEmails).mockRejectedValue(new Error('forbidden'));
        useAuthStore.setState({
          getClientForAccount: (id: string) => (id === 'login-a' ? client : id === 'login-b' ? otherClient : undefined) as never,
        });
      }
      useEmailStore.setState({
        emails: [archived, failed],
        // Selection currently stores bare IDs: this bit selects both rows.
        selectedEmailIds: new Set(['same-email-id']),
        selectedEmail: { ...failed, preview: 'Open failed owner’s message' },
        threadEmailsCache: new Map([[threadKeyFor(archived), [archived]], [threadKeyFor(failed), [failed]]]),
        expandedThreadIds: new Set([threadKeyFor(archived), threadKeyFor(failed)]),
      });
      const viewer = useEmailStore.getState().selectedEmail;

      await expect(useEmailStore.getState().batchArchive(client)).rejects.toThrow(
        failure === 'missing Archive' ? /archive mailbox not found/i : /forbidden/,
      );

      expect(useEmailStore.getState().emails).toEqual([failed]);
      expect([...useEmailStore.getState().selectedEmailIds]).toEqual(['same-email-id']);
      expect(useEmailStore.getState().selectedEmail).toBe(viewer);
      expect([...useEmailStore.getState().threadEmailsCache.keys()]).toEqual([threadKeyFor(failed)]);
      expect([...useEmailStore.getState().expandedThreadIds]).toEqual([threadKeyFor(failed)]);
      expect(refresh).toHaveBeenCalledOnce();
    },
  );

  it('keeps partial Email/set confirmations scoped to the owner with a colliding ID', async () => {
    const archived = email('same-email-id', 'primary');
    const refused = email('refused-primary-email', 'primary');
    const shared = email('same-email-id', 'shared');
    folders.shared = [mailbox('shared', 'inbox', true)];
    vi.mocked(client.batchArchiveEmails).mockRejectedValue(
      new ArchiveEmailsError('Failed to archive emails: notFound', ['same-email-id']),
    );
    useEmailStore.setState({
      emails: [archived, refused, shared], selectedEmail: { ...shared },
      selectedEmailIds: new Set(['same-email-id', refused.id]),
    });

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toThrow('notFound');

    expect(useEmailStore.getState().emails).toEqual([refused, shared]);
    expect([...useEmailStore.getState().selectedEmailIds]).toEqual(['same-email-id', refused.id]);
    expect(useEmailStore.getState().selectedEmail).toEqual(shared);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('clears the successful owner’s viewer while retaining a colliding failed row’s selection', async () => {
    const archived = email('same-email-id', 'primary');
    const failed = email('same-email-id', 'shared');
    folders.shared = [mailbox('shared', 'inbox', true)];
    useEmailStore.setState({
      emails: [archived, failed], selectedEmail: { ...archived },
      selectedEmailIds: new Set(['same-email-id']),
    });

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);

    expect(useEmailStore.getState().emails).toEqual([failed]);
    expect([...useEmailStore.getState().selectedEmailIds]).toEqual(['same-email-id']);
    expect(useEmailStore.getState().selectedEmail).toBeNull();
  });

  it.each(['unified', 'cross-account'] as const)('retains a colliding failed row and viewer through the actual %s refresh', async view => {
    const archived = email('same-email-id', 'primary');
    const failed = email('same-email-id', 'shared');
    const viewer = { ...failed, preview: 'Open failed owner’s message' };
    folders.shared = [mailbox('shared', 'inbox', true)];
    const loader = view === 'unified' ? fetchUnifiedMock : fetchCrossViewMock;
    loader.mockResolvedValue({ emails: [{ ...failed }], total: 1, hasMore: false, errors: new Map() });
    useEmailStore.setState({
      emails: [archived, failed], selectedEmail: viewer,
      selectedEmailIds: new Set(['same-email-id']),
      refreshCurrentMailbox: originalRefresh,
      selectedMailbox: view === 'unified' ? '__unified_inbox__' : '__cross_all__',
      unifiedRole: view === 'unified' ? 'inbox' : null,
      crossView: view === 'cross-account' ? 'all' : null,
    });

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);

    expect(loader).toHaveBeenCalledOnce();
    expect(useEmailStore.getState().emails).toEqual([failed]);
    expect([...useEmailStore.getState().selectedEmailIds]).toEqual(['same-email-id']);
    expect(useEmailStore.getState().selectedEmail).toBe(viewer);
    expect(useEmailStore.getState().error).toMatch(/archive mailbox not found/i);
  });

  it('does not fall back to the active client for a disconnected stamped owner', async () => {
    useEmailStore.setState({
      emails: [email('primary-email', 'primary'), email('shared-email', 'shared', 'disconnected')],
    });
    await expect(useEmailStore.getState().batchArchive(client)).rejects.toThrow('not connected');
    expect(client.batchArchiveEmails).toHaveBeenCalledTimes(1);
    expect([...useEmailStore.getState().selectedEmailIds]).toEqual(['shared-email']);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('refreshes the actual unified view after partial success and retains the failed selection', async () => {
    useEmailStore.setState({ refreshCurrentMailbox: originalRefresh });
    const failed = email('shared-email', 'shared');
    folders.shared = [mailbox('shared', 'inbox', true)];
    fetchUnifiedMock.mockResolvedValue({
      emails: [failed], total: 1, hasMore: false, errors: new Map(),
    });

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);

    expect(fetchUnifiedMock).toHaveBeenCalledOnce();
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['shared-email']);
    expect([...useEmailStore.getState().selectedEmailIds]).toEqual(['shared-email']);
    expect(useEmailStore.getState().error).toMatch(/archive mailbox not found/i);
    expect(useEmailStore.getState().accountMailboxes.primary).toEqual(folders.primary);
    expect(useEmailStore.getState().mailboxes.find(m => m.id === 'shared:archive')).toBeDefined();
  });

  it('leaves a read-only shared Archive untouched without blocking the primary owner', async () => {
    folders.shared[1].myRights.mayAddItems = false;
    await expect(useEmailStore.getState().batchArchive(client)).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);
    expect(client.batchArchiveEmails).toHaveBeenCalledTimes(1);
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['shared-email']);
    expect([...useEmailStore.getState().selectedEmailIds]).toEqual(['shared-email']);
  });

  it('keeps all rows and selections when no owner succeeds', async () => {
    vi.mocked(client.batchArchiveEmails).mockRejectedValue(new Error('forbidden'));
    await expect(useEmailStore.getState().batchArchive(client)).rejects.toThrow('forbidden');
    expect(useEmailStore.getState().emails).toHaveLength(2);
    expect(useEmailStore.getState().selectedEmailIds.size).toBe(2);
    expect(refresh).not.toHaveBeenCalled();
    expect(useEmailStore.getState().isLoading).toBe(false);
  });

});
