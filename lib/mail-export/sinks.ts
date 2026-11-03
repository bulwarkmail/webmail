import { hasWebLocks, holdLock } from "@/lib/mail-import/locks";
import { saveBlobAs } from "@/lib/download-guard";
import { useMailTransferStore } from "@/stores/mail-transfer-store";

/**
 * Where an export's bytes go, so a large mailbox never has to fit in memory:
 *
 * 1. File System Access (Chrome, Edge): the user picks the file first and the
 *    export writes straight into it.
 * 2. The origin private file system (Firefox, Safari): an encrypted spool, so
 *    no readable mail is ever in those files. Each 1 MB piece is sealed with
 *    AES-GCM under a key made for this export, which can't be exported and is
 *    only ever in this tab's memory: a crash leaves bytes nobody can read.
 *    When the export is done the pieces are opened into a Blob the browser
 *    holds (Firefox and Chromium keep a large one in their own temporary
 *    storage; WebKit holds it in memory, so there the export has a cap), the
 *    spool is deleted at once, and the Blob is downloaded. The
 *    Blob goes a while after the dialog closes, so the download can finish, or
 *    at once on sign-out or a wipe. A sweep deletes what a crash left when the
 *    app starts, someone signs in or the next export starts. Each spool is
 *    held under a Web Lock while its tab uses it, so the sweep of another tab
 *    leaves it alone.
 * 3. Memory, for small exports only, where neither exists.
 *
 * Writes are gathered into 1 MB pieces: a message arrives in many small parts.
 */

export interface ExportFile {
  name: string;
  size: number;
  /** Saves the file (again) where the browser keeps downloads; absent when the user picked the place. */
  download?: () => void;
  /** Frees what the export kept in this browser: after the download had time to finish, or `now`. */
  discard: (now?: boolean) => Promise<void>;
}

export interface ExportSink {
  kind: "picker" | "private" | "memory";
  write(chunk: Uint8Array): Promise<void>;
  /** Finishes the file. If `signal` fires, nothing is handed out and it rejects. */
  close(signal?: AbortSignal): Promise<ExportFile>;
  /** Throws away what was written. `leftover`: a file it couldn't remove from where the user put it. */
  abort(): Promise<{ leftover?: string } | void>;
}

export class ExportTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`The export is larger than this browser can keep in memory (${limit} bytes)`);
    this.name = "ExportTooLargeError";
  }
}

/** The device policy "No export" came on while the export ran. */
export class ExportForbiddenError extends Error {
  constructor() {
    super("The organisation doesn't allow exporting mail on this device");
    this.name = "ExportForbiddenError";
  }
}

/** The most a memory-only export may hold. */
export const MEMORY_EXPORT_LIMIT = 200 * 1024 * 1024;
/** The most a spool may hold where its final Blob sits in memory: see spoolLimit. */
export const SPOOL_MEMORY_LIMIT = 1024 * 1024 * 1024;
const PRIVATE_DIR = "bulwark-exports";
const LOCK_PREFIX = "bulwark-export-file:";
/** How long a closed export's Blob stays for its download: a minute, plus a second per 50 MB. */
export function downloadGraceMs(size: number): number {
  return 60_000 + Math.ceil(size / 50_000_000) * 1000;
}
const FLUSH_BYTES = 1 << 20;

