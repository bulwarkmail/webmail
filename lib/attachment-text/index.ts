// The text of an attachment or a file, for a reader that needs words rather
// than layout (the AI assistant's plugin, Files). Picks the format by the
// file name, then the media type, and hands the bytes to its reader:
// plain.ts (text, CSV, HTML, calendar files, address cards), pdf.ts
// (pdf.js), office.ts (docx, xlsx, pptx, odt, ods, odp). Never throws: a
// file that can't be read answers with a status.

import { decodeText, htmlText, icsToText, looksLikeText, vcfText } from './plain';
import { pdfText } from './pdf';
import { officeText } from './office';
import {
  DEFAULT_TEXT_CHARS, MAX_TEXT_CHARS, MAX_TEXT_SOURCE_BYTES,
  type ExtractOptions, type ExtractedText, type TextFormat,
} from './types';

export * from './types';
export { setPdfLoader, type PdfLib } from './pdf';

const BY_EXTENSION: Record<string, TextFormat> = {
  txt: 'text', text: 'text', md: 'text', markdown: 'text', log: 'text', json: 'text', xml: 'text',
  yaml: 'text', yml: 'text', ini: 'text', eml: 'text', tsv: 'csv', csv: 'csv',
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
  if (mediaType.startsWith('text/')) return 'text';
  return 'other';
}

/** Cut `text` at `maxChars`, at a line or word end when one is near. */
export function clipText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.slice(0, maxChars);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return { text: (at > maxChars * 0.9 ? cut.slice(0, at) : cut).trimEnd(), truncated: true };
}

const empty = (format: TextFormat, status: ExtractedText['status']): ExtractedText => ({ format, status, text: '', truncated: false });

async function read(bytes: Uint8Array, format: TextFormat): Promise<Omit<ExtractedText, 'format'>> {
  switch (format) {
    case 'text':
    case 'csv':
      if (!looksLikeText(bytes)) return { status: 'unsupported', text: '', truncated: false };
      return { status: 'ok', text: decodeText(bytes).replace(/\r\n?/g, '\n'), truncated: false };
    case 'html':
      return { status: 'ok', text: htmlText(decodeText(bytes)), truncated: false };
    case 'ics':
      return { status: 'ok', text: icsToText(decodeText(bytes)), truncated: false };
    case 'vcf':
      return { status: 'ok', text: vcfText(decodeText(bytes)), truncated: false };
    case 'pdf':
      return pdfText(bytes);
    case 'docx': case 'xlsx': case 'pptx': case 'odt': case 'ods': case 'odp':
      return officeText(bytes, format);
    default:
      return { status: 'unsupported', text: '', truncated: false };
  }
}

/**
 * The text of a file's bytes. Statuses: too_big over MAX_TEXT_SOURCE_BYTES
 * (or an Office file that unpacks to more than 50 MB), unsupported for
 * images, archives and the legacy .doc/.xls/.ppt, no_text for a scanned
 * PDF or a file with nothing in it, encrypted, failed.
 */
export async function extractText(data: ArrayBuffer | Uint8Array, options: ExtractOptions = {}): Promise<ExtractedText> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const format = textFormatOf(options.name, options.type);
  if (bytes.byteLength > MAX_TEXT_SOURCE_BYTES) return empty(format, 'too_big');
  const maxChars = Math.max(1, Math.min(MAX_TEXT_CHARS, Math.floor(options.maxChars ?? DEFAULT_TEXT_CHARS)));
  // A legacy Office file (and anything else) without a reader.
  if (format === 'other') return empty(format, 'unsupported');
  let result: Omit<ExtractedText, 'format'>;
  try {
    result = await read(bytes, format);
  } catch {
    return empty(format, 'failed');
  }
  if (result.status !== 'ok') return { ...result, format, text: '' };
  const text = result.text.trim();
  if (!text) return { ...result, format, status: 'no_text', text: '', truncated: false };
  const clipped = clipText(text, maxChars);
  return { ...result, format, text: clipped.text, truncated: result.truncated || clipped.truncated };
}
