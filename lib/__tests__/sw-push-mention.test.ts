import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// A team note wakes every member's push (Stalwart 0.16 sends a state change
// for it). The preview route answers `mention` for the members it mentions
// and `skip` for everyone else; the worker shows the first once, under a tag
// of its own, and turns the second into its silent placeholder.
const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

type Shown = { title: string; options: Record<string, unknown>; closed: boolean };

function loadWorker(preview: (url: URL) => Record<string, unknown>, stored: { labels?: Record<string, string>; locked?: boolean } = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: Shown[] = [];
  const shade = new Map<string, Shown>();
  const cacheStore = new Map<string, string>();
  if (stored.labels) cacheStore.set('https://mail.example.com/__push-state/actions', JSON.stringify({ labels: stored.labels }));
  if (stored.locked) cacheStore.set('https://mail.example.com/__push-state/app-lock', JSON.stringify({ state: 'locked' }));
  let opened: string | undefined;
  const self = {
    location: { href: 'https://mail.example.com/sw.js', origin: 'https://mail.example.com' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => [], openWindow: async (url: string) => { opened = url; } },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        const entry: Shown = { title, options, closed: false };
        shown.push(entry);
        shade.set(String(options.tag ?? ''), entry);
      },
      getNotifications: async (filter?: { tag?: string }) => [...shade.entries()]
        .filter(([tag]) => !filter?.tag || tag === filter.tag)
        .map(([tag, n]) => ({ tag, title: n.title, body: n.options.body, data: n.options.data, close: () => { n.closed = true; shade.delete(tag); } })),
    },
  };
  const caches = {
    open: async () => ({
      match: async (key: string) => {
        const value = cacheStore.get(key);
        return value === undefined ? undefined : { json: async () => JSON.parse(value) };
      },
      put: async (key: string, res: { text: () => Promise<string> }) => { cacheStore.set(key, await res.text()); },
    }),
  };
  const fetchMock = vi.fn(async (input: string) => {
    const body = preview(new URL(input, 'https://mail.example.com'));
    return { ok: true, json: async () => body };
  });
  const context = vm.createContext({ self, caches, fetch: fetchMock, URL, URLSearchParams, Response, Date, console, AbortController, setTimeout, clearTimeout });
  vm.runInContext(SW_SOURCE, context);
  async function dispatch(type: string, event: Record<string, unknown>) {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }
  const push = (payload: unknown) => dispatch('push', { data: { json: () => payload } });
  const click = async (n: Shown) => {
    await dispatch('notificationclick', { notification: { tag: n.options.tag, data: n.options.data, close() {} } });
    return opened;
  };
  return { push, click, shown, shade, fetchMock };
}

const MENTION = { noteId: 'n1', messageId: 'n1@notes.bulwark.invalid', threadId: 'T1', emailId: 'offer', from: 'Mabel', subject: 'Offer for the Mulberry project' };
const noteDelivery = { kind: 'jmap-email-push', accountLabel: 'bob@example.org', accountId: 'g', emailIds: ['n1'] };
const stateChange = { kind: 'jmap-state-change', accountLabel: 'bob@example.org', accountId: 'g', emailIds: [], changed: { g: { EmailDelivery: 's1', Email: 's1' } } };
/** What stays on screen, and sounds. */
const visible = (shown: Shown[]) => shown.filter((n) => !n.closed && n.options.silent !== true);

