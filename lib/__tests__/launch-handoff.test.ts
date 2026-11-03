// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCaches, loadWorker } from './sw-harness';
import {
  HANDOFF_CACHE,
  HANDOFF_TTL_MS,
  adoptStoredHandoff,
  clearHandoffs,
  handOffDraft,
  handOffFiles,
  handOffLaunchFiles,
  handOffNewMessage,
  kindForFile,
  parseLaunchLanding,
  pendingHandoffs,
  restoreStoredHandoffs,
  shareDraft,
  shortcutFromTargetUrl,
  stripLandingParams,
  subscribeHandoff,
  takeHandoff,
} from '../launch-handoff';

// Files and links from outside the app on their way to what handles them.

const file = (name: string, type = '', body = 'x') => new File([body], name, { type });
const handle = (f: File) => ({ kind: 'file', getFile: async () => f });
const settle = () => new Promise((r) => setTimeout(r, 0));

function memoryStorage() {
  const backing = new Map<string, string>();
  return {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value); },
    removeItem: (key: string) => { backing.delete(key); },
  };
}

let caches: FakeCaches;

beforeEach(() => {
  caches = new FakeCaches();
  vi.stubGlobal('caches', caches);
  vi.stubGlobal('sessionStorage', memoryStorage());
});

afterEach(() => {
  clearHandoffs();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('where a launched file goes', () => {
  it.each([
    ['mail.eml', '', 'eml'],
    ['MAIL.EML', '', 'eml'],
    ['invite.ics', '', 'calendar'],
    ['invite.ical', '', 'calendar'],
    ['people.vcf', '', 'contacts'],
    ['people.vcard', '', 'contacts'],
    ['noextension', 'message/rfc822', 'eml'],
    ['noextension', 'text/calendar', 'calendar'],
    ['noextension', 'text/x-vcard', 'contacts'],
    ['photo.png', 'image/png', null],
  ])('%s (%s) goes to %s', (name, type, kind) => {
    expect(kindForFile(file(name, type))).toBe(kind);
  });

  it('splits one launch by type and names what nothing handles', async () => {
    const eml = file('a.eml');
    const ics = file('b.ics');
    const vcf = file('c.vcf');
    const result = await handOffLaunchFiles([handle(eml), handle(ics), handle(vcf), handle(file('d.png'))]);

    expect(result).toEqual({ unsupported: ['d.png'], failed: 0 });
    expect(takeHandoff('eml')?.files).toEqual([eml]);
    expect(takeHandoff('calendar')?.files).toEqual([ics]);
    expect(takeHandoff('contacts')?.files).toEqual([vcf]);
  });

  it('counts a file it could not read', async () => {
    const result = await handOffLaunchFiles([{ kind: 'file', getFile: async () => { throw new Error('gone'); } }]);
    expect(result).toEqual({ unsupported: [], failed: 1 });
    expect(pendingHandoffs()).toEqual([]);
  });

  it('skips a directory handle', async () => {
    const result = await handOffLaunchFiles([{ kind: 'directory' }]);
    expect(result).toEqual({ unsupported: [], failed: 0 });
    expect(pendingHandoffs()).toEqual([]);
  });
});

describe('handing off', () => {
  it('gives a handoff to one taker, once', () => {
    const ics = file('a.ics');
    handOffFiles([ics], 'calendar');
    expect(takeHandoff('contacts')).toBeNull();
    expect(takeHandoff('calendar')?.files).toEqual([ics]);
    expect(takeHandoff('calendar')).toBeNull();
  });

  it('tells the app first, while the handoff is still pending, then the taker', () => {
    const order: string[] = [];
    const offKind = subscribeHandoff('contacts', () => {
      order.push(`taker:${takeHandoff('contacts') ? 'got it' : 'nothing'}`);
    });
    const offAny = subscribeHandoff('any', (kind) => {
      order.push(`app:${kind}:${pendingHandoffs().length}`);
    });
    handOffFiles([file('a.vcf')], 'contacts');
    expect(order).toEqual(['app:contacts:1', 'taker:got it']);
    offKind();
    offAny();
  });

  it('stops telling a listener that unsubscribed', () => {
    const listener = vi.fn();
    subscribeHandoff('calendar', listener)();
    handOffFiles([file('a.ics')], 'calendar');
    expect(listener).not.toHaveBeenCalled();
  });

  it('does nothing for no files', () => {
    handOffFiles([], 'calendar');
    expect(pendingHandoffs()).toEqual([]);
  });

  it('drops what waited too long', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    handOffFiles([file('a.ics')], 'calendar');
    vi.advanceTimersByTime(HANDOFF_TTL_MS + 1);
    expect(takeHandoff('calendar')).toBeNull();
    expect(pendingHandoffs()).toEqual([]);
  });

  it('counts a new message that arrives twice in one launch once', () => {
    handOffNewMessage();
    handOffNewMessage();
    expect(takeHandoff('compose')).toMatchObject({ files: [] });
    expect(takeHandoff('compose')).toBeNull();
  });

  it('carries the text of a draft', () => {
    handOffDraft({ subject: 'Hi', body: 'There', files: [file('a.pdf')] });
    const handoff = takeHandoff('compose');
    expect(handoff).toMatchObject({ subject: 'Hi', body: 'There' });
    expect(handoff?.files.map((f) => f.name)).toEqual(['a.pdf']);
  });
});

describe('across a page load', () => {
  // A sign-in through SSO leaves the page. A new module state stands in for
  // the new page: the queue is emptied, sessionStorage and the cache stay.
  async function newPage() {
    pendingHandoffs();
    while (takeHandoffQuietly()) { /* the old page's memory goes */ }
  }
  function takeHandoffQuietly() {
    const list = pendingHandoffs() as unknown as unknown[];
    return list.length > 0 ? list.splice(0, list.length) : null;
  }

  it('brings back a file that waited for a sign-in, with its name and type', async () => {
    handOffFiles([file('a.ics', 'text/calendar', 'BEGIN:VCALENDAR')], 'calendar');
    await settle();
    await newPage();
    expect(takeHandoff('calendar')).toBeNull();

    await restoreStoredHandoffs();
    const handoff = takeHandoff('calendar');
    expect(handoff?.files[0].name).toBe('a.ics');
    expect(handoff?.files[0].type).toBe('text/calendar');
    expect(await handoff?.files[0].text()).toBe('BEGIN:VCALENDAR');
  });

  it('removes the stored copy once it is taken', async () => {
    handOffFiles([file('a.ics')], 'calendar');
    await settle();
    const store = await caches.open(HANDOFF_CACHE);
    expect((await store.keys()).length).toBe(2);

    takeHandoff('calendar');
    await settle();
    await settle();
    expect((await store.keys()).length).toBe(0);
    expect(sessionStorage.getItem('bulwark:launch-handoffs')).toBeNull();
  });

  it('never stores a .eml: it opens at once and needs no sign-in', async () => {
    handOffFiles([file('a.eml')], 'eml');
    await settle();
    expect(await caches.has(HANDOFF_CACHE)).toBe(false);
  });

  it("leaves another window's handoff alone", async () => {
    handOffFiles([file('a.ics')], 'calendar');
    await settle();
    await newPage();
    // Another window: its own sessionStorage, the same cache.
    vi.stubGlobal('sessionStorage', memoryStorage());
    await restoreStoredHandoffs();
    expect(takeHandoff('calendar')).toBeNull();
    expect((await (await caches.open(HANDOFF_CACHE)).keys()).length).toBe(2);
  });

  it('sweeps what nobody took, and keeps what is recent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    handOffFiles([file('old.ics')], 'calendar');
    await settle();
    await newPage();
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.advanceTimersByTime(HANDOFF_TTL_MS + 1);
    handOffFiles([file('new.vcf')], 'contacts');
    await settle();

    await restoreStoredHandoffs();
    const store = await caches.open(HANDOFF_CACHE);
    const urls = (await store.keys()).map((key) => key.url);
    expect(urls).toHaveLength(2);
    const meta = await store.match(urls.find((url) => url.endsWith('/meta'))!);
    expect(((await meta!.json()) as { kind: string }).kind).toBe('contacts');
  });

  it('keeps working in memory without the Cache API', async () => {
    vi.stubGlobal('caches', undefined);
    const ics = file('a.ics');
    handOffFiles([ics], 'calendar');
    await settle();
    expect(takeHandoff('calendar')?.files).toEqual([ics]);
    expect(await adoptStoredHandoff('anything')).toBe(false);
  });

  it('keeps the file in memory when the cache is full', async () => {
    const original = caches.open.bind(caches);
    vi.spyOn(caches, 'open').mockImplementation(async (name: string) => ({
      ...(await original(name)),
      put: async () => { throw new DOMException('full', 'QuotaExceededError'); },
    }));
    const ics = file('a.ics');
    handOffFiles([ics], 'calendar');
    await settle();
    expect(sessionStorage.getItem('bulwark:launch-handoffs')).toBeNull();
    expect(takeHandoff('calendar')?.files).toEqual([ics]);
  });
});

