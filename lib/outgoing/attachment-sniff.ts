/**
 * What a file really is, read from its first bytes: a renamed program
 * (invoice.pdf that starts with "MZ") is still a program. Used for the
 * attachment information plugins get before an upload and before a send
 * (AttachmentInfo.sniffedType, OutgoingEmail.attachments[].sniffedType).
 *
 * Only well-known signatures; anything else is undefined, never a guess
 * from the name.
 */

/** Bytes a sniff needs; read at most this much for a binary file. */
export const SNIFF_BYTES = 4096;

const startsWith = (bytes: Uint8Array, sig: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);

const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0));

const SIGNATURES: readonly { sig: readonly number[]; offset?: number; type: string }[] = [
  { sig: [0x7f, 0x45, 0x4c, 0x46], type: 'application/x-executable' },
  { sig: [0xcf, 0xfa, 0xed, 0xfe], type: 'application/x-mach-binary' },
  { sig: [0xce, 0xfa, 0xed, 0xfe], type: 'application/x-mach-binary' },
  { sig: [0xfe, 0xed, 0xfa, 0xcf], type: 'application/x-mach-binary' },
  { sig: [0xfe, 0xed, 0xfa, 0xce], type: 'application/x-mach-binary' },
  { sig: [0xca, 0xfe, 0xba, 0xbe], type: 'application/x-mach-binary' },
  { sig: [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00], type: 'application/x-ms-shortcut' },
  { sig: ascii('MSCF'), type: 'application/vnd.ms-cab-compressed' },
  { sig: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], type: 'application/x-ole-storage' },
  { sig: [0x50, 0x4b, 0x03, 0x04], type: 'application/zip' },
  { sig: [0x50, 0x4b, 0x05, 0x06], type: 'application/zip' },
  { sig: [0x50, 0x4b, 0x07, 0x08], type: 'application/zip' },
  { sig: ascii('Rar!\x1a\x07'), type: 'application/x-rar-compressed' },
  { sig: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], type: 'application/x-7z-compressed' },
  { sig: [0x1f, 0x8b], type: 'application/gzip' },
  { sig: ascii('%PDF-'), type: 'application/pdf' },
  { sig: ascii('{\\rtf'), type: 'application/rtf' },
  { sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], type: 'image/png' },
  { sig: [0xff, 0xd8, 0xff], type: 'image/jpeg' },
  { sig: ascii('GIF87a'), type: 'image/gif' },
  { sig: ascii('GIF89a'), type: 'image/gif' },
  { sig: ascii('#!'), type: 'text/x-shellscript' },
];

/** Whether `needle` occurs in the bytes. */
function contains(bytes: Uint8Array, needle: string): boolean {
  const sig = ascii(needle);
  outer: for (let i = 0; i + sig.length <= bytes.length; i++) {
    for (let j = 0; j < sig.length; j++) if (bytes[i + j] !== sig[j]) continue outer;
    return true;
  }
  return false;
}

/** The MIME type the bytes start with, or undefined when none is known. */
export function sniffType(bytes: Uint8Array): string | undefined {
  // "MZ" starts every Windows and DOS program, whose header holds zero
  // bytes; a text file that happens to start with "MZ" has none.
  if (startsWith(bytes, ascii('MZ')) && bytes.subarray(0, SNIFF_BYTES).includes(0)) return 'application/x-msdownload';
  for (const { sig, offset, type } of SIGNATURES) {
    if (!startsWith(bytes, sig, offset)) continue;
    // Java and Android apps are ZIP files; their entry names give them away.
    if (type === 'application/zip') {
      if (contains(bytes, 'AndroidManifest.xml')) return 'application/vnd.android.package-archive';
      if (contains(bytes, 'META-INF/MANIFEST.MF')) return 'application/java-archive';
    }
    return type;
  }
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  return sniffText(bytes);
}

/** text/html or text/plain for text without NUL bytes that decodes as UTF-8. */
function sniffText(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return undefined;
  const head = bytes.subarray(0, Math.min(bytes.length, SNIFF_BYTES));
  if (head.includes(0)) return undefined;
  let text: string;
  try {
    // A multi-byte character cut at the end of the head is fine.
    text = new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, trimPartialUtf8(head)));
  } catch {
    return undefined;
  }
  const start = text.replace(/^\uFEFF/, '').trimStart().slice(0, 64).toLowerCase();
  if (start.startsWith('<!doctype html') || start.startsWith('<html')) return 'text/html';
  return 'text/plain';
}

/** Length of `bytes` without a UTF-8 sequence cut off at its end. */
function trimPartialUtf8(bytes: Uint8Array): number {
  let end = bytes.length;
  for (let back = 1; back <= 3 && end - back >= 0; back++) {
    const b = bytes[end - back];
    if ((b & 0xc0) === 0x80) continue; // continuation byte
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? end - back : end;
  }
  return end;
}

const TEXT_EXTENSIONS = new Set(['txt', 'csv', 'tsv', 'json', 'xml', 'ics', 'vcf', 'md', 'log', 'htm', 'html', 'yaml', 'yml', 'ini', 'conf']);
const TEXT_TYPES = new Set(['application/json', 'application/xml', 'application/csv', 'application/x-yaml', 'application/yaml']);

/** Whether a file is text a send check may read: by type, else by extension. */
export function isTextAttachment(name: string, type: string): boolean {
  const t = (type || '').toLowerCase().split(';')[0].trim();
  if (t.startsWith('text/') || TEXT_TYPES.has(t)) return true;
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return !!ext && TEXT_EXTENSIONS.has(ext);
}
