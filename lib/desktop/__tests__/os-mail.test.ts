import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge, DesktopOsNotification } from '../types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Email, Mailbox } from '@/lib/jmap/types';

/** New mail to a native notification: which messages count, what the toast may say. */

const playNotificationSound = vi.hoisted(() => vi.fn());
vi.mock('@/lib/notification-sound', () => ({ playNotificationSound }));

let pushWithoutContent = false;
vi.mock('@/lib/device-policy', () => ({ devicesForAccount: () => ({ pushWithoutContent }) }));

const accounts = [{ id: 'alice@one', cookieSlot: 3, serverUrl: 'https://one.example', username: 'alice@example.org', label: 'Work', email: 'alice@example.org' }];
let client: IJMAPClient;
vi.mock('@/stores/account-store', () => ({ useAccountStore: { getState: () => ({ accounts }) } }));
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: {
    getState: () => ({
      activeAccountId: 'alice@one',
      client,
      getClientForAccount: () => client,
    }),
  },
}));

const INBOX = { id: 'in', role: 'inbox', name: 'Inbox' } as unknown as Mailbox;
const SENT = { id: 'out', role: 'sent', name: 'Sent' } as unknown as Mailbox;
const NEWS = { id: 'news', name: 'News' } as unknown as Mailbox;
const JUNK = { id: 'bad', role: 'junk', name: 'Junk' } as unknown as Mailbox;
const MAILBOXES = [INBOX, SENT, NEWS, JUNK];

function email(id: string, over: Partial<Email> = {}): Email {
  return {
    id,
    threadId: `t-${id}`,
    subject: `Secret ${id}`,
    preview: 'preview text',
    from: [{ name: 'Alice Sender', email: 'sender@example.org' }],
    mailboxIds: { in: true },
    keywords: {},
    receivedAt: new Date().toISOString(),
    ...over,
  } as unknown as Email;
}

function fakeClient(mail: Record<string, Email>, changes: { created: string[]; newState: string }[] = []) {
  const queue = [...changes];
  return {
    getAccountId: () => 'acc',
    getAllMailboxes: vi.fn(async () => MAILBOXES),
    getEmails: vi.fn(async () => ({ emails: [], hasMore: false, total: 0, state: 'seeded' })),
    getEmailChanges: vi.fn(async (since: string) => {
      const next = queue.shift();
      return next ? { oldState: since, newState: next.newState, created: next.created, updated: [], destroyed: [], hasMoreChanges: false } : null;
    }),
    getSomeEmails: vi.fn(async (ids: string[]) => ids.flatMap((id) => mail[id] ?? [])),
  } as unknown as IJMAPClient;
}

const labels = {
  newMail: 'new_mail',
  newMailCount: (count: number) => `count:${count}`,
  noSubject: 'no_subject',
  archive: 'archive',
  markRead: 'mark_read',
  delete: 'delete',
  reply: 'reply',
  replyPlaceholder: 'placeholder',
};

function setBridge(bridge: Partial<BulwarkDesktopBridge> | undefined) {
  window.bulwarkDesktop = bridge as BulwarkDesktopBridge | undefined;
}

beforeEach(async () => {
  vi.clearAllMocks();
  pushWithoutContent = false;
  const { useSettingsStore } = await import('@/stores/settings-store');
  useSettingsStore.setState({
    emailNotificationsEnabled: true,
    emailNotificationSound: true,
    doNotDisturb: false,
    pushNotifyInboxOnly: true,
    notificationMutes: { accounts: [], mailboxes: {} },
    notificationSoundChoice: 'involved',
  });
  const { setAppLockCheck } = await import('../app-lock-state');
  setAppLockCheck(null);
});

afterEach(() => {
  setBridge(undefined);
  vi.useRealTimers();
});

describe('which new messages notify', () => {
  it('a new unread message in the Inbox', async () => {
    const { notifyingMailbox } = await import('../new-mail');
    expect(notifyingMailbox(email('a'), 'acc', 'acc', MAILBOXES)?.id).toBe('in');
  });

  it('nothing already read, a draft, or old mail coming back from an import', async () => {
    const { notifyingMailbox } = await import('../new-mail');
    expect(notifyingMailbox(email('a', { keywords: { $seen: true } }), 'acc', 'acc', MAILBOXES)).toBeNull();
    expect(notifyingMailbox(email('a', { keywords: { $draft: true } }), 'acc', 'acc', MAILBOXES)).toBeNull();
    const old = new Date(Date.now() - 3 * 86400_000).toISOString();
    expect(notifyingMailbox(email('a', { receivedAt: old }), 'acc', 'acc', MAILBOXES)).toBeNull();
  });

  it('with Inbox only on, mail filed elsewhere stays silent; off, it notifies, but never Junk or Sent', async () => {
    const { notifyingMailbox } = await import('../new-mail');
    const { useSettingsStore } = await import('@/stores/settings-store');
    const filed = email('a', { mailboxIds: { news: true } });
    expect(notifyingMailbox(filed, 'acc', 'acc', MAILBOXES)).toBeNull();
    useSettingsStore.setState({ pushNotifyInboxOnly: false });
    expect(notifyingMailbox(filed, 'acc', 'acc', MAILBOXES)?.id).toBe('news');
    expect(notifyingMailbox(email('b', { mailboxIds: { bad: true } }), 'acc', 'acc', MAILBOXES)).toBeNull();
    expect(notifyingMailbox(email('c', { mailboxIds: { out: true } }), 'acc', 'acc', MAILBOXES)).toBeNull();
  });

  it('a muted folder or account stays silent', async () => {
    const { notifyingMailbox } = await import('../new-mail');
    const { useSettingsStore } = await import('@/stores/settings-store');
    useSettingsStore.setState({ notificationMutes: { accounts: [], mailboxes: { 'acc/in': true } } });
    expect(notifyingMailbox(email('a'), 'acc', 'acc', MAILBOXES)).toBeNull();
    useSettingsStore.setState({ notificationMutes: { accounts: ['acc'], mailboxes: {} } });
    expect(notifyingMailbox(email('a'), 'acc', 'acc', MAILBOXES)).toBeNull();
  });
});

