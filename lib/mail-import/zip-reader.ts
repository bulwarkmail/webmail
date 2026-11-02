import { Inflate, inflateSync } from "fflate";

/**
 * Reads a ZIP through its central directory with `Blob.slice`, so a large
 * archive is never loaded whole: entries are read one at a time, and a large
 * entry (an mbox inside the archive) is inflated in chunks. Handles Zip64,
 * entries with data descriptors, stored and deflated entries.
 */

export interface ZipEntry {
  /** Path inside the archive, `/` separated. */
  name: string;
  directory: boolean;
  /** Encrypted (general purpose flag 0): can't be read. */
  encrypted: boolean;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX32 = 0xffffffff;

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

async function bytes(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

function u64(view: DataView, at: number): number {
  return view.getUint32(at, true) + view.getUint32(at + 4, true) * 0x1_0000_0000;
}

const utf8 = new TextDecoder("utf-8");
// IBM 437 isn't a WHATWG label; old archivers' non-UTF-8 names are rare in mail exports.
const legacy = new TextDecoder("windows-1252");

export async function listZipEntries(file: Blob): Promise<ZipEntry[]> {
  const tailStart = Math.max(0, file.size - (0xffff + 22));
  const tail = await bytes(file, tailStart, file.size);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipFormatError("No end of central directory");
  let count = tv.getUint16(eocd + 10, true);
  let cdSize = tv.getUint32(eocd + 12, true);
  let cdOffset = tv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === MAX32 || cdOffset === MAX32) {
    const locatorAt = eocd - 20;
    if (locatorAt >= 0 && tv.getUint32(locatorAt, true) === ZIP64_LOCATOR) {
      const zip64At = u64(tv, locatorAt + 8);
      const rec = await bytes(file, zip64At, zip64At + 56);
      const rv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
      if (rv.getUint32(0, true) !== ZIP64_EOCD) throw new ZipFormatError("Bad Zip64 end record");
      count = u64(rv, 32);
      cdSize = u64(rv, 40);
      cdOffset = u64(rv, 48);
    }
  }
  const cd = await bytes(file, cdOffset, cdOffset + cdSize);
  const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let n = 0; n < count && at + 46 <= cd.length; n++) {
    if (v.getUint32(at, true) !== CENTRAL) throw new ZipFormatError("Bad central directory entry");
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    let compressedSize = v.getUint32(at + 20, true);
    let size = v.getUint32(at + 24, true);
    const nameLength = v.getUint16(at + 28, true);
    const extraLength = v.getUint16(at + 30, true);
    const commentLength = v.getUint16(at + 32, true);
    let localOffset = v.getUint32(at + 42, true);
    const nameBytes = cd.subarray(at + 46, at + 46 + nameLength);
    const name = (flags & 0x0800 ? utf8 : legacy).decode(nameBytes).replace(/\\/g, "/");
    // Zip64 extra field: the values that were 0xFFFFFFFF, in this order.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = v.getUint16(extra, true);
      const len = v.getUint16(extra + 2, true);
      if (id === 0x0001) {
        let p = extra + 4;
        if (size === MAX32) { size = u64(v, p); p += 8; }
        if (compressedSize === MAX32) { compressedSize = u64(v, p); p += 8; }
        if (localOffset === MAX32) { localOffset = u64(v, p); p += 8; }
      }
      extra += 4 + len;
    }
    entries.push({ name, directory: name.endsWith("/"), encrypted: (flags & 0x0001) !== 0, method, compressedSize, size, localOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function dataStart(file: Blob, entry: ZipEntry): Promise<number> {
  const header = await bytes(file, entry.localOffset, entry.localOffset + 30);
  const v = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header.length < 30 || v.getUint32(0, true) !== LOCAL) throw new ZipFormatError("Bad local header");
  return entry.localOffset + 30 + v.getUint16(26, true) + v.getUint16(28, true);
}

function assertMethod(entry: ZipEntry): void {
  if (entry.encrypted) throw new ZipFormatError("Encrypted entry");
  if (entry.method !== 0 && entry.method !== 8) throw new ZipFormatError(`Unsupported compression ${entry.method}`);
}

/** The whole entry, for small entries (a message). */
export async function readZipEntry(file: Blob, entry: ZipEntry): Promise<Uint8Array> {
  assertMethod(entry);
  const start = await dataStart(file, entry);
  const raw = await bytes(file, start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  // No fixed output buffer: a wrong declared size must fail, not cut the message short.
  const data = inflateSync(raw);
  if (data.length !== entry.size) throw new ZipFormatError("Entry size doesn't match");
  return data;
}

/** The entry in chunks of about `chunkBytes`, inflated as they come (an mbox inside the archive). */
export async function* streamZipEntry(file: Blob, entry: ZipEntry, chunkBytes = 1 << 20): AsyncGenerator<Uint8Array> {
  assertMethod(entry);
  const start = await dataStart(file, entry);
  const end = start + entry.compressedSize;
  if (entry.method === 0) {
    for (let at = start; at < end; at += chunkBytes) yield await bytes(file, at, Math.min(end, at + chunkBytes));
    return;
  }
  let out: Uint8Array[] = [];
  const inflate = new Inflate((chunk) => { out.push(chunk); });
  for (let at = start; at < end; at += chunkBytes) {
    const next = Math.min(end, at + chunkBytes);
    inflate.push(await bytes(file, at, next), next >= end);
    const ready = out;
    out = [];
    for (const chunk of ready) yield chunk;
  }
  if (start === end) inflate.push(new Uint8Array(0), true);
  for (const chunk of out) yield chunk;
}
