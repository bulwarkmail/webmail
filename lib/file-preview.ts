export type FilePreviewKind = 'image' | 'html' | 'eml' | 'text' | 'markdown' | 'pdf' | 'audio' | 'video' | 'unsupported';

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v', 'avi', 'mkv']);
const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'log', 'csv', 'json', 'xml', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'sql', 'graphql', 'html', 'htm',
  'md', 'markdown',
]);
const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
]);

function normalizeMimeType(type?: string): string {
  return type?.split(';')[0]?.trim().toLowerCase() || '';
}

function getExtension(name?: string): string {
  const parts = name?.toLowerCase().split('.') || [];
  return parts.length > 1 ? parts.pop() || '' : '';
}

export function getFilePreviewKind(name?: string, type?: string): FilePreviewKind {
  const ext = getExtension(name);
  const mimeType = normalizeMimeType(type);

  if (mimeType.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) {
    return 'image';
  }

  if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml' || ext === 'html' || ext === 'htm') {
    return 'html';
  }

  // Embedded email message (e.g. a bounce/DSN, or forward-as-attachment).
  // Rendered by parsing it and showing it like an email, not as a blob.
  if (mimeType === 'message/rfc822' || ext === 'eml') {
    return 'eml';
  }

  if (mimeType === 'application/pdf' || ext === 'pdf') {
    return 'pdf';
  }

  if (mimeType.startsWith('audio/') || AUDIO_EXTENSIONS.has(ext)) {
    return 'audio';
  }

  if (mimeType.startsWith('video/') || VIDEO_EXTENSIONS.has(ext)) {
    return 'video';
  }

  if (ext === 'md' || ext === 'markdown') {
    return 'markdown';
  }

  if (mimeType.startsWith('text/') || TEXT_MIME_TYPES.has(mimeType) || TEXT_EXTENSIONS.has(ext)) {
    return 'text';
  }

  return 'unsupported';
}

export function isFilePreviewable(name?: string, type?: string): boolean {
  return getFilePreviewKind(name, type) !== 'unsupported';
}

// Canonical types for the extensions the preview renders from a blob: PDF and
// every image, audio and video extension above except SVG. No script-capable
// type (SVG, HTML) may appear here: the preview trusts these over whatever
// the sender declared.
const EXT_TO_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  // Ogg Opus (RFC 7845); audio/opus names the bare RTP payload.
  opus: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
};

const INERT_BLOB_TYPE = 'application/octet-stream';
const SVG_MIME_TYPE = 'image/svg+xml';

const INLINE_SAFE_MIME_TYPES = [
  'image/png', 'image/apng', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
  'image/x-icon', 'image/vnd.microsoft.icon', 'image/tiff', 'image/heic', 'image/heif',
  'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/opus', 'audio/wav', 'audio/flac',
  'audio/webm', 'audio/3gpp',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska',
  'video/mpeg', 'video/3gpp',
  'application/pdf', 'text/plain',
] as const;

/**
 * The extension a download of each type on the list is saved with when its
 * name has none (downloadNameForType()). A download's blob: URL is always
 * octet-stream, so the browser no longer derives one from the type.
 */
