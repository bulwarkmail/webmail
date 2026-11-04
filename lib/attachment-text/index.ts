// The text of an attachment or a file, for a reader that needs words rather
// than layout (the AI assistant's plugin, Files). Picks the format by the
// file name, then the media type, and hands the bytes to its reader:
// plain.ts (text, CSV, HTML, calendar files, address cards), pdf.ts
// (pdf.js), office.ts (docx, xlsx, pptx, odt, ods, odp). Never throws: a
// file that can't be read answers with a status. Import it on demand: the
// readers are only loaded when a file is read.

import { MAX_HTML_CHARS, decodeText, htmlText, icsToText, looksLikeText, vcfText } from './plain';
import { pdfText } from './pdf';
import { officeText } from './office';
import {
  DEFAULT_TEXT_CHARS, MAX_TEXT_CHARS, MAX_TEXT_SOURCE_BYTES, TEXT_BUDGET_SLACK,
  type ExtractOptions, type ExtractedText, type TextFormat,
} from './types';

export * from './types';

const BY_EXTENSION: Record<string, TextFormat> = {
  txt: 'text', text: 'text', md: 'text', markdown: 'text', log: 'text', json: 'text', xml: 'text',
  yaml: 'text', yml: 'text', ini: 'text', tsv: 'csv', csv: 'csv',
  htm: 'html', html: 'html', xhtml: 'html', ics: 'ics', ical: 'ics', ifb: 'ics', vcf: 'vcf', vcard: 'vcf',
  pdf: 'pdf', docx: 'docx', docm: 'docx', dotx: 'docx', xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx',
  pptx: 'pptx', pptm: 'pptx', potx: 'pptx', odt: 'odt', ott: 'odt', ods: 'ods', ots: 'ods', odp: 'odp', otp: 'odp',
};

const BY_TYPE: Record<string, TextFormat> = {
  'text/plain': 'text', 'text/markdown': 'text', 'application/json': 'text', 'application/xml': 'text', 'text/xml': 'text',
  'text/csv': 'csv', 'text/tab-separated-values': 'csv', 'text/html': 'html', 'application/xhtml+xml': 'html',
  'text/calendar': 'ics', 'application/ics': 'ics', 'text/vcard': 'vcf', 'text/x-vcard': 'vcf', 'text/directory': 'vcf',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
};

/** The format to read a file as: by its name's extension, else its media type, else 'other'. */
export function textFormatOf(name = '', type = ''): TextFormat {
  const ext = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase();
  if (ext && BY_EXTENSION[ext]) return BY_EXTENSION[ext];
  const mediaType = type.split(';')[0].trim().toLowerCase();
  if (BY_TYPE[mediaType]) return BY_TYPE[mediaType];
  // Other text types (text/x-python, text/rfc822-headers, ...); not text/html, handled above.
  // A forwarded message (.eml, message/rfc822) is MIME, not text: 'other' until it has a reader.
  if (mediaType.startsWith('text/')) return 'text';
  return 'other';
}

/** Cut `text` at `maxChars`, at a line or word end when one is near. */
export function clipText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  // Never half of a character outside the Basic Multilingual Plane (an emoji).
  const end = /[\uD800-\uDBFF]/.test(text[maxChars - 1] ?? '') ? maxChars - 1 : maxChars;
  const cut = text.slice(0, end);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return { text: (at > maxChars * 0.9 ? cut.slice(0, at) : cut).trimEnd(), truncated: true };
}

const empty = (format: TextFormat, status: ExtractedText['status']): ExtractedText => ({ format, status, text: '', truncated: false });

async function read(bytes: Uint8Array, format: TextFormat, budget: number): Promise<Omit<ExtractedText, 'format'>> {
  switch (format) {
    case 'text':
    case 'csv':
      if (!looksLikeText(bytes)) return { status: 'unsupported', text: '', truncated: false };
      return { status: 'ok', text: decodeText(bytes).replace(/\r\n?/g, '\n'), truncated: false };
    case 'html':
    {
      const html = decodeText(bytes);
      const cut = html.length > MAX_HTML_CHARS;
      return { status: 'ok', text: htmlText(cut ? html.slice(0, MAX_HTML_CHARS) : html), truncated: cut };
    }
    case 'ics':
      return { status: 'ok', text: icsToText(decodeText(bytes)), truncated: false };
    case 'vcf':
      return { status: 'ok', text: vcfText(decodeText(bytes)), truncated: false };
    case 'pdf':
      return pdfText(bytes, { budget });
    case 'docx': case 'xlsx': case 'pptx': case 'odt': case 'ods': case 'odp':
      return officeText(bytes, format, { budget });
    default:
      return { status: 'unsupported', text: '', truncated: false };
  }
}

/** Extractions running at once: each holds a file, and an Office file's DOM, on the main thread. */
export const MAX_EXTRACTIONS_AT_ONCE = 2;
let running = 0;
const waiting: (() => void)[] = [];

/** Runs `work` when fewer than MAX_EXTRACTIONS_AT_ONCE extractions are running. */
async function inTurn<T>(work: () => Promise<T>): Promise<T> {
  while (running >= MAX_EXTRACTIONS_AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/**
 * The text of a file (its bytes, or a Blob such as a file in Files).
 * Statuses: too_big over MAX_TEXT_SOURCE_BYTES (or an Office file that
 * unpacks to more than 50 MB), unsupported for images, archives and the
 * legacy .doc/.xls/.ppt, no_text for a scanned PDF or a file with nothing
 * in it, encrypted, failed. At most MAX_EXTRACTIONS_AT_ONCE run at a time;
 * the others wait their turn.
 */
export async function extractText(data: ArrayBuffer | Uint8Array | Blob, options: ExtractOptions = {}): Promise<ExtractedText> {
  const format = textFormatOf(options.name, options.type);
  const size = data instanceof Blob ? data.size : data.byteLength;
  if (size > MAX_TEXT_SOURCE_BYTES) return empty(format, 'too_big');
  // Files calls this directly: anything but a positive number means the default.
  const asked = Number(options.maxChars);
  const maxChars = Number.isFinite(asked) && asked >= 1 ? Math.min(MAX_TEXT_CHARS, Math.floor(asked)) : DEFAULT_TEXT_CHARS;
  // A legacy Office file (and anything else) without a reader.
  if (format === 'other') return empty(format, 'unsupported');
  let result: Omit<ExtractedText, 'format'>;
  try {
    result = await inTurn(async () => {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data);
      return read(bytes, format, maxChars + TEXT_BUDGET_SLACK);
    });
  } catch {
    return empty(format, 'failed');
  }
  if (result.status !== 'ok') return { ...result, format, text: '' };
  const text = result.text.trim();
  if (!text) return { ...result, format, status: 'no_text', text: '', truncated: false };
  const clipped = clipText(text, maxChars);
  return { ...result, format, text: clipped.text, truncated: result.truncated || clipped.truncated };
}
