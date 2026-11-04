import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import { emailKeyFor } from '@/lib/thread-utils';
import { SEARCH_SCOPE_ALL_FOLDERS } from '@/lib/search-scope-folders';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// The organize hooks (delete, move, archive, spam, read, star, keywords) fire
// from the store actions every button, menu and shortcut goes through.

function makeMailbox(overrides: Partial<Mailbox>): Mailbox {
  return {
    id: 'inbox',
    name: 'Inbox',
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    isSubscribed: true,
    isShared: false,
    ...overrides,
  } as Mailbox;
}

function makeEmail(id: string, overrides: Partial<Email> = {}): Email {
  return {
    id,
    threadId: `t-${id}`,
    subject: id,
    receivedAt: '2026-01-01T00:00:00Z',
    keywords: { $seen: true },
    mailboxIds: { inbox: true },
    ...overrides,
  } as Email;
}

const mailboxes = [
  makeMailbox({ id: 'inbox', role: 'inbox' }),
  makeMailbox({ id: 'custom', name: 'Projects' }),
  makeMailbox({ id: 'archive', name: 'Archive', role: 'archive' }),
  makeMailbox({ id: 'archive-2026', name: '2026', parentId: 'archive' }),
  makeMailbox({ id: 'trash', name: 'Trash', role: 'trash' }),
  makeMailbox({ id: 'junk', name: 'Junk', role: 'junk' }),
];

function makeClient(): IJMAPClient {
  return {
    getAccountId: () => 'me',
    moveToTrash: vi.fn().mockResolvedValue(undefined),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
    batchDeleteEmails: vi.fn().mockResolvedValue(undefined),
    moveEmail: vi.fn().mockResolvedValue(undefined),
    batchMoveEmails: vi.fn().mockResolvedValue(undefined),
    batchArchiveEmails: vi.fn().mockResolvedValue(undefined),
    markAsRead: vi.fn().mockResolvedValue(undefined),
    batchMarkAsRead: vi.fn().mockResolvedValue(undefined),
    toggleStar: vi.fn().mockResolvedValue(undefined),
    batchUpdateKeywords: vi.fn().mockResolvedValue(undefined),
    setKeyword: vi.fn().mockResolvedValue(undefined),
    markAsSpam: vi.fn().mockResolvedValue(undefined),
    undoSpam: vi.fn().mockResolvedValue(undefined),
    getMailboxes: vi.fn().mockResolvedValue(mailboxes),
    getAllMailboxes: vi.fn().mockResolvedValue(mailboxes),
    getEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 0 }),
    getMaxObjectsInGet: () => 500,
    getThreads: vi.fn().mockResolvedValue([]),
  } as unknown as IJMAPClient;
}

let client: IJMAPClient;

function openFolder(folderId: string, emails: Email[]) {
  useEmailStore.setState({
    mailboxes,
    accountMailboxes: {},
    viewingAccountId: null,
    selectedMailbox: folderId,
    selectedKeyword: null,
    isUnifiedView: false,
    unifiedRole: null,
    crossView: null,
    searchQuery: '',
    searchMailboxId: folderId,
    emails,
    selectedEmail: null,
    selectedEmailKeys: new Set(),
    threadEmailsCache: new Map(),
    processingReadStatus: new Set(),
    error: null,
  });
}

beforeEach(() => {
  clearAllHooks();
  client = makeClient();
  useAuthStore.setState({
    activeAccountId: 'acct',
    getClientForAccount: () => client as never,
  } as never);
  useSettingsStore.setState({ deleteAction: 'trash', permanentlyDeleteJunk: false, archiveMode: 'single' } as never);
});

afterEach(() => clearAllHooks());

