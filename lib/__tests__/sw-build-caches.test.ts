import { describe, expect, it } from 'vitest';
import { FakeCaches, loadWorker } from './sw-harness';

const settle = () => new Promise((r) => setTimeout(r, 0));

// The service worker names its caches after the build it came with (#523)
// and deletes a build's cache once no open tab runs that build.
describe('service worker caches per build', () => {
  it('keeps the caches of builds an open tab runs and deletes the rest', async () => {
    const caches = new FakeCaches();
    for (const name of ['bulwark-shell-a', 'bulwark-shell-b', 'bulwark-shell-c', 'bulwark-push-state-v1']) await caches.open(name);
    const clients = [{ id: 'tab-1' }, { id: 'tab-2' }];
    const worker = loadWorker({ buildId: 'c', caches, clients });
    // tab-1 still runs build a; tab-2 already runs c.
    await worker.dispatch('message', { data: { type: 'client-build', buildId: 'a' }, source: { id: 'tab-1' } });
    await worker.dispatch('message', { data: { type: 'client-build', buildId: 'c' }, source: { id: 'tab-2' } });
    expect((await caches.keys()).sort()).toEqual(['bulwark-push-state-v1', 'bulwark-shell-a', 'bulwark-shell-c', 'bulwark-sw-state-v1']);

    // tab-1 reloads into build c: build a's files can go.
    await worker.dispatch('message', { data: { type: 'client-build', buildId: 'c' }, source: { id: 'tab-1' } });
    expect(await caches.has('bulwark-shell-a')).toBe(false);
    expect(await caches.has('bulwark-shell-c')).toBe(true);
    // Push state isn't a build's cache.
    expect(await caches.has('bulwark-push-state-v1')).toBe(true);
  });

  it('a new build activated after a deploy keeps the old build while its tab is open', async () => {
    const caches = new FakeCaches();
    const clients = [{ id: 'tab-1' }];
    const old = loadWorker({ buildId: 'a', caches, clients });
    await caches.open('bulwark-shell-a');
    await old.dispatch('message', { data: { type: 'client-build', buildId: 'a' }, source: { id: 'tab-1' } });

    const next = loadWorker({ buildId: 'b', caches, clients });
    await next.dispatch('activate');
    expect(await caches.has('bulwark-shell-a')).toBe(true);

    // The tab is closed: the next activation removes build a's files.
    clients.length = 0;
    await next.dispatch('activate');
    expect(await caches.has('bulwark-shell-a')).toBe(false);
  });

  it('takes over when the tab asks for it', async () => {
    const worker = loadWorker({ buildId: 'b', caches: new FakeCaches(), clients: [] });
    const before = worker.skipped();
    await worker.dispatch('message', { data: { type: 'skip-waiting' } });
    expect(worker.skipped()).toBe(before + 1);
  });

  it("the old build's worker doesn't bring back its cache after the new build deleted it", async () => {
    const caches = new FakeCaches();
    const state = await caches.open('bulwark-sw-state-v1');
    await state.put('/__bulwark/offline-shell', new Response(JSON.stringify({ on: true })));
    let online = true;
    // The server runs build b now and says so on every answer.
    const fetchFromB = async () => {
      if (!online) throw new TypeError('Failed to fetch');
      const res = new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json', 'X-Bulwark-Build': 'b' } });
      Object.defineProperty(res, 'type', { value: 'basic' });
      return res;
    };
    const old = loadWorker({ buildId: 'a', caches, clients: [], fetch: fetchFromB });
    await settle();
    // Build b's worker took over and deleted build a's files, while the
    // reloaded tab's first requests still went through build a's worker.
    expect(await caches.has('bulwark-shell-a')).toBe(false);
    await old.request({ url: 'https://mail.example.com/api/config' });
    await settle();
    expect(await caches.has('bulwark-shell-a')).toBe(false);
    expect(await caches.has('bulwark-shell-b')).toBe(true);

    online = false;
    await old.request({ url: 'https://mail.example.com/mail', mode: 'navigate' }).catch(() => null);
    await settle();
    expect(await caches.has('bulwark-shell-a')).toBe(false);
  });
});
