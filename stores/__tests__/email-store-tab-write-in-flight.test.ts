import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore, type EmailActionSource } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// A Pro message tab acts on an own message while the Mail tab lists the own
// Inbox (the row there is the same message). The request is still on its way
// when the user opens the team mailbox's Inbox in the Mail tab, which lists a
// message with the same id. When the request comes back, only a row that is
// the same message may follow it: the team's row is another message.

const OWN = 'own-acct';
const GROUP = 'group-acct';
const LOGIN = 'user@server';
const ID = 'eaaaaab';

function makeMailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: 'a', name: 'Inbox', sortOrder: 0, totalEmails: 1, unreadEmails: 1, totalThreads: 1, unreadThreads: 1,
    myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true },
    isSubscribed: true, isShared: false, ...overrides,
  } as Mailbox;
}

const makeEmail = (overrides: Partial<Email> = {}): Email => ({ id: ID, threadId: 'b', subject: 'x', receivedAt: new Date().toISOString(), keywords: {}, mailboxIds: {}, ...overrides } as Email);

const ownMailboxes = [
  makeMailbox({ id: 'a', role: 'inbox', accountId: OWN }),
  makeMailbox({ id: 'b', name: 'Deleted Items', role: 'trash', accountId: OWN }),
];
const groupMailboxes = [
  makeMailbox({ id: `${GROUP}:a`, originalId: 'a', name: 'Team Inbox', role: 'inbox', isShared: true, accountId: GROUP }),
  makeMailbox({ id: `${GROUP}:b`, originalId: 'b', name: 'Deleted Items', role: 'trash', isShared: true, accountId: GROUP }),
];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('a write from a Pro message tab that is still on its way when the Mail tab opens another account\'s folder', () => {
  let gate: ReturnType<typeof deferred>;
  let client: IJMAPClient & Record<'markAsRead' | 'toggleStar' | 'moveToTrash' | 'batchUpdateKeywords', ReturnType<typeof vi.fn>>;
  const ownRow = makeEmail({ subject: 'own message', mailboxIds: { a: true } });
  const source: EmailActionSource = { clientAccountId: LOGIN, accountId: OWN, email: ownRow };

  /** The user opens the team's Inbox in the Mail tab: its row has the same id. */
  const openTeamInbox = () => useEmailStore.setState({
    selectedMailbox: `${GROUP}:a`,
    emails: [makeEmail({ subject: 'group message', mailboxIds: { [`${GROUP}:a`]: true } })],
    selectedEmail: null,
  } as never);

  beforeEach(() => {
    gate = deferred();
    const held = () => vi.fn(() => gate.promise);
    client = {
      getAccountId: () => OWN,
      getServerUrl: () => 'https://one.example',
      markAsRead: held(), toggleStar: held(), moveToTrash: held(), batchUpdateKeywords: held(),
      getEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 0 }),
      getMailboxes: vi.fn().mockResolvedValue([]),
    } as never;
    useAuthStore.setState({
      activeAccountId: LOGIN, client,
      getClientForAccount: (id: string) => (id === LOGIN ? client : undefined) as never,
      getAllConnectedClients: () => new Map([[LOGIN, client]]) as never,
    } as never);
    useSettingsStore.setState({ deleteAction: 'trash', permanentlyDeleteJunk: false } as never);
    useEmailStore.setState({
      isUnifiedView: false, unifiedRole: null, viewingAccountId: null,
      selectedMailbox: 'a',
      mailboxes: [...ownMailboxes, ...groupMailboxes], accountMailboxes: {},
      processingReadStatus: new Set(), selectedEmail: null,
      emails: [ownRow], selectedEmailKeys: new Set(),
      threadEmailsCache: new Map(),
    } as never);
  });

  it('Mark read leaves the team row unread', async () => {
    const pending = useEmailStore.getState().markAsRead(client, ID, true, undefined, source);
    await Promise.resolve();
    openTeamInbox();
    gate.resolve();
    await pending;
    expect(client.markAsRead).toHaveBeenCalledWith(ID, true, undefined);
    const listed = useEmailStore.getState().emails;
    expect(listed.map((e) => e.subject)).toEqual(['group message']);
    expect(listed[0].keywords?.$seen ?? false).toBe(false);
    // The team Inbox's unread counter is the team's, not this message's.
    expect(useEmailStore.getState().mailboxes.find((m) => m.id === `${GROUP}:a`)?.unreadEmails).toBe(1);
  });

  it('Star leaves the team row unflagged', async () => {
    const pending = useEmailStore.getState().toggleStar(client, ID, undefined, source);
    await Promise.resolve();
    openTeamInbox();
    gate.resolve();
    await pending;
    expect(useEmailStore.getState().emails[0].keywords?.$flagged ?? false).toBe(false);
  });

  it('Delete leaves the team row listed', async () => {
    const pending = useEmailStore.getState().deleteEmail(client, ID, false, undefined, source);
    await Promise.resolve();
    await Promise.resolve();
    openTeamInbox();
    gate.resolve();
    await pending;
    expect(client.moveToTrash).toHaveBeenCalledWith(ID, 'b', undefined, false);
    expect(useEmailStore.getState().emails.map((e) => e.subject)).toEqual(['group message']);
  });

  it('a tag leaves the team row untagged', async () => {
    const pending = useEmailStore.getState().patchEmailKeywords(client, ID, { '$label:red': true }, undefined, source);
    await Promise.resolve();
    openTeamInbox();
    gate.resolve();
    await pending;
    expect(useEmailStore.getState().emails[0].keywords?.['$label:red'] ?? false).toBe(false);
  });
});
