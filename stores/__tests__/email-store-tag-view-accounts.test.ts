import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';
import { useAuthStore } from '../auth-store';
import { useMessageListTabsStore } from '../message-list-tabs-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Issue #1038: the user's login also reaches group accounts (each with its own
// address and folders). Tagging is one user-level concept across all of them,
// so the sidebar tag entry must list the tagged mail of the own account AND of
// every group account - not only the account of the folder that happened to be
// selected when the tag was clicked.

const label = 'work';
const keyword = `$label:${label}`;

const ownInbox = { id: 'inbox', name: 'Inbox', role: 'inbox', isShared: false } as Mailbox;
const ownArchive = { id: 'archive', name: 'Archive', role: 'archive', isShared: false } as Mailbox;
const groupInbox = {
  id: 'group:inbox', originalId: 'inbox', name: 'Inbox', role: 'inbox',
  isShared: true, accountId: 'group', accountName: 'group@server.tld',
} as Mailbox;

function email(id: string, mailbox: string, receivedAt: string, tagged = true, seen = true): Email {
  return {
    id, threadId: `thread-${id}`, mailboxIds: { [mailbox]: true },
    keywords: { ...(tagged ? { [keyword]: true } : {}), ...(seen ? { $seen: true } : {}) },
    subject: id, receivedAt,
    from: [{ email: 'sender@example.com' }], to: [],
    preview: '', size: 1, hasAttachment: false,
  } as Email;
}

// Three tagged messages in the own account, one in the group account.
const own = [
  email('own-1', 'inbox', '2026-09-14T00:00:00Z'),
  email('own-2', 'archive', '2026-09-12T00:00:00Z'),
  email('own-3', 'inbox', '2026-09-10T00:00:00Z'),
];
const untagged = email('own-plain', 'inbox', '2026-09-15T00:00:00Z', false);
const group = [email('grp-1', 'inbox', '2026-09-13T00:00:00Z', true, false)];

function makeClient() {
  const rowsFor = (accountId?: string) => (accountId === 'group' ? group : [...own, untagged]);
  const getEmails = vi.fn<IJMAPClient['getEmails']>(async (
    mailboxId?: string, accountId?: string, limit = 50, position = 0, hasKeyword?: string,
  ) => {
    const matches = rowsFor(accountId).filter(row =>
      (!mailboxId || row.mailboxIds[mailboxId]) && (!hasKeyword || row.keywords[hasKeyword]),
    );
    return {
      emails: matches.slice(position, position + limit),
      total: matches.length,
      hasMore: position + limit < matches.length,
      state: `state-${accountId ?? 'me'}`,
    };
  });
  const getTagCounts = vi.fn<IJMAPClient['getTagCounts']>(async (_ids, accountId?: string) =>
    accountId === 'group'
      ? { [label]: { total: 1, unread: 1 } }
      : { [label]: { total: 3, unread: 0 } });
  const client = {
    getEmails,
    getTagCounts,
    getThreads: vi.fn(async () => []),
    batchMarkAsRead: vi.fn(async () => undefined),
    getAccountId: () => 'me',
  } as unknown as IJMAPClient & {
    getEmails: typeof getEmails;
    getTagCounts: typeof getTagCounts;
    batchMarkAsRead: ReturnType<typeof vi.fn>;
  };
  return client;
}

describe('tag view across the own and group accounts (#1038)', () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
    useAuthStore.setState({
      activeAccountId: 'login',
      getClientForAccount: ((id: string) => (id === 'login' ? client : undefined)) as never,
      getAllConnectedClients: (() => new Map([['login', client]])) as never,
    } as never);
    useMessageListTabsStore.setState(useMessageListTabsStore.getInitialState());
    useSettingsStore.setState({
      emailsPerPage: 50, messageListOrder: [], messageListOrderScope: 'inbox',
      emailKeywords: [{ id: label, label: 'Work', color: 'blue' }],
    } as never);
    useEmailStore.setState({
      ...useEmailStore.getInitialState(),
      mailboxes: [ownInbox, ownArchive, groupInbox],
    });
  });

  it('lists the tagged mail of every account while a group folder is selected', async () => {
    useEmailStore.setState({ selectedMailbox: groupInbox.id });
    useEmailStore.getState().selectKeyword(label);

    await useEmailStore.getState().fetchEmails(client);

    const state = useEmailStore.getState();
    expect(state.emails.map(e => e.id)).toEqual(['own-1', 'grp-1', 'own-2', 'own-3']);
    expect(state.totalEmails).toBe(4);
    expect(state.hasMoreEmails).toBe(false);
    expect(state.emailListSync).toBeNull();
    // One keyword query per account, none constrained to a folder.
    expect(client.getEmails).toHaveBeenCalledWith(undefined, undefined, 50, 0, keyword, true, undefined, []);
    expect(client.getEmails).toHaveBeenCalledWith(undefined, 'group', 50, 0, keyword, true, undefined, []);
  });

  it('lists the same set while an own folder is selected', async () => {
    useEmailStore.setState({ selectedMailbox: ownInbox.id });
    useEmailStore.getState().selectKeyword(label);

    await useEmailStore.getState().fetchEmails(client);

    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['own-1', 'grp-1', 'own-2', 'own-3']);
  });

  it('stamps every row with its owning account so actions route back to it', async () => {
    useEmailStore.setState({ selectedMailbox: groupInbox.id });
    useEmailStore.getState().selectKeyword(label);
    await useEmailStore.getState().fetchEmails(client);

    const byId = Object.fromEntries(useEmailStore.getState().emails.map(e => [e.id, e]));
    expect(byId['own-1']).toMatchObject({ sourceClientAccountId: 'login', sourceAccountId: 'me', sourceFolder: 'Inbox' });
    expect(byId['own-2']).toMatchObject({ sourceAccountId: 'me', sourceFolder: 'Archive' });
    expect(byId['grp-1']).toMatchObject({
      sourceClientAccountId: 'login', sourceAccountId: 'group', accountLabel: 'group@server.tld',
    });
  });

  it('marks a mixed selection read in each owning account', async () => {
    useEmailStore.setState({ selectedMailbox: groupInbox.id });
    useEmailStore.getState().selectKeyword(label);
    await useEmailStore.getState().fetchEmails(client);
    useEmailStore.setState({ selectedEmailIds: new Set(['own-1', 'grp-1']) });

    await useEmailStore.getState().batchMarkAsRead(client, true);

    expect(client.batchMarkAsRead).toHaveBeenCalledWith(['own-1'], true, 'me');
    expect(client.batchMarkAsRead).toHaveBeenCalledWith(['grp-1'], true, 'group');
  });

  it('paginates the fan-out from the loaded position in every account', async () => {
    useSettingsStore.setState({ emailsPerPage: 2 } as never);
    useEmailStore.setState({ selectedMailbox: groupInbox.id });
    useEmailStore.getState().selectKeyword(label);
    await useEmailStore.getState().fetchEmails(client);
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['own-1', 'grp-1', 'own-2']);
    expect(useEmailStore.getState().hasMoreEmails).toBe(true);

    await useEmailStore.getState().loadMoreEmails(client);

    // Each account continues after its own rows, not at the merged length.
    expect(client.getEmails).toHaveBeenCalledWith(undefined, undefined, 2, 2, keyword, true, undefined, []);
    expect(client.getEmails).toHaveBeenCalledWith(undefined, 'group', 2, 1, keyword, true, undefined, []);
    expect(useEmailStore.getState().hasMoreEmails).toBe(false);
  });

  it('refreshes the fan-out when a push reports a change in the group account only', async () => {
    useEmailStore.setState({ selectedMailbox: ownInbox.id });
    useEmailStore.getState().selectKeyword(label);
    await useEmailStore.getState().fetchEmails(client);
    client.getEmails.mockClear();

    await useEmailStore.getState().handleStateChange({
      '@type': 'StateChange', changed: { group: { Email: '2' } },
    }, client);

    expect(client.getEmails).toHaveBeenCalledWith(undefined, undefined, 50, 0, keyword, true, undefined, []);
    expect(client.getEmails).toHaveBeenCalledWith(undefined, 'group', 50, 0, keyword, true, undefined, []);
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['own-1', 'grp-1', 'own-2', 'own-3']);
  });

  it('sums the sidebar tag badge over every account', async () => {
    await useEmailStore.getState().fetchTagCounts(client);

    expect(client.getTagCounts).toHaveBeenCalledWith([label], undefined);
    expect(client.getTagCounts).toHaveBeenCalledWith([label], 'group');
    expect(useEmailStore.getState().tagCounts[label]).toEqual({ total: 4, unread: 1 });
  });

  it('still lists only the selected folder when no tag is selected', async () => {
    useEmailStore.setState({ selectedMailbox: groupInbox.id });
    await useEmailStore.getState().fetchEmails(client);

    expect(client.getEmails).toHaveBeenCalledTimes(1);
    expect(client.getEmails).toHaveBeenCalledWith('inbox', 'group', 50, 0, undefined, true, undefined, []);
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['grp-1']);
  });
});
