import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore, type EmailActionSource } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { emailKeyFor } from '@/lib/thread-utils';
import { stampProSource } from '@/components/pro/pro-email-tab-body';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// A Pro message tab holds a message of the active login's OWN account. The
// Mail tab meanwhile lists another account's folder that holds a message with
// the same JMAP id. The tab's actions call the store the way
// components/pro/pro-email-tab-body.tsx does: (client, email.id, ...,
// emailKeyFor(email), source), where the source is the login and JMAP account
// the tab read the message from.

const OWN = 'own-acct';        // primary JMAP account of the login
const GROUP = 'group-acct';    // group mailbox reached through the same login
const LOGIN = 'user@server';
const OTHER_LOGIN = 'other@elsewhere';
const ID = 'eaaaaab';

function makeMailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: 'a', name: 'Inbox', sortOrder: 0, totalEmails: 1, unreadEmails: 1, totalThreads: 1, unreadThreads: 1,
    myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true },
    isSubscribed: true, isShared: false, ...overrides,
  } as Mailbox;
}

function makeEmail(overrides: Partial<Email> = {}): Email {
  return { id: ID, threadId: 'b', subject: 'x', receivedAt: new Date().toISOString(), keywords: {}, mailboxIds: {}, ...overrides } as Email;
}

function makeClient(accountId: string, serverUrl = 'https://one.example') {
  return {
    getAccountId: () => accountId,
    getServerUrl: () => serverUrl,
    markAsRead: vi.fn().mockResolvedValue(undefined),
    toggleStar: vi.fn().mockResolvedValue(undefined),
    moveEmail: vi.fn().mockResolvedValue(undefined),
    moveToTrash: vi.fn().mockResolvedValue(undefined),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
    getEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 0 }),
    getMailboxes: vi.fn().mockResolvedValue([]),
  } as unknown as IJMAPClient & Record<'markAsRead' | 'toggleStar' | 'moveEmail' | 'moveToTrash' | 'deleteEmail', ReturnType<typeof vi.fn>>;
}

const ownMailboxes = [
  makeMailbox({ id: 'a', role: 'inbox', accountId: OWN }),
  makeMailbox({ id: 'b', name: 'Deleted Items', role: 'trash', accountId: OWN }),
  makeMailbox({ id: 'f', name: 'Archive', role: 'archive', accountId: OWN }),
];
const groupMailboxes = [
  makeMailbox({ id: `${GROUP}:a`, originalId: 'a', name: 'Team Inbox', role: 'inbox', isShared: true, accountId: GROUP }),
  makeMailbox({ id: `${GROUP}:b`, originalId: 'b', name: 'Deleted Items', role: 'trash', isShared: true, accountId: GROUP }),
  makeMailbox({ id: `${GROUP}:f`, originalId: 'f', name: 'Projects', isShared: true, accountId: GROUP }),
];

/** What the tab passes: the login and account it read the message from, and the message. */
const sourceOf = (email: Email): EmailActionSource => ({ clientAccountId: LOGIN, accountId: OWN, email });

