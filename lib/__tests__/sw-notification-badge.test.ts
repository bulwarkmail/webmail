import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';

// Android draws a notification's status-bar badge from its transparency only,
// so the opaque app icon showed as a solid blob there (#915). Every
// notification the worker shows takes its badge from /api/notification-badge,
// a cut-out, and keeps the app icon as its icon.
const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

function loadWorker(preview: Record<string, unknown>) {
  const listeners = new Map<string, (event: unknown) => void>();
  const calls: Array<{ title: string; options: Record<string, unknown> }> = [];
  const self = {
    location: { href: 'https://mail.example.com/webmail/sw.js', origin: 'https://mail.example.com' },
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

describe('notification badge', () => {
  it('is the cut-out badge, under the base path, for a new-mail push', async () => {
    const { push, calls } = loadWorker({ unreadTotal: 1, redacted: true, email: { id: 'e1', threadId: 't1' } });
    await push({ kind: 'jmap-email-push', accountId: 'a', emailIds: ['e1'] });
    expect(calls).toHaveLength(1);
    expect(calls[0].options.badge).toBe('/webmail/api/notification-badge');
    expect(calls[0].options.icon).toBe('/webmail/api/pwa-icon/192');
  });

  it('is never the app icon anywhere in the worker', () => {
    const badges = [...SW_SOURCE.matchAll(/\bbadge:\s*([^,\n]+)/g)].map((m) => m[1].trim());
    expect(badges.length).toBeGreaterThanOrEqual(5);
    expect(new Set(badges)).toEqual(new Set(['NOTIFICATION_BADGE']));
  });
});
