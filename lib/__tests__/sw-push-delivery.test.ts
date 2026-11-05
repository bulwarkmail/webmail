import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

// What one new message, several at once and several accounts turn into on screen.
const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

type Preview = Record<string, unknown> | null;
type Shown = { title: string; body?: unknown; data?: Record<string, unknown>; tag: string; options: Record<string, unknown>; close: () => void };

function loadWorker(preview: (url: URL) => Preview, extra: { clients?: unknown[]; globals?: Record<string, unknown>; prefs?: unknown; quiet?: Record<string, boolean>; openWindow?: (url: string) => Promise<unknown>; registration?: Record<string, unknown> } = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const shade = new Map<string, Shown>();
  const previews: URL[] = [];
  const cacheStore = new Map<string, string>();
  if (extra.prefs) cacheStore.set('https://mail.example.com/__push-state/prefs', JSON.stringify(extra.prefs));
  if (extra.quiet) cacheStore.set('https://mail.example.com/__push-state/quiet-logins', JSON.stringify(extra.quiet));
  const self = {
    location: { href: 'https://mail.example.com/sw.js', origin: 'https://mail.example.com' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => extra.clients ?? [], openWindow: extra.openWindow },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        const tag = String(options.tag ?? '');
        shade.set(tag, { title, body: options.body, data: options.data as Record<string, unknown>, tag, options, close: () => shade.delete(tag) });
      },
      getNotifications: async (filter?: { tag?: string }) => [...shade.values()].filter((n) => !filter?.tag || n.tag === filter.tag),
      ...extra.registration,
    },
  };
  const caches = {
    open: async () => ({
      match: async (key: string) => {
        const value = cacheStore.get(key);
        return value === undefined ? undefined : { json: async () => JSON.parse(value) };
      },
      put: async (key: string, res: { text: () => Promise<string> }) => { cacheStore.set(key, await res.text()); },
    }),
  };
  const fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input, 'https://mail.example.com');
    previews.push(url);
    const body = preview(url);
    return body ? { ok: true, json: async () => body } : { ok: false, status: 401, json: async () => ({}) };
  });
  const context = vm.createContext({ self, caches, fetch: fetchMock, URL, URLSearchParams, Response, Date, console, AbortController, setTimeout, clearTimeout, ...extra.globals });
  vm.runInContext(SW_SOURCE, context);
  async function dispatch(type: string, event: Record<string, unknown>) {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }
  const push = (payload: unknown) => dispatch('push', { data: { json: () => payload } });
  return { push, dispatch, shade, previews };
}

const mail = (id: string, subject = 'Hello') => ({ id, threadId: `t-${id}`, from: [{ name: 'Alice' }], subject, preview: '' });
const delivery = (accountId: string, ...emailIds: string[]) => ({ kind: 'jmap-email-push', accountLabel: 'me@example.org', accountId, emailIds });

afterEach(() => vi.useRealTimers());

describe('a state-change push naming several accounts', () => {
  const stateChange = (changed: Record<string, Record<string, string>>, accountId = Object.keys(changed)[0]) => ({
    kind: 'jmap-state-change', accountLabel: 'me@example.org', accountId, emailIds: [], changed,
  });

  it('notifies for each account with new mail', async () => {
    const { push, shade, previews } = loadWorker((url) => ({ unreadTotal: 1, slot: 0, email: mail(`m-${url.searchParams.get('accountId')}`) }));
    await push(stateChange({ me: { EmailDelivery: 's1', Email: 's1' }, team: { EmailDelivery: 's2' } }));
    expect(previews.map((url) => url.searchParams.get('accountId'))).toEqual(['me', 'team']);
    expect([...shade.keys()].sort()).toEqual(['bulwark-mail:me', 'bulwark-mail:team']);
    expect(shade.get('bulwark-mail:team')?.data).toMatchObject({ accountId: 'team', emailId: 'm-team' });
  });

  it('leaves out an account that only changed some other way', async () => {
    const { push, previews } = loadWorker(() => ({ unreadTotal: 1, slot: 0, email: mail('e1') }));
    await push(stateChange({ quiet: { Mailbox: 's1' }, me: { EmailDelivery: 's2' } }));
    expect(previews.map((url) => url.searchParams.get('accountId'))).toEqual(['me']);
  });

  it('still shows something for a ping without new mail in it', async () => {
    const { push, previews } = loadWorker(() => ({ unreadTotal: 1, slot: 0, email: mail('e1') }));
    await push(stateChange({ me: { Mailbox: 's1' } }));
    expect(previews.map((url) => url.searchParams.get('accountId'))).toEqual(['me']);
  });
});

