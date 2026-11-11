// A Blob's type becomes the Content-Type of its blob: URL. Browsers read that
// header the way they read any Content-Type: a comma separates several values
// and the last valid one wins, and Chromium and Firefox stop reading the type
// at the first space (Chromium also at "("). So "image/gif,text/html" is an
// HTML document and "image/svg+xml x" is an SVG document, both on the webmail
// origin. A Blob that gets a blob: URL must carry a type from the inline-safe
// list in the list's own spelling, or octet-stream, never the declared string.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { imageBlobUrl, inertBlobType, isInlineSafeBlob, isMimeTypeSafeForInlinePreview, previewBlobType, toInertBlob } from '../file-preview';

/** The MIME type a browser gives a document loaded from a blob: URL of this Blob type. */
function browserDocumentType(blobType: string): string {
  let result = '';
  for (const value of blobType.split(',')) {
    // Chromium: the type ends at whitespace, ";" or "(".
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
  'image/gif,text/html',
  'image/gif, text/html',
  'image/png x, text/html',
  'image/x, text/html; charset=utf-8',
  'video/mp4,text/html',
  'audio/mpeg, text/html',
  'application/pdf, text/html',
  'text/plain, text/html',
  'text/plain,image/svg+xml',
  'image/png, image/svg+xml',
  'image/svg+xml x',
  'image/svg+xml(x)',
  'image/svg+xml,',
  ',image/svg+xml',
  'image/svg+xml;,',
  'audio/x, application/xhtml+xml',
  'image/x,text/xml',
  'image/x,application/xml',
];

// Spellings that name no single type on the list, whatever a browser makes of
// them: each one becomes octet-stream.
const NOT_ONE_LISTED_TYPE = [
  ...HOSTILE_TYPES,
  // A comma-joined pair, in either order, or with a trailing or leading comma.
  'image/png,image/gif',
  'image/png,',
  ',image/png',
  // Trailing space plus junk, and a type cut short by "(".
  'image/png x',
  'image/gif text/html',
  'image/png(x)',
  // A tab or newline inside; new Blob() empties these.
  'image/gif\ttext/html',
  'image/gif\ntext/html',
  'image/png\t',
  // A comma hidden in the parameters.
  'image/gif;,text/html',
  'image/gif;x=y,text/html',
  'image/png; name="a,b.png"',
  // No single type at all.
  '',
  'image',
  'image/',
  '/png',
  'image/png/x',
  'image/*',
  'image/unknown',
  // Document types and their relatives.
  'text/html',
  'TEXT/HTML; charset=utf-8',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
  'image/svg+xml-compressed',
  'application/javascript',
];

// image/svg+xml in every spelling above: never the type of a blob: URL.
const SVG_SPELLINGS = [
  'image/svg+xml',
  'IMAGE/SVG+XML',
  'Image/Svg+Xml',
  ' image/svg+xml',
  'image/svg+xml ',
  'image/svg+xml; charset=utf-8',
  'image/svg+xml;,text/html',
  'image/svg+xml,',
  ',image/svg+xml',
  'image/gif,image/svg+xml',
  'image/svg+xml x',
  'image/svg+xml(x)',
  'image/svg+xml\t',
  'image/svg+xml\nx',
  'image/svg',
];

// One honest type from each family the list holds, and how the Blob is typed.
const HONEST_TYPES: Array<[string, string]> = [
  ['image/png', 'image/png'],
  ['image/jpeg', 'image/jpeg'],
  ['image/gif', 'image/gif'],
  ['image/webp', 'image/webp'],
  ['audio/mpeg', 'audio/mpeg'],
  ['audio/ogg', 'audio/ogg'],
  ['video/mp4', 'video/mp4'],
  ['video/webm', 'video/webm'],
  ['application/pdf', 'application/pdf'],
  ['text/plain', 'text/plain'],
  // Upper and mixed case, surrounding spaces and parameters are no reason to refuse.
  ['IMAGE/PNG', 'image/png'],
  ['Image/Jpeg', 'image/jpeg'],
  [' image/png', 'image/png'],
  ['image/png ', 'image/png'],
  ['image/jpeg; name=a.jpg', 'image/jpeg'],
  ['text/plain; charset=utf-8', 'text/plain'],
  // Other names for the same formats come out in the list's spelling.
  ['image/jpg', 'image/jpeg'],
  ['audio/x-wav', 'audio/wav'],
];

afterEach(() => {
  vi.restoreAllMocks();
});

function captureObjectUrls(): Blob[] {
  const created: Blob[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    created.push(blob as Blob);
    return `blob:test/${created.length}`;
  });
  return created;
}

