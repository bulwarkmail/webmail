import { describe, expect, it } from 'vitest';
import { readPhotoExif } from '../exif';

// A JPEG with an APP1 Exif block, built by hand: a TIFF header, IFD0 with
// pointers to the Exif and GPS IFDs, and their values after them.

type Value = { tag: number; type: 2 | 4 | 5; ascii?: string; long?: number; rationals?: [number, number][] };

function tiff(little: boolean, ifds: { ifd0: Value[]; exif: Value[]; gps: Value[] }): Uint8Array {
  const buf = new DataView(new ArrayBuffer(1024));
  const u16 = (at: number, v: number) => buf.setUint16(at, v, little);
  const u32 = (at: number, v: number) => buf.setUint32(at, v, little);
  buf.setUint16(0, little ? 0x4949 : 0x4d4d);
  u16(2, 42);
  u32(4, 8);
  const sizeOf = (n: number) => 2 + n * 12 + 4;
  const at0 = 8;
  const atExif = at0 + sizeOf(ifds.ifd0.length + 2);
  const atGps = atExif + sizeOf(ifds.exif.length);
  let data = atGps + sizeOf(ifds.gps.length);
  const write = (at: number, values: Value[]) => {
    u16(at, values.length);
    values.forEach((v, i) => {
      const e = at + 2 + i * 12;
      u16(e, v.tag);
      u16(e + 2, v.type);
      if (v.type === 2) {
        const bytes = [...new TextEncoder().encode(v.ascii ?? ''), 0];
        u32(e + 4, bytes.length);
        const target = bytes.length <= 4 ? e + 8 : data;
        if (bytes.length > 4) { u32(e + 8, data); data += bytes.length + (bytes.length % 2); }
        bytes.forEach((b, j) => buf.setUint8(target + j, b));
      } else if (v.type === 4) {
        u32(e + 4, 1);
        u32(e + 8, v.long ?? 0);
      } else {
        const r = v.rationals ?? [];
        u32(e + 4, r.length);
        u32(e + 8, data);
        r.forEach(([num, den]) => { u32(data, num); u32(data + 4, den); data += 8; });
      }
    });
    u32(at + 2 + values.length * 12, 0);
  };
  write(at0, [...ifds.ifd0, { tag: 0x8769, type: 4, long: atExif }, { tag: 0x8825, type: 4, long: atGps }]);
  write(atExif, ifds.exif);
  write(atGps, ifds.gps);
  return new Uint8Array(buf.buffer.slice(0, data));
}

function jpeg(block: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode('Exif\0\0');
  const length = 2 + header.length + block.length;
  // SOI, an APP0 first (as cameras write JFIF before Exif), then APP1, then the scan.
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
  return new Uint8Array([0xff, 0xd8, ...app0, 0xff, 0xe1, length >> 8, length & 0xff, ...header, ...block, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
}

const photo = (little: boolean) => jpeg(tiff(little, {
  ifd0: [{ tag: 0x0132, type: 2, ascii: '2026:11:01 09:00:00' }],
  exif: [{ tag: 0x9003, type: 2, ascii: '2026:10:31 14:05:30' }, { tag: 0x9011, type: 2, ascii: '+01:00' }],
  gps: [
    { tag: 1, type: 2, ascii: 'N' }, { tag: 2, type: 5, rationals: [[52, 1], [31, 1], [1234, 100]] },
    { tag: 3, type: 2, ascii: 'W' }, { tag: 4, type: 5, rationals: [[13, 1], [24, 1], [0, 1]] },
  ],
}));

describe('readPhotoExif', () => {
  it('reads the date taken and the GPS position, in both byte orders', () => {
    for (const little of [false, true]) {
      expect(readPhotoExif(photo(little))).toEqual({ taken: '2026-10-31T14:05:30+01:00', lat: 52.52009, lon: -13.4 });
    }
  });

  it('gives no date when only the date the file changed is there', () => {
    const bytes = jpeg(tiff(false, { ifd0: [{ tag: 0x0132, type: 2, ascii: '2026:11:01 09:00:00' }], exif: [], gps: [] }));
    expect(readPhotoExif(bytes)).toEqual({});
  });

  it('gives nothing for a JPEG without EXIF, a PNG or broken bytes', () => {
    expect(readPhotoExif(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]))).toEqual({});
    expect(readPhotoExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toEqual({});
    const cut = photo(false).slice(0, 40);
    expect(() => readPhotoExif(cut)).not.toThrow();
  });
});