describe('what a notification counts', () => {
  it('opens the one new message, however much older mail is unread', async () => {
    const { push, shade } = loadWorker(() => ({ unreadTotal: 40, slot: 0, login: 'fp', email: mail('e1') }));
    await push(delivery('a', 'e1'));
    const shown = shade.get('bulwark-mail:a')!;
    expect(shown.body).toBe('Hello');
    expect(shown.data).toMatchObject({ kind: 'email', emailId: 'e1', accountId: 'a', slot: 0, login: 'fp' });
  });

  it('counts the messages it announced, not the unread mail, and opens the inbox for a group', async () => {
    const { push, shade } = loadWorker((url) => ({ unreadTotal: 40, slot: 0, email: mail(String(url.searchParams.get('emailId')), `About ${url.searchParams.get('emailId')}`) }));
    await push(delivery('a', 'e1'));
    await push(delivery('a', 'e2'));
    let shown = shade.get('bulwark-mail:a')!;
    expect(shown.body).toBe('About e2\n+1 more message');
    expect(shown.data).toMatchObject({ kind: 'mail-list', accountId: 'a', slot: 0 });
    await push(delivery('a', 'e3', 'e4'));
    shown = shade.get('bulwark-mail:a')!;
    expect(shown.body).toBe('About e4\n+3 more messages');
  });

  it('starts over once the notification was dismissed', async () => {
    const { push, shade } = loadWorker((url) => ({ unreadTotal: 2, slot: 0, email: mail(String(url.searchParams.get('emailId'))) }));
    await push(delivery('a', 'e1'));
    shade.get('bulwark-mail:a')!.close();
    await push(delivery('a', 'e2'));
    expect(shade.get('bulwark-mail:a')!.data).toMatchObject({ kind: 'email', emailId: 'e2' });
  });

  it('does not count a redelivered message twice', async () => {
    const { push, shade } = loadWorker((url) => ({ unreadTotal: 2, slot: 0, email: mail(String(url.searchParams.get('emailId'))) }));
    await push(delivery('a', 'e1'));
    await push(delivery('a', 'e1'));
    expect(shade.get('bulwark-mail:a')!.data).toMatchObject({ kind: 'email', emailId: 'e1' });
    expect(shade.get('bulwark-mail:a')!.options).toMatchObject({ silent: true });
  });

  it('counts on the state-change path too', async () => {
    let id = 'e1';
    const { push, shade } = loadWorker(() => ({ unreadTotal: 5, slot: 0, email: mail(id) }));
    await push({ kind: 'jmap-state-change', accountId: 'a', changed: { a: { EmailDelivery: 's' } } });
    expect(shade.get('bulwark-mail:a')!.data).toMatchObject({ kind: 'email', emailId: 'e1' });
    id = 'e2';
    await push({ kind: 'jmap-state-change', accountId: 'a', changed: { a: { EmailDelivery: 's2' } } });
    expect(shade.get('bulwark-mail:a')!.body).toBe('Hello\n+1 more message');
  });

  it('says how many new messages without naming any when details are hidden', async () => {
    const { push, shade } = loadWorker((url) => ({ unreadTotal: 9, slot: 0, redacted: true, email: { id: url.searchParams.get('emailId'), threadId: 't' } }));
    await push(delivery('a', 'e1'));
    expect(shade.get('bulwark-mail:a')!.body).toBe('You have new mail');
    expect(shade.get('bulwark-mail:a')!.data).toMatchObject({ kind: 'email', emailId: 'e1' });
    await push(delivery('a', 'e2'));
    expect(shade.get('bulwark-mail:a')!.title).toBe('New mail (me@example.org)');
    expect(shade.get('bulwark-mail:a')!.body).toBe('2 new messages');
  });
});