describe('blob types a browser reads as a list or cuts short', () => {
  it('the reference parser agrees with what the browsers did', () => {
    expect(browserDocumentType('image/gif,text/html')).toBe('text/html');
    expect(browserDocumentType('image/svg+xml x')).toBe('image/svg+xml');
    expect(browserDocumentType('image/svg+xml,')).toBe('image/svg+xml');
    expect(browserDocumentType('image/png')).toBe('image/png');
    expect(browserDocumentType('image/jpeg; name=a.jpg')).toBe('image/jpeg');
  });

  it.each(HOSTILE_TYPES)('does not call %j safe to open on its own', (type) => {
    // The Blob constructor keeps every one of these as written.
    expect(new Blob([], { type }).type).toBe(type.toLowerCase());
    expect(runsScript(browserDocumentType(type))).toBe(true);
    expect(isMimeTypeSafeForInlinePreview(type)).toBe(false);
  });

  it.each(HOSTILE_TYPES)('inertBlobType(%j) is a type no browser runs', (type) => {
    expect(runsScript(browserDocumentType(inertBlobType(type)))).toBe(false);
  });

  it.each(HOSTILE_TYPES)('toInertBlob() re-types a Blob of type %j', (type) => {
    const blob = toInertBlob(new Blob(['<script>alert(document.domain)</script>'], { type }));
    expect(runsScript(browserDocumentType(blob.type))).toBe(false);
  });

  it('the preview does not hand a sender-declared list type to a blob: URL', async () => {
    // What components/files/file-preview-modal.tsx does for an attachment
    // named photo.gif whose part says "Content-Type: image/gif,text/html"
    // (Stalwart returns that string as the part's JMAP type).
    const declared = 'image/gif,text/html';
    const effective = previewBlobType('photo.gif', declared, 'text/html');
    const typed = new Blob(['GIF89a<script>alert(document.domain)</script>'], { type: effective });
    const created: Blob[] = [];
    const original = URL.createObjectURL;
    URL.createObjectURL = (blob: Blob | MediaSource) => { created.push(blob as Blob); return 'blob:test'; };
    try {
      await imageBlobUrl(typed);
    } finally {
      URL.createObjectURL = original;
    }
    for (const blob of created) expect(runsScript(browserDocumentType(blob.type))).toBe(false);
    // "Open in new tab" is offered when this is true.
    expect(isMimeTypeSafeForInlinePreview(effective) && runsScript(browserDocumentType(effective))).toBe(false);
  });

  it('still keeps the plain inert types', () => {
    for (const type of ['image/png', 'image/jpeg; name=a.jpg', 'video/mp4', 'audio/mpeg', 'application/pdf', 'text/plain']) {
      expect(isMimeTypeSafeForInlinePreview(type)).toBe(true);
    }
  });
});

