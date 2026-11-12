import { describe, it, expect, vi } from 'vitest';
import { FakeCaches, loadWorker } from './sw-harness';

// A new worker that takes over (activates) has heard no page yet. The app lock's word in
// the push store may come from the worker before it, and a page of an older version
// deletes that whole store when it wipes one login. So at activation the worker counts
// the lock as on, should that word go before a page speaks, unless the stored word is
// "off". Pages tell a worker that takes over their word at once
// (lib/app-lock/__tests__/service-worker-state.test.ts).

const ORIGIN = 'https://mail.example.com';
const PUSH_CACHE = 'bulwark-push-state-v1';
const PREVIEW = {
  unreadTotal: 1,
  slot: 0,
  login: 'fp',
  email: { id: 'e1', threadId: 't1', subject: 'Secret subject 482913', from: [{ name: 'Secret sender', email: 's@example.org' }] },
};

async function storeWord(caches: FakeCaches, word: Record<string, unknown>): Promise<void> {
  const cache = await caches.open(PUSH_CACHE);
  await cache.put(`${ORIGIN}/__push-state/app-lock`, new Response(JSON.stringify(word)));
}

function setup(caches: FakeCaches, clients: Array<{ id: string }> = []) {
  const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(JSON.stringify(PREVIEW), { status: 200 }));
  const worker = loadWorker({ buildId: 'b', caches, clients, fetch: fetchMock });
  const previews = () => fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/push/preview'));
  let pushes = 0;
  const push = () => worker.dispatch('push', { data: { json: () => ({ kind: 'jmap-email-push', accountId: 'a', emailIds: [`e${++pushes}`] }) } });
  return { worker, previews, push };
}

describe('a worker that takes over', () => {
  it('counts a deleted store as locked when the word before it was "unlocked"', async () => {
    const caches = new FakeCaches();
    await storeWord(caches, { state: 'unlocked' });
    const { worker, previews, push } = setup(caches);
    await worker.dispatch('activate', {});
    // A page of an older version wipes one login and deletes the whole store.
    await caches.delete(PUSH_CACHE);
    await push();
    expect(previews()).toHaveLength(0);
    expect(JSON.stringify(worker.shown)).not.toContain('Secret');
  });

  it('does the same when the word before it was "locked"', async () => {
    const caches = new FakeCaches();
    await storeWord(caches, { state: 'locked' });
    const { worker, previews, push } = setup(caches);
    await worker.dispatch('activate', {});
    await caches.delete(PUSH_CACHE);
    await push();
    expect(previews()).toHaveLength(0);
  });

  it('names the sender after a deleted store when the word before it was "off"', async () => {
    const caches = new FakeCaches();
    await storeWord(caches, { state: 'off' });
    const { worker, push } = setup(caches);
    await worker.dispatch('activate', {});
    await caches.delete(PUSH_CACHE);
    await push();
    expect(worker.shown[0].title).toContain('Secret sender');
  });

  it('with no word at all says nothing until a page speaks, then goes by it', async () => {
    const caches = new FakeCaches();
    const app = { id: 'app' };
    const { worker, previews, push } = setup(caches, [app]);
    await worker.dispatch('activate', {});
    await push();
    expect(previews()).toHaveLength(0);
    expect(worker.shown[0].title).toBe('New mail');
    await worker.dispatch('message', { source: app, data: { type: 'app-lock', state: 'off', at: 1_000 } });
    await push();
    expect(worker.shown[worker.shown.length - 1].title).toContain('Secret sender');
  });

  it('keeps a word a page sent while it was taking over', async () => {
    const caches = new FakeCaches();
    const app = { id: 'app' };
    const { worker, push } = setup(caches, [app]);
    // The page speaks as the worker activates: the word lands after the activation's step.
    await Promise.all([
      worker.dispatch('activate', {}),
      worker.dispatch('message', { source: app, data: { type: 'app-lock', state: 'off', at: 1_000 } }),
    ]);
    await caches.delete(PUSH_CACHE);
    await push();
    expect(worker.shown[0].title).toContain('Secret sender');
  });
});
