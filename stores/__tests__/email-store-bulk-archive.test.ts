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
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import { emailKeyFor, threadKeyFor } from '@/lib/thread-utils';
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
    clearAllHooks();
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
      selectedEmailKeys: new Set([emailKeyFor(email('primary-email', 'primary')), emailKeyFor(email('shared-email', 'shared'))]),
      selectedEmail: email('primary-email', 'primary'),
      selectedMailbox: '__unified_inbox__', viewingAccountId: null,
      isUnifiedView: true, unifiedRole: 'inbox', crossView: null,
      mailboxes: Object.values(folders).flat(), accountMailboxes: { ...folders },
      unifiedScope: [], error: null, isLoading: false,
      selectedKeyword: null, searchQuery: '', totalEmails: 2,
      threadEmailsCache: new Map(), expandedThreadIds: new Set(), retainedInViewIds: new Set(),
    });
    refresh = vi.spyOn(useEmailStore.getState(), 'refreshCurrentMailbox').mockResolvedValue();
  });

  afterEach(() => {
    clearAllHooks();
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
    expect(useEmailStore.getState().selectedEmailKeys.size).toBe(0);
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
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(failed)]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each(['single', 'year', 'month'] as const)('uses an existing Archive in %s mode despite prohibited top-level creation', async mode => {
    const getAccountCapability = vi.fn(() => ({ mayCreateTopLevelMailbox: false }));
    Object.assign(client, { getAccountCapability });
    folders.shared[1].myRights.mayCreateChild = true;
    useSettingsStore.setState({ archiveMode: mode });

    await useEmailStore.getState().batchArchive(client);

    expect(client.createMailbox).not.toHaveBeenCalled();
    expect(getAccountCapability).not.toHaveBeenCalled();
    expect(client.batchArchiveEmails).toHaveBeenCalledWith(
      [{ id: 'shared-email', receivedAt: expect.any(String) }], 'archive', mode,
      expect.arrayContaining([expect.objectContaining({ id: 'archive', myRights: expect.objectContaining({ mayCreateChild: true }) })]), 'shared',
    );
    expect(useEmailStore.getState().selectedEmailKeys.size).toBe(0);
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
      emails: [failed, email('other-email', 'primary', 'login-b')],
      selectedEmailKeys: new Set([emailKeyFor(failed), emailKeyFor(email('other-email', 'primary', 'login-b'))]),
    });

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);

    expect(deniedCapability).toHaveBeenCalledWith('urn:ietf:params:jmap:mail', 'primary');
    expect(allowedCapability).toHaveBeenCalledWith('urn:ietf:params:jmap:mail', 'primary');
    expect(client.createMailbox).not.toHaveBeenCalled();
    expect(client.batchArchiveEmails).not.toHaveBeenCalled();
    expect(otherClient.createMailbox).toHaveBeenCalledWith('Archive', undefined, 'primary', { role: 'archive' });
    expect(vi.mocked(otherClient.batchArchiveEmails).mock.calls[0][1]).toBe('other-archive');
    expect(useEmailStore.getState().emails).toEqual([failed]);
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(failed)]);
  });

  it.each(['shared owner', 'different login'] as const)('retains a prohibited namesake’s selection, viewer, and thread after partial success: %s', async source => {
    const archived = email('same-email-id', 'primary');
    const failed = source === 'shared owner'
      ? email('same-email-id', 'shared') : email('same-email-id', 'primary', 'login-b');
    const deniedClient = source === 'shared owner' ? client : makeClient({ primary: [mailbox('primary', 'inbox')] });
    const getAccountCapability = vi.fn(() => ({ mayCreateTopLevelMailbox: false }));
    Object.assign(deniedClient, { getAccountCapability });
    if (source === 'shared owner') folders.shared = [mailbox('shared', 'inbox', true)];
    useAuthStore.setState({
      getClientForAccount: (id: string) => (id === 'login-a' ? client : id === 'login-b' ? deniedClient : undefined) as never,
    });
    useEmailStore.setState({
      emails: [archived, failed], selectedEmail: failed,
      selectedEmailKeys: new Set([emailKeyFor(archived), emailKeyFor(failed)]),
      threadEmailsCache: new Map([[threadKeyFor(archived), [archived]], [threadKeyFor(failed), [failed]]]),
      expandedThreadIds: new Set([threadKeyFor(archived), threadKeyFor(failed)]),
    });

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);

    expect(getAccountCapability).toHaveBeenCalledExactlyOnceWith('urn:ietf:params:jmap:mail', failed.sourceAccountId);
    expect(deniedClient.createMailbox).not.toHaveBeenCalled();
    expect(client.batchArchiveEmails).toHaveBeenCalledExactlyOnceWith(
      [{ id: archived.id, receivedAt: archived.receivedAt }], 'primary-archive', 'single', expect.any(Array), 'primary',
    );
    if (source === 'different login') expect(deniedClient.batchArchiveEmails).not.toHaveBeenCalled();
    const state = useEmailStore.getState();
    expect(state.emails).toEqual([failed]);
    expect([...state.selectedEmailKeys]).toEqual([emailKeyFor(failed)]);
    expect(state.selectedEmail).toBe(failed);
    expect([...state.threadEmailsCache]).toEqual([[threadKeyFor(failed), [failed]]]);
    expect([...state.expandedThreadIds]).toEqual([threadKeyFor(failed)]);
    expect(state.error).toMatch(/archive mailbox not found/i);
    expect(refresh).toHaveBeenCalledOnce();
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
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(email('shared-email', 'shared'))]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('publishes a newly created Archive even when its email move fails', async () => {
    folders.primary = [mailbox('primary', 'inbox')];
    useEmailStore.setState({ emails: [email('primary-email', 'primary')], selectedEmailKeys: new Set([emailKeyFor(email('primary-email', 'primary'))]) });
    vi.mocked(client.createMailbox).mockImplementation(async () => {
      const archive = mailbox('primary', 'archive');
      folders.primary.push(archive);
      return archive;
    });
    vi.mocked(client.batchArchiveEmails).mockRejectedValue(new Error('Email move forbidden'));

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toThrow('Email move forbidden');

    expect(useEmailStore.getState().accountMailboxes['login-a'].map(m => m.id)).toContain('primary-archive');
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(email('primary-email', 'primary'))]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('groups stamped and unstamped rows of one owner and clears its stamped viewer', async () => {
    const unstamped = { ...email('own-email', 'primary'), sourceAccountId: undefined, sourceClientAccountId: undefined };
    useEmailStore.setState({
      emails: [unstamped, email('stamped-email', 'primary')],
      selectedEmail: email('own-email', 'primary'),
      selectedEmailKeys: new Set([emailKeyFor(unstamped), emailKeyFor(email('stamped-email', 'primary'))]),
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
      emails: [email('shared-email', 'shared')], selectedEmailKeys: new Set([emailKeyFor(email('shared-email', 'shared'))]),
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
      selectedEmailKeys: new Set([emailKeyFor(archived), emailKeyFor(failed)]), retainedInViewIds: new Set(['accepted', 'refused']),
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
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(email('shared-email', 'shared'))]);
    expect(useEmailStore.getState().totalEmails).toBe(1);
  });

  it('leaves the shared row selected when its Archive is missing, while primary succeeds', async () => {
    folders.shared = [mailbox('shared', 'inbox', true)];
    useEmailStore.setState({ accountMailboxes: { ...folders }, mailboxes: Object.values(folders).flat() });

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);

    expect(client.batchArchiveEmails).toHaveBeenCalledTimes(1);
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['shared-email']);
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(email('shared-email', 'shared'))]);
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
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(email('primary-email', 'primary'))]);
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
      selectedEmailKeys: new Set([emailKeyFor(email('primary-email', 'primary')), emailKeyFor(failed)]),
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
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(failed)]);
    expect(useEmailStore.getState().selectedEmail).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
    expect(vi.mocked(client.getMailboxes).mock.calls).toEqual([['primary'], ['primary']]);
    expect(errorToast).toHaveBeenCalledWith('archive failed', 'Failed to archive emails: notFound');
    expect(successToast).not.toHaveBeenCalled();
  });

  it.each(['single', 'year', 'month'] as const)('preserves ordinary single-owner %s archive', async mode => {
    const own = { ...email('own-email', 'primary'), sourceAccountId: undefined, sourceClientAccountId: undefined };
    useEmailStore.setState({
      emails: [own], selectedEmailKeys: new Set([emailKeyFor(own)]),
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
    expect(useEmailStore.getState().selectedEmailKeys.size).toBe(0);
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
      selectedEmailKeys: new Set([emailKeyFor(email('primary-email', 'primary')), emailKeyFor(email('other-email', 'primary', 'login-b'))]),
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
        // Both owners are explicitly selected by their independent keys.
        selectedEmailKeys: new Set([emailKeyFor(archived), emailKeyFor(failed)]),
        selectedEmail: { ...failed, preview: 'Open failed owner’s message' },
        threadEmailsCache: new Map([[threadKeyFor(archived), [archived]], [threadKeyFor(failed), [failed]]]),
        expandedThreadIds: new Set([threadKeyFor(archived), threadKeyFor(failed)]),
      });
      const viewer = useEmailStore.getState().selectedEmail;

      await expect(useEmailStore.getState().batchArchive(client)).rejects.toThrow(
        failure === 'missing Archive' ? /archive mailbox not found/i : /forbidden/,
      );

      expect(useEmailStore.getState().emails).toEqual([failed]);
      expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(failed)]);
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
      selectedEmailKeys: new Set([emailKeyFor(archived), emailKeyFor(refused), emailKeyFor(shared)]),
    });

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toThrow('notFound');

    expect(useEmailStore.getState().emails).toEqual([refused, shared]);
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(refused), emailKeyFor(shared)]);
    expect(useEmailStore.getState().selectedEmail).toEqual(shared);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('clears the successful owner’s viewer while retaining a colliding failed row’s selection', async () => {
    const archived = email('same-email-id', 'primary');
    const failed = email('same-email-id', 'shared');
    folders.shared = [mailbox('shared', 'inbox', true)];
    useEmailStore.setState({
      emails: [archived, failed], selectedEmail: { ...archived },
      selectedEmailKeys: new Set([emailKeyFor(archived), emailKeyFor(failed)]),
    });

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);

    expect(useEmailStore.getState().emails).toEqual([failed]);
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(failed)]);
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
      selectedEmailKeys: new Set([emailKeyFor(archived), emailKeyFor(failed)]),
      refreshCurrentMailbox: originalRefresh,
      selectedMailbox: view === 'unified' ? '__unified_inbox__' : '__cross_all__',
      unifiedRole: view === 'unified' ? 'inbox' : null,
      crossView: view === 'cross-account' ? 'all' : null,
    });

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);

    expect(loader).toHaveBeenCalledOnce();
    expect(useEmailStore.getState().emails).toEqual([failed]);
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(failed)]);
    expect(useEmailStore.getState().selectedEmail).toBe(viewer);
    expect(useEmailStore.getState().error).toMatch(/archive mailbox not found/i);
  });

  it('does not fall back to the active client for a disconnected stamped owner', async () => {
    useEmailStore.setState({
      emails: [email('primary-email', 'primary'), email('shared-email', 'shared', 'disconnected')],
      selectedEmailKeys: new Set([emailKeyFor(email('primary-email', 'primary')), emailKeyFor(email('shared-email', 'shared', 'disconnected'))]),
    });
    await expect(useEmailStore.getState().batchArchive(client)).rejects.toThrow('not connected');
    expect(client.batchArchiveEmails).toHaveBeenCalledTimes(1);
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(email('shared-email', 'shared', 'disconnected'))]);
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
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(email('shared-email', 'shared'))]);
    expect(useEmailStore.getState().error).toMatch(/archive mailbox not found/i);
    expect(useEmailStore.getState().accountMailboxes.primary).toEqual(folders.primary);
    expect(useEmailStore.getState().mailboxes.find(m => m.id === 'shared:archive')).toBeDefined();
  });

  it('leaves a read-only shared Archive untouched without blocking the primary owner', async () => {
    folders.shared[1].myRights.mayAddItems = false;
    await expect(useEmailStore.getState().batchArchive(client)).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);
    expect(client.batchArchiveEmails).toHaveBeenCalledTimes(1);
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['shared-email']);
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(email('shared-email', 'shared'))]);
  });

  it('keeps all rows and selections when no owner succeeds', async () => {
    vi.mocked(client.batchArchiveEmails).mockRejectedValue(new Error('forbidden'));
    await expect(useEmailStore.getState().batchArchive(client)).rejects.toThrow('forbidden');
    expect(useEmailStore.getState().emails).toHaveLength(2);
    expect(useEmailStore.getState().selectedEmailKeys.size).toBe(2);
    expect(refresh).not.toHaveBeenCalled();
    expect(useEmailStore.getState().isLoading).toBe(false);
  });

  it.each(['shared owner', 'different login'] as const)('archives only the selected namesake: %s', async source => {
    const untouched = email('same-email-id', 'primary');
    const selected = source === 'shared owner'
      ? email('same-email-id', 'shared') : email('same-email-id', 'primary', 'login-b');
    const otherClient = makeClient({ primary: folders.primary });
    useAuthStore.setState({
      getClientForAccount: (id: string) => (id === 'login-a' ? client : id === 'login-b' ? otherClient : undefined) as never,
    });
    useEmailStore.setState({
      emails: [untouched, selected], selectedEmail: untouched,
      selectedEmailKeys: new Set([emailKeyFor(selected)]),
      threadEmailsCache: new Map([[threadKeyFor(untouched), [untouched]], [threadKeyFor(selected), [selected]]]),
      expandedThreadIds: new Set([threadKeyFor(untouched), threadKeyFor(selected)]),
    });

    expect(await useEmailStore.getState().batchArchive(client)).toBe(true);

    const actionClient = source === 'shared owner' ? client : otherClient;
    expect(actionClient.batchArchiveEmails).toHaveBeenCalledExactlyOnceWith(
      [{ id: selected.id, receivedAt: selected.receivedAt }],
      source === 'shared owner' ? 'archive' : 'primary-archive', 'single', expect.any(Array), selected.sourceAccountId,
    );
    if (source === 'different login') expect(client.batchArchiveEmails).not.toHaveBeenCalled();
    const state = useEmailStore.getState();
    expect(state.emails).toEqual([untouched]);
    expect(state.selectedEmail).toBe(untouched);
    expect(state.selectedEmailKeys.size).toBe(0);
    expect([...state.threadEmailsCache]).toEqual([[threadKeyFor(untouched), [untouched]]]);
    expect([...state.expandedThreadIds]).toEqual([threadKeyFor(untouched)]);
  });

  it('archives a selected expanded-thread member without archiving its unselected row', async () => {
    const row = email('row', 'shared');
    const member = { ...email('member', 'shared'), threadId: row.threadId };
    useEmailStore.setState({
      emails: [row], selectedEmail: member,
      selectedEmailKeys: new Set([emailKeyFor(member)]),
      threadEmailsCache: new Map([[threadKeyFor(row), [row, member]]]),
      expandedThreadIds: new Set([threadKeyFor(row)]),
    });

    await useEmailStore.getState().batchArchive(client);

    expect(client.batchArchiveEmails).toHaveBeenCalledExactlyOnceWith(
      [{ id: member.id, receivedAt: member.receivedAt }], 'archive', 'single', expect.any(Array), 'shared',
    );
    const state = useEmailStore.getState();
    expect(state.emails).toEqual([row]);
    expect(state.selectedEmail).toBeNull();
    expect(state.selectedEmailKeys.size).toBe(0);
    expect(state.threadEmailsCache.get(threadKeyFor(row))).toEqual([row]);
    expect(state.expandedThreadIds.has(threadKeyFor(row))).toBe(true);
  });

  it('retains a failed expanded-thread member through refresh without adding it as a list row', async () => {
    const archived = email('accepted', 'primary');
    const row = email('row', 'shared');
    const member = { ...email('member', 'shared'), threadId: row.threadId, keywords: { $pinned: true } };
    folders.shared = [mailbox('shared', 'inbox', true)];
    useEmailStore.setState({
      emails: [archived, row], selectedEmail: member,
      selectedEmailKeys: new Set([emailKeyFor(archived), emailKeyFor(member)]),
      threadEmailsCache: new Map([[threadKeyFor(row), [row, member]]]),
      expandedThreadIds: new Set([threadKeyFor(row)]),
      refreshCurrentMailbox: vi.fn(async () => {
        useEmailStore.setState({ emails: [row], threadEmailsCache: new Map() });
      }),
    });

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);

    const state = useEmailStore.getState();
    expect(state.emails).toEqual([row]);
    expect([...state.selectedEmailKeys]).toEqual([emailKeyFor(member)]);
    expect(state.selectedEmail).toBe(member);
    expect(state.threadEmailsCache.get(threadKeyFor(row))).toEqual([row, member]);
    expect(state.expandedThreadIds.has(threadKeyFor(row))).toBe(true);
  });

  it.each(['folder creation', 'archive move'] as const)('keeps plugin cancellation and confirmed notifications per owner: %s', async veto => {
    const before = vi.fn(({ emailIds }: { emailIds: string[] }) => !emailIds.includes('shared-email'));
    const after = vi.fn();
    emailHooks.onEmailArchive.register('test', after);
    if (veto === 'folder creation') {
      folders.shared = [mailbox('shared', 'inbox', true)];
      emailHooks.onBeforeMailboxCreate.register('test', () => false);
    } else emailHooks.onBeforeEmailArchive.register('test', before);

    expect(await useEmailStore.getState().batchArchive(client)).toBe(false);

    expect(client.batchArchiveEmails).toHaveBeenCalledTimes(1);
    expect(client.createMailbox).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['shared-email']);
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(email('shared-email', 'shared'))]);
    expect(after).toHaveBeenCalledExactlyOnceWith({ emailIds: ['primary-email'] });
    expect(useEmailStore.getState().error).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('notifies plugins only of confirmed messages after a partial Email/set failure', async () => {
    const accepted = email('accepted', 'primary');
    const refused = email('refused', 'primary');
    useEmailStore.setState({ emails: [accepted, refused], selectedEmailKeys: new Set([emailKeyFor(accepted), emailKeyFor(refused)]) });
    const after = vi.fn();
    emailHooks.onEmailArchive.register('test', after);
    vi.mocked(client.batchArchiveEmails).mockRejectedValue(new ArchiveEmailsError('forbidden', [accepted.id, 'unrequested-id']));

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toThrow('forbidden');

    expect(after).toHaveBeenCalledExactlyOnceWith({ emailIds: [accepted.id] });
    expect(useEmailStore.getState().emails).toEqual([refused]);
  });

  it('preserves other owners in the viewed login cache when refreshing a successful owner', async () => {
    const other = mailbox('other', 'inbox', true);
    const merged = [...folders.primary, ...folders.shared, other];
    useEmailStore.setState({
      emails: [email('shared-email', 'shared')],
      selectedEmailKeys: new Set([emailKeyFor(email('shared-email', 'shared'))]),
      viewingAccountId: 'login-a', accountMailboxes: { 'login-a': merged },
    });

    await useEmailStore.getState().batchArchive(client);

    expect(useEmailStore.getState().accountMailboxes['login-a']).toEqual([
      ...folders.primary, other, ...folders.shared,
    ]);
  });

});
