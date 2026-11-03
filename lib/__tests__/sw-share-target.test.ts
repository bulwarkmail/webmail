// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { FakeCaches, loadWorker } from './sw-harness';

// The manifest's share_target POST, in the service worker, and a mailto:
// launch while offline. Before: a POST went to the server when offline mode was off.

const ORIGIN = 'https://mail.example.com';
const settle = () => new Promise((r) => setTimeout(r, 0));

function shareRequest(form: FormData, overrides: Record<string, unknown> = {}) {
  return { url: `${ORIGIN}/protocol/share`, method: 'POST', mode: 'navigate', formData: async () => form, ...overrides } as never;
}

function sharedForm(): FormData {
  const form = new FormData();
  form.set('title', 'A link');
  form.set('text', 'Look');
  form.set('url', 'https://example.org/');
  form.append('files', new File(['bytes'], 'photo.png', { type: 'image/png' }));
  return form;
}

async function shellOn(caches: FakeCaches, on: boolean) {
  const cache = await caches.open('bulwark-sw-state-v1');
  await cache.put('/__bulwark/offline-shell', new Response(JSON.stringify({ on })));
}

function htmlPage(body: string) {
  const res = new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}

describe('share target', () => {
  it.each([[false], [true]])('takes the POST with offline mode on=%s, keeps the files and goes to the app', async (on) => {
    const caches = new FakeCaches();
    await shellOn(caches, on);
    const fetchMock = vi.fn();
    const worker = loadWorker({ buildId: 'a', caches, clients: [], fetch: fetchMock });
    await settle();

    const answer = await worker.request(shareRequest(sharedForm()));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(answer?.status).toBe(303);
    const landing = new URL(answer!.headers.get('location')!);
    expect(`${landing.origin}${landing.pathname}`).toBe(`${ORIGIN}/`);
    const id = landing.searchParams.get('share')!;
    expect(id).toMatch(/^[\w-]+$/);

    const store = await caches.open('bulwark-launch-handoff-v1');
    const meta = (await (await store.match(`/__bulwark/handoff/${id}/meta`))!.json()) as Record<string, unknown>;
    expect(meta).toMatchObject({ kind: 'compose', title: 'A link', text: 'Look', url: 'https://example.org/', files: [{ name: 'photo.png', type: 'image/png' }] });
    expect(await (await store.match(`/__bulwark/handoff/${id}/0`))!.text()).toBe('bytes');
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
    expect(answer!.headers.get('location')).toContain(`${ORIGIN}/webmail/?share=`);
  });

  it('skips empty file fields', async () => {
    const caches = new FakeCaches();
    const worker = loadWorker({ buildId: 'a', caches, clients: [] });
    const form = new FormData();
    form.set('url', 'https://example.org/');
    form.append('files', new File([], ''));
    const answer = await worker.request(shareRequest(form));
    const id = new URL(answer!.headers.get('location')!).searchParams.get('share')!;
    const store = await caches.open('bulwark-launch-handoff-v1');
    const meta = (await (await store.match(`/__bulwark/handoff/${id}/meta`))!.json()) as { files: unknown[] };
    expect(meta.files).toEqual([]);
  });

  it('keeps the text and says the files are lost when there is no room', async () => {
    const caches = new FakeCaches();
    const original = caches.open.bind(caches);
    const store = await original('bulwark-launch-handoff-v1');
    vi.spyOn(caches, 'open').mockImplementation(async (name: string) => (name === 'bulwark-launch-handoff-v1'
      ? { ...store, put: async () => { throw new Error('QuotaExceededError'); } }
      : original(name)));
    const worker = loadWorker({ buildId: 'a', caches, clients: [] });

    const answer = await worker.request(shareRequest(sharedForm()));

    const landing = new URL(answer!.headers.get('location')!).searchParams;
    expect(landing.get('share')).toBe('unavailable');
    expect(landing.get('share_files')).toBe('1');
    expect(landing.get('share_title')).toBe('A link');
    expect(landing.get('share_url')).toBe('https://example.org/');
    expect((await store.keys()).length).toBe(0);
  });

  it('says so when the form cannot be read', async () => {
    const worker = loadWorker({ buildId: 'a', caches: new FakeCaches(), clients: [] });
    const answer = await worker.request(shareRequest(new FormData(), { formData: async () => { throw new TypeError('bad body'); } }));
    const landing = new URL(answer!.headers.get('location')!).searchParams;
    expect(landing.get('share')).toBe('unavailable');
    expect(landing.get('share_files')).toBe('1');
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
    expect(await worker.request({ url: `${ORIGIN}/protocol/share`, mode: 'navigate' })).toBeNull();
    expect(await caches.has('bulwark-launch-handoff-v1')).toBe(false);
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
