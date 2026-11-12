import { describe, it, expect, vi } from 'vitest';
import { FakeCaches, loadWorker } from './sw-harness';

// The app lock's state in the worker's push store can be deleted with the rest of that
// store (a sign-out, or a wipe from a page of an older version). Pages say "off" as well
// as "locked" and "unlocked", so the worker can take a missing state for locked once the
// lock was on, until a page says something again.

const PUSH_CACHE = 'bulwark-push-state-v1';
const PREVIEW = { unreadTotal: 1, slot: 0, email: { id: 'e1', threadId: 't1', subject: 'Secret subject', from: [{ name: 'Secret sender', email: 's@example.org' }] } };
const delivery = { kind: 'jmap-email-push', accountId: 'a', emailIds: ['e1'] };

function setup(clients: Array<{ id: string }>, caches = new FakeCaches()) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(PREVIEW), { status: 200 }));
  const worker = loadWorker({ buildId: 'b', caches, clients, fetch: fetchMock });
  return { worker, caches, fetchMock };
}

describe('the app lock\'s state gone from the worker\'s store', () => {
  it('names the sender on a device that never had the lock', async () => {
    const { worker } = setup([]);
    await worker.dispatch('push', { data: { json: () => delivery } });
    expect(worker.shown[0].title).toContain('Secret sender');
  });

  it('says nothing, and asks nothing, once the lock was on', async () => {
    const clients = [{ id: 'app' }];
    const { worker, caches, fetchMock } = setup(clients);
    await worker.dispatch('message', { data: { type: 'app-lock', state: 'unlocked' } });
    await caches.delete(PUSH_CACHE);
    clients.length = 0;
    await worker.dispatch('push', { data: { json: () => delivery } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(worker.shown)).not.toContain('Secret');
  });

  it('says nothing either with the app tab still open: no page has spoken since', async () => {
    const { worker, caches, fetchMock } = setup([{ id: 'app' }]);
    await worker.dispatch('message', { data: { type: 'app-lock', state: 'locked' } });
    await caches.delete(PUSH_CACHE);
    await worker.dispatch('push', { data: { json: () => delivery } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(worker.shown[0].title).toBe('New mail');
  });

  it('names the sender once the lock was turned off before', async () => {
    const { worker, caches } = setup([]);
    await worker.dispatch('message', { data: { type: 'app-lock', state: 'locked' } });
    await worker.dispatch('message', { data: { type: 'app-lock', state: 'off' } });
    await caches.delete(PUSH_CACHE);
    await worker.dispatch('push', { data: { json: () => delivery } });
    expect(worker.shown[0].title).toContain('Secret sender');
  });

  it('goes by what a page says next, also in a worker started again', async () => {
    const caches = new FakeCaches();
    const before = setup([{ id: 'app' }], caches);
    await before.worker.dispatch('message', { data: { type: 'app-lock', state: 'unlocked' } });
    await caches.delete(PUSH_CACHE);

    const after = setup([{ id: 'app' }], caches);
    await after.worker.dispatch('push', { data: { json: () => delivery } });
    expect(after.worker.shown[0].title).toBe('New mail');
    await after.worker.dispatch('message', { data: { type: 'app-lock', state: 'unlocked' } });
    await after.worker.dispatch('push', { data: { json: () => ({ ...delivery, emailIds: ['e2'] }) } });
    expect(after.worker.shown[after.worker.shown.length - 1].title).toContain('Secret sender');
  });
});