describe('a mention of you in a team note', () => {
  it('is its own notification, titled with the author and subject, and opens the message at the note', async () => {
    const { push, click, shown, shade } = loadWorker(() => ({ mention: MENTION, slot: 0, login: 'fp' }));
    await push(noteDelivery);
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('Mabel mentioned you in “Offer for the Mulberry project”');
    expect(shown[0].options.tag).toBe('mention-g:n1');
    expect(shown[0].options.body).toBe('bob@example.org');
    expect(shade.has('bulwark-mail:g')).toBe(false);
    expect(await click(shown[0])).toBe('/mail/message/offer?slot=0&owner=g&note=n1');
  });

  it('uses the words the page left for it', async () => {
    const { push, shown } = loadWorker(() => ({ mention: MENTION, slot: 0 }), {
      labels: { mentionedYou: '{name} hat Sie in „{subject}“ erwähnt', mentionedHidden: 'Sie wurden in einem Team-Postfach erwähnt' },
    });
    await push(noteDelivery);
    expect(shown[0].title).toBe('Mabel hat Sie in „Offer for the Mulberry project“ erwähnt');
  });

  it('names neither author nor subject when the organisation keeps them off', async () => {
    const { from: _from, subject: _subject, ...withoutContent } = MENTION;
    const { push, shown } = loadWorker(() => ({ mention: withoutContent, redacted: true, slot: 0 }));
    await push(noteDelivery);
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('You were mentioned in a team mailbox');
    expect(JSON.stringify(shown[0])).not.toMatch(/Mabel|Mulberry/);
  });

  it('opens the team Inbox when the message it is about was not found', async () => {
    const { emailId: _emailId, ...noMessage } = MENTION;
    const { push, click, shown } = loadWorker(() => ({ mention: noMessage, slot: 0 }));
    await push(noteDelivery);
    expect(await click(shown[0])).toBe('/mail/folder/inbox?slot=0&owner=g&note=n1');
  });

  it('is told once: the same note again is silent', async () => {
    const { push, shown } = loadWorker(() => ({ skip: true, mention: MENTION, slot: 0 }));
    await push(stateChange);
    await push(stateChange);
    expect(visible(shown).map((n) => n.title)).toEqual(['Mabel mentioned you in “Offer for the Mulberry project”']);
  });

  it('is not told again when Undo brings the note back under a new id', async () => {
    let answer: Record<string, unknown> = { skip: true, mention: MENTION, slot: 0 };
    const { push, shown } = loadWorker(() => answer);
    await push(stateChange);
    answer = { skip: true, mention: { ...MENTION, noteId: 'n1-again' }, slot: 0 };
    await push(stateChange);
    expect(visible(shown)).toHaveLength(1);
  });

  it('comes with the mail that arrived alongside it', async () => {
    const { push, shade } = loadWorker(() => ({
      mention: MENTION, unreadTotal: 1, slot: 0,
      email: { id: 'm1', threadId: 't-m1', from: [{ name: 'Client' }], subject: 'New order' },
    }));
    await push(stateChange);
    expect(shade.get('mention-g:n1')?.title).toBe('Mabel mentioned you in “Offer for the Mulberry project”');
    expect(shade.get('bulwark-mail:g')?.title).toBe('Client (bob@example.org)');
  });
});

describe('while the app lock hides content', () => {
  it('asks with locked=1 and says only that you were mentioned', async () => {
    // Whatever the answer holds, the worker names nobody and nothing.
    const { push, shown, fetchMock } = loadWorker(() => ({ skip: true, mention: MENTION, slot: 0 }), { locked: true });
    await push(noteDelivery);
    expect(String(fetchMock.mock.calls[0][0])).toContain('locked=1');
    expect(visible(shown).map((n) => n.title)).toEqual(['You were mentioned in a team mailbox']);
    expect(JSON.stringify(shown)).not.toMatch(/Mabel|Mulberry/);
  });

  it('stays silent for a note that mentions someone else', async () => {
    const { push, shown } = loadWorker(() => ({ skip: true, redacted: true, slot: 0 }), { locked: true });
    await push(stateChange);
    expect(shown.length).toBeGreaterThan(0);
    expect(visible(shown)).toEqual([]);
  });

  it('tells of mail as before: "New mail", nothing from the answer', async () => {
    const { push, shown } = loadWorker(() => ({
      unreadTotal: 1, slot: 0, email: { id: 'm1', threadId: 't-m1', from: [{ name: 'Client' }], subject: 'New order' },
    }), { locked: true });
    await push(stateChange);
    expect(visible(shown).map((n) => n.title)).toEqual(['New mail (bob@example.org)']);
    expect(JSON.stringify(shown)).not.toMatch(/Client|New order/);
  });
});

describe('a team note that does not mention you', () => {
  it('ends in the silent placeholder, not in mail', async () => {
    const { push, shown, shade } = loadWorker(() => ({ skip: true, slot: 0 }));
    await push(stateChange);
    // Every push has to show something (Safari drops the subscription otherwise).
    expect(shown.length).toBeGreaterThan(0);
    expect(visible(shown)).toEqual([]);
    expect(shade.size).toBe(0);
  });

  it('does the same for a push that names the note', async () => {
    const { push, shown } = loadWorker(() => ({ skip: true }));
    await push(noteDelivery);
    expect(shown.length).toBeGreaterThan(0);
    expect(visible(shown)).toEqual([]);
  });
});
