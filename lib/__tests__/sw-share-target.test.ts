// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { FakeCaches, loadWorker } from './sw-harness';

// The manifest's share_target POST, in the service worker, and a mailto:
// launch while offline. Any site can POST here, signed in or not, so what the
// worker keeps is limited and sealed. Before: a POST went to the server when
// offline mode was off, and files sat readable in the cache with no limit.

const ORIGIN = 'https://mail.example.com';
const CACHE = 'bulwark-launch-handoff-v1';
const TTL = 15 * 60 * 1000;
const settle = () => new Promise((r) => setTimeout(r, 0));

function shareRequest(form: FormData, overrides: Record<string, unknown> = {}) {
  return { url: `${ORIGIN}/protocol/share`, method: 'POST', mode: 'navigate', destination: 'document', formData: async () => form, ...overrides } as never;
}

function sharedForm(): FormData {
  const form = new FormData();
  form.set('title', 'A link');
  form.set('text', 'Look');
  form.set('url', 'https://example.org/');
  form.append('files', new File(['secret bytes'], 'photo.png', { type: 'image/png' }));
  return form;
}

const landingOf = (answer: Response | null) => {
  const url = new URL(answer!.headers.get('location')!);
  return { url, fragment: new URLSearchParams(url.hash.slice(1)) };
};

async function shellOn(caches: FakeCaches, on: boolean) {
  const cache = await caches.open('bulwark-sw-state-v1');
  await cache.put('/__bulwark/offline-shell', new Response(JSON.stringify({ on })));
}

async function plantEntry(caches: FakeCaches, id: string, createdAt: number, bytes = 0) {
  const store = await caches.open(CACHE);
  await store.put(`/__bulwark/handoff/${id}/meta`, new Response(JSON.stringify({ kind: 'compose', createdAt, bytes })));
  await store.put(`/__bulwark/handoff/${id}/sealed`, new Response('x'));
}

async function entryIds(caches: FakeCaches): Promise<string[]> {
  const store = await caches.open(CACHE);
  return (await store.keys()).filter((key) => key.url.endsWith('/meta')).map((key) => key.url.split('/').slice(-2)[0]);
}

function htmlPage(body: string) {
  const res = new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}

