import { describe, expect, it, vi } from 'vitest';
import { FakeCaches, loadWorker } from './sw-harness';

// A notification's Archive, Mark read and Reply buttons (public/sw.js). The
// worker has no login: an open tab goes first, then the cookie route, then the
// message opens in the app.

const ORIGIN = 'https://mail.example.com';
const PUSH_CACHE = 'bulwark-push-state-v1';
const PREFS = {
  archiveEnabled: true,
  archiveMode: 'month',
  labels: { archive: 'Archivieren', markRead: 'Als gelesen markieren', reply: 'Antworten', replyPlaceholder: 'Antwort schreiben' },
};
const ONE_MESSAGE = { kind: 'email', emailId: 'e1', threadId: 't1', accountId: 'a', slot: 2, login: 'fp' };
const MESSAGE_URL = '/mail/message/e1?slot=2&owner=a';

async function cachesWith(prefs?: unknown) {
  const caches = new FakeCaches();
  if (prefs) {
    const cache = await caches.open(PUSH_CACHE);
    await cache.put(`${ORIGIN}/__push-state/actions`, new Response(JSON.stringify(prefs)));
  }
  return caches;
}

/** A window client that answers a posted action with the given statuses. */
function tab(id: string, statuses: string[], extra: Record<string, unknown> = {}) {
  const messages: Array<Record<string, unknown>> = [];
  const client = {
    id,
    url: `${ORIGIN}/mail/folder/inbox`,
    messages,
    focus: vi.fn(async function focus(this: unknown) { return client; }),
    navigate: vi.fn(async () => client),
    postMessage(message: Record<string, unknown>, ports?: MessagePort[]) {
      messages.push(message);
      if (message.kind !== 'notification-action') return;
      const port = ports?.[0];
      for (const status of statuses) port?.postMessage({ status });
    },
    ...extra,
  };
  return client;
}

function worker(opts: {
  caches: FakeCaches;
  clients?: Array<{ id: string }>;
  fetch?: (input: unknown, init?: RequestInit) => Promise<Response>;
  max?: number | null;
  inline?: boolean;
  showNotification?: (title: string, options: Record<string, unknown>) => Promise<void>;
  notifications?: Array<Record<string, unknown>>;
}) {
  const openWindow = vi.fn(async () => null);
  const fetch = vi.fn(opts.fetch ?? (async () => new Response('{}', { status: 200 })));
  const max = opts.max === undefined ? 3 : opts.max;
  const loaded = loadWorker({
    buildId: 'b1',
    caches: opts.caches,
    clients: opts.clients ?? [],
    fetch,
    openWindow,
    showNotification: opts.showNotification,
    notifications: opts.notifications,
    globals: {
      MessageChannel,
      ...(max === null ? {} : { Notification: { maxActions: max } }),
      ...(opts.inline ? { NotificationEvent: class { get reply() { return null; } } } : {}),
    },
  });
  const click = (action: string, extra: Record<string, unknown> = {}, data: Record<string, unknown> = ONE_MESSAGE) =>
    loaded.dispatch('notificationclick', { action, ...extra, notification: { data, tag: 'bulwark-mail:a', close() {} } });
  const posts = () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
  return { ...loaded, click, openWindow, fetch, posts };
}

const pushFor = (preview: Record<string, unknown>) => async (w: ReturnType<typeof worker>) => {
  await w.dispatch('push', { data: { json: () => ({ kind: 'jmap-email-push', accountId: 'a', emailIds: ['e1'] }) } });
  return preview;
};

const previewOf = (unreadTotal: number) => JSON.stringify({
  unreadTotal,
  slot: 2,
  login: 'fp',
  email: { id: 'e1', threadId: 't1', subject: 'Hello', from: [{ name: 'Bob' }] },
});

