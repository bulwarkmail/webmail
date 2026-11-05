// Host side of api.ui.openFile, and of api.ui.print with a PDF: a file the
// plugin made (a case file as one PDF, a scanned image) opens in Bulwark's
// own file preview, the one attachments and Files use, with its Download and
// Print. A plugin frame can't open a window or a tab, and openExternalUrl
// takes only http(s) links.
//
// The file never becomes a page of the app's origin: only PDF and common
// raster images, checked by their first bytes as well as the type the plugin
// names, so no HTML, SVG or script can be passed off as one. It stays a Blob
// in memory; the preview's blob: URL is revoked when the preview closes
// (components/files/file-preview-modal.tsx). In the desktop app it is the
// same preview, in the app's window.

import type { InstalledPlugin } from '../plugin-types';
import { MAX_PLUGIN_FETCH_BYTES, isPlainRecord, readObject, readString, withinRate } from './host-api-input';
import { showPluginFile } from './file-viewer';

/** At most this big, like a file a plugin fetches or reads (25 MiB). */
export const MAX_VIEWER_FILE_BYTES = MAX_PLUGIN_FETCH_BYTES;
/** Files a plugin may open per minute. */
export const MAX_OPEN_FILES_PER_MINUTE = 5;

/** What the preview shows, by type, with the extension its name gets. */
export const VIEWER_FILE_TYPES: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
  bytes.length >= at + signature.length && signature.every((value, i) => bytes[at + i] === value);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** Whether the first bytes are a file of `type`. */
export function bytesMatchType(head: Uint8Array, type: string): boolean {
  switch (type) {
    case 'application/pdf': {
      // "%PDF-" in the first kilobyte, where readers look for it.
      const window = head.subarray(0, 1024);
      const marker = ascii('%PDF-');
      for (let i = 0; i + marker.length <= window.length; i++) if (startsWith(window, marker, i)) return true;
      return false;
    }
    case 'image/png': return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg': return startsWith(head, [0xff, 0xd8, 0xff]);
    case 'image/gif': return startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a'));
    case 'image/webp': return startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8);
    default: return false;
  }
}

/** A file name without a path, control characters or a disguised extension, ending in the type's extension. */
export function viewerFileName(name: string, type: string): string {
  const ext = VIEWER_FILE_TYPES[type];
  const cleaned = name
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120) || 'file';
  const lower = cleaned.toLowerCase();
  const fits = lower.endsWith(`.${ext}`) || (ext === 'jpg' && lower.endsWith('.jpeg'));
  return fits ? cleaned : `${cleaned}.${ext}`;
}

// By tag, not instanceof: the bytes come from another frame's realm.
const tagOf = (value: unknown) => Object.prototype.toString.call(value);

async function bytesOf(method: string, content: unknown): Promise<Uint8Array> {
  if (tagOf(content) === '[object ArrayBuffer]') return new Uint8Array(content as ArrayBuffer);
  if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  if (tagOf(content) === '[object Blob]' || tagOf(content) === '[object File]') {
    const blob = content as Blob;
    if (blob.size > MAX_VIEWER_FILE_BYTES) throw new Error(`${method}: the file is bigger than 25 MiB`);
    return new Uint8Array(await blob.arrayBuffer());
  }
  throw new Error(`${method}: content must be bytes (an ArrayBuffer, a typed array or a Blob)`);
}

/**
 * Check a file a plugin hands in and make the Blob the preview shows.
 * `only` limits the types (a PDF to print).
 */
export async function readViewerFile(
  method: string,
  input: { content: unknown; filename: unknown; contentType: unknown },
  only?: readonly string[],
): Promise<{ blob: Blob; name: string; type: string }> {
  const type = readString(input.contentType, method, 'contentType', 255).split(';')[0].trim().toLowerCase();
  const allowed = only ?? Object.keys(VIEWER_FILE_TYPES);
  if (!allowed.includes(type)) {
    throw new Error(`${method}: ${type || 'that type'} can't be opened; only ${allowed.join(', ')}`);
  }
  const bytes = await bytesOf(method, input.content);
  if (bytes.byteLength === 0) throw new Error(`${method}: the file is empty`);
  if (bytes.byteLength > MAX_VIEWER_FILE_BYTES) throw new Error(`${method}: the file is bigger than 25 MiB`);
  if (!bytesMatchType(bytes.subarray(0, 1024), type)) throw new Error(`${method}: the content is not a ${type} file`);
  const name = viewerFileName(readString(input.filename, method, 'filename', 255), type);
  // A copy: the plugin's buffer is the plugin's.
  return { blob: new Blob([bytes.slice()], { type }), name, type };
}

/**
 * api.ui.openFile({ content, filename, contentType }): show the file in the
 * preview. Resolves to true once the preview shows it.
 */
export async function doUiOpenFile(plugin: InstalledPlugin, input: unknown): Promise<boolean> {
  const method = 'ui.openFile';
  const file = readObject(input, method, 'file', ['content', 'filename', 'contentType']);
  const { blob, name } = await readViewerFile(method, { content: file.content, filename: file.filename, contentType: file.contentType });
  if (!withinRate(method, plugin.id, MAX_OPEN_FILES_PER_MINUTE)) {
    throw new Error(`${method}: at most ${MAX_OPEN_FILES_PER_MINUTE} files a minute`);
  }
  if (!showPluginFile({ pluginId: plugin.id, name, blob, print: false })) {
    throw new Error(`${method}: there is no file preview in this window`);
  }
  return true;
}

/** Whether ui.print got a PDF ({ pdf }) rather than a page ({ html }). */
export function isPdfPrintRequest(input: unknown): boolean {
  return isPlainRecord(input) && 'pdf' in input;
}

/**
 * api.ui.print({ title?, pdf }): the PDF opens in the preview and its print
 * dialog comes up. The caller checked the organisation's print policy and the
 * print rate.
 */
export async function showPdfToPrint(plugin: InstalledPlugin, page: Record<string, unknown>, title: string): Promise<boolean> {
  const method = 'ui.print';
  const { blob, name } = await readViewerFile(method, { content: page.pdf, filename: title, contentType: 'application/pdf' }, ['application/pdf']);
  if (!showPluginFile({ pluginId: plugin.id, name, blob, print: true })) {
    throw new Error(`${method}: there is no file preview in this window`);
  }
  return true;
}