describe('Pro message tab of an own message while another account\'s folder is listed', () => {
  let client: ReturnType<typeof makeClient>;
  let otherClient: ReturnType<typeof makeClient>;
  /** The message as the tab holds it: read from the own account, stamped by the tab's own helper. */
  let tabEmail: Email;

  beforeEach(() => {
    client = makeClient(OWN);
    otherClient = makeClient('other-acct', 'https://two.example');
    useAuthStore.setState({
      activeAccountId: LOGIN,
      client,
      getClientForAccount: (id: string) => (id === LOGIN ? client : id === OTHER_LOGIN ? otherClient : undefined) as never,
      getAllConnectedClients: () => new Map([[LOGIN, client], [OTHER_LOGIN, otherClient]]) as never,
    } as never);
    useSettingsStore.setState({ deleteAction: 'trash', permanentlyDeleteJunk: false } as never);

    // The group mailbox's Inbox is open in the Mail tab (the "Shared" sidebar
    // section, not a unified view). Its rows are unstamped.
    useEmailStore.setState({
      isUnifiedView: false,
      unifiedRole: null,
      viewingAccountId: null,
      selectedMailbox: `${GROUP}:a`,
      mailboxes: [...ownMailboxes, ...groupMailboxes],
      accountMailboxes: {},
      processingReadStatus: new Set(),
      selectedEmail: null,
      emails: [makeEmail({ subject: 'group message', mailboxIds: { [`${GROUP}:a`]: true } })],
      selectedEmailKeys: new Set(),
    } as never);

    // ProEmailTabBody for a row double-clicked in the own Inbox:
    // client = the login's client, accountId = its own account.
    const loaded = makeEmail({ subject: 'own message', mailboxIds: { a: true } });
    tabEmail = stampProSource(loaded, { client, accountId: OWN }, LOGIN);
  });

  it('the tab stamps an own message of the active login with its login and account', () => {
    expect(tabEmail).toMatchObject({ sourceClientAccountId: LOGIN, sourceAccountId: OWN });
    // So its key is not the bare id the group's unstamped row has.
    expect(emailKeyFor(tabEmail)).not.toBe(ID);
  });

  it('Delete does not move the group mailbox\'s same-id message to Trash', async () => {
    expect(await useEmailStore.getState().deleteEmail(client, tabEmail.id, false, emailKeyFor(tabEmail), sourceOf(tabEmail))).toBe(true);
    expect(client.moveToTrash).toHaveBeenCalledTimes(1);
    for (const call of client.moveToTrash.mock.calls) {
      expect(call[2]).not.toBe(GROUP);
      // The own Trash.
      expect(call[1]).toBe('b');
    }
    // The group row is still listed.
    expect(useEmailStore.getState().emails.map((e) => e.subject)).toContain('group message');
  });

  it('Delete forever (own message in Trash) does not destroy the group mailbox\'s same-id message', async () => {
    await useEmailStore.getState().deleteEmail(client, tabEmail.id, true, emailKeyFor(tabEmail), sourceOf(tabEmail));
    expect(client.deleteEmail).toHaveBeenCalledTimes(1);
    for (const call of client.deleteEmail.mock.calls) {
      expect(call[1]).not.toBe(GROUP);
    }
    expect(useEmailStore.getState().emails.map((e) => e.subject)).toContain('group message');
  });

  it('the "Delete permanently" setting destroys the own message, not the group one', async () => {
    useSettingsStore.setState({ deleteAction: 'permanent' } as never);
    await useEmailStore.getState().deleteEmail(client, tabEmail.id, false, emailKeyFor(tabEmail), sourceOf(tabEmail));
    expect(client.deleteEmail).toHaveBeenCalledTimes(1);
    expect(client.deleteEmail.mock.calls[0][1]).not.toBe(GROUP);
    expect(client.moveToTrash).not.toHaveBeenCalled();
  });

  it('Star does not flag the group mailbox\'s same-id message', async () => {
    await useEmailStore.getState().toggleStar(client, tabEmail.id, emailKeyFor(tabEmail), sourceOf(tabEmail));
    expect(client.toggleStar).toHaveBeenCalledTimes(1);
    for (const call of client.toggleStar.mock.calls) {
      expect(call[2]).not.toBe(GROUP);
    }
    expect(useEmailStore.getState().emails[0].keywords?.$flagged).toBeFalsy();
  });

  it('Mark read (also sent automatically when the tab opens) does not touch the group message', async () => {
    await useEmailStore.getState().markAsRead(client, tabEmail.id, true, undefined, sourceOf(tabEmail));
    expect(client.markAsRead).toHaveBeenCalledTimes(1);
    for (const call of client.markAsRead.mock.calls) {
      expect(call[2]).not.toBe(GROUP);
    }
    expect(useEmailStore.getState().emails[0].keywords?.$seen).toBeFalsy();
  });

  it('Mark unread does not touch the group message', async () => {
    const read = { ...tabEmail, keywords: { $seen: true } };
    await useEmailStore.getState().markAsRead(client, read.id, false, undefined, sourceOf(read));
    expect(client.markAsRead).toHaveBeenCalledTimes(1);
    expect(client.markAsRead.mock.calls[0][2]).not.toBe(GROUP);
  });

  it('Move (to the own Archive) does not move the group message', async () => {
    await useEmailStore.getState().moveToMailbox(client, tabEmail.id, 'f', emailKeyFor(tabEmail), sourceOf(tabEmail));
    expect(client.moveEmail).toHaveBeenCalledTimes(1);
    for (const call of client.moveEmail.mock.calls) {
      expect(call[2]).not.toBe(GROUP);
    }
    expect(useEmailStore.getState().emails.map((e) => e.subject)).toContain('group message');
  });

  it('Move to a folder of another account is refused, even when its bare id exists in the own account', async () => {
    await expect(useEmailStore.getState().moveToMailbox(client, tabEmail.id, `${GROUP}:f`, emailKeyFor(tabEmail), sourceOf(tabEmail)))
      .rejects.toThrow();
    expect(client.moveEmail).not.toHaveBeenCalled();
  });

  it('with another LOGIN\'s folder listed, Delete does not go to that login\'s server', async () => {
    useEmailStore.setState({
      viewingAccountId: OTHER_LOGIN,
      selectedMailbox: 'a',
      accountMailboxes: {
        [OTHER_LOGIN]: [
          makeMailbox({ id: 'a', role: 'inbox', accountId: 'other-acct' }),
          makeMailbox({ id: 'b', role: 'trash', accountId: 'other-acct' }),
        ],
      },
      emails: [makeEmail({ subject: 'other login message', mailboxIds: { a: true } })],
    } as never);
    await useEmailStore.getState().deleteEmail(client, tabEmail.id, false, emailKeyFor(tabEmail), sourceOf(tabEmail));
    expect(otherClient.moveToTrash).not.toHaveBeenCalled();
    expect(otherClient.deleteEmail).not.toHaveBeenCalled();
    expect(client.moveToTrash).toHaveBeenCalledTimes(1);
    expect(useEmailStore.getState().emails.map((e) => e.subject)).toEqual(['other login message']);
  });

  it('a login without a client is refused, never written through another one', async () => {
    // A message the tab read through a third login, which has no client now.
    const gone: EmailActionSource = { clientAccountId: 'gone@server', email: tabEmail };
    await expect(useEmailStore.getState().deleteEmail(client, tabEmail.id, false, emailKeyFor(tabEmail), gone))
      .rejects.toThrow('Not connected');
    await expect(useEmailStore.getState().markAsRead(client, tabEmail.id, true, undefined, gone)).rejects.toThrow('Not connected');
    await expect(useEmailStore.getState().toggleStar(client, tabEmail.id, emailKeyFor(tabEmail), gone)).rejects.toThrow('Not connected');
    await expect(useEmailStore.getState().moveToMailbox(client, tabEmail.id, 'f', emailKeyFor(tabEmail), gone)).rejects.toThrow('Not connected');
    for (const c of [client, otherClient]) {
      expect(c.moveToTrash).not.toHaveBeenCalled();
      expect(c.markAsRead).not.toHaveBeenCalled();
      expect(c.toggleStar).not.toHaveBeenCalled();
      expect(c.moveEmail).not.toHaveBeenCalled();
    }
  });
});

