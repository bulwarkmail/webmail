import { describe, it, expect, vi } from 'vitest';
import { FakeCaches, loadWorker } from './sw-harness';

// App lock and push notifications: the worker keeps the last state a page told it in
// the Cache API. A page can't say "locked" when its tab or the browser closes, so a
// stored "unlocked" only counts while a tab holds the lock key (the Web Lock
// `bulwark-app-lock-holder`, which the page asks too: lib/app-lock/controller.ts
// holderAlive) and one of the tabs that said "unlocked" is open. Any other window of
// the origin (a picture, an opened attachment, the login page) counts for nothing.

const ORIGIN = 'https://mail.example.com';
const PUSH_CACHE = 'bulwark-push-state-v1';
const PREVIEW = {
  unreadTotal: 1,
  slot: 0,
  login: 'fp',
  email: { id: 'e1', threadId: 't1', subject: 'Secret subject 482913', from: [{ name: 'Secret sender', email: 's@example.org' }] },
};
const delivery = { kind: 'jmap-email-push', accountId: 'a', emailIds: ['e1'] };
const HOLDER = 'bulwark-app-lock-holder';

interface FakeClient {
  id: string;
  url: string;
  frameType?: string;
  focused?: boolean;
  visibilityState?: string;
  postMessage: (message: unknown, ports?: MessagePort[]) => void;
  focus?: () => Promise<unknown>;
}

function client(id: string, path: string): FakeClient {
  return { id, url: `${ORIGIN}${path}`, frameType: 'top-level', focused: false, visibilityState: 'visible', postMessage: () => {} };
}

async function setup(opts: { caches?: FakeCaches; locks?: boolean; notifications?: Array<Record<string, unknown>> } = {}) {
  const caches = opts.caches ?? new FakeCaches();
  // The route may be used for a notification's buttons (no plugin in the way).
  const cache = await caches.open(PUSH_CACHE);
  await cache.put(`${ORIGIN}/__push-state/actions`, new Response(JSON.stringify({
    archiveEnabled: true,
    archiveMode: 'single',
    pluginsMayVeto: false,
    labels: { archive: 'Archive', markRead: 'Mark as read', reply: 'Reply', replyPlaceholder: 'Write a reply' },
  })));
  const clients: FakeClient[] = [];
  // Which tabs hold the app lock's key: the Web Lock they keep while they live.
  const holders = new Set<string>();
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify(PREVIEW), { status: 200 });
  });
  const openWindow = vi.fn(async () => null);
  const worker = loadWorker({
    buildId: 'b',
    caches,
    clients,
    fetch: fetchMock,
    openWindow,
    notifications: opts.notifications,
    globals: {
      MessageChannel,
      Notification: { maxActions: 2 },
      navigator: opts.locks === false ? {} : {
        locks: {
          query: async () => ({ held: [...holders].map((clientId) => ({ name: HOLDER, mode: 'exclusive', clientId })), pending: [] }),
        },
      },
    },
  });
  const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
  const previews = () => fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/push/preview'));
  return { worker, caches, clients, holders, fetchMock, posts, previews, openWindow };
}