describe('the buttons a notification gets', () => {
  const buttonsFor = async (opts: { prefs?: unknown; max?: number | null; inline?: boolean; unreadTotal?: number }) => {
    const w = worker({
      caches: await cachesWith(opts.prefs),
      max: opts.max,
      inline: opts.inline,
      fetch: async () => new Response(previewOf(opts.unreadTotal ?? 1), { status: 200 }),
    });
    await pushFor({})(w);
    expect(w.shown).toHaveLength(1);
    return w.shown[0].options.actions as Array<Record<string, unknown>> | undefined;
  };

  it('offers the three in the labels the page left, on one message', async () => {
    expect(await buttonsFor({ prefs: PREFS })).toEqual([
      { action: 'archive', title: 'Archivieren' },
      { action: 'mark-read', title: 'Als gelesen markieren' },
      { action: 'reply', title: 'Antworten' },
    ]);
  });

  it('keeps Archive and Reply where the browser has two buttons', async () => {
    const buttons = await buttonsFor({ prefs: PREFS, max: 2 });
    expect(buttons?.map((b) => b.action)).toEqual(['archive', 'reply']);
  });

  it('leaves Archive out when the admin turned it off', async () => {
    const buttons = await buttonsFor({ prefs: { ...PREFS, archiveEnabled: false }, max: 2 });
    expect(buttons?.map((b) => b.action)).toEqual(['mark-read', 'reply']);
  });

  it('offers no Archive, in English, before any page has spoken', async () => {
    expect(await buttonsFor({})).toEqual([
      { action: 'mark-read', title: 'Mark as read' },
      { action: 'reply', title: 'Reply' },
    ]);
  });

  it('adds nothing in a browser without notification buttons', async () => {
    expect(await buttonsFor({ prefs: PREFS, max: null })).toBeUndefined();
    expect(await buttonsFor({ prefs: PREFS, max: 0 })).toBeUndefined();
  });

  it('gives the group notification none: it names no message', async () => {
    expect(await buttonsFor({ prefs: PREFS, unreadTotal: 4 })).toBeUndefined();
  });

  it('gives a message without its login none', async () => {
    const w = worker({
      caches: await cachesWith(PREFS),
      fetch: async () => new Response(JSON.stringify({ unreadTotal: 1, slot: 2, email: { id: 'e1', threadId: 't1' } }), { status: 200 }),
    });
    await pushFor({})(w);
    expect(w.shown[0].options.actions).toBeUndefined();
  });

  it('makes Reply a text field only where the browser can hand the text back', async () => {
    const buttons = await buttonsFor({ prefs: PREFS, inline: true });
    expect(buttons?.find((b) => b.action === 'reply')).toEqual({
      action: 'reply', title: 'Antworten', type: 'text', placeholder: 'Antwort schreiben',
    });
  });

  it('still shows the notification when the browser refuses the buttons', async () => {
    const w = worker({
      caches: await cachesWith(PREFS),
      fetch: async () => new Response(previewOf(1), { status: 200 }),
      showNotification: async (_title, options) => {
        if (options.actions) throw new TypeError('bad action');
      },
    });
    await pushFor({})(w);
    expect(w.shown).toHaveLength(2);
    expect(w.shown[1].options.actions).toBeUndefined();
    expect(w.shown[1].options.data).toMatchObject({ emailId: 'e1', login: 'fp' });
  });

  it('keeps the buttons when a redelivered push shows the same notification again', async () => {
    const existing = { title: 'Bob', body: 'Hello', data: ONE_MESSAGE };
    const caches = await cachesWith(PREFS);
    const cache = await caches.open(PUSH_CACHE);
    await cache.put(`${ORIGIN}/__push-state/notified/a`, new Response(JSON.stringify({ ids: ['e1'] })));
    const w = worker({ caches, notifications: [existing] });
    await pushFor({})(w);
    expect(w.shown).toHaveLength(1);
    expect((w.shown[0].options.actions as unknown[]).length).toBe(3);
  });
});

