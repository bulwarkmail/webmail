// The date and place a photo was taken, from the EXIF block of a JPEG
// (APP1 "Exif"): DateTimeOriginal and the GPS position. Nothing else is
// read. Never throws: a damaged block gives what could be read, or nothing.

export interface PhotoExif {
  /** When the photo was taken, "2026-10-31T14:05:00" (with "+01:00" when the camera wrote its offset). */
  taken?: string;
  /** Latitude and longitude in degrees, north and east positive, five decimals. */
  lat?: number;
  lon?: number;
}

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const GPS_LAT_REF = 1;
const GPS_LAT = 2;
const GPS_LON_REF = 3;
const GPS_LON = 4;

/** The TIFF block inside the first APP1 Exif segment, or null. */
function exifBlock(bytes: Uint8Array): DataView | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    // Start of scan, end of image: no more headers.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (length < 2) return null;
    if (marker === 0xe1 && at + 10 <= bytes.length
      && bytes[at + 4] === 0x45 && bytes[at + 5] === 0x78 && bytes[at + 6] === 0x69 && bytes[at + 7] === 0x66 && bytes[at + 8] === 0 && bytes[at + 9] === 0) {
      const start = at + 10;
      const end = Math.min(bytes.length, at + 2 + length);
      return new DataView(bytes.buffer, bytes.byteOffset + start, Math.max(0, end - start));
    }
    at += 2 + length;
  }
  return null;
}

interface Entry { type: number; count: number; valueAt: number }

class Tiff {
  readonly little: boolean;
  constructor(readonly view: DataView) {
    const order = view.getUint16(0);
    if (order !== 0x4949 && order !== 0x4d4d) throw new Error('not TIFF');
    this.little = order === 0x4949;
  }
  u16(at: number): number { return this.view.getUint16(at, this.little); }
  u32(at: number): number { return this.view.getUint32(at, this.little); }
  firstIfd(): number { return this.u32(4); }

  /** The entries of the IFD at `at`, by tag. */
  ifd(at: number): Map<number, Entry> {
    const out = new Map<number, Entry>();
    if (at < 8 || at + 2 > this.view.byteLength) return out;
    const n = this.u16(at);
    for (let i = 0; i < n && i < 500; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > this.view.byteLength) break;
      const type = this.u16(e + 2);
      const count = this.u32(e + 4);
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 } as Record<number, number>)[type] ?? 1;
      // Values of 4 bytes or less sit in the entry itself, longer ones at an offset.
      const valueAt = size * count <= 4 ? e + 8 : this.u32(e + 8);
      out.set(this.u16(e), { type, count, valueAt });
    }
    return out;
  }

  ascii(entry: Entry | undefined): string | undefined {
    if (!entry || entry.type !== 2 || entry.valueAt + entry.count > this.view.byteLength) return undefined;
    let s = '';
    for (let i = 0; i < entry.count; i++) {
      const c = this.view.getUint8(entry.valueAt + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim() || undefined;
  }

  rationals(entry: Entry | undefined): number[] | undefined {
    if (!entry || entry.type !== 5 || entry.valueAt + entry.count * 8 > this.view.byteLength) return undefined;
    const out: number[] = [];
    for (let i = 0; i < entry.count; i++) {
      const den = this.u32(entry.valueAt + i * 8 + 4);
      out.push(den === 0 ? NaN : this.u32(entry.valueAt + i * 8) / den);
    }
    return out;
  }

  long(entry: Entry | undefined): number | undefined {
    if (!entry || (entry.type !== 4 && entry.type !== 3)) return undefined;
    return entry.type === 4 ? this.u32(entry.valueAt) : this.u16(entry.valueAt);
  }
}

/** "2026:10:31 14:05:00" → "2026-10-31T14:05:00". */
function exifDate(value: string | undefined, offset: string | undefined): string | undefined {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value ?? '');
  if (!m || m[1] === '0000') return undefined;
  const zone = /^[+-]\d{2}:\d{2}$/.test(offset ?? '') ? offset : '';
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${zone}`;
}

function degrees(parts: number[] | undefined, ref: string | undefined, negative: string): number | undefined {
  if (!parts || parts.length < 1 || parts.some((p) => !Number.isFinite(p))) return undefined;
  const [d, m = 0, s = 0] = parts;
  const value = (d + m / 60 + s / 3600) * (ref?.toUpperCase() === negative ? -1 : 1);
  return Math.round(value * 1e5) / 1e5;
}

/** The date and place in a JPEG's EXIF block; {} when there is none. */
export function readPhotoExif(data: ArrayBuffer | Uint8Array): PhotoExif {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const out: PhotoExif = {};
  try {
    const view = exifBlock(bytes);
    if (!view) return out;
    const tiff = new Tiff(view);
    const ifd0 = tiff.ifd(tiff.firstIfd());
    const exifAt = tiff.long(ifd0.get(TAG_EXIF_IFD));
    const exif = exifAt ? tiff.ifd(exifAt) : new Map<number, Entry>();
    // Only the date the photo was taken: IFD0's DateTime is when the file was last changed.
    const taken = exifDate(tiff.ascii(exif.get(TAG_DATETIME_ORIGINAL)), tiff.ascii(exif.get(TAG_OFFSET_TIME_ORIGINAL)));
    if (taken) out.taken = taken;
    const gpsAt = tiff.long(ifd0.get(TAG_GPS_IFD));
    if (gpsAt) {
      const gps = tiff.ifd(gpsAt);
      const lat = degrees(tiff.rationals(gps.get(GPS_LAT)), tiff.ascii(gps.get(GPS_LAT_REF)), 'S');
      const lon = degrees(tiff.rationals(gps.get(GPS_LON)), tiff.ascii(gps.get(GPS_LON_REF)), 'W');
      if (lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        out.lat = lat;
        out.lon = lon;
      }
    }
  } catch {
    // What was read so far stays.
  }
  return out;
}