describe('app lock: "unlocked" only counts while the tab that holds the key is open', () => {
  it('names the sender while the unlocked app tab is open and holds the key', async () => {
    const { worker, clients, holders } = await setup();
    const app = client('app', '/mail/folder/inbox');
    clients.push(app);
    holders.add('app');
    await worker.dispatch('message', { source: app, data: { type: 'app-lock', state: 'unlocked' } });
    await worker.dispatch('push', { data: { json: () => delivery } });
    expect(worker.shown[0].title).toContain('Secret sender');
  });

  it('says nothing about the message once the app tab is gone and only a picture of the origin is open', async () => {
    const { worker, clients, holders, previews } = await setup();
    const app = client('app', '/mail/folder/inbox');
    clients.push(app);
    holders.add('app');
    await worker.dispatch('message', { source: app, data: { type: 'app-lock', state: 'unlocked' } });

    // The app's tab closes, which tells the worker nothing. Another address of the
    // origin is open in a tab that isn't the app.
    clients.length = 0;
    holders.clear();
    clients.push(client('other', '/icon-192x192.png'));

    await worker.dispatch('push', { data: { json: () => delivery } });
    expect(JSON.stringify(worker.shown)).not.toContain('Secret');
    expect(previews()).toHaveLength(0);
    expect(worker.shown[worker.shown.length - 1].title).toBe('New mail');
  });

  it('runs no notification button through the route in that state either', async () => {
    const { worker, clients, holders, posts } = await setup();
    const app = client('app', '/mail/folder/inbox');
    clients.push(app);
    holders.add('app');
    await worker.dispatch('message', { source: app, data: { type: 'app-lock', state: 'unlocked' } });
    clients.length = 0;
    holders.clear();
    clients.push(client('other', '/icon-192x192.png'));

    await worker.dispatch('notificationclick', {
      action: 'archive',
      notification: { data: { kind: 'email', emailId: 'e1', threadId: 't1', accountId: 'a', slot: 0, login: 'fp' }, tag: 'bulwark-mail:a', close() {} },
    });
    expect(posts()).toHaveLength(0);
  });
});

describe('app lock: what the worker goes by', () => {
  it('takes the app for locked in a worker without Web Locks, with the unlocked tab open', async () => {
    const { worker, clients, previews } = await setup({ locks: false });
    const app = client('app', '/mail/folder/inbox');
    clients.push(app);
    await worker.dispatch('message', { source: app, data: { type: 'app-lock', state: 'unlocked' } });
    await worker.dispatch('push', { data: { json: () => delivery } });
    expect(previews()).toHaveLength(0);
    expect(worker.shown[0].title).toBe('New mail');
  });

  it('says nothing while the tab with the key is not among the open windows (a frozen tab)', async () => {
    const { worker, clients, holders, previews } = await setup();
    const app = client('app', '/mail/folder/inbox');
    clients.push(app);
    holders.add('app');
    await worker.dispatch('message', { source: app, data: { type: 'app-lock', state: 'unlocked' } });
    // A frozen page keeps its Web Lock, and the browser leaves it out of the worker's windows.
    clients.length = 0;
    clients.push(client('other', '/icon-192x192.png'));
    await worker.dispatch('push', { data: { json: () => delivery } });
    expect(previews()).toHaveLength(0);
    expect(JSON.stringify(worker.shown)).not.toContain('Secret');
  });

  it('goes on naming the sender while one of two unlocked app tabs stays, and stops when the key goes', async () => {
    const { worker, clients, holders, previews } = await setup();
    const first = client('first', '/mail/folder/inbox');
    const second = client('second', '/calendar');
    clients.push(first, second);
    holders.add('first');
    await worker.dispatch('message', { source: first, data: { type: 'app-lock', state: 'unlocked' } });
    await worker.dispatch('message', { source: second, data: { type: 'app-lock', state: 'unlocked' } });

    // The second tab closes; the first, with the key, is still in use.
    clients.splice(1, 1);
    await worker.dispatch('push', { data: { json: () => delivery } });
    expect(worker.shown[0].title).toContain('Secret sender');

    // Now the tab with the key goes too. A picture of the origin is all that's open.
    clients.length = 0;
    holders.clear();
    clients.push(client('other', '/icon-192x192.png'));
    await worker.dispatch('push', { data: { json: () => ({ ...delivery, emailIds: ['e2'] }) } });
    expect(previews()).toHaveLength(1);
    expect(worker.shown[worker.shown.length - 1].title).toBe('New mail');
  });

  it('counts a stored "unlocked" for nothing after a browser restart with no app tab', async () => {
    const before = await setup();
    const app = client('app', '/mail/folder/inbox');
    before.clients.push(app);
    before.holders.add('app');
    await before.worker.dispatch('message', { source: app, data: { type: 'app-lock', state: 'unlocked' } });

    // The browser closes and starts again: a new worker, the same Cache API, no lock held.
    const after = await setup({ caches: before.caches });
    after.clients.push(client('other', '/mail/folder/inbox'));
    await after.worker.dispatch('push', { data: { json: () => delivery } });
    expect(after.previews()).toHaveLength(0);
    expect(JSON.stringify(after.worker.shown)).not.toContain('Secret');
  });

  it('names the sender with the lock off, whatever the worker can ask', async () => {
    const { worker, clients } = await setup({ locks: false });
    clients.push(client('other', '/icon-192x192.png'));
    await worker.dispatch('message', { source: clients[0], data: { type: 'app-lock', state: 'locked' } });
    await worker.dispatch('message', { source: clients[0], data: { type: 'app-lock', state: 'off' } });
    await worker.dispatch('push', { data: { json: () => delivery } });
    expect(worker.shown[0].title).toContain('Secret sender');
  });
});