interface WritableLike {
  write(data: BufferSource | Blob): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

/** Gathers small writes and passes them on in pieces of about 1 MB. */
function buffered(write: (chunk: Uint8Array) => Promise<void>) {
  let parts: Uint8Array[] = [];
  let size = 0;
  let total = 0;
  const flush = async () => {
    if (size === 0) return;
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    parts = [];
    size = 0;
    await write(out);
  };
  return {
    async write(chunk: Uint8Array) {
      if (chunk.length === 0) return;
      // The caller may reuse its buffer: keep a copy until it's written.
      parts.push(chunk.slice());
      size += chunk.length;
      total += chunk.length;
      if (size >= FLUSH_BYTES) await flush();
    },
    flush,
    get total() { return total; },
  };
}

/**
 * Hands the finished file to the browser, unless the device policy "No
 * export" of the account the export runs for is on (also when it was
 * switched on while the export ran).
 */
function triggerDownload(url: string, name: string): void {
  const scope = useMailTransferStore.getState().job?.scope;
  saveBlobAs(url, name, { kind: "export", subject: scope && scope !== "default" ? scope : null });
}

type SavePicker = (options: { suggestedName?: string; types?: { description?: string; accept: Record<string, string[]> }[] }) => Promise<{ name?: string; createWritable(): Promise<WritableLike>; remove?(): Promise<void> }>;

function stopped(): DOMException {
  return new DOMException("Export cancelled", "AbortError");
}

/**
 * An engine that keeps a large Blob in memory: every browser on iOS, and Safari.
 * Firefox and Chromium move a large one to their own temporary storage.
 */
export function blobHeldInMemory(): boolean {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent ?? "";
  return /AppleWebKit/.test(agent) && !/Chrome\/|Chromium\/|Edg\//.test(agent);
}

/**
 * How much a spool may hold before it stops. On an engine holding the Blob in memory
 * it fails early: a tab killed with no message after hours is what this is for.
 */
export function spoolLimit(): number {
  return blobHeldInMemory() ? SPOOL_MEMORY_LIMIT : Infinity;
}

/** What holds a finished export in this browser, until it's released. */
interface LiveFile {
  url: string;
  scope: string | null;
}

const liveFiles = new Set<LiveFile>();

/** The object URL is what keeps the Blob alive: once it's revoked nothing else here refers to it. */
function holdFile(blob: Blob): LiveFile {
  const scope = useMailTransferStore.getState().job?.scope;
  const file: LiveFile = { url: URL.createObjectURL(blob), scope: scope && scope !== "default" ? scope : null };
  liveFiles.add(file);
  return file;
}

function releaseFile(file: LiveFile): void {
  if (!liveFiles.delete(file)) return;
  URL.revokeObjectURL(file.url);
}

/**
 * Drops finished exports still held for their download, also after the dialog closed:
 * a sign-out or a wipe doesn't wait out the grace period. `all`: whoever's they are.
 */
export function dropExportFiles(account: string): void {
  for (const file of [...liveFiles]) {
    if (account === "all" || file.scope === null || file.scope === account) releaseFile(file);
  }
}

/** A file downloaded when done, for as long as the Blob is held. */
function downloadableFile(name: string, blob: Blob): ExportFile {
  const size = blob.size;
  const held = holdFile(blob);
  const download = () => {
    if (liveFiles.has(held)) triggerDownload(held.url, name);
  };
  download();
  return {
    name,
    size,
    download,
    discard: async (now = false) => {
      // Taking the Blob away from a download that is still reading it would break the download.
      if (!now) await new Promise((resolve) => setTimeout(resolve, downloadGraceMs(size)));
      releaseFile(held);
    },
  };
}

/** Whether this browser can write a private file from the page (Safari before 26 can't). */
export function canWritePrivateFile(): boolean {
  if (typeof navigator === "undefined" || typeof (navigator.storage as { getDirectory?: unknown } | undefined)?.getDirectory !== "function") return false;
  const handle = (globalThis as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle;
  return !!handle && "createWritable" in handle.prototype;
}

export function canPickSaveFile(): boolean {
  return typeof window !== "undefined" && typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";
}

/**
 * Asks where to save (call it straight from the click, before any await:
 * the browser only shows the picker for a user action). Rejects with an
 * AbortError when the user closes the picker.
 */
export async function pickSaveFile(name: string, mime: string, extension: string): Promise<ExportSink> {
  const picker = (window as unknown as { showSaveFilePicker: SavePicker }).showSaveFilePicker;
  const handle = await picker({ suggestedName: name, types: [{ accept: { [mime]: [extension] } }] });
  const writable = await handle.createWritable();
  const buf = buffered((chunk) => writable.write(chunk as BufferSource));
  return {
    kind: "picker",
    write: (chunk) => buf.write(chunk),
    close: async (signal) => {
      await buf.flush();
      if (signal?.aborted) throw stopped();
      await writable.close();
      return { name, size: buf.total, discard: async () => {} };
    },
    abort: async () => {
      await writable.abort().catch(() => {});
      // The picker made or emptied the file the moment it answered. Not every browser can remove it.
      // What the person called it in the picker, which needn't be what was suggested.
      const leftover = { leftover: handle.name ?? name };
      if (typeof handle.remove !== "function") return leftover;
      try {
        await handle.remove();
        return {};
      } catch {
        return leftover;
      }
    },
  };
}

async function privateDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    return root ? await root.getDirectoryHandle(PRIVATE_DIR, { create: true }) : null;
  } catch {
    return null;
  }
}

/** The IV of a piece: its number. A key seals one spool, so a number never repeats under it. */
function pieceIv(piece: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, piece);
  return iv;
}

/** Reads the pieces back in order, one at a time, opened. A piece that was changed fails the read. */
function openedPieces(file: Blob, sizes: readonly number[], key: CryptoKey, signal?: AbortSignal): ReadableStream<Uint8Array> {
  let piece = 0;
  let at = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted) throw stopped();
      if (piece === sizes.length) {
        controller.close();
        return;
      }
      const size = sizes[piece];
      const sealed = await file.slice(at, at + size).arrayBuffer();
      controller.enqueue(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: pieceIv(piece) }, key, sealed)));
      piece += 1;
      at += size;
    },
  });
}