describe('the watch', () => {
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('resolves a push against its baseline, whatever page is open', async () => {
    const { startNewMailWatch } = await import('../new-mail');
    const { emitPushStateChange } = await import('@/lib/push-events');
    const fake = fakeClient({ a: email('a') }, [{ created: ['a'], newState: 's2' }]);
    const seen: string[] = [];
    const watch = startNewMailWatch((mail) => seen.push(...mail.map((m) => m.email.id)));
    watch.seed(fake);
    await flush();
    emitPushStateChange({ changed: { acc: { Email: 's2' } } } as never, fake, 'background');
    await flush();
    expect(fake.getEmailChanges).toHaveBeenCalledWith('seeded', 'acc', 200);
    expect(seen).toEqual(['a']);
    watch.stop();
  });

  it('tells a message once when the store and the push both report it', async () => {
    const { startNewMailWatch } = await import('../new-mail');
    const { emitPushStateChange } = await import('@/lib/push-events');
    const fake = fakeClient({ a: email('a') }, [{ created: ['a'], newState: 's2' }]);
    const seen: string[] = [];
    const watch = startNewMailWatch((mail) => seen.push(...mail.map((m) => m.email.id)));
    watch.seed(fake);
    await flush();
    watch.noteCreated(fake, 'acc', ['a']);
    await flush();
    emitPushStateChange({ changed: { acc: { Email: 's2' } } } as never, fake, 'active');
    await flush();
    expect(seen).toEqual(['a']);
    watch.stop();
  });

  it('without a baseline the first push only sets one: old mail is not news', async () => {
    const { startNewMailWatch } = await import('../new-mail');
    const { emitPushStateChange } = await import('@/lib/push-events');
    const fake = fakeClient({}, []);
    const onMail = vi.fn();
    const watch = startNewMailWatch(onMail);
    emitPushStateChange({ changed: { acc: { Email: 's1' } } } as never, fake, 'active');
    await flush();
    expect(fake.getEmailChanges).not.toHaveBeenCalled();
    expect(onMail).not.toHaveBeenCalled();
    watch.stop();
  });

  it('ignores a change after it stopped', async () => {
    const { startNewMailWatch } = await import('../new-mail');
    const { emitPushStateChange } = await import('@/lib/push-events');
    const fake = fakeClient({ a: email('a') }, [{ created: ['a'], newState: 's2' }]);
    const onMail = vi.fn();
    const watch = startNewMailWatch(onMail);
    watch.seed(fake);
    await flush();
    watch.stop();
    emitPushStateChange({ changed: { acc: { Email: 's2' } } } as never, fake, 'active');
    await flush();
    expect(onMail).not.toHaveBeenCalled();
  });
});