describe('Pro message tab: the list row that is the same message', () => {
  let client: ReturnType<typeof makeClient>;
  let tabEmail: Email;

  beforeEach(() => {
    client = makeClient(OWN);
    useAuthStore.setState({
      activeAccountId: LOGIN,
      client,
      getClientForAccount: (id: string) => (id === LOGIN ? client : undefined) as never,
      getAllConnectedClients: () => new Map([[LOGIN, client]]) as never,
    } as never);
    useSettingsStore.setState({ deleteAction: 'trash', permanentlyDeleteJunk: false } as never);
    useEmailStore.setState({
      isUnifiedView: false, unifiedRole: null, viewingAccountId: null,
      selectedMailbox: `${GROUP}:a`,
      mailboxes: [...ownMailboxes, ...groupMailboxes],
      accountMailboxes: {}, processingReadStatus: new Set(), selectedEmail: null, selectedEmailKeys: new Set(),
      emails: [makeEmail({ id: 'eaaaaac', subject: 'other id', mailboxIds: { [`${GROUP}:a`]: true } })],
    } as never);
    tabEmail = stampProSource(makeEmail({ subject: 'own message', mailboxIds: { a: true } }), { client, accountId: OWN }, LOGIN);
  });

  it('works when the message is not in the list', async () => {
    const done = await useEmailStore.getState().deleteEmail(client, tabEmail.id, false, emailKeyFor(tabEmail), sourceOf(tabEmail));
    expect(done).toBe(true);
    expect(client.moveToTrash).toHaveBeenCalledWith(ID, 'b', undefined, false);
    expect(useEmailStore.getState().emails.map((e) => e.subject)).toEqual(['other id']);
  });

  it('a stamped namesake row (unified view) is left alone', async () => {
    useEmailStore.setState({
      isUnifiedView: true, unifiedRole: 'inbox', selectedMailbox: null,
      emails: [makeEmail({ subject: 'group message', mailboxIds: { a: true }, sourceClientAccountId: LOGIN, sourceAccountId: GROUP })],
    } as never);
    const done = await useEmailStore.getState().deleteEmail(client, tabEmail.id, false, emailKeyFor(tabEmail), sourceOf(tabEmail));
    expect(done).toBe(true);
    expect(client.moveToTrash.mock.calls[0][2]).not.toBe(GROUP);
    expect(useEmailStore.getState().emails.map((e) => e.subject)).toEqual(['group message']);
  });

  it('unified view: Mark read from the tab does not touch a stamped group namesake', async () => {
    useEmailStore.setState({
      isUnifiedView: true, unifiedRole: 'inbox', selectedMailbox: null,
      emails: [makeEmail({ subject: 'group message', mailboxIds: { a: true }, sourceClientAccountId: LOGIN, sourceAccountId: GROUP })],
    } as never);
    await useEmailStore.getState().markAsRead(client, tabEmail.id, true, undefined, sourceOf(tabEmail));
    for (const call of client.markAsRead.mock.calls) {
      expect(call[2]).not.toBe(GROUP);
    }
    expect(useEmailStore.getState().emails[0].keywords?.$seen).toBeFalsy();
  });

  it('the stamped unified row of the same message follows the write', async () => {
    useEmailStore.setState({
      isUnifiedView: true, unifiedRole: 'inbox', selectedMailbox: null,
      emails: [
        makeEmail({ subject: 'group message', mailboxIds: { a: true }, sourceClientAccountId: LOGIN, sourceAccountId: GROUP }),
        makeEmail({ subject: 'own message', mailboxIds: { a: true }, sourceClientAccountId: LOGIN, sourceAccountId: OWN }),
      ],
    } as never);
    await useEmailStore.getState().toggleStar(client, tabEmail.id, emailKeyFor(tabEmail), sourceOf(tabEmail));
    const flagged = Object.fromEntries(useEmailStore.getState().emails.map((e) => [e.subject, !!e.keywords?.$flagged]));
    expect(flagged).toEqual({ 'group message': false, 'own message': true });
  });

  it('an unstamped row of the own folder that is listed is the same message and follows the write', async () => {
    useEmailStore.setState({
      selectedMailbox: 'a',
      emails: [makeEmail({ subject: 'own message', mailboxIds: { a: true } })],
    } as never);
    await useEmailStore.getState().deleteEmail(client, tabEmail.id, false, emailKeyFor(tabEmail), sourceOf(tabEmail));
    expect(client.moveToTrash).toHaveBeenCalledWith(ID, 'b', undefined, false);
    expect(useEmailStore.getState().emails).toEqual([]);
  });
});
