// The width and height an image file declares in its header, read before
// anything decodes it: PNG (IHDR), GIF, JPEG (the SOF segment), WebP
// (VP8, VP8L, VP8X) and BMP. A file can declare a size whose pixels alone
// would fill the memory, so callers check this first.

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Bytes of a file's start that hold the size of every format read here, EXIF blocks before a JPEG's SOF included. */
export const IMAGE_HEADER_BYTES = 512 * 1024;

const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
const ascii = (b: Uint8Array, at: number, text: string) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

function jpeg(b: Uint8Array): ImageDimensions | null {
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    // Fill bytes, and markers without a length (restart markers, TEM).
    if (marker === 0xff) { at++; continue; }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16be(b, at + 2);
    // Start of frame: every SOF but DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, at + 5), width: u16be(b, at + 7) };
    }
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

function webp(b: Uint8Array): ImageDimensions | null {
  if (b.length >= 30 && ascii(b, 12, 'VP8 ') && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, 'VP8L') && b[20] === 0x2f) {
    return {
      width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
      height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)),
    };
  }
  if (b.length >= 30 && ascii(b, 12, 'VP8X')) return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  return null;
}

/** The size the file declares, or null for a format not read here (or a damaged header). */
export function imageDimensions(bytes: Uint8Array): ImageDimensions | null {
  const b = bytes;
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 'PNG') && ascii(b, 12, 'IHDR')) return { width: u32be(b, 16), height: u32be(b, 20) };
  if (b.length >= 10 && ascii(b, 0, 'GIF8')) return { width: u16le(b, 6), height: u16le(b, 8) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  if (b.length >= 25 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return webp(b);
  if (b.length >= 26 && ascii(b, 0, 'BM')) {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
  }
  return null;
}