describe('a Blob that gets a blob: URL carries the list\'s type or octet-stream', () => {
  it.each(NOT_ONE_LISTED_TYPE)('%j is not safe and becomes octet-stream', (type) => {
    expect(isMimeTypeSafeForInlinePreview(type)).toBe(false);
    expect(inertBlobType(type)).toBe('application/octet-stream');
    expect(toInertBlob(new Blob(['x'], { type })).type).toBe('application/octet-stream');
  });

  it('treats a missing type as octet-stream', () => {
    expect(isMimeTypeSafeForInlinePreview(undefined)).toBe(false);
    expect(inertBlobType(undefined)).toBe('application/octet-stream');
    expect(toInertBlob(new Blob(['x'])).type).toBe('application/octet-stream');
  });

  it.each(HONEST_TYPES)('keeps %j as %j', (type, expected) => {
    expect(isMimeTypeSafeForInlinePreview(type)).toBe(true);
    expect(inertBlobType(type)).toBe(expected);
    expect(toInertBlob(new Blob(['x'], { type })).type).toBe(expected);
  });

  it.each(HONEST_TYPES)('shows a %j image or file through an object URL typed %j', async (type, expected) => {
    const created = captureObjectUrls();
    await imageBlobUrl(new Blob(['x'], { type }));
    await imageBlobUrl(new Blob(['x']), type);
    expect(created.map((blob) => blob.type)).toEqual([expected, expected]);
  });

  it.each(SVG_SPELLINGS)('never mints an object URL typed as SVG for %j', async (type) => {
    expect(isMimeTypeSafeForInlinePreview(type)).toBe(false);
    expect(inertBlobType(type)).toBe('application/octet-stream');
    expect(toInertBlob(new Blob(['<svg/>'], { type })).type).toBe('application/octet-stream');
    const created = captureObjectUrls();
    for (const url of [await imageBlobUrl(new Blob(['<svg/>'], { type })), await imageBlobUrl(new Blob(['<svg/>']), type)]) {
      // A single SVG type is shown from a data: URL, whose document has an opaque origin.
      if (url.startsWith('data:')) expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
    }
    for (const blob of created) {
      expect(blob.type).toBe('application/octet-stream');
      expect(browserDocumentType(blob.type)).not.toBe('image/svg+xml');
    }
  });

  it('keeps the very Blob when its type is already the list\'s spelling', () => {
    const png = new Blob(['x'], { type: 'image/png' });
    expect(toInertBlob(png)).toBe(png);
  });

  it('opens in a window of its own only a Blob typed exactly as the list spells it', () => {
    expect(isInlineSafeBlob(new Blob([], { type: 'image/png' }))).toBe(true);
    expect(isInlineSafeBlob(new Blob([], { type: 'application/pdf' }))).toBe(true);
    for (const type of ['image/gif,text/html', 'image/png; x=y', 'image/png ', 'image/jpg', 'image/svg+xml', 'text/html', '']) {
      expect(isInlineSafeBlob(new Blob([], { type }))).toBe(false);
    }
    for (const type of NOT_ONE_LISTED_TYPE) expect(isInlineSafeBlob(new Blob([], { type }))).toBe(false);
  });

  it.each([
    ['photo.gif', 'image/gif,text/html', 'image/gif,text/html', 'image/gif'],
    ['photo.gif', 'IMAGE/GIF, text/html', '', 'image/gif'],
    ['clip.mp4', 'video/mp4,text/html', 'video/mp4,text/html', 'video/mp4'],
    ['song.mp3', 'audio/mpeg, text/html', '', 'audio/mpeg'],
    ['photo', 'image/gif,text/html', 'image/gif,text/html', 'application/octet-stream'],
    ['photo', 'image/svg+xml x', '', 'application/octet-stream'],
    ['photo', 'image/x,application/xhtml+xml', '', 'application/octet-stream'],
    ['scan.pdf', 'application/pdf;,text/html', '', 'application/pdf'],
    ['scan', 'application/pdf;,text/html', '', 'application/octet-stream'],
    ['drawing.svg', 'image/svg+xml', 'image/svg+xml', 'image/svg+xml'],
    ['photo.jpg', 'image/jpeg; name=photo.jpg', '', 'image/jpeg'],
  ])('previewBlobType(%j, %j, %j) is %j', (name, declared, served, expected) => {
    expect(previewBlobType(name, declared, served)).toBe(expected);
  });
});
