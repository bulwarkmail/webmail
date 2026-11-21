// saveBlobAs() hands a file to the browser through an <a download> on a blob:
// URL. While that URL lives it is a document of the webmail origin for anyone
// who loads it on its own, and the browser's downloads list keeps it as the
// file's address. So the Blob behind it must not carry a type a browser shows
// as a page: either it is typed from the inline-safe list (or octet-stream),
// or the URL is gone by the time saveBlobAs() returns. The saved file keeps
// its name either way, and the name is what the operating system opens it by.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveBlobAs } from '../download-guard';

/** The MIME type a browser gives a document loaded from a blob: URL of this Blob type. */
function browserDocumentType(blobType: string): string {
  let result = '';
  for (const value of blobType.split(',')) {
    const type = value.trim().split(/[\s;(]/)[0].toLowerCase();
    if (/^[^/\s]+\/[^/\s]+$/.test(type)) result = type;
  }
  return result;
}

/** Types a browser runs script from when it shows them as a document. */
function runsScript(mime: string): boolean {
  return mime === 'text/html' || mime === 'image/svg+xml' || mime === 'text/xml' || mime === 'application/xml'
    || mime === 'application/xhtml+xml' || mime.endsWith('+xml');
}

const HOSTILE_TYPES = [
  'text/html',
  'image/gif,text/html',
  'image/gif, text/html',
  'audio/mpeg,text/html',
  'image/svg+xml',
  'image/gif,image/svg+xml',
  'application/xhtml+xml',
  'text/xml',
];

const USER_AGENTS = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  androidChrome: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  desktopApp: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) bulwark-desktop/1.0.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
};