describe('a click', () => {
  it('on the body works as before: it opens the message and runs nothing', async () => {
    const client = tab('t', ['done']);
    const w = worker({ caches: await cachesWith(PREFS), clients: [client] });
    await w.click('');
    expect(client.navigate).toHaveBeenCalledWith(MESSAGE_URL);
    expect(client.messages.map((m) => m.kind)).toEqual(['notificationclick']);
    expect(w.posts()).toHaveLength(0);
  });

  it('on an unknown button counts as a click on the body', async () => {
    const client = tab('t', ['done']);
    const w = worker({ caches: await cachesWith(PREFS), clients: [client] });
    await w.click('explode');
    expect(client.navigate).toHaveBeenCalledWith(MESSAGE_URL);
    expect(w.posts()).toHaveLength(0);
  });

  it('on a button of a group notification opens the inbox and runs nothing', async () => {
    const client = tab('t', ['done']);
    const w = worker({ caches: await cachesWith(PREFS), clients: [client] });
    await w.click('archive', {}, { kind: 'mail-list', accountId: 'a', slot: 2 });
    expect(client.navigate).toHaveBeenCalledWith('/mail/folder/inbox?slot=2&owner=a');
    expect(w.posts()).toHaveLength(0);
  });
});

describe('Mark read and Archive', () => {
  it('go to an open tab first, which leaves nothing else to do', async () => {
    const client = tab('t', ['accepted', 'done']);
    const w = worker({ caches: await cachesWith(PREFS), clients: [client] });
    await w.click('mark-read');
    expect(client.messages.find((m) => m.kind === 'notification-action')).toEqual({
      kind: 'notification-action', action: 'mark-read', emailId: 'e1', threadId: 't1', accountId: 'a', slot: 2, login: 'fp',
    });
    expect(w.posts()).toHaveLength(0);
    expect(client.navigate).not.toHaveBeenCalled();
    expect(client.focus).not.toHaveBeenCalled();
    expect(w.openWindow).not.toHaveBeenCalled();
  });

  it('go to the tab in front first', async () => {
    const hidden = tab('hidden', ['done'], { visibilityState: 'hidden' });
    const front = tab('front', ['done'], { focused: true, visibilityState: 'visible' });
    const w = worker({ caches: await cachesWith(PREFS), clients: [hidden, front] });
    await w.click('mark-read');
    expect(front.messages.some((m) => m.kind === 'notification-action')).toBe(true);
    expect(hidden.messages.some((m) => m.kind === 'notification-action')).toBe(false);
  });

  it('try the next tab when one declines', async () => {
    const other = tab('other', ['declined']);
    const right = tab('right', ['done']);
    const w = worker({ caches: await cachesWith(PREFS), clients: [other, right] });
    await w.click('mark-read');
    expect(right.messages.some((m) => m.kind === 'notification-action')).toBe(true);
    expect(w.posts()).toHaveLength(0);
  });

  it('use the route with no tab open, and nothing opens when it works', async () => {
    const w = worker({ caches: await cachesWith(PREFS) });
    await w.click('mark-read');
    expect(w.posts()).toHaveLength(1);
    const [url, init] = w.posts()[0];
    expect(url).toBe('/api/push/action');
    expect(init?.credentials).toBe('include');
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'mark-read', accountId: 'a', emailId: 'e1', login: 'fp' });
    expect(w.openWindow).not.toHaveBeenCalled();
  });

  it('send the mirrored archive mode and the time zone with Archive', async () => {
    const w = worker({ caches: await cachesWith(PREFS) });
    await w.click('archive');
    const body = JSON.parse(String(w.posts()[0][1]?.body));
    expect(body).toMatchObject({ action: 'archive', archiveMode: 'month', accountId: 'a', emailId: 'e1', login: 'fp' });
    expect(typeof body.timeZone).toBe('string');
    expect(body.timeZone).not.toBe('');
  });

  it('use the route when a tab never answers, so a frozen tab costs a moment only', async () => {
    const frozen = tab('frozen', []);
    const w = worker({ caches: await cachesWith(PREFS), clients: [frozen] });
    await w.click('mark-read');
    expect(w.posts()).toHaveLength(1);
    expect(frozen.navigate).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 409, 502])('open the message when the route answers %i', async (status) => {
    const w = worker({ caches: await cachesWith(PREFS), fetch: async () => new Response('{}', { status }) });
    await w.click('archive');
    expect(w.posts()).toHaveLength(1);
    expect(w.openWindow).toHaveBeenCalledWith(MESSAGE_URL);
  });

  it('open the message when the route is out of reach', async () => {
    const w = worker({ caches: await cachesWith(PREFS), fetch: async () => { throw new TypeError('offline'); } });
    await w.click('mark-read');
    expect(w.openWindow).toHaveBeenCalledWith(MESSAGE_URL);
  });

  it('open the message when a tab with a live login tried and failed, without the route', async () => {
    const client = tab('t', ['accepted', 'failed']);
    const w = worker({ caches: await cachesWith(PREFS), clients: [client] });
    await w.click('archive');
    expect(w.posts()).toHaveLength(0);
    expect(client.focus).toHaveBeenCalled();
    expect(client.navigate).toHaveBeenCalledWith(MESSAGE_URL);
  });

  it('never post an Archive the mirror says is off', async () => {
    const w = worker({ caches: await cachesWith({ ...PREFS, archiveEnabled: false }) });
    await w.click('archive');
    expect(w.posts()).toHaveLength(0);
    expect(w.openWindow).toHaveBeenCalledWith(MESSAGE_URL);
  });
});

