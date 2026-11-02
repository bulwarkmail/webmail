import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';

// Organisation > Devices > Push without sender and subject: the preview
// route answers `redacted` with only the message's ids. The worker then
// says "New mail", never "(no subject)", and still opens the message.
const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

function loadWorker(preview: Record<string, unknown>) {
  const listeners = new Map<string, (event: unknown) => void>();
  const calls: Array<{ title: string; options: Record<string, unknown> }> = [];
  const self = {
    location: { href: 'https://mail.example.com/sw.js', origin: 'https://mail.example.com' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => [] },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => { calls.push({ title, options }); },
      getNotifications: async () => [],
    },
  };
  const caches = { open: async () => ({ match: async () => undefined, put: async () => {} }) };
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => preview }));
  const context = vm.createContext({ self, caches, fetch: fetchMock, URL, URLSearchParams, Response, Date, console, AbortController, setTimeout, clearTimeout });
  vm.runInContext(SW_SOURCE, context);
  async function push(payload: unknown) {
    const waits: Promise<unknown>[] = [];
    listeners.get('push')?.({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }
  return { push, calls };
}

const delivery = { kind: 'jmap-email-push', accountId: 'a', emailIds: ['e1'] };

describe('service worker with a redacted preview', () => {
  it('shows "New mail" and opens the one message', async () => {
    const { push, calls } = loadWorker({ unreadTotal: 1, redacted: true, email: { id: 'e1', threadId: 't1', receivedAt: null } });
    await push(delivery);
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe('New mail');
    expect(calls[0].options.body).toBe('You have new mail');
    expect(calls[0].options.data).toMatchObject({ kind: 'email', emailId: 'e1' });
  });

  it('counts several unread messages without naming any', async () => {
    const { push, calls } = loadWorker({ unreadTotal: 3, redacted: true, email: { id: 'e1', threadId: 't1' } });
    await push(delivery);
    expect(calls[0].title).toBe('New mail');
    expect(calls[0].options.body).toBe('3 unread messages');
  });
});
