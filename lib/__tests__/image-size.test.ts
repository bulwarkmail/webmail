import { describe, expect, it } from 'vitest';
import { imageDimensions } from '../image-size';

// The size an image declares, read from the header of each format.

const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const le32 = (n: number) => [...le16(n & 0xffff), ...le16(n >>> 16)];

describe('imageDimensions', () => {
  it('reads PNG and GIF', () => {
    expect(imageDimensions(bytes([0x89], 'PNG', [13, 10, 26, 10, 0, 0, 0, 13], 'IHDR', be32(40_000), be32(30_000), [8, 2, 0, 0, 0]))).toEqual({ width: 40_000, height: 30_000 });
    expect(imageDimensions(bytes('GIF89a', le16(320), le16(200), [0, 0, 0]))).toEqual({ width: 320, height: 200 });
  });

  it('reads a JPEG frame header after an EXIF block', () => {
    const app1 = [0xff, 0xe1, 0x00, 0x10, ...new Array(14).fill(0)];
    const sof = [0xff, 0xc2, 0x00, 0x11, 8, 0x0b, 0xb8, 0x0f, 0xa0, 3, ...new Array(9).fill(0)];
    expect(imageDimensions(bytes([0xff, 0xd8], app1, sof))).toEqual({ width: 4000, height: 3000 });
    // No frame header before the image data: unknown.
    expect(imageDimensions(bytes([0xff, 0xd8], app1, [0xff, 0xda, 0, 2, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });

  it('reads the three kinds of WebP', () => {
    const riff = (chunk: string, body: number[]) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', chunk, [0, 0, 0, 0], body);
    expect(imageDimensions(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(640), ...le16(480)]))).toEqual({ width: 640, height: 480 });
    // VP8L: 14 bits each of width - 1 and height - 1 after the 0x2f signature.
    const w = 1023;
    const h = 767;
    const packed = (w - 1) | ((h - 1) << 14);
    expect(imageDimensions(riff('VP8L', [0x2f, ...le32(packed), 0]))).toEqual({ width: w, height: h });
    expect(imageDimensions(riff('VP8X', [0, 0, 0, 0, ...le24(16_383), ...le24(9_999)]))).toEqual({ width: 16_384, height: 10_000 });
  });

  it('reads BMP, and nothing from what it does not know', () => {
    expect(imageDimensions(bytes('BM', new Array(16).fill(0), le32(800), le32(-600 >>> 0)))).toEqual({ width: 800, height: 600 });
    expect(imageDimensions(bytes('<svg width="100000" height="100000">'))).toBeNull();
    expect(imageDimensions(new Uint8Array(0))).toBeNull();
  });
});
