import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loginFingerprint } from '../login-fingerprint';
import { isNotificationActionRequest, runNotificationAction, setNotificationReplyOpener, type NotificationActionRequest, type NotificationActionStatus } from '../page-actions';

// A notification's button in an open tab: only for the login it was shown for,
// through the store actions, with the tab's answer telling the worker what's next.

const accounts = [
  { id: 'alice@one', cookieSlot: 0, serverUrl: 'https://one.example', username: 'alice@example.org' },
  { id: 'bob@two', cookieSlot: 1, serverUrl: 'https://two.example', username: 'bob@example.org' },
];
const makeClient = (accountId: string) => ({
  getAccountId: () => accountId,
  getEmail: vi.fn(async (id: string) => (id === 'gone' ? null : { id, receivedAt: '2026-01-01T00:00:00Z', mailboxIds: { [id === 'binned' ? 'bin' : 'inbox']: true } })),
  getMailboxes: vi.fn(async () => [{ id: 'inbox', role: 'inbox' }, { id: 'x', originalId: 'bin', role: 'trash' }]),
});
let clients: Record<string, ReturnType<typeof makeClient>>;
let activeAccountId = 'alice@one';
const gateOff = new Set<string>();
let hooksRegistered = false;
const batchMarkAsRead = vi.fn(async (..._args: unknown[]) => true);
const batchArchive = vi.fn(async (..._args: unknown[]) => true);

vi.mock('@/stores/account-store', () => ({ useAccountStore: { getState: () => ({ accounts }) } }));
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: {
    getState: () => ({
      activeAccountId,
      client: clients[activeAccountId] ?? null,
      getClientForAccount: (id: string) => clients[id],
    }),
  },
}));
vi.mock('@/stores/email-store', () => ({ useEmailStore: { getState: () => ({ batchMarkAsRead, batchArchive }) } }));
// Each login's own subject, and a policy that reads it: the gate of the login
// the notification is for, not of the one that's active here.
vi.mock('@/lib/org/account-subjects', () => ({ subjectForAccount: (id: string) => ({ email: id, groups: [] }) }));
vi.mock('@/stores/policy-store', () => ({
  usePolicyStore: {
    getState: () => ({
      resolveFor: (subject: { email: string }) => ({ features: { archiveActionEnabled: !gateOff.has(subject.email) } }),
    }),
  },
}));
vi.mock('../plugin-veto', () => ({ vetoHooksRegistered: () => hooksRegistered }));

async function run(over: Partial<NotificationActionRequest> = {}) {
  const request: NotificationActionRequest = {
    action: 'mark-read',
    emailId: 'e1',
    accountId: 'a',
    slot: 0,
    login: await loginFingerprint('https://one.example', 'alice@example.org'),
    at: Date.now(),
    ...over,
  };
  const answers: NotificationActionStatus[] = [];
  await runNotificationAction(request, (status) => answers.push(status));
  return answers;
}

beforeEach(() => {
  vi.clearAllMocks();
  clients = { 'alice@one': makeClient('a'), 'bob@two': makeClient('b') };
  activeAccountId = 'alice@one';
  gateOff.clear();
  hooksRegistered = false;
  batchMarkAsRead.mockResolvedValue(true);
  batchArchive.mockResolvedValue(true);
});

