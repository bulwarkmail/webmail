import { hasWebLocks, holdLock } from "@/lib/mail-import/locks";
import { saveBlobAs } from "@/lib/download-guard";
import { useMailTransferStore } from "@/stores/mail-transfer-store";

/**
 * Where an export's bytes go, so a large mailbox never has to fit in memory:
 *
 * 1. File System Access (Chrome, Edge): the user picks the file first and the
 *    export writes straight into it.
 * 2. The origin private file system (Firefox, Safari): written to a private
 *    file on disk, then downloaded. The file is deleted a while after the
 *    dialog closes (so the download can finish), at once on sign-out, and by
 *    a sweep when the app starts, someone signs in or the next export starts.
 *    Each file is held under a Web Lock while its tab uses it, so the sweep
 *    of another tab leaves it alone.
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
  close(): Promise<ExportFile>;
  abort(): Promise<void>;
}

export class ExportTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`The export is larger than this browser can keep in memory (${limit} bytes)`);
    this.name = "ExportTooLargeError";
  }
}

/** The most a memory-only export may hold. */
export const MEMORY_EXPORT_LIMIT = 200 * 1024 * 1024;
const PRIVATE_DIR = "bulwark-exports";
const LOCK_PREFIX = "bulwark-export-file:";
/** How long a closed export's private file stays for its download: a minute, plus a second per 50 MB. */
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

type SavePicker = (options: { suggestedName?: string; types?: { description?: string; accept: Record<string, string[]> }[] }) => Promise<{ createWritable(): Promise<WritableLike> }>;

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
    close: async () => {
      await buf.flush();
      await writable.close();
      return { name, size: buf.total, discard: async () => {} };
    },
    abort: async () => { await writable.abort().catch(() => {}); },
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

/** A private file on disk, downloaded when done; null where the browser can't write one from the page. */
export async function privateFileSink(name: string, mime: string): Promise<ExportSink | null> {
  const dir = await privateDir();
  if (!dir) return null;
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
  const buf = buffered((chunk) => writable.write(chunk as BufferSource));
  const remove = async () => {
    await dir.removeEntry(entry).catch(() => {});
    release();
  };
  return {
    kind: "private",
    write: (chunk) => buf.write(chunk),
    close: async () => {
      await buf.flush();
      await writable.close();
      const file = await handle.getFile();
      const url = URL.createObjectURL(new Blob([file], { type: mime }));
      triggerDownload(url, name);
      return {
        name,
        size: file.size,
        download: () => triggerDownload(url, name),
        discard: async (now = false) => {
          // Deleting the file under a download that is still reading it would break the download.
          if (!now) await new Promise((resolve) => setTimeout(resolve, downloadGraceMs(file.size)));
          URL.revokeObjectURL(url);
          await remove();
        },
      };
    },
    abort: async () => { await writable.abort().catch(() => {}); await remove(); },
  };
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
    close: async () => {
      const blob = new Blob(parts as BlobPart[], { type: mime });
      parts = [];
      const url = URL.createObjectURL(blob);
      triggerDownload(url, name);
      return {
        name,
        size: blob.size,
        download: () => triggerDownload(url, name),
        discard: async (now = false) => {
          if (!now) await new Promise((resolve) => setTimeout(resolve, downloadGraceMs(blob.size)));
          URL.revokeObjectURL(url);
        },
      };
    },
    abort: async () => { parts = []; },
  };
}

/**
 * Deletes private export files no tab uses any more (a closed tab, a crash),
 * so no copy of the mail stays in the browser profile. A file another tab
 * holds is left alone; `force` deletes everything (everyone signed out).
 * Without Web Locks only `force` sweeps, since another tab can't be asked.
 */
export async function sweepPrivateExports({ force = false }: { force?: boolean } = {}): Promise<void> {
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