describe('share target', () => {
  it.each([[false], [true]])('takes the POST with offline mode on=%s, keeps the files sealed and goes to the app', async (on) => {
    const caches = new FakeCaches();
    await shellOn(caches, on);
    const fetchMock = vi.fn();
    const worker = loadWorker({ buildId: 'a', caches, clients: [], fetch: fetchMock });
    await settle();

    const answer = await worker.request(shareRequest(sharedForm()));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(answer?.status).toBe(303);
    const { url, fragment } = landingOf(answer);
    expect(`${url.origin}${url.pathname}`).toBe(`${ORIGIN}/`);
    // Id and key in the fragment: neither ever reaches the server.
    expect(url.search).toBe('');
    const id = fragment.get('share')!;
    expect(id).toMatch(/^[\w-]+$/);
    expect(fragment.get('key')).toMatch(/^[\w-]{43}$/);

    const store = await caches.open(CACHE);
    const meta = (await (await store.match(`/__bulwark/handoff/${id}/meta`))!.json()) as Record<string, unknown>;
    expect(meta).toMatchObject({ kind: 'compose', bytes: 12 });
    // Only what a sweep needs is readable.
    expect(Object.keys(meta).sort()).toEqual(['bytes', 'createdAt', 'kind']);
    for (const part of ['meta', 'sealed', '0']) {
      const text = await (await store.match(`/__bulwark/handoff/${id}/${part}`))!.text();
      for (const secret of ['secret bytes', 'photo.png', 'A link', 'example.org']) expect(text).not.toContain(secret);
    }
  });

  it('answers while the worker has only just started and has not read its state', async () => {
    const worker = loadWorker({ buildId: 'a', caches: new FakeCaches(), clients: [] });
    const answer = await worker.request(shareRequest(sharedForm()));
    expect(answer?.status).toBe(303);
  });

  it('works under a subpath', async () => {
    const worker = loadWorker({ buildId: 'a', caches: new FakeCaches(), clients: [], location: `${ORIGIN}/webmail/sw.js?v=a` });
    expect(await worker.request(shareRequest(sharedForm()))).toBeNull();
    const answer = await worker.request(shareRequest(sharedForm(), { url: `${ORIGIN}/webmail/protocol/share` }));
    expect(answer!.headers.get('location')).toContain(`${ORIGIN}/webmail/#share=`);
  });

  it('skips empty file fields', async () => {
    const caches = new FakeCaches();
    const worker = loadWorker({ buildId: 'a', caches, clients: [] });
    const form = new FormData();
    form.set('url', 'https://example.org/');
    form.append('files', new File([], ''));
    const answer = await worker.request(shareRequest(form));
    const id = landingOf(answer).fragment.get('share')!;
    const store = await caches.open(CACHE);
    const meta = (await (await store.match(`/__bulwark/handoff/${id}/meta`))!.json()) as { bytes: number };
    expect(meta.bytes).toBe(0);
    expect(await store.match(`/__bulwark/handoff/${id}/0`)).toBeUndefined();
  });

  it('keeps the text and says the files are lost when there is no room', async () => {
    const caches = new FakeCaches();
    const original = caches.open.bind(caches);
    const store = await original(CACHE);
    vi.spyOn(caches, 'open').mockImplementation(async (name: string) => (name === CACHE
      ? { ...store, put: async () => { throw new Error('QuotaExceededError'); } }
      : original(name)));
    const worker = loadWorker({ buildId: 'a', caches, clients: [] });

    const { fragment } = landingOf(await worker.request(shareRequest(sharedForm())));

    expect(fragment.get('share')).toBe('unavailable');
    expect(fragment.get('share_files')).toBe('1');
    expect(fragment.get('share_title')).toBe('A link');
    expect(fragment.get('share_url')).toBe('https://example.org/');
    expect((await store.keys()).length).toBe(0);
  });

  it('keeps that address short too, and says it cut', async () => {
    const caches = new FakeCaches();
    const original = caches.open.bind(caches);
    const store = await original(CACHE);
    vi.spyOn(caches, 'open').mockImplementation(async (name: string) => (name === CACHE
      ? { ...store, put: async () => { throw new Error('QuotaExceededError'); } }
      : original(name)));
    const worker = loadWorker({ buildId: 'a', caches, clients: [] });
    const form = new FormData();
    form.set('text', 'あ'.repeat(3000));

    const answer = await worker.request(shareRequest(form));

    expect(answer!.headers.get('location')!.length).toBeLessThan(4000);
    expect(landingOf(answer).fragment.get('share_cut')).toBe('1');
  });

  it('says so when the form cannot be read', async () => {
    const worker = loadWorker({ buildId: 'a', caches: new FakeCaches(), clients: [] });
    const answer = await worker.request(shareRequest(new FormData(), { formData: async () => { throw new TypeError('bad body'); } }));
    const { fragment } = landingOf(answer);
    expect(fragment.get('share')).toBe('unavailable');
    expect(fragment.get('share_files')).toBe('1');
  });

  it('leaves other requests alone', async () => {
    const caches = new FakeCaches();
    await shellOn(caches, false);
    const worker = loadWorker({ buildId: 'a', caches, clients: [] });
    await settle();
    // A fetch from a page, a POST elsewhere, another origin, and a plain GET.
    expect(await worker.request(shareRequest(sharedForm(), { mode: 'cors' }))).toBeNull();
    expect(await worker.request(shareRequest(sharedForm(), { url: `${ORIGIN}/api/share` }))).toBeNull();
    expect(await worker.request(shareRequest(sharedForm(), { url: 'https://other.example/protocol/share' }))).toBeNull();
    expect(await worker.request({ url: `${ORIGIN}/protocol/share`, mode: 'navigate', destination: 'document' } as never)).toBeNull();
    expect(await caches.has(CACHE)).toBe(false);
  });

  it('leaves a POST into a hidden frame to the network: it stores nothing', async () => {
    const caches = new FakeCaches();
    await shellOn(caches, false);
    const worker = loadWorker({ buildId: 'a', caches, clients: [] });
    await settle();
    expect(await worker.request(shareRequest(sharedForm(), { destination: 'iframe' }))).toBeNull();
    expect(await worker.request(shareRequest(sharedForm(), { destination: 'embed' }))).toBeNull();
    expect(await caches.has(CACHE)).toBe(false);
  });
});

