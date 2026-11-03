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
  getEmail: vi.fn(async (id: string) => (id === 'gone' ? null : { id, receivedAt: '2026-01-01T00:00:00Z' })),
});
let clients: Record<string, ReturnType<typeof makeClient>>;
let activeAccountId = 'alice@one';
let archiveEnabled = true;
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
vi.mock('@/lib/archive-gate', () => ({ isArchiveActionEnabled: () => archiveEnabled }));

async function run(over: Partial<NotificationActionRequest> = {}) {
  const request: NotificationActionRequest = {
    action: 'mark-read',
    emailId: 'e1',
    accountId: 'a',
    slot: 0,
    login: await loginFingerprint('https://one.example', 'alice@example.org'),
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
  archiveEnabled = true;
  batchMarkAsRead.mockResolvedValue(true);
  batchArchive.mockResolvedValue(true);
});

describe('which notifications a tab takes', () => {
  it('declines when the slot holds someone else now', async () => {
    const answers = await run({ login: await loginFingerprint('https://other.example', 'alice@example.org') });
    expect(answers).toEqual(['declined']);
    expect(batchMarkAsRead).not.toHaveBeenCalled();
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

  it('checks a message from the worker for the shape it needs', () => {
    expect(isNotificationActionRequest({ action: 'archive', emailId: 'e', accountId: 'a' })).toBe(true);
    expect(isNotificationActionRequest({ action: 'delete', emailId: 'e', accountId: 'a' })).toBe(false);
    expect(isNotificationActionRequest({ action: 'archive', emailId: '', accountId: 'a' })).toBe(false);
    expect(isNotificationActionRequest({ action: 'archive', emailId: 'e' })).toBe(false);
    expect(isNotificationActionRequest(null)).toBe(false);
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
  });

  it('reports a failure, so the worker opens the message', async () => {
    batchMarkAsRead.mockRejectedValue(new Error('forbidden'));
    expect(await run()).toEqual(['accepted', 'failed']);
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
      emails: [{ id: 'e1', receivedAt: '2026-01-01T00:00:00Z' }],
    });
  });

  it('declines when the admin turned it off', async () => {
    archiveEnabled = false;
    expect(await run({ action: 'archive' })).toEqual(['declined']);
    expect(batchArchive).not.toHaveBeenCalled();
  });

  it("leaves a shared account's Archive to the route: the store reads own folders only", async () => {
    expect(await run({ action: 'archive', accountId: 'team' })).toEqual(['declined']);
    expect(batchArchive).not.toHaveBeenCalled();
  });

  it('reports a message that is gone', async () => {
    expect(await run({ action: 'archive', emailId: 'gone' })).toEqual(['accepted', 'failed']);
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
