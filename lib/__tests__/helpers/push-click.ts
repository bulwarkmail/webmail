import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

export async function pushClick(
  accountId: string,
  preview: (url: string) => Promise<unknown>,
  options: { warm?: boolean; basePath?: string; legacy?: boolean; emailId?: string; noParamsSize?: boolean } = {},
): Promise<string> {
  const source = readFileSync(resolve('public/sw.js'), 'utf8');
  let notification: { data: unknown } | undefined;
  let target: string | undefined;
  const listeners = new Map<string, (event: unknown) => void>();
  const cache = new Map<string, string>();
  const client = {
    id: 'window-1', url: 'https://mail.example.test/',
    postMessage() {},
    async focus() { return this; },
    async navigate(url: string) { target = url; return this; },
  };
  // Safari before 17 has no URLSearchParams.size.
  const SearchParams = options.noParamsSize
    ? class extends URLSearchParams { get size(): number { return undefined as unknown as number; } }
    : URLSearchParams;
  const context = vm.createContext({
    URL, URLSearchParams: SearchParams, Response, AbortController, setTimeout, clearTimeout, console,
    self: {
      location: { href: `https://mail.example.test${options.basePath ?? ''}/sw.js`, origin: 'https://mail.example.test' },
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
      clients: {
        matchAll: async () => options.warm ? [client] : [],
        openWindow: async (url: string) => { target = url; },
      },
      registration: {
        showNotification: async (_title: string, data: { data: unknown }) => { notification = data; },
        getNotifications: async () => [],
      },
    },
    caches: { open: async () => ({
      match: async (key: string) => cache.has(key) ? new Response(cache.get(key)) : undefined,
      put: async (key: string, response: Response) => cache.set(key, await response.text()),
    }) },
    fetch: async (url: string) => ({ ok: true, json: async () => preview(url) }),
  });
  vm.runInContext(source, context);
  async function dispatch(type: string, event: Record<string, unknown>) {
    const waits: Promise<unknown>[] = [];
    const listener = listeners.get(type);
    if (!listener) throw new Error(`Missing worker handler: ${type}`);
    listener({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }
  const payload = options.legacy
    ? { changed: { [accountId]: { EmailDelivery: 'new' } } }
    : { kind: 'jmap-email-push', accountId, emailIds: [options.emailId ?? 'new-email'] };
  await dispatch('push', { data: { json: () => payload } });
  if (!notification) throw new Error('No notification shown');
  await dispatch('notificationclick', { notification: { ...notification, close() {} } });
  if (!target) throw new Error('Notification did not navigate');
  return target;
}
