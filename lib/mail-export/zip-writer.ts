import { Deflate, deflateSync } from "fflate";
import { crc32 } from "./crc32";

/**
 * A streaming ZIP writer: each entry goes to the sink as soon as it is added,
 * so an export never holds the archive in memory. Zip64 records are written
 * when the archive passes 4 GB or 65,535 entries (fflate's Zip writes none).
 *
 * - addFile: a whole file in memory (one message); deflated when that saves space.
 * - openStream: a file written piece by piece (a folder's mbox), deflated,
 *   with its CRC and sizes in a data descriptor after the data. Its size
 *   isn't known up front, so its local header always carries a Zip64 extra
 *   field and the descriptor always has 64-bit sizes: readers that go
 *   through the archive in order (Java's ZipInputStream, macOS Archive
 *   Utility) learn the descriptor's size from the local header.
 */

export interface ZipWriterOptions {
  /** Deflate streamed entries (default). Off only for tests that push gigabytes through. */
  compressStreams?: boolean;
  /** The CRC-32 function; a test that only counts bytes can pass a cheap one. */
  checksum?: (data: Uint8Array, crc: number) => number;
}

export type ZipSink = (chunk: Uint8Array) => Promise<void>;

interface CentralEntry {
  name: Uint8Array;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  directory: boolean;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** General purpose flag 11: the name is UTF-8. */
const FLAG_UTF8 = 0x0800;
/** General purpose flag 3: CRC and sizes follow the data. */
const FLAG_DESCRIPTOR = 0x0008;

function dosDateTime(date: Date): { time: number; date: number } {
  const d = Number.isNaN(date.getTime()) || date.getFullYear() < 1980 ? new Date(1980, 0, 1) : date;
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.min(d.getFullYear(), 2107) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function u64(view: DataView, at: number, value: number): void {
  view.setUint32(at, value % 0x1_0000_0000, true);
  view.setUint32(at + 4, Math.floor(value / 0x1_0000_0000), true);
}

const encoder = new TextEncoder();

export interface ZipEntryStream {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export class ZipWriter {
  private offset = 0;
  private readonly entries: CentralEntry[] = [];
  private streaming = false;

  constructor(private readonly sink: ZipSink, private readonly options: ZipWriterOptions = {}) {}

  /** Bytes written so far. */
  get bytesWritten(): number {
    return this.offset;
  }

  private async emit(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return;
    this.offset += bytes.length;
    await this.sink(bytes);
  }

  /** `zip64`: a streamed entry of unknown size, with a Zip64 extra field of zeros. */
  private localHeader(entry: Omit<CentralEntry, "offset" | "directory">, zip64: boolean): Uint8Array {
    const extra = zip64 ? 20 : 0;
    const header = new Uint8Array(30 + entry.name.length + extra);
    const v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, zip64 ? 45 : 20, true);
    v.setUint16(6, entry.flags, true);
    v.setUint16(8, entry.method, true);
    v.setUint16(10, entry.time, true);
    v.setUint16(12, entry.date, true);
    v.setUint32(14, entry.crc, true);
    v.setUint32(18, zip64 ? MAX32 : entry.compressedSize, true);
    v.setUint32(22, zip64 ? MAX32 : entry.size, true);
    v.setUint16(26, entry.name.length, true);
    v.setUint16(28, extra, true);
    header.set(entry.name, 30);
    if (zip64) {
      // Zip64 extra field: original and compressed size, both 0 (they follow in the descriptor).
      v.setUint16(30 + entry.name.length, 0x0001, true);
      v.setUint16(32 + entry.name.length, 16, true);
    }
    return header;
  }

  private assertIdle(): void {
    if (this.streaming) throw new Error("ZipWriter: close the open entry first");
  }

  /** An empty folder, so the tree survives without files in it. */
  async addDirectory(path: string, mtime = new Date()): Promise<void> {
    this.assertIdle();
    const name = encoder.encode(path.endsWith("/") ? path : `${path}/`);
    const { time, date } = dosDateTime(mtime);
    const entry = { name, flags: FLAG_UTF8, method: 0, time, date, crc: 0, compressedSize: 0, size: 0 };
    const offset = this.offset;
    await this.emit(this.localHeader(entry, false));
    this.entries.push({ ...entry, offset, directory: true });
  }

  async addFile(path: string, data: Uint8Array, mtime = new Date()): Promise<void> {
    this.assertIdle();
    const name = encoder.encode(path);
    const { time, date } = dosDateTime(mtime);
    const crc = crc32(data);
    const deflated = data.length > 64 ? deflateSync(data, { level: 1 }) : null;
    const useDeflate = !!deflated && deflated.length < data.length;
    const body = useDeflate ? deflated! : data;
    const entry = { name, flags: FLAG_UTF8, method: useDeflate ? 8 : 0, time, date, crc, compressedSize: body.length, size: data.length };
    const offset = this.offset;
    await this.emit(this.localHeader(entry, false));
    await this.emit(body);
    this.entries.push({ ...entry, offset, directory: false });
  }

  async openStream(path: string, mtime = new Date()): Promise<ZipEntryStream> {
    this.assertIdle();
    this.streaming = true;
    const name = encoder.encode(path);
    const { time, date } = dosDateTime(mtime);
    const flags = FLAG_UTF8 | FLAG_DESCRIPTOR;
    const compress = this.options.compressStreams !== false;
    const method = compress ? 8 : 0;
    const checksum = this.options.checksum ?? crc32;
    const offset = this.offset;
    await this.emit(this.localHeader({ name, flags, method, time, date, crc: 0, compressedSize: 0, size: 0 }, true));

    let crc = 0;
    let size = 0;
    let compressedSize = 0;
    let pending: Uint8Array[] = [];
    const deflate = new Deflate({ level: 1 });
    deflate.ondata = (chunk) => {
      pending.push(chunk);
      compressedSize += chunk.length;
    };
    const drain = async () => {
      const out = pending;
      pending = [];
      for (const chunk of out) await this.emit(chunk);
    };

    return {
      write: async (chunk: Uint8Array) => {
        if (chunk.length === 0) return;
        crc = checksum(chunk, crc);
        size += chunk.length;
        if (compress) {
          deflate.push(chunk, false);
          await drain();
        } else {
          compressedSize += chunk.length;
          await this.emit(chunk);
        }
      },
      close: async () => {
        if (compress) {
          deflate.push(new Uint8Array(0), true);
          await drain();
        }
        // Always 64-bit sizes: the local header announced Zip64.
        const descriptor = new Uint8Array(24);
        const v = new DataView(descriptor.buffer);
        v.setUint32(0, 0x08074b50, true);
        v.setUint32(4, crc, true);
        u64(v, 8, compressedSize);
        u64(v, 16, size);
        await this.emit(descriptor);
        this.entries.push({ name, flags, method, time, date, crc, compressedSize, size, offset, directory: false });
        this.streaming = false;
      },
    };
  }

  /** Writes the central directory. Nothing may be added afterwards. */
  async finish(): Promise<void> {
    this.assertIdle();
    const cdStart = this.offset;
    for (const e of this.entries) {
      const needSize = e.size >= MAX32;
      const needCompressed = e.compressedSize >= MAX32;
      const needOffset = e.offset >= MAX32;
      const extraLength = needSize || needCompressed || needOffset
        ? 4 + 8 * (Number(needSize) + Number(needCompressed) + Number(needOffset))
        : 0;
      const record = new Uint8Array(46 + e.name.length + extraLength);
      const v = new DataView(record.buffer);
      const zip64 = extraLength > 0;
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, zip64 ? 45 : 20, true);
      v.setUint16(6, zip64 ? 45 : 20, true);
      v.setUint16(8, e.flags, true);
      v.setUint16(10, e.method, true);
      v.setUint16(12, e.time, true);
      v.setUint16(14, e.date, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, needCompressed ? MAX32 : e.compressedSize, true);
      v.setUint32(24, needSize ? MAX32 : e.size, true);
      v.setUint16(28, e.name.length, true);
      v.setUint16(30, extraLength, true);
      v.setUint16(32, 0, true);
      v.setUint16(34, 0, true);
      v.setUint16(36, 0, true);
      v.setUint32(38, e.directory ? 0x10 : 0, true);
      v.setUint32(42, needOffset ? MAX32 : e.offset, true);
      record.set(e.name, 46);
      if (zip64) {
        let at = 46 + e.name.length;
        v.setUint16(at, 0x0001, true);
        v.setUint16(at + 2, extraLength - 4, true);
        at += 4;
        if (needSize) { u64(v, at, e.size); at += 8; }
        if (needCompressed) { u64(v, at, e.compressedSize); at += 8; }
        if (needOffset) { u64(v, at, e.offset); at += 8; }
      }
      await this.emit(record);
    }
    const cdSize = this.offset - cdStart;
    const count = this.entries.length;
    const zip64 = count >= MAX16 || cdStart >= MAX32 || cdSize >= MAX32;
    if (zip64) {
      const zip64End = this.offset;
      const record = new Uint8Array(56 + 20);
      const v = new DataView(record.buffer);
      v.setUint32(0, 0x06064b50, true);
      u64(v, 4, 44);
      v.setUint16(12, 45, true);
      v.setUint16(14, 45, true);
      v.setUint32(16, 0, true);
      v.setUint32(20, 0, true);
      u64(v, 24, count);
      u64(v, 32, count);
      u64(v, 40, cdSize);
      u64(v, 48, cdStart);
      v.setUint32(56, 0x07064b50, true);
      v.setUint32(60, 0, true);
      u64(v, 64, zip64End);
      v.setUint32(72, 1, true);
      await this.emit(record);
    }
    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, Math.min(count, MAX16), true);
    v.setUint16(10, Math.min(count, MAX16), true);
    v.setUint32(12, Math.min(cdSize, MAX32), true);
    v.setUint32(16, Math.min(cdStart, MAX32), true);
    await this.emit(end);
  }
}