describe('with notifications off or do not disturb on', () => {
  const quiet = { 'me@example.org': true };

  it('announces nothing for that login: shows and removes at once, without asking for the message', async () => {
    const { push, shade, previews } = loadWorker(() => ({ unreadTotal: 1, slot: 0, email: mail('e1', 'Secret subject') }), { quiet });
    await push(delivery('a', 'e1'));
    expect(shade.size).toBe(0);
    expect(previews).toHaveLength(0);
  });

  it('still announces mail for another login', async () => {
    const { push, shade } = loadWorker(() => ({ unreadTotal: 1, slot: 0, email: mail('e1') }), { quiet: { 'someone-else@example.org': true } });
    await push(delivery('a', 'e1'));
    expect(shade.size).toBe(1);
  });

  it('does not bring the message up later', async () => {
    const off = loadWorker(() => ({ unreadTotal: 1, slot: 0, email: mail('e1') }), { quiet });
    await off.push(delivery('a', 'e1'));
    await off.push(delivery('a', 'e1'));
    expect(off.shade.size).toBe(0);
  });

  it('keeps showing with only the sound off', async () => {
    const { push, shade } = loadWorker(() => ({ unreadTotal: 1, slot: 0, email: mail('e1') }), { prefs: { sound: false } });
    await push(delivery('a', 'e1'));
    expect(shade.get('bulwark-mail:a')!.options).toMatchObject({ silent: true, renotify: false });
  });

  it('shows for a push without a label, or with nothing stored', async () => {
    const { push, shade } = loadWorker(() => ({ unreadTotal: 1, slot: 0, email: mail('e1') }), { quiet });
    await push({ kind: 'jmap-email-push', accountId: 'a', emailIds: ['e1'] });
    expect(shade.size).toBe(1);
  });
});

describe('which login a push is for', () => {
  it('names the login in the preview request', async () => {
    const { push, previews } = loadWorker(() => ({ unreadTotal: 1, slot: 0, email: mail('e1') }));
    await push(delivery('a', 'e1'));
    expect(previews[0].searchParams.get('login')).toBe('me@example.org');
  });

  it('leaves it out when the push has no label', async () => {
    const { push, previews } = loadWorker(() => ({ unreadTotal: 1, slot: 0, email: mail('e1') }));
    await push({ kind: 'jmap-email-push', accountId: 'a', emailIds: ['e1'] });
    expect(previews[0].searchParams.has('login')).toBe(false);
  });
});

describe('when building the notification goes wrong', () => {
  it('still shows one', async () => {
    const { push, shade } = loadWorker(() => ({ unreadTotal: 1, slot: 0, login: 'fp', email: mail('e1') }), {
      globals: { Notification: { get maxActions() { throw new Error('no such thing'); } } },
    });
    await push(delivery('a', 'e1'));
    expect(shade.size).toBe(1);
  });

  it('shows one for a push that is no JSON at all', async () => {
    const { dispatch, shade } = loadWorker(() => null);
    await dispatch('push', { data: { json: () => { throw new SyntaxError('not JSON'); } } });
    expect(shade.size).toBe(1);
  });

  it('shows one for a push without any data', async () => {
    const { dispatch, shade } = loadWorker(() => null);
    await dispatch('push', {});
    expect(shade.size).toBe(1);
  });
});

describe('which window a click uses', () => {
  const win = (id: string, url: string, extra: Record<string, unknown> = {}) => {
    const client = {
      id, url: `https://mail.example.com${url}`, frameType: 'top-level', visibilityState: 'hidden', focused: false,
      postMessage: vi.fn(),
      focus: vi.fn(async () => client),
      navigate: vi.fn(async () => client),
      ...extra,
    };
    return client;
  };
  const clickOn = (w: ReturnType<typeof loadWorker>) => w.dispatch('notificationclick', {
    notification: { tag: 'bulwark-mail:a', close() {}, data: { kind: 'email', emailId: 'e1', accountId: 'a', slot: 0 } },
  });

  it('leaves a pop-out and a frame alone and takes the app window', async () => {
    const popout = win('p', '/popout/message/x');
    const frame = win('f', '/mail/folder/inbox', { frameType: 'nested' });
    const main = win('m', '/mail/folder/inbox');
    const w = loadWorker(() => null, { clients: [popout, frame, main] });
    await clickOn(w);
    expect(popout.navigate).not.toHaveBeenCalled();
    expect(frame.navigate).not.toHaveBeenCalled();
    expect(main.navigate).toHaveBeenCalledWith('/mail/message/e1?slot=0&owner=a');
  });

  it('takes the window in front when there are several', async () => {
    const back = win('b', '/mail/folder/inbox');
    const front = win('f', '/mail/folder/inbox', { focused: true, visibilityState: 'visible' });
    const w = loadWorker(() => null, { clients: [back, front] });
    await clickOn(w);
    expect(front.navigate).toHaveBeenCalled();
    expect(back.navigate).not.toHaveBeenCalled();
  });

  it('opens a new window when only a pop-out is open', async () => {
    const popout = win('p', '/popout/compose');
    const openWindow = vi.fn(async () => null);
    const w = loadWorker(() => null, { clients: [popout], openWindow });
    await clickOn(w);
    expect(popout.navigate).not.toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledWith('/mail/message/e1?slot=0&owner=a');
  });
});