describe('delete hooks', () => {
  it('asks before moving to Trash and reports a non-permanent delete', async () => {
    openFolder('inbox', [makeEmail('e1')]);
    const order: string[] = [];
    const before = vi.fn(() => { order.push('before'); return true; });
    vi.mocked(client.moveToTrash).mockImplementation(async () => { order.push('server'); });
    const after = vi.fn();
    emailHooks.onBeforeEmailDelete.register('t', before);
    emailHooks.onAfterEmailDelete.register('t', after);

    expect(await useEmailStore.getState().deleteEmail(client, 'e1')).toBe(true);

    expect(before).toHaveBeenCalledWith({ emailIds: ['e1'], permanent: false });
    expect(order).toEqual(['before', 'server']);
    expect(after).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith({ emailIds: ['e1'], permanent: false });
  });

  it('reports permanent when the message is destroyed', async () => {
    openFolder('inbox', [makeEmail('e1')]);
    const after = vi.fn();
    emailHooks.onAfterEmailDelete.register('t', after);

    expect(await useEmailStore.getState().deleteEmail(client, 'e1', true)).toBe(true);

    expect(client.deleteEmail).toHaveBeenCalled();
    expect(after).toHaveBeenCalledWith({ emailIds: ['e1'], permanent: true });
  });

  it('stops when a plugin says no', async () => {
    openFolder('inbox', [makeEmail('e1')]);
    const after = vi.fn();
    emailHooks.onBeforeEmailDelete.register('t', () => false);
    emailHooks.onAfterEmailDelete.register('t', after);

    expect(await useEmailStore.getState().deleteEmail(client, 'e1')).toBe(false);

    expect(client.moveToTrash).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['e1']);
    expect(after).not.toHaveBeenCalled();
  });

  it('does not report a delete the server refused', async () => {
    openFolder('inbox', [makeEmail('e1')]);
    vi.mocked(client.moveToTrash).mockRejectedValue(new Error('nope'));
    const after = vi.fn();
    emailHooks.onAfterEmailDelete.register('t', after);

    await expect(useEmailStore.getState().deleteEmail(client, 'e1')).rejects.toThrow('nope');
    expect(after).not.toHaveBeenCalled();
  });

  it('batch delete in Trash is permanent', async () => {
    const a = makeEmail('a', { mailboxIds: { trash: true } });
    const b = makeEmail('b', { mailboxIds: { trash: true } });
    openFolder('trash', [a, b]);
    useEmailStore.setState({ selectedEmailKeys: new Set([emailKeyFor(a), emailKeyFor(b)]) });
    const before = vi.fn(() => true);
    const after = vi.fn();
    emailHooks.onBeforeEmailDelete.register('t', before);
    emailHooks.onAfterEmailDelete.register('t', after);

    await useEmailStore.getState().batchDelete(client);

    expect(before).toHaveBeenCalledWith({ emailIds: ['a', 'b'], permanent: true });
    expect(after).toHaveBeenCalledWith({ emailIds: ['a', 'b'], permanent: true });
  });
});

