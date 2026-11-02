import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// A stand-in service worker global for public/sw.js (#523): a Cache API in
// memory and the events the worker listens to.
const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

export class FakeCaches {
  stores = new Map<string, Map<string, Response>>();
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    const store = this.stores.get(name)!;
    const keyOf = (req: string | { url: string }) => (typeof req === 'string' ? req : req.url);
    return {
      match: async (req: string | { url: string }) => store.get(keyOf(req))?.clone(),
      put: async (req: string | { url: string }, res: Response) => { store.set(keyOf(req), res); },
      delete: async (req: string | { url: string }) => store.delete(keyOf(req)),
      keys: async () => [...store.keys()].map((url) => ({ url })),
    };
  }
  async keys() { return [...this.stores.keys()]; }
  async delete(name: string) { return this.stores.delete(name); }
  async has(name: string) { return this.stores.has(name); }
  async match(req: string | { url: string }) {
    const key = typeof req === 'string' ? req : req.url;
    for (const store of this.stores.values()) if (store.has(key)) return store.get(key)!.clone();
    return undefined;
  }
}

export function loadWorker(opts: { buildId: string; caches: FakeCaches; clients: Array<{ id: string }>; fetch?: (input: unknown) => Promise<Response> }) {
  const listeners = new Map<string, (event: unknown) => void>();
  let skipped = 0;
  const self = {
    location: { href: `https://mail.example.com/sw.js?v=${opts.buildId}`, origin: 'https://mail.example.com' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => { skipped++; },
    clients: { claim: async () => {}, matchAll: async () => opts.clients },
    registration: { showNotification: async () => {}, getNotifications: async () => [] },
  };
  const context = vm.createContext({ self, caches: opts.caches, fetch: opts.fetch ?? (async () => { throw new TypeError('offline'); }), URL, URLSearchParams, Request, Response, Headers, Date, console, AbortController, setTimeout, clearTimeout });
  vm.runInContext(SW_SOURCE, context);
  async function dispatch(type: string, event: Record<string, unknown> = {}) {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }
  /** A fetch event: what the worker answered, or null when it left the request to the network. */
  async function request(req: { url: string; method?: string; mode?: string }): Promise<Response | null> {
    let answer: Promise<Response> | null = null;
    listeners.get('fetch')?.({ request: { method: 'GET', mode: 'cors', ...req }, respondWith: (p: Promise<Response>) => { answer = p; } });
    return answer ? await answer : null;
  }
  return { dispatch, listeners, request, skipped: () => skipped };
}