describe('limits on what the worker keeps', () => {
  it('drops the oldest entries over the entry limit, on every share', async () => {
    const caches = new FakeCaches();
    const now = Date.now();
    for (let n = 0; n < 5; n += 1) await plantEntry(caches, `old-${n}`, now - 1000 * (5 - n));
    const worker = loadWorker({ buildId: 'a', caches, clients: [] });

    const answer = await worker.request(shareRequest(sharedForm()));

    const ids = await entryIds(caches);
    expect(ids).toHaveLength(5);
    expect(ids).not.toContain('old-0');
    expect(ids).toContain('old-1');
    expect(ids).toContain(landingOf(answer).fragment.get('share'));
    // Everything of the dropped one goes, not only its list.
    expect(await (await caches.open(CACHE)).match('/__bulwark/handoff/old-0/sealed')).toBeUndefined();
  });

  it('drops the oldest entries over the byte limit', async () => {
    const caches = new FakeCaches();
    const now = Date.now();
    await plantEntry(caches, 'big', now - 2000, 100 * 1024 * 1024 - 5);
    await plantEntry(caches, 'small', now - 1000, 2);
    const worker = loadWorker({ buildId: 'a', caches, clients: [] });

    await worker.request(shareRequest(sharedForm()));

    const ids = await entryIds(caches);
    expect(ids).not.toContain('big');
    expect(ids).toContain('small');
  });

  it('stores nothing from a share over the byte limit, says the files are lost, and keeps the rest', async () => {
    const caches = new FakeCaches();
    await plantEntry(caches, 'kept', Date.now() - 1000, 10);
    const worker = loadWorker({ buildId: 'a', caches, clients: [] });
    const big = new File(['x'], 'huge.bin');
    Object.defineProperty(big, 'size', { value: 100 * 1024 * 1024 + 1 });
    const fields = new Map<string, unknown>([['title', 'T']]);
    const form = { get: (name: string) => fields.get(name) ?? null, getAll: () => [big] } as unknown as FormData;

    const { fragment } = landingOf(await worker.request(shareRequest(form)));

    expect(fragment.get('share')).toBe('unavailable');
    expect(fragment.get('share_files')).toBe('1');
    expect(await entryIds(caches)).toEqual(['kept']);
  });

  it('sweeps what is too old on every share', async () => {
    const caches = new FakeCaches();
    await plantEntry(caches, 'stale', Date.now() - TTL - 1);
    await plantEntry(caches, 'fresh', Date.now() - 1000);
    const worker = loadWorker({ buildId: 'a', caches, clients: [] });
    await worker.request(shareRequest(sharedForm()));
    const ids = await entryIds(caches);
    expect(ids).not.toContain('stale');
    expect(ids).toContain('fresh');
  });

  it('sweeps what is too old when it activates', async () => {
    const caches = new FakeCaches();
    await plantEntry(caches, 'stale', Date.now() - TTL - 1);
    await plantEntry(caches, 'fresh', Date.now() - 1000);
    const worker = loadWorker({ buildId: 'a', caches, clients: [] });
    await worker.dispatch('activate');
    expect(await entryIds(caches)).toEqual(['fresh']);
  });

  it('creates no cache when it activates with nothing kept', async () => {
    const caches = new FakeCaches();
    const worker = loadWorker({ buildId: 'a', caches, clients: [] });
    await worker.dispatch('activate');
    expect(await caches.has(CACHE)).toBe(false);
  });
});

describe('a mailto: launch without a connection', () => {
  it('gets the kept handler page instead of a network error', async () => {
    const caches = new FakeCaches();
    await shellOn(caches, true);
    const online = vi.fn(async () => htmlPage('<html>mailto page'));
    const worker = loadWorker({ buildId: 'a', caches, clients: [], fetch: online });
    await settle();

    await worker.dispatch('message', { data: { type: 'offline-shell', on: true, urls: ['/protocol/mailto'], buildId: 'a' } });
    await settle();

    online.mockImplementation(async () => { throw new TypeError('offline'); });
    const answer = await worker.request({ url: `${ORIGIN}/protocol/mailto?url=mailto%3Aa%40example.org`, mode: 'navigate' });
    expect(await answer!.text()).toBe('<html>mailto page');
  });

  it('falls back to the start page when that page was never kept', async () => {
    const caches = new FakeCaches();
    await shellOn(caches, true);
    const shell = await caches.open('bulwark-shell-a');
    await shell.put(ORIGIN, htmlPage('<html>start'));
    const worker = loadWorker({ buildId: 'a', caches, clients: [] });
    await settle();

    const answer = await worker.request({ url: `${ORIGIN}/protocol/webcal?url=x`, mode: 'navigate' });
    expect(await answer!.text()).toBe('<html>start');
  });
});
