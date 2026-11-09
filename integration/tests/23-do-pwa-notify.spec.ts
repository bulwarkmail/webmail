import { test, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { JMAP_URL } from './helpers/config';
import { ENT, adminContext, deliver, jmapAs, requireEntEnv, userPage, withPolicy } from './helpers/ent';

/**
 * A notification's Archive, Mark read and Reply, and Background Sync, in
 * Chromium with the real service worker of a production build, the real
 * /api/push/preview and /api/push/action, and a VM 106 test Stalwart.
 *
 * Headless Chromium has no toasts to click, and a page can't make a browser
 * send a trusted notificationclick. So the spec dispatches the event inside
 * the real worker, on its real listener: an Event carrying `action`, the
 * `notification` the browser really shows, and a waitUntil of its own
 * (ExtendableEvent.waitUntil refuses a synthetic event). Everything after
 * that is real: matchAll, postMessage to the page, the cookies on the route.
 * What can't run this way is openWindow, focus and navigate, which want the
 * browser's user activation, so those are recorded on the worker's side and
 * the spec then opens the recorded URL itself.
 *
 * The account is ent-dave, whom the other specs leave alone: the one-message
 * notification needs an Inbox with exactly one unread message.
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);
// The headless shell denies notifications whatever is granted; full Chromium
// in headless mode really shows them, buttons and all, to getNotifications.
test.use({ channel: 'chromium' });

const RUN = Date.now().toString(36);
let serial = 0;
const USER = ENT.dave;

interface ShownNotification {
  title: string;
  data: Record<string, unknown>;
  actions: Array<{ action: string; title: string; type?: string }>;
}

async function workerOf(context: BrowserContext, page: Page): Promise<Worker> {
  // A production build registers the worker; the dev server removes it.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => context.serviceWorkers().length, { timeout: 30_000 }).toBeGreaterThan(0);
  const sw = context.serviceWorkers().at(-1)!;
  // What needs the user activation a dispatched click doesn't have.
  await sw.evaluate(() => {
    const self_ = globalThis as unknown as { __opened: string[]; __posts: string[]; clients: Record<string, unknown>; fetch: typeof fetch };
    if (self_.__opened) return;
    self_.__opened = [];
    self_.__posts = [];
    self_.clients.openWindow = async (url: string) => { self_.__opened.push(url); return null; };
    const realFetch = self_.fetch.bind(globalThis);
    self_.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') self_.__posts.push(String(input));
      return realFetch(input, init);
    }) as typeof fetch;
  });
  return sw;
}

/** The real listener, with what the browser would pass. Resolves when its waitUntil settled. */
async function click(sw: Worker, action: string, data: Record<string, unknown>, reply?: string): Promise<void> {
  await sw.evaluate(async ({ action: a, data: d, reply: r }) => {
    const waits: Promise<unknown>[] = [];
    const event = new Event('notificationclick') as Event & Record<string, unknown>;
    Object.assign(event, {
      action: a,
      reply: r ?? null,
      notification: { data: d, tag: 'spec', close() {} },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    self.dispatchEvent(event);
    await Promise.all(waits);
  }, { action, data, reply });
}

/**
 * `keepShown`: leave the account's notification on screen. By default the user
 * has dealt with it first: one still showing keeps the messages it announced,
 * and the next push adds "+N more" to them (7fb0242a7), a group with no buttons.
 */
async function pushed(sw: Worker, accountId: string, emailId: string, keepShown = false): Promise<ShownNotification> {
  return sw.evaluate(async ({ accountId: account, emailId: id, keepShown: keep }) => {
    const registration_ = (self as unknown as { registration: ServiceWorkerRegistration }).registration;
    if (!keep) for (const old of await registration_.getNotifications({ tag: `bulwark-mail:${account}` })) old.close();
    const waits: Promise<unknown>[] = [];
    const event = new Event('push') as Event & Record<string, unknown>;
    Object.assign(event, {
      data: { json: () => ({ kind: 'jmap-email-push', accountId: account, emailIds: [id] }) },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    self.dispatchEvent(event);
    await Promise.all(waits);
    const registration = (self as unknown as { registration: ServiceWorkerRegistration }).registration;
    const [shown] = await registration.getNotifications({ tag: `bulwark-mail:${account}` });
    return { title: shown.title, data: shown.data, actions: [...(shown as unknown as { actions: ShownNotification['actions'] }).actions] };
  }, { accountId, emailId, keepShown });
}

async function opened(sw: Worker): Promise<string[]> {
  return sw.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened.splice(0));
}

async function routePosts(sw: Worker): Promise<string[]> {
  return sw.evaluate(() => (globalThis as unknown as { __posts: string[] }).__posts.splice(0));
}

/** Everything unread in the Inbox read, then one new message: what makes a notification name it. */
async function oneUnread(): Promise<{ id: string; subject: string; accountId: string }> {
  const client = await jmapAs(USER);
  const inbox = await client.mailboxByRole('inbox');
  const query = await client.request([
    ['Email/query', { accountId: client.accountId, filter: { inMailbox: inbox!.id, notKeyword: '$seen' } }, 'q'],
  ]);
  const unread: string[] = query.methodResponses[0][1].ids;
  if (unread.length > 0) {
    await client.request([['Email/set', {
      accountId: client.accountId,
      update: Object.fromEntries(unread.map((id) => [id, { 'keywords/$seen': true }])),
    }, 's']]);
  }
  const subject = `Notify ${RUN} ${++serial}`;
  await deliver({ from: ENT.bob, to: [USER], subject, text: 'Please answer.' });
  const email = await client.waitForEmail(subject, { mailboxId: inbox!.id, timeoutMs: 30_000 });
  return { id: email.id, subject, accountId: client.accountId };
}

async function serverCopy(emailId: string): Promise<{ keywords: Record<string, boolean>; mailboxIds: Record<string, boolean>; receivedAt: string }> {
  const client = await jmapAs(USER);
  const res = await client.request([['Email/get', { accountId: client.accountId, ids: [emailId], properties: ['keywords', 'mailboxIds', 'receivedAt'] }, 'g']]);
  return res.methodResponses[0][1].list[0];
}

async function archiveFolderId(): Promise<string | undefined> {
  const client = await jmapAs(USER);
  return (await client.mailboxByRole('archive'))?.id;
}

test.beforeAll(() => requireEntEnv());

test.describe('with the app open', () => {
  let page: Page;
  let context: BrowserContext;
  let sw: Worker;

  test.beforeAll(async ({ browser }) => {
    page = await userPage(browser, USER);
    context = page.context();
    await context.grantPermissions(['notifications']);
    sw = await workerOf(context, page);
    // The mirror reaches the worker's store after the app has started.
    await expect.poll(() => sw.evaluate(async () => {
      const cache = await caches.open('bulwark-push-state-v1');
      const hit = await cache.match(`${self.location.origin}/__push-state/actions`);
      return hit ? (await hit.json()).labels?.archive : null;
    }), { timeout: 30_000 }).toBe('Archive');
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('a push for one message shows the buttons the browser has room for', async () => {
    const mail = await oneUnread();
    const shown = await pushed(sw, mail.accountId, mail.id);
    expect(shown.title).toContain(ENT.bob.split('@')[0]);
    expect(shown.data).toMatchObject({ kind: 'email', emailId: mail.id, accountId: mail.accountId });
    expect(typeof shown.data.login).toBe('string');
    const max = await sw.evaluate(() => (Notification as unknown as { maxActions: number }).maxActions);
    const names = shown.actions.map((a) => a.action);
    expect(names.length).toBe(Math.min(3, max));
    expect(names).toContain('reply');
    expect(names).toContain('archive');
    expect(shown.actions.find((a) => a.action === 'archive')?.title).toBe('Archive');
    // Chromium has `reply` on the event: the text field.
    expect(shown.actions.find((a) => a.action === 'reply')?.type).toBe('text');
  });

  test('a group of messages gets no buttons', async () => {
    const client = await jmapAs(USER);
    const first = await oneUnread();
    const subject = `Notify ${RUN} second`;
    await deliver({ from: ENT.bob, to: [USER], subject, text: 'Another.' });
    const second = await client.waitForEmail(subject, { timeoutMs: 30_000 });
    // The first one's notification is still on screen when the second comes.
    await pushed(sw, first.accountId, first.id);
    const shown = await pushed(sw, first.accountId, second.id, true);
    expect(shown.data.kind).toBe('mail-list');
    expect(shown.actions).toEqual([]);
  });

  test('Mark read goes to the open tab, which marks it in the list too, not to the route', async () => {
    const mail = await oneUnread();
    const shown = await pushed(sw, mail.accountId, mail.id);
    await routePosts(sw);
    await click(sw, 'mark-read', shown.data);
    await expect.poll(async () => (await serverCopy(mail.id)).keywords.$seen === true, { timeout: 15_000 }).toBe(true);
    expect(await routePosts(sw)).toEqual([]);
    expect(await opened(sw)).toEqual([]);
  });

  test('Archive goes to the open tab and files the message by the store', async () => {
    const mail = await oneUnread();
    const shown = await pushed(sw, mail.accountId, mail.id);
    await routePosts(sw);
    await click(sw, 'archive', shown.data);
    const client = await jmapAs(USER);
    const inbox = await client.mailboxByRole('inbox');
    await expect.poll(async () => !(await serverCopy(mail.id)).mailboxIds[inbox!.id], { timeout: 20_000 }).toBe(true);
    const archive = await archiveFolderId();
    expect(archive).toBeTruthy();
    expect(Object.keys((await serverCopy(mail.id)).mailboxIds)).toEqual([archive]);
    expect(await routePosts(sw)).toEqual([]);
  });

  test('a body click still opens the message and runs nothing', async () => {
    const mail = await oneUnread();
    const shown = await pushed(sw, mail.accountId, mail.id);
    await routePosts(sw);
    // focus() needs the activation a dispatched click lacks, so this ends in openWindow.
    await click(sw, '', shown.data);
    const urls = await opened(sw);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/mail/message/${mail.id}`);
    expect(urls[0]).not.toContain('reply=1');
    expect(await routePosts(sw)).toEqual([]);
    expect((await serverCopy(mail.id)).keywords.$seen).toBeFalsy();
  });

  test('Reply opens the composer in the open tab, with the text typed on the notification', async () => {
    const mail = await oneUnread();
    const shown = await pushed(sw, mail.accountId, mail.id);
    await routePosts(sw);
    await click(sw, 'reply', shown.data, `Typed on the toast ${RUN}`);
    await expect.poll(async () => page.evaluate((subjectText) => {
      const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[];
      return inputs.some((input) => input.value === `Re: ${subjectText}`);
    }, mail.subject), { timeout: 20_000 }).toBe(true);
    await expect(page.getByText(`Typed on the toast ${RUN}`).first()).toBeVisible({ timeout: 10_000 });
    expect(await routePosts(sw)).toEqual([]);
    expect(await opened(sw)).toEqual([]);
  });
});

test.describe('Background Sync', () => {
  test('a queued change registers the tag, and a sync event makes a tab that missed `online` flush it', async ({ browser }) => {
    const page = await userPage(browser, USER);
    const context = page.context();
    await context.grantPermissions(['notifications', 'background-sync']);
    const sw = await workerOf(context, page);
    await page.addInitScript(() => {
      const w = window as unknown as { __syncTags: string[] };
      w.__syncTags = [];
      const register = SyncManager.prototype.register;
      SyncManager.prototype.register = function patched(tag: string) {
        w.__syncTags.push(tag);
        return register.call(this, tag);
      };
    });
    await page.goto('/settings/backup/offline');
    const toggle = page.getByTestId('offline-switch');
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
    await expect(page.getByTestId('offline-status')).toContainText('updated', { timeout: 180_000 });
    await page.goto('/mail');
    await expect(page.locator('[data-testid="email-list-item"]').first()).toBeVisible({ timeout: 60_000 });

    const mail = await oneUnread();
    const shown = await pushed(sw, mail.accountId, mail.id);

    // The mail server is gone, the browser still online: no `online` event will come.
    const block = `${new URL(JMAP_URL).origin}/**`;
    await context.route(block, (route) => route.abort('internetdisconnected'));
    await page.keyboard.press('Shift+G');
    await expect(page.getByTestId('offline-banner')).toContainText("The mail server can't be reached", { timeout: 60_000 });

    // The tab queues the change, as it does for its own Mark read button.
    await click(sw, 'mark-read', shown.data);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __syncTags: string[] }).__syncTags)).toContain('bulwark-outbox');
    expect((await serverCopy(mail.id)).keywords.$seen).toBeFalsy();

    await context.unroute(block);
    await sw.evaluate(async () => {
      const waits: Promise<unknown>[] = [];
      const event = new Event('sync') as Event & Record<string, unknown>;
      Object.assign(event, { tag: 'bulwark-outbox', waitUntil: (p: Promise<unknown>) => waits.push(p) });
      self.dispatchEvent(event);
      await Promise.all(waits);
    });
    await expect.poll(async () => (await serverCopy(mail.id)).keywords.$seen === true, { timeout: 30_000 }).toBe(true);

    // Offline mode stays local to this context, which ends here.
    await context.close();
  });
});

test.describe('with no tab open', () => {
  let page: Page;
  let context: BrowserContext;
  let sw: Worker;

  /** A blank tab keeps the context alive: it's outside the worker's scope. */
  async function closeTheApp(): Promise<Page> {
    const blank = await context.newPage();
    await page.close();
    await expect.poll(() => sw.evaluate(async () => (await (self as unknown as { clients: Clients }).clients.matchAll({ type: 'window', includeUncontrolled: true })).length)).toBe(0);
    return blank;
  }

  test.beforeEach(async ({ browser }) => {
    page = await userPage(browser, USER);
    context = page.context();
    await context.grantPermissions(['notifications']);
    sw = await workerOf(context, page);
    await expect.poll(() => sw.evaluate(async () => {
      const cache = await caches.open('bulwark-push-state-v1');
      return !!(await cache.match(`${self.location.origin}/__push-state/actions`));
    }), { timeout: 30_000 }).toBe(true);
  });

  test.afterEach(async () => {
    await context.close();
  });

  test('Mark read goes through the route on the context cookie', async () => {
    const mail = await oneUnread();
    const shown = await pushed(sw, mail.accountId, mail.id);
    await closeTheApp();
    await routePosts(sw);
    await click(sw, 'mark-read', shown.data);
    expect((await routePosts(sw)).at(-1)).toContain('/api/push/action');
    expect((await serverCopy(mail.id)).keywords.$seen).toBe(true);
    expect(await opened(sw)).toEqual([]);
  });

  test('Archive goes through the route, to the folder the app uses', async () => {
    const mail = await oneUnread();
    const shown = await pushed(sw, mail.accountId, mail.id);
    await closeTheApp();
    await click(sw, 'archive', shown.data);
    const archive = await archiveFolderId();
    expect(archive).toBeTruthy();
    expect(Object.keys((await serverCopy(mail.id)).mailboxIds)).toEqual([archive]);
    expect(await opened(sw)).toEqual([]);
  });

  test('Archive follows the mirrored mode into year and month folders', async () => {
    const mail = await oneUnread();
    const shown = await pushed(sw, mail.accountId, mail.id);
    await sw.evaluate(async () => {
      const cache = await caches.open('bulwark-push-state-v1');
      const key = `${self.location.origin}/__push-state/actions`;
      const prefs = await (await cache.match(key))!.json();
      await cache.put(key, new Response(JSON.stringify({ ...prefs, archiveMode: 'month' })));
    });
    await closeTheApp();
    await click(sw, 'archive', shown.data);
    const client = await jmapAs(USER);
    const copy = await serverCopy(mail.id);
    const [folderId] = Object.keys(copy.mailboxIds);
    const folders = await client.mailboxes();
    const month = folders.find((f) => f.id === folderId)!;
    const year = folders.find((f) => f.id === month.parentId)!;
    const when = new Date(copy.receivedAt);
    expect(month.name).toBe(String(when.getMonth() + 1).padStart(2, '0'));
    expect(year.name).toBe(String(when.getFullYear()));
    expect(year.parentId).toBe(await archiveFolderId());
  });

  test('Archive makes the Archive, year and month folders on an account without them', async () => {
    const client = await jmapAs(USER);
    const mail = await oneUnread();
    const shown = await pushed(sw, mail.accountId, mail.id);
    await sw.evaluate(async () => {
      const cache = await caches.open('bulwark-push-state-v1');
      const key = `${self.location.origin}/__push-state/actions`;
      const prefs = await (await cache.match(key))!.json();
      await cache.put(key, new Response(JSON.stringify({ ...prefs, archiveMode: 'month' })));
    });
    await closeTheApp();
    // Out of the way, so the account has no Archive for the moment.
    const old = await client.mailboxByRole('archive');
    const oldName = `Old archive ${RUN}`;
    if (old) {
      const renamed = await client.request([['Mailbox/set', { accountId: client.accountId, update: { [old.id]: { name: oldName, role: null } } }, 'r']]);
      expect(renamed.methodResponses[0][1].updated).toHaveProperty(old.id);
    }

    await click(sw, 'archive', shown.data);

    expect(await opened(sw)).toEqual([]);
    const created = await client.mailboxByRole('archive');
    expect(created?.name).toBe('Archive');
    expect(created?.id).not.toBe(old?.id);
    const copy = await serverCopy(mail.id);
    const folders = await client.mailboxes();
    const month = folders.find((f) => f.id === Object.keys(copy.mailboxIds)[0])!;
    const year = folders.find((f) => f.id === month.parentId)!;
    expect(year.parentId).toBe(created!.id);

    if (old) {
      // Only this spec's messages live in ent-dave's Archive.
      await client.request([['Mailbox/set', { accountId: client.accountId, destroy: [old.id], onDestroyRemoveEmails: true }, 'd']]);
    }
  });

  test('with an enabled plugin that may stop it, the route is skipped and the message opens', async () => {
    const mail = await oneUnread();
    const shown = await pushed(sw, mail.accountId, mail.id);
    await sw.evaluate(async () => {
      const cache = await caches.open('bulwark-push-state-v1');
      const key = `${self.location.origin}/__push-state/actions`;
      const prefs = await (await cache.match(key))!.json();
      await cache.put(key, new Response(JSON.stringify({ ...prefs, pluginsMayVeto: true })));
    });
    await closeTheApp();
    await routePosts(sw);
    await click(sw, 'mark-read', shown.data);
    expect(await routePosts(sw)).toEqual([]);
    expect((await opened(sw))[0]).toContain(`/mail/message/${mail.id}`);
    expect((await serverCopy(mail.id)).keywords.$seen).toBeFalsy();
  });

  test('a message since moved to Trash stays there, and opens in the app', async () => {
    const mail = await oneUnread();
    const shown = await pushed(sw, mail.accountId, mail.id);
    await closeTheApp();
    const client = await jmapAs(USER);
    const trash = await client.mailboxByRole('trash');
    await client.moveEmail(mail.id, trash!.id);
    await click(sw, 'archive', shown.data);
    expect((await opened(sw))[0]).toContain(`/mail/message/${mail.id}`);
    expect(Object.keys((await serverCopy(mail.id)).mailboxIds)).toEqual([trash!.id]);
  });

  test('with the context cookie and the remembered login gone the message opens instead, and stays as it was', async () => {
    const mail = await oneUnread();
    const shown = await pushed(sw, mail.accountId, mail.id);
    await closeTheApp();
    const jar = await context.cookies();
    // Without the context cookie the route takes the remembered login, as a
    // browser closed and woken by a push has only that (6ffa0a371).
    await context.clearCookies({ name: /^(jmap_stalwart_ctx|jmap_session)/ });
    expect(jar.some((c) => c.name.startsWith('jmap_stalwart_ctx'))).toBe(true);
    expect(jar.some((c) => c.name.startsWith('jmap_session'))).toBe(true);
    await routePosts(sw);
    await click(sw, 'mark-read', shown.data);
    expect((await routePosts(sw)).at(-1)).toContain('/api/push/action');
    const urls = await opened(sw);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/mail/message/${mail.id}`);
    expect((await serverCopy(mail.id)).keywords.$seen).toBeFalsy();
    // The next tests open the app with the remembered login, as before.
    await context.addCookies(jar.filter((c) => c.name.startsWith('jmap_session')));
  });

  test('a notification from a login no longer signed in acts on nothing', async () => {
    const mail = await oneUnread();
    const shown = await pushed(sw, mail.accountId, mail.id);
    await closeTheApp();
    await click(sw, 'mark-read', { ...shown.data, login: 'someone-else' });
    expect(await opened(sw)).toHaveLength(1);
    expect((await serverCopy(mail.id)).keywords.$seen).toBeFalsy();
  });

  test('Reply opens the link, the composer opens once with the typed text, and a reload leaves it shut', async () => {
    const mail = await oneUnread();
    const shown = await pushed(sw, mail.accountId, mail.id);
    const blank = await closeTheApp();
    await click(sw, 'reply', shown.data, `Typed while closed ${RUN}`);
    const [url] = await opened(sw);
    expect(url).toContain(`/mail/message/${mail.id}`);
    expect(url).toContain('reply=1');
    expect(url).not.toContain('Typed');

    page = await context.newPage();
    await page.goto(url);
    await blank.close();
    const replyInput = () => page.evaluate((subjectText) => {
      const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[];
      return inputs.some((input) => input.value === `Re: ${subjectText}`);
    }, mail.subject);
    await expect.poll(replyInput, { timeout: 45_000 }).toBe(true);
    await expect(page.getByText(`Typed while closed ${RUN}`).first()).toBeVisible({ timeout: 10_000 });
    expect(page.url()).not.toContain('reply=1');

    // Leave the draft and come back: the link's job is done.
    await page.reload();
    await expect(page.getByText('Please answer.').first()).toBeVisible({ timeout: 45_000 });
    expect(await replyInput()).toBe(false);
  });
});

test.describe('Reply in the Pro shell', () => {
  test('opens the composer in the message tab, with the typed text, from the live tab and from the link', async ({ browser }) => {
    const page = await userPage(browser, USER);
    const context = page.context();
    await context.grantPermissions(['notifications']);
    await page.evaluate(() => {
      const raw = localStorage.getItem('settings-storage');
      const stored = raw ? JSON.parse(raw) : { state: {} };
      stored.state = { ...stored.state, proInterface: true };
      localStorage.setItem('settings-storage', JSON.stringify(stored));
    });
    await page.goto('/pro');
    await expect(page.locator('[data-pro-takeover]')).toHaveCount(0, { timeout: 60_000 });
    const sw = await workerOf(context, page);
    const replyIsOpen = (subject: string) => page.evaluate((text) => {
      const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[];
      return inputs.some((input) => input.value === `Re: ${text}`);
    }, subject);

    const live = await oneUnread();
    const liveShown = await pushed(sw, live.accountId, live.id);
    // Until the shell's mail surface is up the tab declines, and the worker
    // falls back to the link: ask again. Taken once, no window opens.
    await expect.poll(async () => {
      await click(sw, 'reply', liveShown.data, `Pro typed ${RUN}`);
      return (await opened(sw)).length;
    }, { timeout: 45_000, intervals: [3_000] }).toBe(0);
    await expect.poll(() => replyIsOpen(live.subject), { timeout: 30_000 }).toBe(true);
    await expect(page.getByText(`Pro typed ${RUN}`).first()).toBeVisible({ timeout: 10_000 });

    const linked = await oneUnread();
    await page.goto(`/mail/message/${linked.id}?owner=${linked.accountId}&reply=1`);
    await expect.poll(() => replyIsOpen(linked.subject), { timeout: 60_000 }).toBe(true);
    await context.close();
  });
});

test.describe('session limits', () => {
  test('under a maximum session age the route answers 401 and writes nothing', async ({ browser }) => {
    const admin = await adminContext(browser);
    const page = await userPage(browser, USER);
    await page.context().grantPermissions(['notifications']);
    const sw = await workerOf(page.context(), page);
    const mail = await oneUnread();
    const shown = await pushed(sw, mail.accountId, mail.id);
    await withPolicy(admin, { organisation: { session: { idleMinutes: 0, maxHours: 8, warnSeconds: 60 } } }, async () => {
      const res = await page.request.post('/api/push/action', {
        data: { action: 'mark-read', accountId: mail.accountId, emailId: mail.id, login: shown.data.login },
      });
      expect(res.status()).toBe(401);
    });
    expect((await serverCopy(mail.id)).keywords.$seen).toBeFalsy();
    await page.context().close();
    await admin.close();
  });
});

test.describe('the route, as a page or another site would call it', () => {
  test('refuses a cross-site POST at the gate, with the cookies on it', async ({ browser }) => {
    const page = await userPage(browser, USER);
    const mail = await oneUnread();
    const res = await page.request.post('/api/push/action', {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
      data: { action: 'mark-read', accountId: mail.accountId, emailId: mail.id, login: 'x' },
    });
    expect(res.status()).toBe(403);
    expect((await serverCopy(mail.id)).keywords.$seen).toBeFalsy();
    await page.context().close();
  });

  test('refuses another account of the same login, and answers 401 without cookies', async ({ browser }) => {
    const page = await userPage(browser, USER);
    await page.context().grantPermissions(['notifications']);
    const sw = await workerOf(page.context(), page);
    const mail = await oneUnread();
    const shown = await pushed(sw, mail.accountId, mail.id);
    const post = (over: Record<string, unknown>) => page.request.post('/api/push/action', {
      data: { action: 'mark-read', accountId: mail.accountId, emailId: mail.id, login: shown.data.login, ...over },
    });
    expect((await post({ accountId: 'zzzzzz' })).status()).toBe(403);
    expect((await serverCopy(mail.id)).keywords.$seen).toBeFalsy();
    // The remembered login counts too (6ffa0a371): without cookies is without both.
    await page.context().clearCookies({ name: /^(jmap_stalwart_ctx|jmap_session)/ });
    expect((await post({})).status()).toBe(401);
    expect((await serverCopy(mail.id)).keywords.$seen).toBeFalsy();
    await page.context().close();
  });
});