const DOWNLOAD_EXTENSIONS: Readonly<Record<(typeof INLINE_SAFE_MIME_TYPES)[number], string>> = {
  'image/png': 'png',
  'image/apng': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'audio/webm': 'weba',
  'audio/3gpp': '3gp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-matroska': 'mkv',
  'video/mpeg': 'mpeg',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

/**
 * The types a Blob may carry when it gets a blob: URL, keyed by every
 * spelling of each that is accepted, with the string the Blob gets. A blob:
 * URL is a document of the webmail origin when it is opened on its own, and
 * the browser decides what to do with it from the Blob's type alone. Raster
 * images, audio, video, PDF and plain text are shown or downloaded; none of
 * them runs script. SVG, HTML, XML and every type not named here are not on
 * the list. Plain text gets its character set as the one parameter on the
 * list: text/plain;charset=<a name from TEXT_CHARSETS>.
 */
const INLINE_SAFE_TYPES: ReadonlyMap<string, string> = new Map<string, string>([
  ...INLINE_SAFE_MIME_TYPES.map((type): [string, string] => [type, type]),
  // Other names mail clients give the same formats.
  ['image/jpg', 'image/jpeg'],
  ['image/pjpeg', 'image/jpeg'],
  ['image/x-png', 'image/png'],
  ['image/x-ms-bmp', 'image/bmp'],
  ['image/x-bmp', 'image/bmp'],
  ['audio/mp3', 'audio/mpeg'],
  ['audio/x-mpeg', 'audio/mpeg'],
  ['audio/x-wav', 'audio/wav'],
  ['audio/wave', 'audio/wav'],
  ['audio/vnd.wave', 'audio/wav'],
  ['audio/x-m4a', 'audio/mp4'],
  ['audio/m4a', 'audio/mp4'],
  ['audio/x-aac', 'audio/aac'],
  ['audio/x-flac', 'audio/flac'],
  ['video/x-m4v', 'video/mp4'],
  ['video/avi', 'video/x-msvideo'],
  ['video/msvideo', 'video/x-msvideo'],
]);

// One type/subtype token pair.
const MIME_ESSENCE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/**
 * The lower-case `type/subtype` of a declared MIME type that names exactly
 * one type, without its parameters; undefined for anything else. A browser
 * reads a Blob's type like a Content-Type header: a comma starts another
 * type and the last one counts, and the type ends at the first space
 * (Chromium also at "("). So a comma anywhere, or anything but one token
 * pair before the parameters, names no single type. new Blob() empties a
 * type with any character outside U+0020-U+007E, and Firefox sniffs an
 * untyped blob: document, so such a type names none either.
 */
function mimeEssence(type?: string): string | undefined {
  if (!type || !/^[\x20-\x7e]+$/.test(type) || type.includes(',')) return undefined;
  const essence = type.split(';', 1)[0].trim().toLowerCase();
  return MIME_ESSENCE.test(essence) ? essence : undefined;
}

const TEXT_PLAIN = 'text/plain';

/**
 * The character sets a text/plain Blob may name, keyed by the labels accepted
 * for each, with the name the Blob gets: the names of the WHATWG Encoding
 * Standard, in lower case as new Blob() keeps a type. Browsers decode
 * US-ASCII and ISO-8859-1 as windows-1252, so those get that name. UTF-7 is
 * not on the list.
 */
const TEXT_CHARSETS: ReadonlyMap<string, string> = new Map<string, string>([
  ['utf-8', 'utf-8'],
  ['utf8', 'utf-8'],
  ['utf-16le', 'utf-16le'],
  ['utf-16', 'utf-16le'],
  ['utf-16be', 'utf-16be'],
  ['us-ascii', 'windows-1252'],
  ['ascii', 'windows-1252'],
  ['iso-8859-1', 'windows-1252'],
  ['latin1', 'windows-1252'],
  ...['2', '3', '4', '5', '6', '7', '8', '8-i', '10', '13', '14', '15', '16']
    .map((part): [string, string] => [`iso-8859-${part}`, `iso-8859-${part}`]),
  ['iso-8859-9', 'windows-1254'],
  ['iso-8859-11', 'windows-874'],
  ['windows-874', 'windows-874'],
  ...['1250', '1251', '1252', '1253', '1254', '1255', '1256', '1257', '1258']
    .map((page): [string, string] => [`windows-${page}`, `windows-${page}`]),
  ['koi8-r', 'koi8-r'],
  ['koi8-u', 'koi8-u'],
  ['shift_jis', 'shift_jis'],
  ['shift-jis', 'shift_jis'],
  ['sjis', 'shift_jis'],
  ['euc-jp', 'euc-jp'],
  ['iso-2022-jp', 'iso-2022-jp'],
  ['gbk', 'gbk'],
  ['gb2312', 'gbk'],
  ['gb18030', 'gb18030'],
  ['big5', 'big5'],
  ['euc-kr', 'euc-kr'],
  ['ks_c_5601-1987', 'euc-kr'],
]);

/** What plain text is read as when its type names no character set on TEXT_CHARSETS. */
const DEFAULT_TEXT_CHARSET = 'utf-8';

// The parameters of a text/plain type when they are one charset parameter
// and nothing else: a single token, optionally in quotes.
const CHARSET_PARAMETER = /^\s*charset\s*=\s*(?:([a-z0-9_.-]+)|"([a-z0-9_.-]+)")\s*$/i;

/**
 * The list's name for the character set a text/plain type names, UTF-8 when
 * it names none on TEXT_CHARSETS. The parameters must be one charset
 * parameter and nothing else: another parameter, a second charset or a value
 * that is not one token count as naming none.
 */
function textCharset(type: string): string {
  const semicolon = type.indexOf(';');
  const match = semicolon === -1 ? null : CHARSET_PARAMETER.exec(type.slice(semicolon + 1));
  const label = (match?.[1] ?? match?.[2])?.toLowerCase();
  return (label && TEXT_CHARSETS.get(label)) || DEFAULT_TEXT_CHARSET;
}

/** The list's own string for a declared type that names one type on INLINE_SAFE_TYPES. */
function inlineSafeType(type?: string): string | undefined {
  const essence = mimeEssence(type);
  if (essence === undefined) return undefined;
  const listed = INLINE_SAFE_TYPES.get(essence);
  return listed === TEXT_PLAIN ? `${TEXT_PLAIN};charset=${textCharset(type ?? '')}` : listed;
}

function isSvgType(type?: string): boolean {
  const essence = mimeEssence(type);
  return essence === SVG_MIME_TYPE || essence === 'image/svg';
}

// Kinds the preview renders from the file's text, not from a blob: URL.
const DOCUMENT_KINDS = new Set<FilePreviewKind>(['html', 'eml', 'text', 'markdown']);

// Blob types the browser actually shows in each blob-backed preview.
const RENDERABLE_FOR_KIND: Partial<Record<FilePreviewKind, (mimeType: string) => boolean>> = {
  pdf: (t) => t === 'application/pdf',
  image: (t) => t.startsWith('image/'),
  audio: (t) => t.startsWith('audio/'),
  video: (t) => t.startsWith('video/'),
};

/**
 * MIME type to give a preview's blob. Browsers pick the viewer from the
 * blob's type, not the file name, and download anything they cannot show -
 * under the blob's UUID. Neither the sender's declaration (octet-stream, or a
 * catch-all such as the application/x-as400attachment IBM i systems put on
 * every attachment) nor Stalwart's download response is reliably a type the
 * viewer accepts, so a PDF, image, audio or video preview takes the first
 * type its viewer can show: declared, then served, then the one the file
 * name implies. The result is always a type from INLINE_SAFE_TYPES in the
 * list's spelling, or octet-stream, never the declared string; the one
 * exception is image/svg+xml for an SVG image, which imageBlobUrl() shows
 * from a data: URL.
 */
export function previewBlobType(name: string | undefined, declaredType?: string, blobType?: string): string {
  const declared = inlineSafeType(declaredType);
  const served = inlineSafeType(blobType);
  const fromName = EXT_TO_MIME[getExtension(name)];
  const kind = getFilePreviewKind(name, normalizeMimeType(declaredType) || normalizeMimeType(blobType));
  // Documents are previewed from their text (sanitised, in a srcdoc frame),
  // never from a blob: URL. Should one still be minted for them, it must be
  // nothing a browser would render as the webmail origin.
  if (DOCUMENT_KINDS.has(kind)) return INERT_BLOB_TYPE;
  const renderable = RENDERABLE_FOR_KIND[kind];
  if (renderable) {
    const orSvg = (listed: string | undefined, type?: string) =>
      listed ?? (kind === 'image' && isSvgType(type) ? SVG_MIME_TYPE : undefined);
    const match = [orSvg(declared, declaredType), orSvg(served, blobType), fromName]
      .find((t): t is string => !!t && renderable(t));
    if (match) return match;
  }
  return declared ?? fromName ?? served ?? INERT_BLOB_TYPE;
}

// Whether a Blob with this MIME type is safe to open as a top-level navigation
// (e.g. window.open on a blob: URL): the type names exactly one type from
// INLINE_SAFE_TYPES. Blob URLs inherit the creator's origin, so script-bearing
// types like text/html, application/xhtml+xml, image/svg+xml, and XML variants
// would execute in our origin; everything off the list must be downloaded.
// The Blob itself gets inertBlobType(type), never the declared string.
export function isMimeTypeSafeForInlinePreview(type?: string): boolean {
  return inlineSafeType(type) !== undefined;
}

/**
 * MIME type for a Blob that gets a blob: URL: an attachment, a file, a
 * contact photo, the cid: parts of a rendered message body. Blob URLs
 * inherit the creating document's origin, so a sender-declared text/html or
 * image/svg+xml part navigated to as a top-level document would run script
 * as the webmail origin (GHSA-xvjh-v9c6-qcvc). A type on INLINE_SAFE_TYPES
 * comes back in the list's own spelling, without parameters, so img, video
 * and audio keep rendering it; plain text comes back with the list's name of
 * its character set (textCharset()). Anything else becomes octet-stream,
 * which no browser executes.
 */
export function inertBlobType(type?: string): string {
  return inlineSafeType(type) ?? INERT_BLOB_TYPE;
}

/** Re-type a fetched Blob per inertBlobType() without copying its bytes. */
export function toInertBlob(blob: Blob): Blob {
  const type = inertBlobType(blob.type);
  return blob.type === type ? blob : blob.slice(0, blob.size, type);
}

/**
 * Whether a blob: URL of this Blob may be opened in a window of its own: the
 * Blob's type is one from INLINE_SAFE_TYPES, spelled exactly as
 * inertBlobType() gives it (plain text only as text/plain;charset=<name>).
 */
export function isInlineSafeBlob(blob: Blob): boolean {
  return inlineSafeType(blob.type) === blob.type;
}

// A name's extension: a dot and at least one character that is neither a dot
// nor white space, at its end. ".gitignore" has one.
const NAME_EXTENSION = /\.[^.\s]+$/;

/**
 * The name a download of a Blob typed `type` is saved under. A name with an
 * extension stays as it is, whatever the type. A name without one gets the
 * extension DOWNLOAD_EXTENSIONS holds for the type when the type names one
 * type on INLINE_SAFE_TYPES (trailing dots and spaces go first: "invoice."
 * becomes "invoice.pdf"); any other type adds nothing, and so does a name
 * that is only dots and spaces.
 */
export function downloadNameForType(name: string, type?: string): string {
  // A loop, not a regular expression: names come from senders and can be long.
  let end = name.length;
  while (end > 0 && (name[end - 1] === '.' || /\s/.test(name[end - 1]))) end--;
  const stem = name.slice(0, end);
  if (!stem || NAME_EXTENSION.test(stem)) return name;
  const listed = inlineSafeType(type);
  if (listed === undefined) return name;
  const extension: string | undefined = DOWNLOAD_EXTENSIONS[listed.split(';', 1)[0] as keyof typeof DOWNLOAD_EXTENSIONS];
  return extension ? `${stem}.${extension}` : name;
}

/**
 * A URL an <img> can show whose target is inert when opened on its own
 * ("Open image in new tab", dragging it to the tab strip). An object URL
 * shares the webmail origin, so an image/svg+xml one would run the
 * sender's script there. SVG is handed over as a data: URL instead - its
 * document gets an opaque origin - and every other type as an object URL
 * typed per inertBlobType(). Revoking the result is safe either way.
 */
export async function imageBlobUrl(blob: Blob, type?: string): Promise<string> {
  const declared = type || blob.type;
  if (isSvgType(declared)) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob.slice(0, blob.size, SVG_MIME_TYPE));
    });
  }
  const inert = inertBlobType(declared);
  return URL.createObjectURL(blob.type === inert ? blob : blob.slice(0, blob.size, inert));
}