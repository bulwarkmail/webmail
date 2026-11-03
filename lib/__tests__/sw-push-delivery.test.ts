import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

// What one new message, several at once and several accounts turn into on screen.
const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

type Preview = Record<string, unknown> | null;
type Shown = { title: string; body?: unknown; data?: Record<string, unknown>; tag: string; options: Record<string, unknown>; close: () => void };

function loadWorker(preview: (url: URL) => Preview, extra: { clients?: unknown[]; globals?: Record<string, unknown>; prefs?: unknown; openWindow?: (url: string) => Promise<unknown> } = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const shade = new Map<string, Shown>();
  const previews: URL[] = [];
  const cacheStore = new Map<string, string>();
  if (extra.prefs) cacheStore.set('https://mail.example.com/__push-state/prefs', JSON.stringify(extra.prefs));
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
  it('announces nothing: shows and removes at once, without asking for the message', async () => {
    const { push, shade, previews } = loadWorker(() => ({ unreadTotal: 1, slot: 0, email: mail('e1', 'Secret subject') }), { prefs: { sound: false, show: false } });
    await push(delivery('a', 'e1'));
    expect(shade.size).toBe(0);
    expect(previews).toHaveLength(0);
  });

  it('does not bring the message up later when turned on again', async () => {
    const off = loadWorker(() => ({ unreadTotal: 1, slot: 0, email: mail('e1') }), { prefs: { sound: false, show: false } });
    await off.push(delivery('a', 'e1'));
    const { push, shade } = off;
    // Same store, now switched on: a redelivery stays quiet.
    await push(delivery('a', 'e1'));
    expect(shade.size).toBe(0);
  });

  it('keeps showing with only the sound off', async () => {
    const { push, shade } = loadWorker(() => ({ unreadTotal: 1, slot: 0, email: mail('e1') }), { prefs: { sound: false, show: true } });
    await push(delivery('a', 'e1'));
    expect(shade.get('bulwark-mail:a')!.options).toMatchObject({ silent: true, renotify: false });
  });

  it('shows as before for prefs written by an older page', async () => {
    const { push, shade } = loadWorker(() => ({ unreadTotal: 1, slot: 0, email: mail('e1') }), { prefs: { sound: true } });
    await push(delivery('a', 'e1'));
    expect(shade.size).toBe(1);
  });
});

// -- end of cases --