describe('nothing new to say', () => {
  it('removes only what it showed itself', async () => {
    const { push, shade } = loadWorker(() => ({ unreadTotal: 0, email: null }));
    await push({ kind: 'jmap-state-change', accountId: 'a', changed: { a: { EmailDelivery: 's' } } });
    expect(shade.size).toBe(0);
  });

  it('still shows something when the browser cannot list its notifications', async () => {
    const shown: string[] = [];
    const w = loadWorker(() => ({ unreadTotal: 0, email: null }), {
      registration: {
        showNotification: async (title: string) => { shown.push(title); },
        getNotifications: async () => { throw new Error('nope'); },
      },
    });
    await w.push({ kind: 'jmap-state-change', accountId: 'a', changed: { a: { EmailDelivery: 's' } } });
    expect(shown).toHaveLength(1);
  });

  it('uses its own tag, so it can never replace a real notification', async () => {
    const tags: string[] = [];
    const w = loadWorker(() => ({ unreadTotal: 0, email: null }), {
      registration: {
        showNotification: async (_title: string, options: { tag: string }) => { tags.push(options.tag); },
        getNotifications: async () => [],
      },
    });
    await w.push({ kind: 'jmap-state-change', accountId: 'a', changed: { a: { EmailDelivery: 's' } } });
    expect(tags).toHaveLength(1);
    expect(tags[0]).not.toBe('bulwark-mail:a');
  });
});

describe('a push naming several accounts, one server slow', () => {
  it('does not make the others wait out its deadline', async () => {
    const started: string[] = [];
    let release = () => {};
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const fetchSlow = vi.fn(async (input: string) => {
      const url = new URL(input, 'https://mail.example.com');
      const account = url.searchParams.get('accountId') ?? '';
      started.push(account);
      if (account === 'slow') await slow;
      return { ok: true, json: async () => ({ unreadTotal: 1, slot: 0, email: mail(`m-${account}`) }) };
    });
    const w = loadWorker(() => null, { globals: { fetch: fetchSlow } });
    const done = w.push({ kind: 'jmap-state-change', accountId: 'slow', changed: { slow: { EmailDelivery: 's' }, fast: { EmailDelivery: 's' } } });
    await vi.waitFor(() => expect(started).toEqual(['slow', 'fast']));
    await vi.waitFor(() => expect(w.shade.has('bulwark-mail:fast')).toBe(true));
    release();
    await done;
    expect(w.shade.size).toBe(2);
  });
});

describe('when the preview is signed out (#1509)', () => {
  const ping = { kind: 'jmap-state-change', accountLabel: 'me@example.org', accountId: 'a', changed: { a: { EmailDelivery: 's1' } } };

  it('shows the generic notification without a sound for a push that names no message', async () => {
    const { push, shade } = loadWorker(() => null);
    await push(ping);
    const shown = shade.get('bulwark-mail:a')!;
    expect(shown.title).toBe('New mail (me@example.org)');
    expect(shown.options).toMatchObject({ silent: true, renotify: false });
  });

  it('still rings when the server named the new message', async () => {
    const { push, shade } = loadWorker(() => null);
    await push(delivery('a', 'e1'));
    expect(shade.get('bulwark-mail:a')!.options).toMatchObject({ silent: false, renotify: true });
  });

  it('still rings when the preview failed some other way', async () => {
    const down = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }));
    const { push, shade } = loadWorker(() => null, { globals: { fetch: down } });
    await push(ping);
    expect(shade.get('bulwark-mail:a')!.options).toMatchObject({ silent: false, renotify: true });
  });
});

// -- end of cases --