describe('blob: URLs made for a download', () => {
  let minted: Array<{ url: string; type: string; blob: Blob }>;
  let revoked: string[];
  let anchors: Array<{ href: string; download: string }>;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;

  beforeEach(() => {
    minted = [];
    revoked = [];
    anchors = [];
    URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
      const url = `blob:http://localhost/${minted.length}`;
      minted.push({ url, type: (blob as Blob).type, blob: blob as Blob });
      return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
    // jsdom would report "navigation not implemented" for the anchor click.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push({ href: this.getAttribute('href') ?? '', download: this.download });
    });
  });

  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function asBrowser(agent: string): void {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(agent);
  }

  it.each(HOSTILE_TYPES)('leaves no live blob: URL that is a page for a Blob typed "%s"', (type) => {
    const saved = saveBlobAs(new Blob(['<html><body><script>1</script></body></html>'], { type }), 'photo.gif', { kind: 'attachment' });
    expect(saved).toBe(true);
    expect(minted).toHaveLength(1);
    // What is still loadable once saveBlobAs() has returned.
    const live = minted.filter((entry) => !revoked.includes(entry.url));
    for (const entry of live) {
      expect(runsScript(browserDocumentType(entry.type)), `a live blob: URL of type "${entry.type}"`).toBe(false);
    }
  });

  it.each(['image/png', 'application/pdf', 'application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])(
    'still saves a Blob typed "%s" through an <a download>',
    (type) => {
      const click = vi.mocked(HTMLAnchorElement.prototype.click);
      expect(saveBlobAs(new Blob(['x'], { type }), 'file.bin', { kind: 'attachment' })).toBe(true);
      expect(minted).toHaveLength(1);
      expect(click).toHaveBeenCalledTimes(1);
    },
  );

  it.each([...HOSTILE_TYPES, 'image/png', 'text/plain;charset=utf-8', 'application/zip', 'IMAGE/GIF', 'application/octet-stream'])(
    'saves a Blob typed "%s" from a URL typed application/octet-stream, with its bytes and its name',
    async (type) => {
      saveBlobAs(new Blob(['GIF89a<p>bytes</p>'], { type }), 'photo.gif', { kind: 'attachment' });
      expect(minted.map((entry) => entry.type)).toEqual(['application/octet-stream']);
      expect(await minted[0].blob.text()).toBe('GIF89a<p>bytes</p>');
      expect(anchors).toEqual([{ href: minted[0].url, download: 'photo.gif' }]);
    },
  );

  it('saves a Blob without a type from a URL typed application/octet-stream, never an untyped one', () => {
    saveBlobAs(new Blob(['<p>bytes</p>']), 'notes', { kind: 'attachment' });
    expect(minted.map((entry) => entry.type)).toEqual(['application/octet-stream']);
    expect(anchors).toEqual([{ href: minted[0].url, download: 'notes' }]);
  });

  it('saves a File under the name it is given, from a URL typed application/octet-stream', async () => {
    const file = new File(['<svg onload="1"/>'], 'drawing.svg', { type: 'image/svg+xml' });
    saveBlobAs(file, file.name, { kind: 'attachment' });
    expect(minted.map((entry) => entry.type)).toEqual(['application/octet-stream']);
    expect(await minted[0].blob.text()).toBe('<svg onload="1"/>');
    expect(anchors).toEqual([{ href: minted[0].url, download: 'drawing.svg' }]);
  });

  it.each(['chrome', 'edge', 'androidChrome', 'desktopApp', 'firefox'] as const)('revokes the URL in the task after the click in %s', (browser) => {
    vi.useFakeTimers();
    asBrowser(USER_AGENTS[browser]);
    saveBlobAs(new Blob(['x'], { type: 'image/png' }), 'photo.png', { kind: 'attachment' });
    expect(anchors).toHaveLength(1);
    // Still there when the click's task ends, so the download can start from it.
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(0);
    expect(revoked).toEqual([minted[0].url]);
  });

  it.each(Object.keys(USER_AGENTS) as Array<keyof typeof USER_AGENTS>)(
    'in %s the URL is typed application/octet-stream for as long as it exists',
    (browser) => {
      vi.useFakeTimers();
      asBrowser(USER_AGENTS[browser]);
      for (const type of HOSTILE_TYPES) {
        saveBlobAs(new Blob(['<script>1</script>'], { type }), 'page', { kind: 'attachment' });
      }
      expect(minted).toHaveLength(HOSTILE_TYPES.length);
      // Every URL that is still there after the click, and until the last timer has run.
      const live = () => minted.filter((entry) => !revoked.includes(entry.url));
      expect(live()).toHaveLength(HOSTILE_TYPES.length);
      for (const entry of live()) expect(entry.type).toBe('application/octet-stream');
      vi.advanceTimersByTime(30_000);
      for (const entry of live()) expect(entry.type).toBe('application/octet-stream');
      vi.runAllTimers();
      expect(live()).toEqual([]);
    },
  );

  it.each(['safari', 'iosChrome'] as const)('keeps the URL a minute in %s, where the download may start later', (browser) => {
    vi.useFakeTimers();
    asBrowser(USER_AGENTS[browser]);
    saveBlobAs(new Blob(['x'], { type: 'text/html' }), 'page.html', { kind: 'attachment' });
    expect(minted.map((entry) => entry.type)).toEqual(['application/octet-stream']);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(59_999);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(revoked).toEqual([minted[0].url]);
  });

  it('revokes in the task after the click when the caller asks for no delay, in every browser', () => {
    vi.useFakeTimers();
    asBrowser(USER_AGENTS.safari);
    saveBlobAs(new Blob(['x'], { type: 'image/png' }), 'photo.png', { kind: 'attachment', revokeAfterMs: 0 });
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(0);
    expect(revoked).toEqual([minted[0].url]);
  });

  it('leaves an object URL it is handed alone: no new URL, not revoked', () => {
    asBrowser(USER_AGENTS.chrome);
    saveBlobAs('blob:http://localhost/held', 'export.zip', { kind: 'export' });
    expect(minted).toEqual([]);
    expect(revoked).toEqual([]);
    expect(anchors).toEqual([{ href: 'blob:http://localhost/held', download: 'export.zip' }]);
  });
});
