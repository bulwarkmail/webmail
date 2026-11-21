import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// #1516: with the app closed, a push keeps the installed app's icon badge at
// the number the page would show: the page's last total with the pushed
// login's Inbox share replaced by its unread count now.

const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');
const BADGE_KEY = 'https://mail.example.com/__push-state/app-badge';

interface BadgeState { enabled: boolean; total: number; logins: Record<string, { accountId: string; unread: number }> }

function loadWorker(preview: (url: URL) => Record<string, unknown>, options: { state?: BadgeState; windows?: unknown[]; badging?: boolean } = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const cacheStore = new Map<string, string>();
  if (options.state) cacheStore.set(BADGE_KEY, JSON.stringify(options.state));
  const setAppBadge = vi.fn(async () => {});
  const clearAppBadge = vi.fn(async () => {});
  const self = {
    location: { href: 'https://mail.example.com/sw.js', origin: 'https://mail.example.com' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => options.windows ?? [] },
    navigator: options.badging === false ? {} : { setAppBadge, clearAppBadge },
    registration: { showNotification: async () => {}, getNotifications: async () => [] },
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
    return { ok: true, json: async () => preview(url) };
  });
  const context = vm.createContext({ self, caches, fetch: fetchMock, URL, URLSearchParams, Response, Date, console, AbortController, setTimeout, clearTimeout });
  vm.runInContext(SW_SOURCE, context);
  async function push(payload: unknown) {
    const waits: Promise<unknown>[] = [];
    listeners.get('push')?.({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }
  const stored = () => (cacheStore.has(BADGE_KEY) ? JSON.parse(cacheStore.get(BADGE_KEY)!) as BadgeState : null);
  return { push, setAppBadge, clearAppBadge, stored };
}

const mail = (id: string) => ({ id, threadId: `t-${id}`, from: [{ name: 'Alice' }], subject: 'Hi', preview: '' });
const delivery = (accountId: string, id: string, accountLabel = 'me@example.org') => ({ kind: 'jmap-email-push', accountLabel, accountId, emailIds: [id] });
// Two logins counted: 2 unread in mine, 3 in the other's.
const twoLogins: BadgeState = {
  enabled: true,
  total: 5,
  logins: { 'me@example.org': { accountId: 'a', unread: 2 }, 'other@example.net': { accountId: 'b', unread: 3 } },
};

describe('the app badge on push, with the app closed (#1516)', () => {
  it('swaps the pushed login\'s share for its Inbox count now, keeping the other login\'s', async () => {
    const { push, setAppBadge, stored } = loadWorker(() => ({ unreadTotal: 4, inboxUnread: 4, slot: 0, email: mail('e1') }), { state: twoLogins });
    await push(delivery('a', 'e1'));
    expect(setAppBadge).toHaveBeenLastCalledWith(7);
    expect(stored()).toMatchObject({ total: 7, logins: { 'me@example.org': { unread: 4 }, 'other@example.net': { unread: 3 } } });
  });

  it('does not count the same unread mail twice when pushes repeat', async () => {
    const { push, setAppBadge } = loadWorker(() => ({ unreadTotal: 4, inboxUnread: 4, slot: 0, email: mail('e1') }), { state: twoLogins });
    await push(delivery('a', 'e1'));
    await push(delivery('a', 'e2'));
    expect(setAppBadge).toHaveBeenLastCalledWith(7);
  });

  it('takes the badge off when nothing is unread any more', async () => {
    const { push, setAppBadge, clearAppBadge } = loadWorker(() => ({ unreadTotal: 0, inboxUnread: 0, slot: 0, email: null }), {
      state: { enabled: true, total: 2, logins: { 'me@example.org': { accountId: 'a', unread: 2 } } },
    });
    await push(delivery('a', 'e1'));
    expect(clearAppBadge).toHaveBeenCalled();
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it('leaves the badge alone where it cannot know the number', async () => {
    const preview = () => ({ unreadTotal: 9, inboxUnread: 9, slot: 0, email: mail('e1') });
    const cases = [
      // A window is open: the page badges the icon itself.
      { state: twoLogins, windows: [{ id: 'w' }], payload: delivery('a', 'e1') },
      // The badge setting is off.
      { state: { ...twoLogins, enabled: false }, payload: delivery('a', 'e1') },
      // A shared account the page doesn't count.
      { state: twoLogins, payload: delivery('team', 'e1') },
      // A login the page doesn't count ("count every account" off, or a user name two logins share).
      { state: twoLogins, payload: delivery('a', 'e1', 'third@example.com') },
      // The page never left a number.
      { state: undefined, payload: delivery('a', 'e1') },
    ];
    for (const { state, windows, payload } of cases) {
      const { push, setAppBadge, clearAppBadge } = loadWorker(preview, { state, windows });
      await push(payload);
      expect(setAppBadge).not.toHaveBeenCalled();
      expect(clearAppBadge).not.toHaveBeenCalled();
    }
  });

  it('does nothing without an Inbox count from the server', async () => {
    const { push, setAppBadge } = loadWorker(() => ({ unreadTotal: 1, slot: 0, email: mail('e1') }), { state: twoLogins });
    await push(delivery('a', 'e1'));
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it('still notifies where the browser has no app badge', async () => {
    const { push, stored } = loadWorker(() => ({ unreadTotal: 4, inboxUnread: 4, slot: 0, email: mail('e1') }), { state: twoLogins, badging: false });
    await push(delivery('a', 'e1'));
    expect(stored()).toEqual(twoLogins);
  });
});