describe('which notifications a tab takes', () => {
  it('declines when the slot holds someone else now', async () => {
    const answers = await run({ login: await loginFingerprint('https://other.example', 'alice@example.org') });
    expect(answers).toEqual(['declined']);
    expect(batchMarkAsRead).not.toHaveBeenCalled();
  });

  it('takes a notification whose server address was written differently', async () => {
    const answers = await run({ login: await loginFingerprint('https://ONE.example:443/', 'alice@example.org') });
    expect(answers).toEqual(['accepted', 'done']);
  });

  it('declines a slot it has no login for', async () => {
    expect(await run({ slot: 7 })).toEqual(['declined']);
  });

  it('declines without a login to compare', async () => {
    expect(await run({ login: undefined })).toEqual(['declined']);
    expect(batchMarkAsRead).not.toHaveBeenCalled();
  });

  it('declines when that login is not connected in this tab', async () => {
    delete clients['alice@one'];
    activeAccountId = 'bob@two';
    expect(await run()).toEqual(['declined']);
  });

  it('declines a click from long ago: a tab that thawed has lost it', async () => {
    expect(await run({ at: Date.now() - 6_000 })).toEqual(['declined']);
    expect(batchMarkAsRead).not.toHaveBeenCalled();
    const opener = vi.fn();
    const remove = setNotificationReplyOpener(opener);
    expect(await run({ action: 'reply', at: Date.now() - 6_000 })).toEqual(['declined']);
    expect(opener).not.toHaveBeenCalled();
    remove();
  });

  it('takes one from a moment ago', async () => {
    expect(await run({ at: Date.now() - 2_000 })).toEqual(['accepted', 'done']);
  });

  it('checks a message from the worker for the shape it needs', () => {
    const at = 1;
    expect(isNotificationActionRequest({ action: 'archive', emailId: 'e', accountId: 'a', at })).toBe(true);
    expect(isNotificationActionRequest({ action: 'archive', emailId: 'e', accountId: 'a' })).toBe(false);
    expect(isNotificationActionRequest({ action: 'delete', emailId: 'e', accountId: 'a', at })).toBe(false);
    expect(isNotificationActionRequest({ action: 'archive', emailId: '', accountId: 'a', at })).toBe(false);
    expect(isNotificationActionRequest({ action: 'archive', emailId: 'e', at })).toBe(false);
    expect(isNotificationActionRequest(null)).toBe(false);
  });
});

describe('with plugins listening on a veto hook', () => {
  beforeEach(() => { hooksRegistered = true; });

  it("doesn't pass on a shared account's Archive to the route, which has no plugins", async () => {
    expect(await run({ action: 'archive', accountId: 'team' })).toEqual(['failed']);
    expect(batchArchive).not.toHaveBeenCalled();
  });

  it("doesn't pass on a login that isn't connected here", async () => {
    delete clients['alice@one'];
    activeAccountId = 'bob@two';
    expect(await run()).toEqual(['failed']);
  });

  it('still declines a notification of a login this tab does not hold', async () => {
    expect(await run({ slot: 7 })).toEqual(['declined']);
  });

  it('runs what it can itself, through the store, where the hooks are', async () => {
    expect(await run()).toEqual(['accepted', 'done']);
    expect(batchMarkAsRead).toHaveBeenCalled();
  });
});

describe('Mark read', () => {
  it('goes through the store, with the login of the notification', async () => {
    expect(await run()).toEqual(['accepted', 'done']);
    const [active, read, target] = batchMarkAsRead.mock.calls[0];
    expect(active).toBe(clients['alice@one']);
    expect(read).toBe(true);
    expect(target).toEqual({ emailIds: ['e1'], client: clients['alice@one'], accountId: undefined });
  });

  it('reaches a login that is not the active one through its own client', async () => {
    const answers = await run({ slot: 1, accountId: 'b', login: await loginFingerprint('https://two.example', 'bob@example.org') });
    expect(answers).toEqual(['accepted', 'done']);
    const [active, , target] = batchMarkAsRead.mock.calls[0];
    expect(active).toBe(clients['alice@one']);
    expect((target as { client: unknown }).client).toBe(clients['bob@two']);
  });

  it('names a shared account', async () => {
    await run({ accountId: 'team' });
    expect((batchMarkAsRead.mock.calls[0][2] as { accountId?: string }).accountId).toBe('team');
    expect(clients['alice@one'].getEmail).toHaveBeenCalledWith('e1', 'team');
  });

  it('reports a failure, so the worker opens the message', async () => {
    batchMarkAsRead.mockRejectedValue(new Error('forbidden'));
    expect(await run()).toEqual(['accepted', 'failed']);
  });

  it('reports a plugin stopping it', async () => {
    batchMarkAsRead.mockResolvedValue(false);
    expect(await run()).toEqual(['accepted', 'failed']);
  });

  it('still queues with the mail server out of reach, like the app\'s own button', async () => {
    clients['alice@one'].getEmail.mockRejectedValue(new Error('offline'));
    clients['alice@one'].getMailboxes.mockRejectedValue(new Error('offline'));
    expect(await run()).toEqual(['accepted', 'done']);
    expect(batchMarkAsRead).toHaveBeenCalled();
  });

  it('leaves a message since moved to Trash alone, by the server id of the folder', async () => {
    expect(await run({ emailId: 'binned' })).toEqual(['accepted', 'failed']);
    expect(batchMarkAsRead).not.toHaveBeenCalled();
  });
});