/** An encrypted spool on disk, downloaded when done; null where the browser can't write one from the page. */
export async function privateFileSink(name: string, mime: string, limit = spoolLimit()): Promise<ExportSink | null> {
  const dir = await privateDir();
  if (!dir || !globalThis.crypto?.subtle) return null;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const entry = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Held until the file is gone, so no other tab's sweep deletes it meanwhile.
  const release = (await holdLock(`${LOCK_PREFIX}${entry}`)) ?? (() => {});
  let handle: FileSystemFileHandle;
  let writable: WritableLike;
  try {
    handle = await dir.getFileHandle(entry, { create: true });
    const create = (handle as unknown as { createWritable?: () => Promise<WritableLike> }).createWritable;
    if (typeof create !== "function") {
      await dir.removeEntry(entry).catch(() => {});
      release();
      return null;
    }
    writable = await create.call(handle);
  } catch {
    await dir.removeEntry(entry).catch(() => {});
    release();
    return null;
  }
  const sizes: number[] = [];
  const buf = buffered(async (chunk) => {
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: pieceIv(sizes.length) }, key, chunk as BufferSource));
    await writable.write(sealed);
    sizes.push(sealed.length);
  });
  const remove = async () => {
    await dir.removeEntry(entry).catch(() => {});
    release();
  };
  return {
    kind: "private",
    write: async (chunk) => {
      if (buf.total + chunk.length > limit) throw new ExportTooLargeError(limit);
      await buf.write(chunk);
    },
    close: async (signal) => {
      await buf.flush();
      await writable.close();
      // Through a Response so the browser may spill a large Blob to its own storage.
      const opened = await new Response(openedPieces(await handle.getFile(), sizes, key, signal)).blob();
      // A cancel, sign-out or wipe during that: the Blob is dropped here and nothing downloads.
      if (signal?.aborted) throw stopped();
      await remove();
      return downloadableFile(name, new Blob([opened], { type: mime }));
    },
    abort: async () => { await writable.abort().catch(() => {}); await remove(); },
  };
}

/**
 * The sink for an export: the file the user picks where the browser can ask (in
 * the desktop app that's the OS's Save dialog), else the encrypted spool, else
 * memory. Null when the user closed the picker. Call it straight from the click.
 */
export async function openExportSink(name: string, mime: string, extension: string): Promise<ExportSink | null> {
  if (canPickSaveFile()) {
    try {
      return await pickSaveFile(name, mime, extension);
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "AbortError") return null;
    }
  }
  await sweepPrivateExports();
  return (await privateFileSink(name, mime)) ?? memorySink(name, mime);
}

/** Everything in memory, then downloaded: only for small exports. */
export function memorySink(name: string, mime: string, limit = MEMORY_EXPORT_LIMIT): ExportSink {
  let parts: Uint8Array[] = [];
  let size = 0;
  return {
    kind: "memory",
    write: async (chunk) => {
      size += chunk.length;
      if (size > limit) throw new ExportTooLargeError(limit);
      parts.push(chunk.slice());
    },
    close: async (signal) => {
      if (signal?.aborted) {
        parts = [];
        throw stopped();
      }
      const blob = new Blob(parts as BlobPart[], { type: mime });
      parts = [];
      return downloadableFile(name, blob);
    },
    abort: async () => { parts = []; },
  };
}

/**
 * Stops an export the moment `allowed` says no, whichever sink it writes to: the
 * save picker writes straight to the user's file, past the guard in saveBlobAs.
 */
export function guardedSink(sink: ExportSink, allowed: () => boolean): ExportSink {
  const check = () => {
    if (!allowed()) throw new ExportForbiddenError();
  };
  return {
    kind: sink.kind,
    write: async (chunk) => {
      check();
      await sink.write(chunk);
    },
    close: async (signal) => {
      check();
      return sink.close(signal);
    },
    abort: () => sink.abort(),
  };
}

/**
 * Deletes private export files no tab uses any more (a closed tab, a crash).
 * They're encrypted under a key that died with the tab, but one from an older
 * version is plain, and they take up room. A file another tab holds is left alone; `force` deletes everything (everyone signed out).
 * Without Web Locks only `force` sweeps, since another tab can't be asked.
 */
export async function sweepPrivateExports({ force = false }: { force?: boolean } = {}): Promise<void> {
  if (force) dropExportFiles("all");
  if (!force && !hasWebLocks()) return;
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return;
    if (force) {
      await root.removeEntry(PRIVATE_DIR, { recursive: true }).catch(() => {});
      return;
    }
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await root.getDirectoryHandle(PRIVATE_DIR);
    } catch {
      return;
    }
    const names: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    for (const name of names) {
      const release = await holdLock(`${LOCK_PREFIX}${name}`);
      if (!release) continue;
      try {
        await dir.removeEntry(name).catch(() => {});
      } finally {
        release();
      }
    }
  } catch {
    /* nothing there */
  }
}
