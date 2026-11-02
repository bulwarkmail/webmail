import { describe, expect, it, vi } from 'vitest';
import { FakeCaches, loadWorker } from './sw-harness';

// Offline mode's app shell in the service worker (#523): nothing is cached
// or answered while it is off; while it is on, pages are network first and
// kept in this build's cache, chunks come from any build's cache first.

const ORIGIN = 'https://mail.example.com';

function sameOrigin(body: string, type = 'text/html') {
  const res = new Response(body, { status: 200, headers: { 'Content-Type': type } });
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}

async function shellOn(caches: FakeCaches, on: boolean) {
  const cache = await caches.open('bulwark-sw-state-v1');
  await cache.put('/__bulwark/offline-shell', new Response(JSON.stringify({ on })));
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('service worker with offline mode off', () => {
  it('leaves every request to the network and caches nothing', async () => {
    const caches = new FakeCaches();
    await shellOn(caches, false);
    const fetchMock = vi.fn(async () => sameOrigin('<html>'));
    const worker = loadWorker({ buildId: 'a', caches, clients: [], fetch: fetchMock });
    await settle();
    expect(await worker.request({ url: `${ORIGIN}/mail`, mode: 'navigate' })).toBeNull();
    expect(await worker.request({ url: `${ORIGIN}/_next/static/chunks/app.js` })).toBeNull();
    expect((await caches.keys()).filter((k) => k.startsWith('bulwark-shell-'))).toEqual([]);
  });

  it('also when nothing was ever stored', async () => {
    const caches = new FakeCaches();
    const fetchMock = vi.fn(async () => sameOrigin('<html>'));
    const worker = loadWorker({ buildId: 'a', caches, clients: [], fetch: fetchMock });
    await settle();
    expect(await worker.request({ url: `${ORIGIN}/mail`, mode: 'navigate' })).toBeNull();
  });
});

describe('service worker with offline mode on', () => {
  it('keeps the pages it served and serves them when the network fails', async () => {
    const caches = new FakeCaches();
    await shellOn(caches, true);
    let online = true;
    const fetchMock = vi.fn(async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return sameOrigin('<html>mail page</html>');
    });
    const worker = loadWorker({ buildId: 'a', caches, clients: [], fetch: fetchMock });
    await settle();
    const first = await worker.request({ url: `${ORIGIN}/mail`, mode: 'navigate' });
    expect(await first!.text()).toBe('<html>mail page</html>');
    await settle();
    expect(await caches.has('bulwark-shell-a')).toBe(true);

    online = false;
    const offline = await worker.request({ url: `${ORIGIN}/mail`, mode: 'navigate' });
    expect(await offline!.text()).toBe('<html>mail page</html>');
    // A deeper page of the same section falls back to the section's page.
    const deep = await worker.request({ url: `${ORIGIN}/mail/inbox/abc`, mode: 'navigate' });
    expect(await deep!.text()).toBe('<html>mail page</html>');
  });

  it('serves a chunk of an older build from that build\'s cache, and keeps new ones per build', async () => {
    const caches = new FakeCaches();
    await shellOn(caches, true);
    const old = await caches.open('bulwark-shell-a');
    await old.put(`${ORIGIN}/_next/static/chunks/old.js`, sameOrigin('old chunk', 'text/javascript'));
    const fetchMock = vi.fn(async () => sameOrigin('new chunk', 'text/javascript'));
    const worker = loadWorker({ buildId: 'b', caches, clients: [], fetch: fetchMock });
    await settle();
    const hit = await worker.request({ url: `${ORIGIN}/_next/static/chunks/old.js` });
    expect(await hit!.text()).toBe('old chunk');
    expect(fetchMock).not.toHaveBeenCalled();

    await worker.request({ url: `${ORIGIN}/_next/static/chunks/new.js` });
    await settle();
    const own = await caches.open('bulwark-shell-b');
    expect(await own.match(`${ORIGIN}/_next/static/chunks/new.js`)).toBeDefined();
    expect(await old.match(`${ORIGIN}/_next/static/chunks/new.js`)).toBeUndefined();
  });

  it('never answers the API, the admin pages or other origins', async () => {
    const caches = new FakeCaches();
    await shellOn(caches, true);
    const worker = loadWorker({ buildId: 'a', caches, clients: [], fetch: vi.fn(async () => sameOrigin('x')) });
    await settle();
    expect(await worker.request({ url: `${ORIGIN}/api/admin/policy` })).toBeNull();
    expect(await worker.request({ url: `${ORIGIN}/admin/login`, mode: 'navigate' })).toBeNull();
    expect(await worker.request({ url: 'https://stalwart.example.com/jmap' })).toBeNull();
    expect(await worker.request({ url: `${ORIGIN}/mail`, method: 'POST', mode: 'navigate' })).toBeNull();
  });

  it('waits for the old build\'s tabs before taking over', async () => {
    const caches = new FakeCaches();
    await shellOn(caches, true);
    const worker = loadWorker({ buildId: 'b', caches, clients: [{ id: 'tab-1' }] });
    const before = worker.skipped();
    await worker.dispatch('install');
    expect(worker.skipped()).toBe(before);
    // Without offline mode it takes over at once, as before.
    const plain = new FakeCaches();
    const other = loadWorker({ buildId: 'b', caches: plain, clients: [{ id: 'tab-1' }] });
    await other.dispatch('install');
    expect(other.skipped()).toBe(1);
  });

  it('precaches the shell a tab names, and drops every shell when turned off', async () => {
    const caches = new FakeCaches();
    const fetchMock = vi.fn(async (url: unknown) => sameOrigin(`file ${String(url)}`, 'text/javascript'));
    const worker = loadWorker({ buildId: 'a', caches, clients: [], fetch: fetchMock });
    await worker.dispatch('message', { data: { type: 'offline-shell', on: true, urls: ['/_next/static/chunks/a.js', '/mail', 'https://evil.example/x.js'] } });
    const shell = await caches.open('bulwark-shell-a');
    await vi.waitFor(async () => {
      expect(await shell.match(`${ORIGIN}/_next/static/chunks/a.js`)).toBeDefined();
      expect(await shell.match(`${ORIGIN}/mail`)).toBeDefined();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await worker.dispatch('message', { data: { type: 'offline-shell', on: false } });
    expect((await caches.keys()).filter((k) => k.startsWith('bulwark-shell-'))).toEqual([]);
    expect(await worker.request({ url: `${ORIGIN}/mail`, mode: 'navigate' })).toBeNull();
  });

  it('keeps a newer tab’s shell in that tab’s build cache, not its own', async () => {
    const caches = new FakeCaches();
    const fetchMock = vi.fn(async () => sameOrigin('x', 'text/javascript'));
    const worker = loadWorker({ buildId: 'old', caches, clients: [], fetch: fetchMock });
    await worker.dispatch('message', { data: { type: 'offline-shell', on: true, urls: ['/_next/static/chunks/n.js'], buildId: 'new' } });
    await vi.waitFor(async () => expect(await caches.has('bulwark-shell-new')).toBe(true));
    expect(await caches.has('bulwark-shell-old')).toBe(false);
  });

  it('doesn’t hold the message open while it fetches the shell, so a new build’s worker can take over', async () => {
    const caches = new FakeCaches();
    // The network never answers.
    const worker = loadWorker({ buildId: 'a', caches, clients: [], fetch: () => new Promise<Response>(() => {}) });
    let settled = false;
    const done = worker.dispatch('message', { data: { type: 'offline-shell', on: true, urls: ['/_next/static/chunks/a.js'] } }).then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(true);
    await done;
    // The switch was kept all the same.
    const state = await caches.open('bulwark-sw-state-v1');
    expect(await (await state.match('/__bulwark/offline-shell'))?.json()).toEqual({ on: true });
  });
});