describe('move and archive hooks', () => {
  it('asks before a move and reports it with source and destination', async () => {
    openFolder('inbox', [makeEmail('e1')]);
    const before = vi.fn(() => true);
    const after = vi.fn();
    const archived = vi.fn();
    emailHooks.onBeforeEmailMove.register('t', before);
    emailHooks.onAfterEmailMove.register('t', after);
    emailHooks.onEmailArchive.register('t', archived);

    expect(await useEmailStore.getState().moveToMailbox(client, 'e1', 'custom')).toBe(true);

    const payload = { emailIds: ['e1'], fromMailboxId: 'inbox', toMailboxId: 'custom' };
    expect(before).toHaveBeenCalledWith(payload);
    expect(after).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith(payload);
    expect(archived).not.toHaveBeenCalled();
  });

  it('stops a move a plugin refuses', async () => {
    openFolder('inbox', [makeEmail('e1')]);
    const after = vi.fn();
    emailHooks.onBeforeEmailMove.register('t', () => false);
    emailHooks.onAfterEmailMove.register('t', after);

    expect(await useEmailStore.getState().moveToMailbox(client, 'e1', 'custom')).toBe(false);

    expect(client.moveEmail).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails).toHaveLength(1);
    expect(after).not.toHaveBeenCalled();
  });

  it('treats a move into the archive (or a sub-folder of it) as archiving', async () => {
    openFolder('inbox', [makeEmail('e1'), makeEmail('e2')]);
    const archived = vi.fn();
    emailHooks.onEmailArchive.register('t', archived);

    await useEmailStore.getState().moveToMailbox(client, 'e1', 'archive');
    await useEmailStore.getState().moveToMailbox(client, 'e2', 'archive-2026');

    expect(archived.mock.calls).toEqual([[{ emailIds: ['e1'] }], [{ emailIds: ['e2'] }]]);
  });

  it('lets onBeforeEmailArchive stop an archive', async () => {
    openFolder('inbox', [makeEmail('e1')]);
    emailHooks.onBeforeEmailArchive.register('t', () => false);

    expect(await useEmailStore.getState().moveToMailbox(client, 'e1', 'archive')).toBe(false);

    expect(client.moveEmail).not.toHaveBeenCalled();
  });

  it('reports a move out of the archive as unarchiving', async () => {
    openFolder('archive', [makeEmail('e1', { mailboxIds: { archive: true } })]);
    const archived = vi.fn();
    const unarchived = vi.fn();
    emailHooks.onEmailArchive.register('t', archived);
    emailHooks.onEmailUnarchive.register('t', unarchived);

    await useEmailStore.getState().moveToMailbox(client, 'e1', 'inbox');

    expect(unarchived).toHaveBeenCalledWith({ emailIds: ['e1'], toMailboxId: 'inbox' });
    expect(archived).not.toHaveBeenCalled();
  });

  it('reports the folder a search hit is in, not the open one (#1452)', async () => {
    openFolder('archive', [makeEmail('e1', { mailboxIds: { custom: true } })]);
    useEmailStore.setState({ searchQuery: 'invoice', searchMailboxId: SEARCH_SCOPE_ALL_FOLDERS });
    const after = vi.fn();
    const archived = vi.fn();
    emailHooks.onAfterEmailMove.register('t', after);
    emailHooks.onEmailArchive.register('t', archived);

    expect(await useEmailStore.getState().moveToMailbox(client, 'e1', 'archive')).toBe(true);

    expect(after).toHaveBeenCalledWith({ emailIds: ['e1'], fromMailboxId: 'custom', toMailboxId: 'archive' });
    expect(archived).toHaveBeenCalledWith({ emailIds: ['e1'] });
  });

  it('batch archive asks and reports once for the selection', async () => {
    const a = makeEmail('a');
    const b = makeEmail('b');
    openFolder('inbox', [a, b]);
    useEmailStore.setState({ selectedEmailKeys: new Set([emailKeyFor(a), emailKeyFor(b)]) });
    const before = vi.fn(() => true);
    const archived = vi.fn();
    emailHooks.onBeforeEmailArchive.register('t', before);
    emailHooks.onEmailArchive.register('t', archived);

    expect(await useEmailStore.getState().batchArchive(client)).toBe(true);

    expect(before).toHaveBeenCalledWith({ emailIds: ['a', 'b'] });
    expect(archived).toHaveBeenCalledTimes(1);
    expect(archived).toHaveBeenCalledWith({ emailIds: ['a', 'b'] });
  });

  it('batch move reports nothing when the server refused it', async () => {
    const a = makeEmail('a');
    openFolder('inbox', [a]);
    useEmailStore.setState({ selectedEmailKeys: new Set([emailKeyFor(a)]) });
    vi.mocked(client.batchMoveEmails).mockRejectedValue(new Error('nope'));
    const after = vi.fn();
    emailHooks.onAfterEmailMove.register('t', after);

    expect(await useEmailStore.getState().batchMoveToMailbox(client, 'custom')).toBe(false);

    expect(after).not.toHaveBeenCalled();
  });
});

describe('spam hooks', () => {
  it('asks and reports mark-as-spam', async () => {
    openFolder('inbox', [makeEmail('e1')]);
    const before = vi.fn(() => true);
    const after = vi.fn();
    emailHooks.onBeforeEmailSpamToggle.register('t', before);
    emailHooks.onEmailSpamToggle.register('t', after);

    expect(await useEmailStore.getState().markAsSpam(client, 'e1')).toBe(true);

    expect(before).toHaveBeenCalledWith({ emailIds: ['e1'], spam: true });
    expect(after).toHaveBeenCalledWith({ emailIds: ['e1'], spam: true });
  });

  it('stops mark-as-spam a plugin refuses', async () => {
    openFolder('inbox', [makeEmail('e1')]);
    emailHooks.onBeforeEmailSpamToggle.register('t', () => false);

    expect(await useEmailStore.getState().markAsSpam(client, 'e1')).toBe(false);

    expect(client.markAsSpam).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails).toHaveLength(1);
  });

  it('reports not-spam for a batch', async () => {
    const a = makeEmail('a', { mailboxIds: { junk: true } });
    const b = makeEmail('b', { mailboxIds: { junk: true } });
    openFolder('junk', [a, b]);
    const after = vi.fn();
    emailHooks.onEmailSpamToggle.register('t', after);

    expect(await useEmailStore.getState().batchUndoSpam(client, ['a', 'b'])).toBe(true);

    expect(after).toHaveBeenCalledWith({ emailIds: ['a', 'b'], spam: false });
  });
});