describe('what the notification says', () => {
  const one = (id = 'a', over: Partial<Email> = {}) => ({ client, accountId: 'acc', email: email(id, over) });

  beforeEach(() => {
    client = fakeClient({});
  });

  it('sender, subject, the buttons, and what a button needs after a restart', async () => {
    const { buildMailNotification } = await import('../mail-notifications');
    const { loginFingerprint } = await import('@/lib/pwa-notify/login-fingerprint');
    const notification = await buildMailNotification([one()], labels);
    expect(notification.title).toBe('Alice Sender');
    expect(notification.body).toBe('Secret a');
    expect(notification.actions?.map((a) => a.id)).toEqual(['archive', 'mark-read', 'delete']);
    expect(notification.reply?.label).toBe('reply');
    expect(JSON.parse(notification.context)).toEqual({
      accountId: 'acc',
      slot: 3,
      login: await loginFingerprint('https://one.example', 'alice@example.org'),
      emailId: 'a',
      threadId: 't-a',
    });
  });

  it('no Archive button where the organisation has it off', async () => {
    const { buildMailNotification } = await import('../mail-notifications');
    const notification = await buildMailNotification([one()], { ...labels, archive: null });
    expect(notification.actions?.map((a) => a.id)).toEqual(['mark-read', 'delete']);
  });

  it('while the app is locked: no sender, no subject, no buttons', async () => {
    const { buildMailNotification } = await import('../mail-notifications');
    const { setAppLockCheck } = await import('../app-lock-state');
    setAppLockCheck(() => true);
    const notification = await buildMailNotification([one()], labels);
    const text = JSON.stringify(notification);
    expect(notification.title).toBe('new_mail');
    expect(text).not.toContain('Alice Sender');
    expect(text).not.toContain('Secret');
    expect(notification.actions).toBeUndefined();
    expect(notification.reply).toBeUndefined();
  });

  it('where the organisation keeps content off notifications: the same', async () => {
    const { buildMailNotification } = await import('../mail-notifications');
    pushWithoutContent = true;
    const notification = await buildMailNotification([one()], labels);
    expect(JSON.stringify(notification)).not.toContain('Secret');
    expect(JSON.stringify(notification)).not.toContain('Alice Sender');
  });

  it('several at once are told about once, and that one has no message to act on', async () => {
    const { buildMailNotification } = await import('../mail-notifications');
    const notification = await buildMailNotification([one('a'), one('b'), one('c')], labels);
    expect(notification.title).toBe('count:3');
    expect(notification.actions).toBeUndefined();
    expect(JSON.parse(notification.context).emailId).toBeUndefined();
  });

  it('several at once while locked say only how many', async () => {
    const { buildMailNotification } = await import('../mail-notifications');
    const { setAppLockCheck } = await import('../app-lock-state');
    setAppLockCheck(() => true);
    const notification = await buildMailNotification([one('a'), one('b')], labels);
    expect(notification.title).toBe('count:2');
    expect(notification.body).toBe('');
  });
});

describe('from arrival to toast and sound', () => {
  /** The login's fingerprint comes from crypto.subtle, which no fake timer moves. */
  const settle = async () => {
    const end = performance.now() + 80;
    while (performance.now() < end) await new Promise((resolve) => setImmediate(resolve));
  };

  async function arrive(over: { result?: { shown: boolean; playSound: boolean } } = {}) {
    const { startMailNotifications, MAIL_BATCH_MS } = await import('../mail-notifications');
    const { emitPushStateChange } = await import('@/lib/push-events');
    const notify = vi.fn(async (_n: DesktopOsNotification) => over.result ?? { shown: true, playSound: true });
    setBridge({ version: 1, platform: 'win32', os: { notify } as never });
    client = fakeClient({ a: email('a') }, [{ created: ['a'], newState: 's2' }]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const mail = startMailNotifications(labels);
    mail.seed(client);
    await vi.advanceTimersByTimeAsync(10);
    emitPushStateChange({ changed: { acc: { Email: 's2' } } } as never, client, 'active');
    await vi.advanceTimersByTimeAsync(MAIL_BATCH_MS + 10);
    await settle();
    mail.stop();
    return notify;
  }

  it('asks main, and plays the picked sound when main says so', async () => {
    const notify = await arrive();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].sound).toBe(true);
    expect(notify.mock.calls[0][0].attention).toBe(true);
    expect(playNotificationSound).toHaveBeenCalledWith('involved');
  });

  it('no sound when main says it is quiet', async () => {
    const notify = await arrive({ result: { shown: true, playSound: false } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it('nothing at all with mail notifications off or the app\'s Do not disturb on', async () => {
    const { useSettingsStore } = await import('@/stores/settings-store');
    useSettingsStore.setState({ emailNotificationsEnabled: false });
    expect(await arrive()).not.toHaveBeenCalled();
    useSettingsStore.setState({ emailNotificationsEnabled: true, doNotDisturb: true });
    expect(await arrive()).not.toHaveBeenCalled();
    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it("the store's created event reaches a running watch, and nothing else", async () => {
    const { startMailNotifications, MAIL_BATCH_MS } = await import('../mail-notifications');
    const { reportStoreCreatedMail: noteStoreCreated } = await import('../system-events');
    const notify = vi.fn(async () => ({ shown: true, playSound: false }));
    setBridge({ version: 1, platform: 'win32', os: { notify } as never });
    client = fakeClient({ a: email('a') });
    noteStoreCreated(client, 'acc', ['a']);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const mail = startMailNotifications(labels);
    noteStoreCreated(client, 'acc', ['a']);
    await vi.advanceTimersByTimeAsync(MAIL_BATCH_MS + 10);
    await settle();
    expect(notify).toHaveBeenCalledTimes(1);
    mail.stop();
    noteStoreCreated(client, 'acc', ['b']);
    await vi.advanceTimersByTimeAsync(MAIL_BATCH_MS + 10);
    await settle();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('tells main the sound is off when the user has it off', async () => {
    const { useSettingsStore } = await import('@/stores/settings-store');
    useSettingsStore.setState({ emailNotificationSound: false });
    const notify = await arrive({ result: { shown: true, playSound: false } });
    expect(notify.mock.calls[0][0].sound).toBe(false);
  });
});
