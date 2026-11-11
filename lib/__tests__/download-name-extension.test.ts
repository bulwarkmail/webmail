// A download is saved from a URL typed application/octet-stream, so the browser no longer adds
// the extension a file's type implies when its name has none ("invoice" typed application/pdf
// was saved as "invoice.pdf" by Chromium and Firefox, and is saved as "invoice" now). The name
// is what the operating system opens a file by, so saveBlobAs() has to give such a name its
// extension itself, from a fixed list of its own. A name that has an extension stays as it is,
// and a type that names no single known type adds nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveBlobAs } from '../download-guard';

describe('the name a download is saved under', () => {
  let minted: string[];
  let anchors: string[];

  beforeEach(() => {
    minted = [];
    anchors = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
      minted.push((blob as Blob).type);
      return `blob:http://localhost/${minted.length}`;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push(this.download);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each<[string, string, RegExp]>([
    ['invoice', 'application/pdf', /^invoice\.pdf$/],
    ['photo', 'image/png', /^photo\.png$/],
    ['photo', 'image/jpeg', /^photo\.jpe?g$/],
    ['voice', 'audio/mpeg', /^voice\.mp3$/],
    ['Rechnung 2026', 'APPLICATION/PDF', /^Rechnung 2026\.pdf$/],
  ])('"%s" typed %s gets the extension of its type', (name, type, expected) => {
    saveBlobAs(new Blob(['x'], { type }), name, { kind: 'attachment' });
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatch(expected);
    // The URL itself stays a plain file.
    expect(minted).toEqual(['application/octet-stream']);
  });

  it.each<[string, string]>([
    ['photo.gif', 'image/png'],
    ['notes.txt', 'text/html'],
    ['report.v2', 'application/pdf'],
    ['archive.tar.gz', 'application/gzip'],
    ['Grüße – 你好.txt', 'application/pdf'],
  ])('"%s" keeps its own extension whatever the type (%s)', (name, type) => {
    saveBlobAs(new Blob(['x'], { type }), name, { kind: 'attachment' });
    expect(anchors).toEqual([name]);
  });

  it.each<[string, string]>([
    ['photo', 'image/gif,text/html'],
    ['photo', 'image/png, text/html'],
    ['page', 'application/pdf;,text/html'],
    ['data', 'application/octet-stream'],
    ['data', ''],
    ['data', 'application/x-unknown-thing'],
    // Common types that are not on the inline-safe list add nothing either.
    ['archive', 'application/zip'],
    ['letter', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['message', 'message/rfc822'],
    ['page', 'text/html'],
    ['drawing', 'image/svg+xml'],
  ])('"%s" typed %j gets no extension', (name, type) => {
    saveBlobAs(new Blob(['x'], { type }), name, { kind: 'attachment' });
    expect(anchors).toEqual([name]);
    expect(minted).toEqual(['application/octet-stream']);
  });

  it.each<[string, string, string]>([
    // Plain text in any character set, and other names of listed types, through the list's own spelling.
    ['notes', 'text/plain', 'notes.txt'],
    ['notes', 'text/plain; charset=ISO-8859-1', 'notes.txt'],
    ['notes', 'TEXT/PLAIN;charset=utf-7', 'notes.txt'],
    ['photo', 'image/jpg', 'photo.jpg'],
    ['clip', 'video/quicktime', 'clip.mov'],
    ['song', 'audio/x-wav', 'song.wav'],
    ['scan', 'image/tiff', 'scan.tiff'],
    // A name that ends in a dot, in spaces, or both: they go before the extension.
    ['invoice.', 'application/pdf', 'invoice.pdf'],
    ['invoice ', 'application/pdf', 'invoice.pdf'],
    ['invoice. . ', 'application/pdf', 'invoice.pdf'],
    // A dot inside that does not start an extension.
    ['Report v1.0 final', 'application/pdf', 'Report v1.0 final.pdf'],
    // Names outside ASCII.
    ['Rechnung für Köln', 'application/pdf', 'Rechnung für Köln.pdf'],
    ['請求書', 'image/png', '請求書.png'],
  ])('"%s" typed %j is saved as "%s"', (name, type, expected) => {
    saveBlobAs(new Blob(['x'], { type }), name, { kind: 'attachment' });
    expect(anchors).toEqual([expected]);
    expect(minted).toEqual(['application/octet-stream']);
  });

  it.each<[string, string]>([
    // A name of its own that starts with a dot.
    ['.gitignore', 'text/plain'],
    // More than one dot: the last part is the extension.
    ['archive.tar', 'application/pdf'],
    ['photo.gif ', 'image/png'],
    // Nothing to put an extension on.
    ['', 'application/pdf'],
    ['...', 'application/pdf'],
    ['   ', 'application/pdf'],
  ])('"%s" typed %s is saved under the name as given', (name, type) => {
    saveBlobAs(new Blob(['x'], { type }), name, { kind: 'attachment' });
    expect(anchors).toEqual([name]);
  });

  it('gives a File without an extension the one of its type', () => {
    saveBlobAs(new File(['x'], 'scan', { type: 'application/pdf' }), 'scan', { kind: 'attachment' });
    expect(anchors).toEqual(['scan.pdf']);
  });

  it.each([
    'image/png', 'image/apng', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
    'image/x-icon', 'image/vnd.microsoft.icon', 'image/tiff', 'image/heic', 'image/heif',
    'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/opus', 'audio/wav', 'audio/flac',
    'audio/webm', 'audio/3gpp',
    'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska',
    'video/mpeg', 'video/3gpp',
    'application/pdf', 'text/plain;charset=utf-8',
  ])('every listed type gives a name an extension: %s', (type) => {
    saveBlobAs(new Blob(['x'], { type }), 'file', { kind: 'attachment' });
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatch(/^file\.[a-z0-9]+$/);
  });

  it('leaves the name of an object URL it is handed alone', () => {
    saveBlobAs('blob:http://localhost/held', 'export', { kind: 'export' });
    expect(anchors).toEqual(['export']);
  });
});