describe('sign-out', () => {
  it('forgets what is waiting, in memory and stored', async () => {
    handOffFiles([file('a.ics')], 'calendar');
    await settle();
    clearHandoffs();
    await settle();
    expect(pendingHandoffs()).toEqual([]);
    expect(await caches.has(HANDOFF_CACHE)).toBe(false);
    expect(sessionStorage.getItem('bulwark:launch-handoffs')).toBeNull();
  });
});

describe('what the service worker stored', () => {
  it('becomes a draft with the files, under the id in the address', async () => {
    // The real worker writes it, so this fails if the two layouts drift apart.
    const worker = loadWorker({ buildId: 'a', caches, clients: [] });
    const form = new FormData();
    form.set('title', 'A link');
    form.set('text', 'Look at this');
    form.set('url', 'https://example.org/page');
    form.append('files', file('photo.png', 'image/png', 'bytes'));
    const answer = await worker.request({ url: 'https://mail.example.com/protocol/share', method: 'POST', mode: 'navigate', formData: async () => form } as never);
    const landing = parseLaunchLanding(new URL(answer!.headers.get('location')!).search);
    expect(landing?.type).toBe('stored');
    const { id } = landing as { id: string };

    expect(await adoptStoredHandoff(id)).toBe(true);
    const handoff = takeHandoff('compose');
    expect(handoff).toMatchObject({ subject: 'A link', body: 'Look at this\n\nhttps://example.org/page' });
    expect(handoff?.files[0].name).toBe('photo.png');
    expect(handoff?.files[0].type).toBe('image/png');
    expect(await handoff?.files[0].text()).toBe('bytes');
    await settle();
    await settle();
    expect((await (await caches.open(HANDOFF_CACHE)).keys()).length).toBe(0);
  });

  it('is gone when the id names nothing', async () => {
    expect(await adoptStoredHandoff('11111111-2222')).toBe(false);
  });

  it('is gone when it is too old', async () => {
    const store = await caches.open(HANDOFF_CACHE);
    await store.put('/__bulwark/handoff/old/meta', new Response(JSON.stringify({ kind: 'compose', createdAt: Date.now() - HANDOFF_TTL_MS - 1, files: [] })));
    expect(await adoptStoredHandoff('old')).toBe(false);
    expect((await store.keys()).length).toBe(0);
  });
});

