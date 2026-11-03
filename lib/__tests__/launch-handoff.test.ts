// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCaches, loadWorker } from './sw-harness';
import {
  HANDOFF_CACHE,
  HANDOFF_MAX_BYTES,
  HANDOFF_MAX_ENTRIES,
  HANDOFF_TTL_MS,
  adoptStoredHandoff,
  clearHandoffs,
  discardStoredHandoff,
  expireHandoffs,
  handOffDraft,
  handOffFiles,
  handOffLaunchFiles,
  handOffNewMessage,
  kindForFile,
  parseLaunchLanding,
  peekStoredHandoff,
  pendingHandoffs,
  restoreStoredHandoffs,
  shareDraft,
  shortcutFromTargetUrl,
  stripLandingParams,
  subscribeHandoff,
  subscribeHandoffLost,
  takeHandoff,
} from '../launch-handoff';

// Files and links from outside the app on their way to what handles them.

const file = (name: string, type = '', body = 'x') => new File([body], name, { type });
const handle = (f: File) => ({ kind: 'file', getFile: async () => f });
// Sealing runs on Web Crypto's thread pool.
const settle = () => new Promise((r) => setTimeout(r, 60));
const whenStored = () => vi.waitFor(() => expect(sessionStorage.getItem('bulwark:launch-handoffs')).not.toBeNull(), { timeout: 5000 });

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
    await whenStored();
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
    await whenStored();
    const store = await caches.open(HANDOFF_CACHE);
    expect((await store.keys()).length).toBe(3);

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
    await whenStored();
    await newPage();
    // Another window: its own sessionStorage, the same cache.
    vi.stubGlobal('sessionStorage', memoryStorage());
    await restoreStoredHandoffs();
    expect(takeHandoff('calendar')).toBeNull();
    expect((await (await caches.open(HANDOFF_CACHE)).keys()).length).toBe(3);
  });

  it('keeps no readable bytes, name or text at rest', async () => {
    handOffDraft({ subject: 'Secret subject', body: 'Secret text', files: [file('secret-name.txt', 'text/plain', 'secret bytes')] });
    await whenStored();
    const store = await caches.open(HANDOFF_CACHE);
    const keys = await store.keys();
    expect(keys.length).toBeGreaterThanOrEqual(3);
    for (const key of keys) {
      const stored = await (await store.match(key))!.text();
      for (const secret of ['Secret subject', 'Secret text', 'secret-name', 'secret bytes']) expect(stored).not.toContain(secret);
    }
  });

  it('cannot read it once the tab with the key is gone', async () => {
    handOffFiles([file('a.ics')], 'calendar');
    await whenStored();
    await newPage();
    vi.stubGlobal('sessionStorage', memoryStorage());
    const store = await caches.open(HANDOFF_CACHE);
    const metaKey = (await store.keys()).find((key) => key.url.endsWith('/meta'))!.url;
    const id = metaKey.split('/').slice(-2)[0];
    expect(await adoptStoredHandoff(id)).toBe(false);
    expect(await adoptStoredHandoff(id, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
  });

  it('says so when a stored handoff of this tab is gone after the reload', async () => {
    const losses: string[] = [];
    const off = subscribeHandoffLost((loss) => losses.push(loss));
    handOffFiles([file('a.ics')], 'calendar');
    await whenStored();
    await newPage();
    await caches.delete(HANDOFF_CACHE);
    await restoreStoredHandoffs();
    expect(losses).toEqual(['expired']);
    expect(sessionStorage.getItem('bulwark:launch-handoffs')).toBeNull();
    off();
  });

  it('says so when a stored file is missing, and delivers the rest', async () => {
    const losses: string[] = [];
    const off = subscribeHandoffLost((loss) => losses.push(loss));
    handOffDraft({ subject: 'S', files: [file('one.txt'), file('two.txt')] });
    await whenStored();
    await newPage();
    const store = await caches.open(HANDOFF_CACHE);
    const first = (await store.keys()).find((key) => key.url.endsWith('/0'))!;
    await store.delete(first);
    await restoreStoredHandoffs();
    expect(losses).toEqual(['missing']);
    expect(takeHandoff('compose')?.files.map((f) => f.name)).toEqual(['two.txt']);
    off();
  });

  it('keeps no more than the limit, oldest out first', async () => {
    const created: string[] = [];
    for (let n = 0; n < HANDOFF_MAX_ENTRIES + 2; n += 1) {
      const name = `f${n}.ics`;
      handOffFiles([file(name)], 'calendar');
      created.push(name);
      await settle();
      await settle();
    }
    const store = await caches.open(HANDOFF_CACHE);
    const metas = (await store.keys()).filter((key) => key.url.endsWith('/meta'));
    expect(metas.length).toBeLessThanOrEqual(HANDOFF_MAX_ENTRIES);
  });

  it('does not store what is over the byte limit, and keeps it in memory', async () => {
    const big = file('big.ics');
    Object.defineProperty(big, 'size', { value: HANDOFF_MAX_BYTES + 1 });
    handOffFiles([big], 'calendar');
    await settle();
    expect(await caches.has(HANDOFF_CACHE)).toBe(false);
    expect(takeHandoff('calendar')?.files).toEqual([big]);
  });

  it('sweeps what nobody took, and keeps what is recent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    handOffFiles([file('old.ics')], 'calendar');
    await whenStored();
    await newPage();
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.advanceTimersByTime(HANDOFF_TTL_MS + 1);
    handOffFiles([file('new.vcf')], 'contacts');
    await whenStored();

    await restoreStoredHandoffs();
    const store = await caches.open(HANDOFF_CACHE);
    const urls = (await store.keys()).map((key) => key.url);
    expect(urls).toHaveLength(3);
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

describe('while the page stays open', () => {
  it('drops what waited too long on a timer, and says so', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const losses: string[] = [];
    const off = subscribeHandoffLost((loss) => losses.push(loss));
    handOffFiles([file('a.eml')], 'eml');
    await vi.advanceTimersByTimeAsync(HANDOFF_TTL_MS + 2000);
    expect(pendingHandoffs()).toEqual([]);
    expect(losses).toEqual(['expired']);
    off();
  });

  it('says so when a taker finds only an expired handoff', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const losses: string[] = [];
    const off = subscribeHandoffLost((loss) => losses.push(loss));
    handOffFiles([file('a.eml')], 'eml');
    vi.advanceTimersByTime(HANDOFF_TTL_MS + 1);
    expect(takeHandoff('eml')).toBeNull();
    expect(losses).toEqual(['expired']);
    off();
  });

  it('keeps what is still in time', async () => {
    handOffFiles([file('a.eml')], 'eml');
    await expireHandoffs();
    expect(pendingHandoffs()).toHaveLength(1);
  });

  it('leaves the second of two drafts queued until it is taken', () => {
    handOffDraft({ subject: 'first' });
    handOffDraft({ subject: 'second' });
    expect(takeHandoff('compose')?.subject).toBe('first');
    expect(pendingHandoffs().map((h) => h.subject)).toEqual(['second']);
  });
});

describe('sign-out', () => {
  it('forgets what is waiting, in memory and stored', async () => {
    handOffFiles([file('a.ics')], 'calendar');
    await whenStored();
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
    const answer = await worker.request({ url: 'https://mail.example.com/protocol/share', method: 'POST', mode: 'navigate', destination: 'document', formData: async () => form } as never);
    const location = new URL(answer!.headers.get('location')!);
    const landing = parseLaunchLanding(location.search, location.hash);
    expect(landing?.type).toBe('stored');
    const { id, key } = landing as { id: string; key: string };

    // Without the key from the address it can't be read; asking shows what it is.
    expect(await peekStoredHandoff(id, '')).toBeNull();
    expect(await peekStoredHandoff(id, key)).toEqual({ subject: 'A link', body: 'Look at this\n\nhttps://example.org/page', files: ['photo.png'] });
    expect(pendingHandoffs()).toEqual([]);

    expect(await adoptStoredHandoff(id, key)).toBe(true);
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
    expect(await adoptStoredHandoff('11111111-2222', 'AAAA')).toBe(false);
    expect(await peekStoredHandoff('11111111-2222', 'AAAA')).toBeNull();
  });

  it('goes when the user refuses it', async () => {
    const worker = loadWorker({ buildId: 'a', caches, clients: [] });
    const form = new FormData();
    form.append('files', file('photo.png'));
    const answer = await worker.request({ url: 'https://mail.example.com/protocol/share', method: 'POST', mode: 'navigate', destination: 'document', formData: async () => form } as never);
    const location = new URL(answer!.headers.get('location')!);
    const { id, key } = parseLaunchLanding(location.search, location.hash) as { id: string; key: string };
    await discardStoredHandoff(id);
    expect((await (await caches.open(HANDOFF_CACHE)).keys()).length).toBe(0);
    expect(await peekStoredHandoff(id, key)).toBeNull();
  });

  it('cleans control characters out of names and text, as for a mailto: link', async () => {
    const worker = loadWorker({ buildId: 'a', caches, clients: [] });
    const form = new FormData();
    form.set('title', 'Hi\r\nBcc: evil@example.org');
    form.append('files', file('a\u202Egnp.exe'));
    const answer = await worker.request({ url: 'https://mail.example.com/protocol/share', method: 'POST', mode: 'navigate', destination: 'document', formData: async () => form } as never);
    const location = new URL(answer!.headers.get('location')!);
    const { id, key } = parseLaunchLanding(location.search, location.hash) as { id: string; key: string };
    expect(await peekStoredHandoff(id, key)).toMatchObject({ subject: 'HiBcc: evil@example.org', files: ['agnp.exe'] });
  });

  it('is gone when it is too old', async () => {
    const store = await caches.open(HANDOFF_CACHE);
    await store.put('/__bulwark/handoff/old/meta', new Response(JSON.stringify({ kind: 'compose', createdAt: Date.now() - HANDOFF_TTL_MS - 1, bytes: 0 })));
    expect(await adoptStoredHandoff('old', 'AAAA')).toBe(false);
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

  it('strips control characters from the subject, so no header can be planted', () => {
    expect(shareDraft({ title: 'Hi\r\nBcc: evil@example.org' }).subject).toBe('HiBcc: evil@example.org');
  });

  it('keeps line breaks in the body and drops other control characters', () => {
    expect(shareDraft({ text: 'one\r\ntwo\u0000\u0007' }).body).toBe('one\ntwo');
  });

  it('applies the limits of a mailto: link', () => {
    const draft = shareDraft({ title: 'x'.repeat(2000), text: 'y'.repeat(100_000), url: 'https://a.example' });
    expect(draft.subject).toHaveLength(998);
    expect(draft.body).toHaveLength(64 * 1024);
  });

  it('applies them to a draft handed in directly as well', () => {
    handOffDraft({ subject: 'a\r\nb', body: 'y'.repeat(100_000) });
    const handoff = takeHandoff('compose');
    expect(handoff?.subject).toBe('ab');
    expect(handoff?.body).toHaveLength(64 * 1024);
  });
});

describe('the address a launch lands on', () => {
  it.each([
    ['?compose=1', '', { type: 'new-message' }],
    ['', '#share=abc-123&key=k1', { type: 'stored', id: 'abc-123', key: 'k1' }],
    ['', '#share=unavailable&share_title=T&share_text=B&share_files=1', { type: 'inline', subject: 'T', body: 'B', filesLost: true, cut: false }],
    ['', '#share=unavailable&share_url=https%3A%2F%2Fa.example&share_cut=1', { type: 'inline', subject: '', body: 'https://a.example', filesLost: false, cut: true }],
    ['', '#share=..%2F..%2Fetc', null],
    // Shared text stays out of the query, which reaches logs.
    ['?share=unavailable&share_text=x', '', null],
    ['?compose=0', '', null],
    ['?openLatestUnread=1', '#x', null],
    ['', '', null],
  ])('%s %s', (search, hash, expected) => {
    expect(parseLaunchLanding(search, hash)).toEqual(expected);
  });

  it('cleans text that came in the address', () => {
    const landing = parseLaunchLanding('', '#share=unavailable&share_title=Hi%0D%0ABcc%3A%20evil');
    expect(landing).toMatchObject({ subject: 'HiBcc: evil' });
  });

  it('leaves only what is not about the launch', () => {
    expect(stripLandingParams('?compose=1', '')).toEqual({ search: '', hash: '' });
    expect(stripLandingParams('?slot=2', '#share=unavailable&share_text=x')).toEqual({ search: '?slot=2', hash: '' });
    expect(stripLandingParams('?compose=1&slot=2', '#section')).toEqual({ search: '?slot=2', hash: '#section' });
    expect(stripLandingParams('', '#share=a&key=b')).toEqual({ search: '', hash: '' });
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
