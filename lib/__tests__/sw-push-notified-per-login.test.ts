import { describe, it, expect, vi } from 'vitest';
import { FakeCaches, loadWorker } from './sw-harness';

// The worker keeps a list of the messages it announced, so that a push delivered twice
// doesn't ring twice. Account ids repeat across servers, so the list goes under the login
// the push names (its label, the user name) as well as the account: two logins whose
// accounts share an id each get their own notification, and a wipe of one login takes
// its own lists only (lib/offline/__tests__/device-wipe-push-state-per-login.test.ts). A
// reply typed on a notification is kept with the notification's login, for the same wipe.

const ORIGIN = 'https://mail.example.com';
const PUSH_CACHE = 'bulwark-push-state-v1';

function preview(login: string) {
  return { unreadTotal: 1, slot: 0, login, email: { id: 'e1', threadId: 't1', subject: 'Secret subject', from: [{ name: 'Secret sender', email: 's@example.org' }] } };
}

function setup(caches = new FakeCaches()) {
  const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
    const login = new URL(String(input), ORIGIN).searchParams.get('login') === 'bob' ? 'fp-bob' : 'fp-alice';
    return new Response(JSON.stringify(preview(login)), { status: 200 });
  });
  const openWindow = vi.fn(async (_url: string) => null);
  const worker = loadWorker({ buildId: 'b', caches, clients: [], fetch: fetchMock, openWindow, globals: { MessageChannel } });
  const previews = () => fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/push/preview'));
  const pushFor = (accountLabel: string | undefined) => worker.dispatch('push', {
    data: { json: () => ({ kind: 'jmap-email-push', accountId: 'a', emailIds: ['e1'], ...(accountLabel ? { accountLabel } : {}) }) },
  });
  return { worker, caches, previews, pushFor };
}

async function stored(caches: FakeCaches, path: string): Promise<unknown> {
  const response = await (await caches.open(PUSH_CACHE)).match(`${ORIGIN}/__push-state/${path}`);
  return response ? response.json() : undefined;
}

describe('the list of announced messages', () => {
  it('lets two logins whose accounts share an id each announce the same message id', async () => {
    const { worker, previews, pushFor } = setup();
    await pushFor('alice');
    await pushFor('bob');
    expect(previews()).toHaveLength(2);
    expect(worker.shown.map((shown) => shown.title)).toEqual(['Secret sender (alice)', 'Secret sender (bob)']);
  });

  it('still rings once for a push delivered twice to the same login', async () => {
    const { previews, pushFor } = setup();
    await pushFor('alice');
    await pushFor('alice');
    expect(previews()).toHaveLength(1);
  });

  it('is kept under the login and the account', async () => {
    const { caches, pushFor } = setup();
    await pushFor('alice');
    expect(await stored(caches, 'notified/alice/a')).toEqual({ ids: ['e1'] });
    expect(await stored(caches, 'notified/a')).toBeUndefined();
  });

  it('is kept per account for a push that names no login', async () => {
    const { caches, pushFor } = setup();
    await pushFor(undefined);
    expect(await stored(caches, 'notified/a')).toEqual({ ids: ['e1'] });
  });
});

describe('a reply typed on a notification', () => {
  it('is kept with the notification\'s login', async () => {
    const { worker, caches } = setup();
    await worker.dispatch('notificationclick', {
      action: 'reply',
      reply: 'Private words',
      notification: { data: { kind: 'email', emailId: 'e1', threadId: 't1', accountId: 'a', slot: 0, login: 'fp-alice' }, tag: 'bulwark-mail:a', close() {} },
    });
    expect(await stored(caches, 'pending-reply')).toMatchObject({ emailId: 'e1', text: 'Private words', login: 'fp-alice' });
  });
});
