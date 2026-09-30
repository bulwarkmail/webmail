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

const INLINE_PREVIEW_SAFE_MIME_PREFIXES = ['image/', 'audio/', 'video/'];
const INLINE_PREVIEW_SAFE_MIME_TYPES = new Set(['application/pdf', 'text/plain']);
const INLINE_PREVIEW_UNSAFE_MIME_TYPES = new Set([
  'image/svg+xml',
  'image/svg',
]);

// Whether a Blob with this MIME type is safe to open as a top-level navigation
// (e.g. window.open on a blob: URL). Blob URLs inherit the creator's origin, so
// script-bearing types like text/html, application/xhtml+xml, image/svg+xml, and
// XML variants would execute in our origin. Only an explicit allowlist of inert
// types is permitted; everything else must be downloaded.
export function isMimeTypeSafeForInlinePreview(type?: string): boolean {
  const mimeType = type?.split(';')[0]?.trim().toLowerCase() || '';
  if (!mimeType) return false;
  if (INLINE_PREVIEW_UNSAFE_MIME_TYPES.has(mimeType)) return false;
  if (INLINE_PREVIEW_SAFE_MIME_TYPES.has(mimeType)) return true;
  return INLINE_PREVIEW_SAFE_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

const INERT_BLOB_TYPE = 'application/octet-stream';

/**
 * MIME type for a Blob whose blob: URL ends up inside untrusted markup (the
 * cid: parts of a rendered message body). Blob URLs inherit the creating
 * document's origin, so a sender-declared text/html or image/svg+xml part
 * navigated to as a top-level document would run script as the webmail origin
 * (GHSA-xvjh-v9c6-qcvc). Inert types keep their MIME so img/video/audio keep
 * rendering them; anything else becomes octet-stream, which no browser executes.
 */
export function inertBlobType(type?: string): string {
  return type && isMimeTypeSafeForInlinePreview(type) ? type : INERT_BLOB_TYPE;
}

/** Re-type a fetched Blob per inertBlobType() without copying its bytes. */
export function toInertBlob(blob: Blob): Blob {
  return isMimeTypeSafeForInlinePreview(blob.type) ? blob : blob.slice(0, blob.size, INERT_BLOB_TYPE);
}

/**
 * A URL an <img> can show whose target is inert when opened on its own
 * ("Open image in new tab", dragging it to the tab strip). An object URL
 * shares the webmail origin, so an image/svg+xml one would run the
 * sender's script there. SVG is handed over as a data: URL instead - its
 * document gets an opaque origin - and every other type as an object URL
 * re-typed per inertBlobType(). Revoking the result is safe either way.
 */
export async function imageBlobUrl(blob: Blob, type?: string): Promise<string> {
  const mimeType = (type || blob.type).split(';')[0].trim().toLowerCase();
  if (INLINE_PREVIEW_UNSAFE_MIME_TYPES.has(mimeType)) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob.slice(0, blob.size, 'image/svg+xml'));
    });
  }
  return URL.createObjectURL(toInertBlob(type ? blob.slice(0, blob.size, type) : blob));
}