describe('text of a share', () => {
  it('puts the link under the text', () => {
    expect(shareDraft({ title: ' T ', text: 'Hello', url: 'https://a.example' })).toEqual({ subject: 'T', body: 'Hello\n\nhttps://a.example' });
  });

  it('does not repeat a link that is in the text already', () => {
    expect(shareDraft({ text: 'See https://a.example now', url: 'https://a.example' }).body).toBe('See https://a.example now');
  });

  it('copes with only a link', () => {
    expect(shareDraft({ url: 'https://a.example' })).toEqual({ subject: '', body: 'https://a.example' });
  });
});

describe('the address a launch lands on', () => {
  it.each([
    ['?compose=1', { type: 'new-message' }],
    ['?share=abc-123', { type: 'stored', id: 'abc-123' }],
    ['?share=unavailable&share_title=T&share_text=B&share_files=1', { type: 'inline', subject: 'T', body: 'B', filesLost: true }],
    ['?share=unavailable&share_url=https%3A%2F%2Fa.example', { type: 'inline', subject: '', body: 'https://a.example', filesLost: false }],
    ['?share=..%2F..%2Fetc', null],
    ['?compose=0', null],
    ['?openLatestUnread=1', null],
    ['', null],
  ])('%s', (search, expected) => {
    expect(parseLaunchLanding(search)).toEqual(expected);
  });

  it('leaves only what is not about the launch', () => {
    expect(stripLandingParams('?compose=1')).toBe('');
    expect(stripLandingParams('?share=unavailable&share_text=x&slot=2')).toBe('?slot=2');
  });
});

describe('a shortcut reaching an open window', () => {
  const origin = 'https://mail.example.com';
  it.each([
    [`${origin}/?compose=1`, 'new-message'],
    [`${origin}/en/?compose=1`, 'new-message'],
    [`${origin}/calendar`, 'calendar'],
    [`${origin}/de/contacts`, 'contacts'],
    // The plain app icon and links into the app don't move an open window.
    [`${origin}/`, null],
    [`${origin}/calendar/some-event`, null],
    [`${origin}/settings`, null],
    ['https://evil.example/calendar', null],
  ])('%s', (target, expected) => {
    expect(shortcutFromTargetUrl(target, origin)).toBe(expected);
  });
});
