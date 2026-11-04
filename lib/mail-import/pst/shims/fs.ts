/**
 * `fs` for pst-extractor inside the PST worker: random access into a File
 * without loading it whole. pst-extractor only calls openSync, readSync and
 * closeSync. Reads go through FileReaderSync (workers only) in 64 KB pages
 * with a small cache, since the library reads a few bytes at a time. A file
 * the desktop app reads from disk has no Blob: there the pages come through a
 * synchronous XHR with a Range header, which a worker may still do.
 *
 * Register the file first: `registerPstFile(name, file)`.
 */

declare const FileReaderSync: { new (): { readAsArrayBuffer(blob: Blob): ArrayBuffer } };

const PAGE = 64 * 1024;
const MAX_PAGES = 128; // 8 MB

/** Where the pages come from. */
export interface PstBacking {
  size: number;
  read(start: number, end: number): Uint8Array;
}

const files = new Map<string, PstBacking>();
const open = new Map<number, { file: PstBacking; pages: Map<number, Uint8Array> }>();
let nextFd = 3;

function blobBacking(blob: Blob): PstBacking {
  return {
    size: blob.size,
    read: (start, end) => new Uint8Array(new FileReaderSync().readAsArrayBuffer(blob.slice(start, end))),
  };
}

/** A file behind a URL that answers Range requests. */
export function rangeBacking(url: string, size: number): PstBacking {
  return {
    size,
    read(start, end) {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, false);
      xhr.responseType = "arraybuffer";
      xhr.setRequestHeader("Range", `bytes=${start}-${end - 1}`);
      xhr.send();
      const bytes = xhr.status === 206 ? new Uint8Array(xhr.response as ArrayBuffer) : null;
      // A short answer would be read as data further on, so it counts as a failure here.
      if (!bytes || bytes.length !== end - start) throw new Error(`read failed: ${xhr.status}`);
      return bytes;
    },
  };
}

export function registerPstFile(name: string, file: Blob | PstBacking): void {
  files.set(name, "read" in file ? file : blobBacking(file));
}

export function openSync(name: string): number {
  const file = files.get(name);
  if (!file) throw new Error(`no such file: ${name}`);
  const fd = nextFd++;
  open.set(fd, { file, pages: new Map() });
  return fd;
}

function page(entry: { file: PstBacking; pages: Map<number, Uint8Array> }, index: number): Uint8Array {
  let bytes = entry.pages.get(index);
  if (bytes) {
    // Most recently used goes last.
    entry.pages.delete(index);
    entry.pages.set(index, bytes);
    return bytes;
  }
  const start = index * PAGE;
  bytes = entry.file.read(start, Math.min(entry.file.size, start + PAGE));
  entry.pages.set(index, bytes);
  if (entry.pages.size > MAX_PAGES) entry.pages.delete(entry.pages.keys().next().value as number);
  return bytes;
}

export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
  const entry = open.get(fd);
  if (!entry) throw new Error("bad file descriptor");
  const end = Math.min(entry.file.size, position + length);
  let at = position;
  while (at < end) {
    const index = Math.floor(at / PAGE);
    const bytes = page(entry, index);
    const from = at - index * PAGE;
    const take = Math.min(bytes.length - from, end - at);
    if (take <= 0) break;
    buffer.set(bytes.subarray(from, from + take), offset + (at - position));
    at += take;
  }
  return at - position;
}

export function closeSync(fd: number): void {
  open.delete(fd);
}

export default { openSync, readSync, closeSync };
