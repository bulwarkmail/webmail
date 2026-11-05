import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, afterEach, vi } from 'vitest';

// #1322: Safari drops the push subscription after three pushes that end
// without showNotification, so every path through the push handler has to
// show something, without a sound when there is nothing new.
const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

type Shown = { title: string; body?: unknown; data?: unknown; options: Record<string, unknown>; close: () => void };

type Preview = { unreadTotal: number; email: Record<string, unknown> | null };

function loadWorker(preview: (url: string, init: { signal?: AbortSignal }) => Promise<Preview>) {
  const listeners = new Map<string, (event: unknown) => void>();
  const shade = new Map<string, Shown>();
  const calls: Array<{ title: string; options: Record<string, unknown> }> = [];
  const cacheStore = new Map<string, string>();

  const self = {
    location: { href: 'https://mail.example.com/sw.js', origin: 'https://mail.example.com' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => [] },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        const tag = String(options.tag ?? '');
        calls.push({ title, options });
        shade.set(tag, { title, body: options.body, data: options.data, options, close: () => shade.delete(tag) });
      },
      getNotifications: async ({ tag }: { tag: string }) => (shade.has(tag) ? [shade.get(tag)!] : []),
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
  const fetchMock = vi.fn(async (url: string, init: { signal?: AbortSignal }) => {
    const body = await preview(url, init);
    return { ok: true, json: async () => body };
  });

  const context = vm.createContext({
    self, caches, fetch: fetchMock, URL, URLSearchParams, Response, Date, console,
    AbortController, setTimeout, clearTimeout,
  });
  vm.runInContext(SW_SOURCE, context);

  async function push(payload: unknown) {
    const waits: Promise<unknown>[] = [];
    listeners.get('push')?.({
      data: { json: () => payload },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
  }
  return { push, shade, calls };
}

const mail = (id: string) => ({ id, threadId: 't-' + id, from: [{ name: 'Alice' }], subject: 'Hello', preview: '' });
const delivery = (id: string) => ({ kind: 'jmap-email-push', accountId: 'a', emailIds: [id] });

describe('service worker never ends a push without a notification (#1322)', () => {
  afterEach(() => vi.useRealTimers());

  it('re-shows the notification silently when a push is redelivered', async () => {
    const { push, shade, calls } = loadWorker(async () => ({ unreadTotal: 1, email: mail('e1') }));
    await push(delivery('e1'));
    expect(calls).toHaveLength(1);

    await push(delivery('e1'));
    expect(calls).toHaveLength(2);
    expect(calls[1].title).toBe('Alice');
    expect(calls[1].options).toMatchObject({ tag: 'bulwark-mail:a', body: 'Hello', renotify: false, silent: true });
    expect(shade.get('bulwark-mail:a')?.title).toBe('Alice');
  });

  it('shows and removes a notification when nothing is unread and none is on screen', async () => {
    const { push, shade, calls } = loadWorker(async () => ({ unreadTotal: 0, email: null }));
    await push({ kind: 'jmap-state-change', changed: { a: {} } });
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toMatchObject({ renotify: false, silent: true });
    expect(shade.size).toBe(0);
  });

  it('re-shows silently when the newest unread mail was already announced', async () => {
    const { push, calls } = loadWorker(async () => ({ unreadTotal: 1, email: mail('e1') }));
    await push(delivery('e1'));
    await push({ kind: 'jmap-state-change', changed: { a: {} } });
    expect(calls).toHaveLength(2);
    expect(calls[1].options).toMatchObject({ renotify: false, silent: true });
  });

  it('gives up on a slow preview and shows the generic notification in time', async () => {
    vi.useFakeTimers();
    const { push, calls } = loadWorker((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const done = push(delivery('e1'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe('New mail');
    // A preview that never answers is called off in the end.
    await vi.advanceTimersByTimeAsync(50_000);
    await done;
    expect(calls).toHaveLength(1);
  });

  it('lets a slow preview finish after the generic notification, for the cookies it sets (#1509)', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const { push, calls } = loadWorker((_url, init) => {
      signal = init.signal;
      return new Promise((resolve) => setTimeout(() => resolve({ unreadTotal: 1, email: mail('e1') }), 15_000));
    });
    let finished = false;
    const done = push(delivery('e1')).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe('New mail');
    // A renewed token's answer carries the rotated refresh token.
    expect(signal?.aborted).toBe(false);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(signal?.aborted).toBe(false);
    // Nothing more shows for an answer that came after its notification.
    expect(calls).toHaveLength(1);
  });
});
