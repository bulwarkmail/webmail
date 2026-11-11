import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  clearContactPhotoCache,
  contactPhotoConcurrency,
  contactPhotoKey,
  loadContactPhotoBlob,
  peekContactPhoto,
  requestContactPhoto,
  subscribeContactPhotos,
} from '../contact-photo-cache';

/** Lets every settled download run its continuation (fetchers resolve as microtasks). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred() {
  let resolve!: (blob: Blob) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Blob>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const jpeg = (label = 'x') => new Blob([label], { type: 'image/jpeg' });

describe('contact photo cache', () => {
  let urls = 0;
  let createObjectURL: ReturnType<typeof vi.spyOn>;
  let revokeObjectURL: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearContactPhotoCache();
    urls = 0;
    createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:photo-${urls++}`);
    revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    clearContactPhotoCache();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keys photos by login and blobId', () => {
    expect(contactPhotoKey('me@host', 'dbcX')).toBe('me@host|dbcX');
    expect(contactPhotoKey(undefined, 'dbcX')).toBe('|dbcX');
  });

  it('downloads a photo once for every avatar that asks for it', async () => {
    const fetcher = vi.fn(() => Promise.resolve(jpeg()));
    const listener = vi.fn();
    subscribeContactPhotos(listener);

    requestContactPhoto('|dbcX', fetcher);
    requestContactPhoto('|dbcX', fetcher);
    await flush();
    requestContactPhoto('|dbcX', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(peekContactPhoto('|dbcX')).toBe('blob:photo-0');
    expect(listener).toHaveBeenCalled();
  });

  it("runs at most two downloads at a time by default, so JMAP calls keep two of Stalwart's four slots", async () => {
    const pending = [deferred(), deferred(), deferred(), deferred()];
    const fetchers = pending.map((d) => vi.fn(() => d.promise));
    fetchers.forEach((fetcher, i) => requestContactPhoto(`|b${i}`, fetcher));

    expect(fetchers.map((f) => f.mock.calls.length)).toEqual([1, 1, 0, 0]);

    pending[0].resolve(jpeg());
    await flush();
    expect(fetchers.map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 0]);

    pending[1].resolve(jpeg());
    pending[2].resolve(jpeg());
    await flush();
    expect(fetchers[3]).toHaveBeenCalledTimes(1);
    pending[3].resolve(jpeg());
    await flush();
  });

  it("takes half of the server's maxConcurrentRequests, and at least one", () => {
    // Stalwart 0.16 and 1.0 both advertise 4 (core capability).
    expect(contactPhotoConcurrency(4)).toBe(2);
    expect(contactPhotoConcurrency(8)).toBe(4);
    expect(contactPhotoConcurrency(3)).toBe(1);
    expect(contactPhotoConcurrency(1)).toBe(1);
    expect(contactPhotoConcurrency(undefined)).toBe(2);
  });

  it("runs as many downloads at once as the server's share allows", async () => {
    const pending = Array.from({ length: 6 }, () => deferred());
    const fetchers = pending.map((d) => vi.fn(() => d.promise));
    fetchers.forEach((fetcher, i) => requestContactPhoto(`|c${i}`, fetcher, { concurrency: 4 }));

    expect(fetchers.map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1, 0, 0]);

    pending.forEach((d) => d.resolve(jpeg()));
    await flush();
    expect(fetchers.every((f) => f.mock.calls.length === 1)).toBe(true);
  });

  it("starts an avatar's download before the ones only an export asked for", async () => {
    const exports = [deferred(), deferred()];
    const exported = [...exports.map((d) => vi.fn(() => d.promise)), vi.fn(() => Promise.resolve(jpeg()))];
    exported.forEach((fetcher, i) => void loadContactPhotoBlob(`|e${i}`, fetcher, { background: true }));
    expect(exported.map((f) => f.mock.calls.length)).toEqual([1, 1, 0]);

    const avatar = deferred();
    const shown = vi.fn(() => avatar.promise);
    requestContactPhoto('|a0', shown);
    exports[0].resolve(jpeg());
    await flush();
    expect(shown).toHaveBeenCalledTimes(1);
    expect(exported[2]).not.toHaveBeenCalled();

    avatar.resolve(jpeg());
    await flush();
    expect(exported[2]).toHaveBeenCalledTimes(1);
    expect(peekContactPhoto('|a0')).toBeDefined();
    exports[1].resolve(jpeg());
    await flush();
  });

  it('moves a photo an export queued up once an avatar wants it too', async () => {
    const busy = [deferred(), deferred()];
    busy.forEach((d, i) => requestContactPhoto(`|busy${i}`, () => d.promise));
    const started: string[] = [];
    const fetcherFor = (name: string) => () => {
      started.push(name);
      return Promise.resolve(jpeg());
    };
    const exported = loadContactPhotoBlob('|x0', fetcherFor('export only'), { background: true });
    void loadContactPhotoBlob('|x1', fetcherFor('export and avatar'), { background: true });
    requestContactPhoto('|x1', fetcherFor('export and avatar'));

    busy[0].resolve(jpeg());
    busy[1].resolve(jpeg());
    expect(await exported).not.toBeNull();

    expect(started).toEqual(['export and avatar', 'export only']);
    expect(peekContactPhoto('|x1')).toBeDefined();
  });

  it('leaves part of the burst to avatars while an export downloads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const exported = vi.fn(() => Promise.resolve(jpeg()));
    for (let i = 0; i < 30; i++) void loadContactPhotoBlob(`|x${i}`, exported, { background: true });
    await flush();
    expect(exported).toHaveBeenCalledTimes(20);

    const shown = vi.fn(() => Promise.resolve(jpeg()));
    for (let i = 0; i < 20; i++) requestContactPhoto(`|v${i}`, shown);
    await flush();
    expect(shown).toHaveBeenCalledTimes(20);
    expect(exported).toHaveBeenCalledTimes(20);
  });

  it('neither retries nor remembers a download that had no client to ask', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fetcher = vi.fn(async () => null);

    requestContactPhoto('|offline', fetcher);
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(peekContactPhoto('|offline')).toBeUndefined();

    // Asked again once there is a client: not held back as a failure.
    requestContactPhoto('|offline', fetcher);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await loadContactPhotoBlob('|offline', fetcher)).toBeNull();
  });

  it('drops a queued download once no avatar on screen wants it', async () => {
    const first = deferred();
    const second = deferred();
    requestContactPhoto('|b0', () => first.promise);
    requestContactPhoto('|b1', () => second.promise);
    const scrolledAway = vi.fn(() => Promise.resolve(jpeg()));
    const release = requestContactPhoto('|b2', scrolledAway);

    release();
    first.resolve(jpeg());
    second.resolve(jpeg());
    await flush();

    expect(scrolledAway).not.toHaveBeenCalled();
    expect(peekContactPhoto('|b2')).toBeUndefined();
  });

  it('tries a failed download once more, then remembers the failure for a while', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fetcher = vi.fn(() => Promise.reject(new Error('Failed to fetch blob: 404')));

    requestContactPhoto('|gone', fetcher);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);

    requestContactPhoto('|gone', fetcher);
    expect(await loadContactPhotoBlob('|gone', fetcher)).toBeNull();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(peekContactPhoto('|gone')).toBeUndefined();

    vi.advanceTimersByTime(2 * 60_000);
    requestContactPhoto('|gone', fetcher);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('shows the photo when the retry succeeds, e.g. after a concurrency refusal on Stalwart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('Failed to fetch blob: 400'))
      .mockResolvedValueOnce(jpeg());

    requestContactPhoto('|busy', fetcher);
    await flush();
    expect(peekContactPhoto('|busy')).toBeUndefined();
    vi.advanceTimersByTime(1000);
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(peekContactPhoto('|busy')).toBe('blob:photo-0');
  });

  it('makes an SVG photo inert before it becomes a blob: URL', async () => {
    requestContactPhoto('|svg', () => Promise.resolve(new Blob(['<svg/>'], { type: 'image/svg+xml' })));
    await flush();

    const shown = createObjectURL.mock.calls[0][0] as Blob;
    expect(shown.type).toBe('application/octet-stream');
  });

  it('gives a blob: URL only a type from the inline-safe list, never the media type as served', async () => {
    // The download answers with the card's mediaType, which another user wrote.
    // A browser reads a Blob type like a Content-Type header: after a comma the last type counts.
    const served: Record<string, string> = {
      '|list': 'image/gif,text/html',
      '|spaced': 'image/gif, text/html',
      '|svg-list': 'image/png,image/svg+xml',
      '|svg-junk': 'image/svg+xml x',
      '|params': 'IMAGE/JPEG; name=photo.jpg',
    };
    for (const [key, type] of Object.entries(served)) {
      requestContactPhoto(key, () => Promise.resolve(new Blob(['GIF89a'], { type })));
    }
    await flush();

    const shown = createObjectURL.mock.calls.map((call: unknown[]) => (call[0] as Blob).type).sort();
    expect(shown).toEqual(['application/octet-stream', 'application/octet-stream', 'application/octet-stream', 'application/octet-stream', 'image/jpeg']);
  });

  it('evicts the least recently used photo past 300 and revokes its URL', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const load = async (count: number, offset = 0) => {
      for (let i = offset; i < offset + count; i++) requestContactPhoto(`|b${i}`, () => Promise.resolve(jpeg(String(i))));
      // Past the first burst, downloads start at a paced rate.
      for (let s = 0; s < 120 && urls < offset + count; s++) {
        await flush();
        vi.advanceTimersByTime(1000);
      }
      await flush();
    };

    await load(300);
    expect(urls).toBe(300);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    // Seen again: no longer the least recently used.
    requestContactPhoto('|b0', () => Promise.resolve(jpeg()));
    await load(1, 300);

    expect(peekContactPhoto('|b0')).toBe('blob:photo-0');
    expect(peekContactPhoto('|b1')).toBeUndefined();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:photo-1');
    expect(peekContactPhoto('|b300')).toBe('blob:photo-300');
  });

  it('starts downloads at a paced rate after the first burst', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fetcher = vi.fn(() => Promise.resolve(jpeg()));
    for (let i = 0; i < 60; i++) requestContactPhoto(`|p${i}`, fetcher);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(40);

    vi.advanceTimersByTime(1000);
    await flush();
    expect(fetcher.mock.calls.length).toBeGreaterThan(40);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(47);
  });

  it('revokes every photo on clear and does not store a download that finishes afterwards', async () => {
    requestContactPhoto('|kept', () => Promise.resolve(jpeg()));
    await flush();
    const late = deferred();
    requestContactPhoto('|late', () => late.promise);

    clearContactPhotoCache();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:photo-0');
    expect(peekContactPhoto('|kept')).toBeUndefined();

    late.resolve(jpeg());
    await flush();
    expect(peekContactPhoto('|late')).toBeUndefined();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('frees the slots of downloads still running for the account before a switch', async () => {
    const hung = [deferred(), deferred()];
    hung.forEach((d, i) => requestContactPhoto(`|old${i}`, () => d.promise));
    clearContactPhotoCache();

    const fetcher = vi.fn(() => Promise.resolve(jpeg()));
    requestContactPhoto('|new', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    hung.forEach((d) => d.resolve(jpeg()));
    await flush();
    expect(peekContactPhoto('|old0')).toBeUndefined();
    expect(peekContactPhoto('|new')).toBeDefined();
  });

  it('gives print and export the bytes, from the cache when it has them', async () => {
    const shown = jpeg('shown');
    requestContactPhoto('|shown', () => Promise.resolve(shown));
    await flush();
    const refetch = vi.fn(() => Promise.resolve(jpeg()));
    expect(await loadContactPhotoBlob('|shown', refetch)).toBe(shown);
    expect(refetch).not.toHaveBeenCalled();

    // A download only for export is not kept as an object URL.
    const exported = jpeg('exported');
    expect(await loadContactPhotoBlob('|export-only', () => Promise.resolve(exported))).toBe(exported);
    expect(peekContactPhoto('|export-only')).toBeUndefined();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('keeps a forced download queued even when no avatar asks for it', async () => {
    const first = deferred();
    const second = deferred();
    requestContactPhoto('|b0', () => first.promise);
    requestContactPhoto('|b1', () => second.promise);
    const printed = jpeg('print');
    const result = loadContactPhotoBlob('|print', () => Promise.resolve(printed));

    first.resolve(jpeg());
    second.resolve(jpeg());
    await flush();
    expect(await result).toBe(printed);
  });
});