describe('Archive', () => {
  it('goes through the store with the message, which it files by date', async () => {
    expect(await run({ action: 'archive' })).toEqual(['accepted', 'done']);
    const [active, target] = batchArchive.mock.calls[0];
    expect(active).toBe(clients['alice@one']);
    expect(target).toEqual({
      emailIds: ['e1'],
      client: clients['alice@one'],
      emails: [{ id: 'e1', receivedAt: '2026-01-01T00:00:00Z', mailboxIds: { inbox: true } }],
      userArchive: true,
    });
  });

  it('fails when the admin turned it off for this login, and the message opens', async () => {
    gateOff.add('alice@one');
    expect(await run({ action: 'archive' })).toEqual(['failed']);
    expect(batchArchive).not.toHaveBeenCalled();
  });

  it("goes by the notification's login, not the active one", async () => {
    const bob = { slot: 1, accountId: 'b', login: await loginFingerprint('https://two.example', 'bob@example.org') };
    gateOff.add('bob@two');
    expect(await run({ action: 'archive', ...bob })).toEqual(['failed']);
    expect(batchArchive).not.toHaveBeenCalled();

    gateOff.clear();
    gateOff.add('alice@one');
    expect(await run({ action: 'archive', ...bob })).toEqual(['accepted', 'done']);
  });

  it("leaves a shared account's Archive to the route: the store reads own folders only", async () => {
    expect(await run({ action: 'archive', accountId: 'team' })).toEqual(['declined']);
    expect(batchArchive).not.toHaveBeenCalled();
  });

  it('reports a message that is gone', async () => {
    expect(await run({ action: 'archive', emailId: 'gone' })).toEqual(['accepted', 'failed']);
    expect(batchArchive).not.toHaveBeenCalled();
  });

  it('reports a message it can\'t read with the mail server out of reach', async () => {
    clients['alice@one'].getEmail.mockRejectedValue(new Error('offline'));
    expect(await run({ action: 'archive' })).toEqual(['accepted', 'failed']);
    expect(batchArchive).not.toHaveBeenCalled();
  });

  it('leaves a message since moved to Trash alone', async () => {
    expect(await run({ action: 'archive', emailId: 'binned' })).toEqual(['accepted', 'failed']);
    expect(batchArchive).not.toHaveBeenCalled();
  });

  it('reports a plugin or the store stopping it', async () => {
    batchArchive.mockResolvedValue(false);
    expect(await run({ action: 'archive' })).toEqual(['accepted', 'failed']);
  });
});

describe('Reply', () => {
  it('declines on a page without the mail app', async () => {
    expect(await run({ action: 'reply' })).toEqual(['declined']);
  });

  it('declines on such a page with plugins too: a link opens the composer, nothing is skipped', async () => {
    hooksRegistered = true;
    expect(await run({ action: 'reply' })).toEqual(['declined']);
  });

  it('hands the request to the mail page, typed text included', async () => {
    const opener = vi.fn();
    const remove = setNotificationReplyOpener(opener);
    expect(await run({ action: 'reply', text: 'Thanks' })).toEqual(['done']);
    expect(opener).toHaveBeenCalledWith({ emailId: 'e1', accountId: 'a', slot: 0, text: 'Thanks' });
    remove();
    expect(await run({ action: 'reply' })).toEqual(['declined']);
    expect(opener).toHaveBeenCalledTimes(1);
  });

  it('keeps a newer opener when an older one is removed', async () => {
    const remove = setNotificationReplyOpener(vi.fn());
    const current = vi.fn();
    const removeCurrent = setNotificationReplyOpener(current);
    remove();
    await run({ action: 'reply' });
    expect(current).toHaveBeenCalled();
    removeCurrent();
  });
});
