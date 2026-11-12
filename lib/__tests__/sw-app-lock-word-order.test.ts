import { describe, it, expect, vi } from 'vitest';
import { FakeCaches, loadWorker } from './sw-harness';

// The pages' words on the app lock reach the worker one after another and are applied
// in that order, one at a time: an "unlocked" that reads the store before it writes
// can't land after a "locked" that came right behind it. Pages stamp each word with the
// time they sent it (`at`); a word sent before what's stored doesn't count, except a
// "locked", which always does. A word without a stamp, from an older page, can't be
// placed after a stamped one.

const ORIGIN = 'https://mail.example.com';
const PREVIEW = {
  unreadTotal: 1,
  slot: 0,
  login: 'fp',
  email: { id: 'e1', threadId: 't1', subject: 'Secret subject 482913', from: [{ name: 'Secret sender', email: 's@example.org' }] },
};
const HOLDER = 'bulwark-app-lock-holder';

function client(id: string, path = '/mail/folder/inbox') {
  return { id, url: `${ORIGIN}${path}`, frameType: 'top-level', focused: false, visibilityState: 'visible', postMessage: () => {} };
}

function setup() {
  const clients: Array<ReturnType<typeof client>> = [];
  const holders = new Set<string>();
  const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(JSON.stringify(PREVIEW), { status: 200 }));
  const worker = loadWorker({
    buildId: 'b',
    caches: new FakeCaches(),
    clients,
    fetch: fetchMock,
    globals: {
      navigator: { locks: { query: async () => ({ held: [...holders].map((clientId) => ({ name: HOLDER, mode: 'exclusive', clientId })), pending: [] }) } },
    },
  });
  const previews = () => fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/push/preview'));
  let pushes = 0;
  // Each push names a new message, so none counts as already announced.
  const push = () => worker.dispatch('push', { data: { json: () => ({ kind: 'jmap-email-push', accountId: 'a', emailIds: [`e${++pushes}`] }) } });
  const say = (from: ReturnType<typeof client>, state: string, at?: number) =>
    worker.dispatch('message', { source: from, data: { type: 'app-lock', state, ...(at === undefined ? {} : { at }) } });
  const lastTitle = () => worker.shown[worker.shown.length - 1].title;
  return { worker, clients, holders, previews, push, say, lastTitle };
}

describe('the order of the pages\' words on the lock', () => {
  it('ends locked when an "unlocked" races a "locked" right behind it', async () => {
    const { clients, holders, previews, push, say, worker } = setup();
    const a = client('A');
    const b = client('B');
    clients.push(a, b);
    holders.add('A');
    await say(a, 'unlocked');
    await Promise.all([say(b, 'unlocked'), say(a, 'locked')]);
    // A still holds the key while it saves and scrubs before dropping it.
    await push();
    expect(previews()).toHaveLength(0);
    expect(JSON.stringify(worker.shown)).not.toContain('Secret');
  });

  it('ends locked in the same race between stamped words', async () => {
    const { clients, holders, previews, push, say } = setup();
    const a = client('A');
    const b = client('B');
    clients.push(a, b);
    holders.add('A');
    await say(a, 'unlocked', 1_000);
    await Promise.all([say(b, 'unlocked', 2_000), say(a, 'locked', 2_001)]);
    await push();
    expect(previews()).toHaveLength(0);
  });

  it('drops an "unlocked" that was sent before a "locked" and reached the worker after it', async () => {
    const { clients, holders, previews, push, say, lastTitle } = setup();
    const a = client('A');
    clients.push(a);
    holders.add('A');
    await say(a, 'locked', 2_000);
    await say(a, 'unlocked', 1_000);
    await push();
    expect(previews()).toHaveLength(0);
    expect(lastTitle()).toBe('New mail');
  });

  it('applies a late "locked" all the same, and the next "unlocked" opens it again', async () => {
    const { clients, holders, previews, push, say, lastTitle } = setup();
    const a = client('A');
    clients.push(a);
    holders.add('A');
    await say(a, 'unlocked', 2_000);
    await say(a, 'locked', 1_000);
    await push();
    expect(previews()).toHaveLength(0);
    // An "unlocked" sent between the two counts for nothing either.
    await say(a, 'unlocked', 1_500);
    await push();
    expect(previews()).toHaveLength(0);
    await say(a, 'unlocked', 3_000);
    await push();
    expect(lastTitle()).toContain('Secret sender');
  });

  it('keeps "locked" when an "off" sent before it arrives after it', async () => {
    const { clients, previews, push, say } = setup();
    const a = client('A');
    clients.push(a);
    await say(a, 'locked', 2_000);
    await say(a, 'off', 1_000);
    await push();
    expect(previews()).toHaveLength(0);
  });

  it('drops an unstamped "unlocked" after a stamped word', async () => {
    const { clients, holders, previews, push, say } = setup();
    const a = client('A');
    clients.push(a);
    holders.add('A');
    await say(a, 'locked', 2_000);
    await say(a, 'unlocked');
    await push();
    expect(previews()).toHaveLength(0);
  });

  it('counts both tabs that said "unlocked" in the same millisecond', async () => {
    const { clients, holders, push, say, lastTitle } = setup();
    const a = client('A');
    const b = client('B');
    clients.push(a, b);
    holders.add('B');
    await say(a, 'unlocked', 1_000);
    await say(b, 'unlocked', 1_000);
    // A closes; B, with the key, stays.
    clients.splice(0, 1);
    await push();
    expect(lastTitle()).toContain('Secret sender');
  });
});
