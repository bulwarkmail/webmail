import { describe, it, expect, vi } from 'vitest';
import { FakeCaches, loadWorker } from './sw-harness';

// App lock: while locked a notification names no sender and no subject, and the
// worker doesn't even ask the server for them. It can't hear a browser closing, so
// "unlocked" only counts with a window open.

const PREVIEW = { unreadTotal: 1, slot: 0, email: { id: 'e1', threadId: 't1', subject: 'Secret subject', from: [{ name: 'Secret sender', email: 's@example.org' }] } };
const delivery = { kind: 'jmap-email-push', accountId: 'a', emailIds: ['e1'] };

function setup(clients: Array<{ id: string }>, notifications: Array<Record<string, unknown>> = []) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(PREVIEW), { status: 200 }));
  const worker = loadWorker({ buildId: 'b', caches: new FakeCaches(), clients, fetch: fetchMock, notifications });
  return { worker, fetchMock };
}

describe('a push while the app lock is on', () => {
  it('names the sender with no lock at all', async () => {
    const { worker, fetchMock } = setup([]);
    await worker.dispatch('push', { data: { json: () => delivery } });
    expect(fetchMock).toHaveBeenCalled();
    expect(worker.shown[0].title).toContain('Secret sender');
  });

  it('says nothing about the message while locked, and asks nothing', async () => {
    const { worker, fetchMock } = setup([{ id: 'c' }]);
    await worker.dispatch('message', { data: { type: 'app-lock', state: 'locked' } });
    await worker.dispatch('push', { data: { json: () => delivery } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(worker.shown)).not.toContain('Secret');
    expect(worker.shown[0].title).toBe('New mail');
  });

  it('names it again after unlock, with a window open', async () => {
    const { worker } = setup([{ id: 'c' }]);
    await worker.dispatch('message', { data: { type: 'app-lock', state: 'locked' } });
    await worker.dispatch('message', { data: { type: 'app-lock', state: 'unlocked' } });
    await worker.dispatch('push', { data: { json: () => delivery } });
    expect(worker.shown[0].title).toContain('Secret sender');
  });

  it('counts as locked with no window open: the key is in a window or nowhere', async () => {
    const { worker, fetchMock } = setup([]);
    await worker.dispatch('message', { data: { type: 'app-lock', state: 'unlocked' } });
    await worker.dispatch('push', { data: { json: () => delivery } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(worker.shown)).not.toContain('Secret');
  });

  it('names it again once the lock is off', async () => {
    const { worker } = setup([]);
    await worker.dispatch('message', { data: { type: 'app-lock', state: 'locked' } });
    await worker.dispatch('message', { data: { type: 'app-lock', state: 'off' } });
    await worker.dispatch('push', { data: { json: () => delivery } });
    expect(worker.shown[0].title).toContain('Secret sender');
  });

  it('closes what\'s already on screen when it locks', async () => {
    const close = vi.fn();
    const { worker } = setup([{ id: 'c' }], [
      { tag: 'bulwark-mail:a', title: 'Secret sender', close },
    ]);
    await worker.dispatch('message', { data: { type: 'app-lock', state: 'locked' } });
    expect(close).toHaveBeenCalled();
  });
});
