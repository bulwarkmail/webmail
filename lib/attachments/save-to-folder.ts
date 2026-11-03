/**
 * "Save all attachments to a folder", with the File System Access API.
 *
 * These writes don't pass saveBlobAs (lib/download-guard.ts), the backstop of
 * the device policies, so the caller's `allowed` is asked before each file:
 * a policy that turns on while the files are written stops the rest.
 *
 * The folder handle is an interface, not the DOM type, so the desktop bridge
 * or a test can supply its own.
 */

export interface WritableFile {
  write(data: Blob | BufferSource): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface FolderFile {
  createWritable(): Promise<WritableFile>;
}

export interface FolderHandle {
  name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FolderFile>;
  removeEntry?(name: string): Promise<void>;
}

type DirectoryPicker = (options?: { mode?: 'read' | 'readwrite'; id?: string; startIn?: string }) => Promise<FolderHandle>;

/** Whether this browser can ask for a folder. Without it the zip download is all there is. */
export function canPickFolder(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/**
 * Asks where to save. Call it straight from the click, before any await: the
 * browser only shows the picker for a user action. Rejects with an AbortError
 * when the user closes the picker (see isPickerCancelled).
 */
export function pickFolder(): Promise<FolderHandle> {
  const picker = (window as unknown as { showDirectoryPicker: DirectoryPicker }).showDirectoryPicker;
  return picker.call(window, { mode: 'readwrite', id: 'bulwark-attachments', startIn: 'downloads' });
}

export function isPickerCancelled(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError';
}

/** The name's nth alternative: " (n)" before the extension, so duplicates stay recognisable. */
function numberedName(base: string, n: number): string {
  if (n === 0) return base;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  return `${stem} (${n})${ext}`;
}

/** Names unique within one batch, for the zip's entries. */
export function createUniqueNamer(fallback = 'attachment'): (raw: string) => string {
  const used = new Set<string>();
  return (raw) => {
    const base = raw || fallback;
    let n = 0;
    while (used.has(numberedName(base, n))) n++;
    const name = numberedName(base, n);
    used.add(name);
    return name;
  };
}

/** Names Windows keeps for devices, with any extension: NUL.txt is NUL. */
const RESERVED_STEM = /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
/** Names and extensions the shell acts on, which browsers refuse to create. */
const SHELL_NAMES = new Set(['desktop.ini', 'thumbs.db', 'autorun.inf']);
const SHELL_EXTENSIONS = new Set(['.lnk', '.url', '.scf', '.local', '.pif', '.shb', '.cpl', '.inf']);
/** A file system's limit is 255 bytes. Below it, leaving room for " (n)". */
const MAX_NAME_BYTES = 240;

function truncateName(name: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(name).length <= MAX_NAME_BYTES) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && encoder.encode(name.slice(dot)).length <= 32 ? name.slice(dot) : '';
  let room = MAX_NAME_BYTES - encoder.encode(ext).length;
  let stem = '';
  // By code point, so a character is never cut in half.
  for (const char of ext ? name.slice(0, dot) : name) {
    room -= encoder.encode(char).length;
    if (room < 0) break;
    stem += char;
  }
  return stem.trimEnd() + ext;
}

/**
 * A name the folder will take: no path parts a sender could smuggle in, no
 * characters a file system refuses, and nothing Windows or the shell treats as
 * special. Renamed, so the attachment is still saved.
 */
function safeFileName(raw: string, fallback: string): string {
  const leaf = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = leaf.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  const lower = cleaned.toLowerCase();
  const stem = lower.split('.')[0];
  const dot = lower.lastIndexOf('.');
  let safe = cleaned;
  if (RESERVED_STEM.test(stem) || SHELL_NAMES.has(lower)) safe = `_${cleaned}`;
  else if (dot > 0 && SHELL_EXTENSIONS.has(lower.slice(dot))) safe = `${cleaned}.txt`;
  return truncateName(safe);
}

/** The folder or the browser refused this name, which says nothing about the next file. */
function isNameRefused(error: unknown): boolean {
  const kind = (error as { name?: unknown } | null)?.name;
  return kind === 'TypeError' || kind === 'SecurityError';
}

async function existsInFolder(folder: FolderHandle, name: string): Promise<boolean> {
  try {
    await folder.getFileHandle(name);
    return true;
  } catch (error) {
    const kind = (error as { name?: unknown } | null)?.name;
    if (kind === 'NotFoundError') return false;
    // A sub-folder of that name: taken as well.
    if (kind === 'TypeMismatchError') return true;
    throw error;
  }
}

/** The first of the name's alternatives neither this batch nor the folder has. */
async function freeFileName(folder: FolderHandle, base: string, claimed: ReadonlySet<string>): Promise<string> {
  let n = 0;
  while (claimed.has(numberedName(base, n)) || await existsInFolder(folder, numberedName(base, n))) n++;
  return numberedName(base, n);
}

export interface FolderSaveItem {
  name: string;
  /** The file's content, or null when it has none to save. Fetched only when its turn comes. */
  read: () => Promise<Blob | BufferSource | null>;
}

export interface FolderSaveResult {
  folder: string;
  total: number;
  saved: number;
  /** Files that couldn't be read from the server, or whose name was refused; the rest still went. */
  skipped: number;
  /** Why the run ended early, when it did. */
  stopped: 'policy' | 'write' | null;
}

/**
 * Writes the files one at a time. A file that can't be fetched or whose name is
 * refused is skipped, like in the zip. A write that fails stops the run, because
 * the next one would fail the same way (disk full, permission gone), and the
 * result says how many made it. A file already in the folder is never overwritten.
 */
export async function saveFilesToFolder(
  folder: FolderHandle,
  items: readonly FolderSaveItem[],
  allowed: () => boolean,
): Promise<FolderSaveResult> {
  const result: FolderSaveResult = { folder: folder.name, total: items.length, saved: 0, skipped: 0, stopped: null };
  const claimed = new Set<string>();

  for (const item of items) {
    if (!allowed()) {
      result.stopped = 'policy';
      return result;
    }

    let data: Blob | BufferSource | null;
    try {
      data = await item.read();
    } catch {
      data = null;
    }
    if (data === null) {
      result.skipped += 1;
      continue;
    }
    // The policy may have changed during the fetch, and nothing is on disk yet.
    if (!allowed()) {
      result.stopped = 'policy';
      return result;
    }

    let name: string | null = null;
    let writable: WritableFile | null = null;
    try {
      name = await freeFileName(folder, safeFileName(item.name, 'attachment'), claimed);
      claimed.add(name);
      const file = await folder.getFileHandle(name, { create: true });
      writable = await file.createWritable();
      await writable.write(data);
      await writable.close();
      result.saved += 1;
    } catch (error) {
      await writable?.abort?.().catch(() => {});
      // getFileHandle created an empty file; don't leave it looking saved.
      if (name) await folder.removeEntry?.(name).catch(() => {});
      if (isNameRefused(error)) {
        result.skipped += 1;
        continue;
      }
      result.stopped = 'write';
      return result;
    }
  }
  return result;
}