describe('app lock: what is on screen from before', () => {
  const onScreen = () => ({
    tag: 'bulwark-mail:a',
    title: 'Secret sender',
    body: 'Secret subject 482913',
    data: { kind: 'email', emailId: 'e1', threadId: 't1', accountId: 'a', slot: 0, login: 'fp', ids: ['e1'] },
    close: vi.fn(),
  });

  async function announced(caches: FakeCaches): Promise<void> {
    const cache = await caches.open(PUSH_CACHE);
    await cache.put(`${ORIGIN}/__push-state/notified/a`, new Response(JSON.stringify({ ids: ['e1'] })));
  }

  it('shows a message from before again with its sender and buttons while unlocked', async () => {
    const caches = new FakeCaches();
    await announced(caches);
    const { worker, clients, holders } = await setup({ caches, notifications: [onScreen()] });
    const app = client('app', '/mail/folder/inbox');
    clients.push(app);
    holders.add('app');
    await worker.dispatch('message', { source: app, data: { type: 'app-lock', state: 'unlocked' } });
    // The same message again: the notification on screen is shown as it is.
    await worker.dispatch('push', { data: { json: () => delivery } });
    expect(worker.shown[0].title).toBe('Secret sender');
    expect(worker.shown[0].options.actions).toBeDefined();
  });

  it('shows it again without sender, subject or buttons once the lock holds', async () => {
    const caches = new FakeCaches();
    await announced(caches);
    const { worker, clients, holders, previews } = await setup({ caches, notifications: [onScreen()] });
    const app = client('app', '/mail/folder/inbox');
    clients.push(app);
    holders.add('app');
    await worker.dispatch('message', { source: app, data: { type: 'app-lock', state: 'unlocked' } });
    clients.length = 0;
    holders.clear();
    await worker.dispatch('push', { data: { json: () => delivery } });
    expect(previews()).toHaveLength(0);
    expect(JSON.stringify(worker.shown)).not.toContain('Secret');
    expect(worker.shown[0].title).toBe('New mail');
    expect(worker.shown[0].options.actions).toBeUndefined();
  });

  it('does nothing for a button of a notification from before the lock', async () => {
    const { worker, clients, posts } = await setup();
    clients.push(client('app', '/mail/folder/inbox'));
    await worker.dispatch('message', { source: clients[0], data: { type: 'app-lock', state: 'locked' } });
    for (const action of ['mark-read', 'archive']) {
      await worker.dispatch('notificationclick', {
        action,
        notification: { data: { kind: 'email', emailId: 'e1', threadId: 't1', accountId: 'a', slot: 0, login: 'fp' }, tag: 'bulwark-mail:a', close() {} },
      });
    }
    expect(posts()).toHaveLength(0);
  });

  it('closes a calendar reminder at a lock, and leaves the prompt that names nothing', async () => {
    const reminder = { tag: 'calendar-reminder:k1', title: 'Secret meeting', close: vi.fn() };
    const prompt = { tag: 'bulwark-mailto-focus', title: 'Bulwark', close: vi.fn() };
    const mail = onScreen();
    const { worker, clients } = await setup({ notifications: [reminder, prompt, mail] });
    clients.push(client('app', '/mail/folder/inbox'));
    await worker.dispatch('message', { source: clients[0], data: { type: 'app-lock', state: 'locked' } });
    expect(reminder.close).toHaveBeenCalled();
    expect(mail.close).toHaveBeenCalled();
    expect(prompt.close).not.toHaveBeenCalled();
  });
});
