import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, afterEach, vi } from 'vitest';

// public/sw.js is served raw, never bundled, so it cannot be imported. Run it
// in a VM with a minimal ServiceWorkerGlobalScope and drive the push listener.
const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

type Shown = { tag: string; options: Record<string, unknown> };

function loadWorker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const shade = new Map<string, Shown>();
  const cacheStore = new Map<string, string>();

  const self = {
    location: { href: 'https://mail.example.com/sw.js', origin: 'https://mail.example.com' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => [] },
    registration: {
      showNotification: async (_title: string, options: Record<string, unknown>) => {
        const tag = String(options.tag ?? '');
        shade.set(tag, { tag, options });
      },
      getNotifications: async () => [],
    },
  };
  const caches = {
    open: async () => ({
      match: async (key: string) => {
        const value = cacheStore.get(key);
        return value === undefined ? undefined : { json: async () => JSON.parse(value) };
      },
      put: async (key: string, res: { text: () => Promise<string> }) => {
        cacheStore.set(key, await res.text());
      },
    }),
  };
  // One unread message per account, whichever account is asked about.
  const fetchMock = vi.fn(async (url: string) => {
    const id = new URL(url, 'https://mail.example.com').searchParams.get('emailId') ?? 'm';
    return {
      ok: true,
      json: async () => ({
        unreadTotal: 1,
        email: { id, threadId: 't-' + id, from: [{ name: 'Alice' }], subject: 'Hello', preview: '' },
      }),
    };
  });

  const context = vm.createContext({ self, caches, fetch: fetchMock, URL, URLSearchParams, Response, Date, console });
  vm.runInContext(SW_SOURCE, context);

  async function push(payload: unknown) {
    const waits: Promise<unknown>[] = [];
    listeners.get('push')?.({
      data: { json: () => payload },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
  }
  return { push, shade };
}

const delivery = (accountId: string, id: string) => ({ kind: 'jmap-email-push', accountId, emailIds: [id] });

describe('service worker quiet window', () => {
  afterEach(() => vi.useRealTimers());

  it('rings once for a burst across accounts, and again once the window has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T10:00:00Z'));
    const { push, shade } = loadWorker();

    await push(delivery('a', 'e1'));
    expect(shade.get('bulwark-mail:a')!.options).toMatchObject({ renotify: true, silent: false });

    vi.setSystemTime(new Date('2026-09-30T10:00:05Z'));
    await push(delivery('b', 'e2'));
    // Shown, but without a second sound.
    expect(shade.get('bulwark-mail:b')!.options).toMatchObject({ renotify: false, silent: true });

    // Silent alerts do not extend the window: 31 s after the audible one it rings again.
    vi.setSystemTime(new Date('2026-09-30T10:00:31Z'));
    await push(delivery('b', 'e3'));
    expect(shade.get('bulwark-mail:b')!.options).toMatchObject({ renotify: true, silent: false });
  });

  it('still rings for a second message in the same account inside the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T10:00:00Z'));
    const { push, shade } = loadWorker();

    await push(delivery('a', 'e1'));
    vi.setSystemTime(new Date('2026-09-30T10:00:10Z'));
    await push(delivery('a', 'e2'));
    expect(shade.get('bulwark-mail:a')!.options).toMatchObject({ renotify: true, silent: false });
  });
});