describe('read, star and keyword hooks', () => {
  it('asks and reports a read-state change', async () => {
    openFolder('inbox', [makeEmail('e1', { keywords: {} })]);
    const before = vi.fn(() => true);
    const after = vi.fn();
    emailHooks.onBeforeEmailReadStateChange.register('t', before);
    emailHooks.onEmailReadStateChange.register('t', after);

    expect(await useEmailStore.getState().markAsRead(client, 'e1', true)).toBe(true);

    expect(before).toHaveBeenCalledWith({ emailIds: ['e1'], read: true });
    expect(after).toHaveBeenCalledWith({ emailIds: ['e1'], read: true });
  });

  it('leaves the message unread when a plugin refuses', async () => {
    openFolder('inbox', [makeEmail('e1', { keywords: {} })]);
    emailHooks.onBeforeEmailReadStateChange.register('t', () => false);

    expect(await useEmailStore.getState().markAsRead(client, 'e1', true)).toBe(false);

    expect(client.markAsRead).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails[0].keywords.$seen).toBeUndefined();
    // A later attempt is not blocked by a stale in-progress marker.
    expect(useEmailStore.getState().processingReadStatus.size).toBe(0);
  });

  it('reports a batch read-state change', async () => {
    const a = makeEmail('a', { keywords: {} });
    openFolder('inbox', [a]);
    useEmailStore.setState({ selectedEmailKeys: new Set([emailKeyFor(a)]) });
    const after = vi.fn();
    emailHooks.onEmailReadStateChange.register('t', after);

    await useEmailStore.getState().batchMarkAsRead(client, true);

    expect(after).toHaveBeenCalledWith({ emailIds: ['a'], read: true });
  });

  it('asks and reports a star toggle', async () => {
    openFolder('inbox', [makeEmail('e1')]);
    const before = vi.fn(() => true);
    const after = vi.fn();
    emailHooks.onBeforeEmailStarToggle.register('t', before);
    emailHooks.onEmailStarToggle.register('t', after);

    expect(await useEmailStore.getState().toggleStar(client, 'e1')).toBe(true);

    expect(before).toHaveBeenCalledWith({ emailIds: ['e1'], starred: true });
    expect(after).toHaveBeenCalledWith({ emailIds: ['e1'], starred: true });
  });

  it('stars a selection in one write, asks once and reports once', async () => {
    openFolder('inbox', [makeEmail('a'), makeEmail('b', { keywords: { $seen: true, $flagged: true } }), makeEmail('c')]);
    useEmailStore.setState({ selectedEmailKeys: new Set(['a', 'b', 'c']) });
    const before = vi.fn(() => true);
    const after = vi.fn();
    emailHooks.onBeforeEmailStarToggle.register('t', before);
    emailHooks.onEmailStarToggle.register('t', after);

    expect(await useEmailStore.getState().batchSetStarred(client, true)).toBe(true);

    // b has its star already: left alone.
    expect(client.batchUpdateKeywords).toHaveBeenCalledTimes(1);
    expect(client.batchUpdateKeywords).toHaveBeenCalledWith(['a', 'c'], { 'keywords/$flagged': true }, undefined);
    expect(before).toHaveBeenCalledWith({ emailIds: ['a', 'c'], starred: true });
    expect(after).toHaveBeenCalledWith({ emailIds: ['a', 'c'], starred: true });
    expect(useEmailStore.getState().emails.every((e) => e.keywords.$flagged)).toBe(true);

    await useEmailStore.getState().batchSetStarred(client, false);
    expect(client.batchUpdateKeywords).toHaveBeenLastCalledWith(['a', 'b', 'c'], { 'keywords/$flagged': null }, undefined);
    expect(useEmailStore.getState().emails.some((e) => e.keywords.$flagged)).toBe(false);
  });

  it('writes nothing for a selection a plugin stops', async () => {
    openFolder('inbox', [makeEmail('a'), makeEmail('b')]);
    useEmailStore.setState({ selectedEmailKeys: new Set(['a', 'b']) });
    emailHooks.onBeforeEmailStarToggle.register('t', () => false);
    await useEmailStore.getState().batchSetStarred(client, true);
    expect(client.batchUpdateKeywords).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails.some((e) => e.keywords.$flagged)).toBe(false);
  });

  it('names a group mailbox\'s account on a star toggle', async () => {
    const groupInbox = makeMailbox({ id: 'vertrieb:inbox', originalId: 'inbox', role: 'inbox', isShared: true, accountId: 'vertrieb' });
    openFolder('vertrieb:inbox', [makeEmail('e1', { mailboxIds: { 'vertrieb:inbox': true } })]);
    useEmailStore.setState({ mailboxes: [...mailboxes, groupInbox] });
    const before = vi.fn(() => true);
    const after = vi.fn();
    emailHooks.onBeforeEmailStarToggle.register('t', before);
    emailHooks.onEmailStarToggle.register('t', after);

    expect(await useEmailStore.getState().toggleStar(client, 'e1')).toBe(true);

    expect(client.toggleStar).toHaveBeenCalledWith('e1', true, 'vertrieb');
    expect(before).toHaveBeenCalledWith({ emailIds: ['e1'], starred: true, accountId: 'vertrieb' });
    expect(after).toHaveBeenCalledWith({ emailIds: ['e1'], starred: true, accountId: 'vertrieb' });
  });

  it('names a stamped row\'s account only when it is not the own one', async () => {
    openFolder('inbox', [
      makeEmail('own', { sourceClientAccountId: 'acct', sourceAccountId: 'me' }),
      makeEmail('shared', { sourceClientAccountId: 'acct', sourceAccountId: 'vertrieb' }),
    ]);
    const before = vi.fn(() => true);
    const after = vi.fn();
    emailHooks.onBeforeEmailStarToggle.register('t', before);
    emailHooks.onEmailStarToggle.register('t', after);

    await useEmailStore.getState().toggleStar(client, 'own');
    await useEmailStore.getState().toggleStar(client, 'shared');

    expect(before.mock.calls).toEqual([
      [{ emailIds: ['own'], starred: true }],
      [{ emailIds: ['shared'], starred: true, accountId: 'vertrieb' }],
    ]);
    expect(after.mock.calls).toEqual([
      [{ emailIds: ['own'], starred: true }],
      [{ emailIds: ['shared'], starred: true, accountId: 'vertrieb' }],
    ]);
  });

  it('stops a star toggle a plugin refuses', async () => {
    openFolder('inbox', [makeEmail('e1')]);
    emailHooks.onBeforeEmailStarToggle.register('t', () => false);

    expect(await useEmailStore.getState().toggleStar(client, 'e1')).toBe(false);

    expect(client.toggleStar).not.toHaveBeenCalled();
  });

  it('reports added and removed keywords', async () => {
    openFolder('inbox', [makeEmail('e1', { keywords: { $seen: true, '$label:old': true } })]);
    const before = vi.fn(() => true);
    const after = vi.fn();
    emailHooks.onBeforeEmailKeywordChange.register('t', before);
    emailHooks.onEmailKeywordChange.register('t', after);

    expect(await useEmailStore.getState().setEmailKeywords(client, 'e1', { $seen: true, '$label:new': true })).toBe(true);

    const payload = { emailIds: ['e1'], added: ['$label:new'], removed: ['$label:old'] };
    expect(before).toHaveBeenCalledWith(payload);
    expect(after).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith(payload);
  });

  it('stops a keyword change a plugin refuses', async () => {
    openFolder('inbox', [makeEmail('e1')]);
    const after = vi.fn();
    emailHooks.onBeforeEmailKeywordChange.register('t', () => false);
    emailHooks.onEmailKeywordChange.register('t', after);

    expect(await useEmailStore.getState().patchEmailKeywords(client, 'e1', { '$label:x': true })).toBe(false);

    expect(client.batchUpdateKeywords).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('reports a tag put on a selection', async () => {
    const a = makeEmail('a');
    const b = makeEmail('b');
    openFolder('inbox', [a, b]);
    useEmailStore.setState({ selectedEmailKeys: new Set([emailKeyFor(a), emailKeyFor(b)]) });
    const after = vi.fn();
    emailHooks.onEmailKeywordChange.register('t', after);

    await useEmailStore.getState().batchSetTag(client, 'work', true);

    expect(after).toHaveBeenCalledWith({ emailIds: ['a', 'b'], added: ['$label:work'], removed: [] });
  });
});