describe('Reply', () => {
  it('opens the composer in an open tab and brings it to the front', async () => {
    const client = tab('t', ['done']);
    const w = worker({ caches: await cachesWith(PREFS), clients: [client] });
    await w.click('reply', { reply: ' Thanks! ' });
    expect(client.messages.find((m) => m.kind === 'notification-action')).toMatchObject({ action: 'reply', emailId: 'e1', text: 'Thanks!' });
    expect(client.focus).toHaveBeenCalled();
    expect(client.navigate).not.toHaveBeenCalled();
    expect(w.posts()).toHaveLength(0);
  });

  it('navigates a tab that has no mail page to the reply link', async () => {
    const client = tab('t', ['declined']);
    const w = worker({ caches: await cachesWith(PREFS), clients: [client] });
    await w.click('reply');
    expect(client.focus).toHaveBeenCalled();
    expect(client.navigate).toHaveBeenCalledWith(`${MESSAGE_URL}&reply=1`);
  });

  it('opens a window on the reply link with no tab open, never through the route', async () => {
    const w = worker({ caches: await cachesWith(PREFS) });
    await w.click('reply');
    expect(w.openWindow).toHaveBeenCalledWith(`${MESSAGE_URL}&reply=1`);
    expect(w.posts()).toHaveLength(0);
  });

  it('keeps typed text in the store for the page, out of the URL', async () => {
    const caches = await cachesWith(PREFS);
    const w = worker({ caches });
    await w.click('reply', { reply: 'Private words' });
    expect(w.openWindow).toHaveBeenCalledWith(`${MESSAGE_URL}&reply=1`);
    const cache = await caches.open(PUSH_CACHE);
    const kept = await (await cache.match(`${ORIGIN}/__push-state/pending-reply`))!.json();
    expect(kept).toMatchObject({ emailId: 'e1', text: 'Private words' });
  });

  it('leaves nothing in the store without typed text', async () => {
    const caches = await cachesWith(PREFS);
    const w = worker({ caches });
    await w.click('reply', { reply: '   ' });
    const cache = await caches.open(PUSH_CACHE);
    expect(await cache.match(`${ORIGIN}/__push-state/pending-reply`)).toBeUndefined();
  });
});

describe('Background Sync', () => {
  it('tells every open tab to flush the outbox', async () => {
    const one = tab('one', []);
    const two = tab('two', []);
    const w = worker({ caches: await cachesWith(), clients: [one, two] });
    await w.dispatch('sync', { tag: 'bulwark-outbox' });
    expect(one.messages).toEqual([{ kind: 'outbox-flush' }]);
    expect(two.messages).toEqual([{ kind: 'outbox-flush' }]);
  });

  it('ignores other tags', async () => {
    const one = tab('one', []);
    const w = worker({ caches: await cachesWith(), clients: [one] });
    await w.dispatch('sync', { tag: 'something-else' });
    expect(one.messages).toEqual([]);
  });

  it('settles with no tab open', async () => {
    const w = worker({ caches: await cachesWith(), clients: [] });
    await expect(w.dispatch('sync', { tag: 'bulwark-outbox' })).resolves.toBeUndefined();
  });
});
