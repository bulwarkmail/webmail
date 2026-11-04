/**
 * The Files screen's end of the file drop overlay. While it's open on a folder that takes
 * uploads it says so here, and the overlay offers "Upload to <folder>". From anywhere else
 * the files wait here while the app goes to Files, which takes them once it has listed a
 * folder they can go in.
 */

export interface FilesUpload {
  files: File[];
  /** A dropped folder: the files carry their paths, and the upload keeps them. */
  asFolder: boolean;
}

interface FilesTarget {
  /** The folder in view, as the user sees its name. Null at the top of Files. */
  folder: string | null;
  take: (upload: FilesUpload) => unknown;
  /** The Pro shell keeps Files mounted on a tab out of sight. */
  visible: () => boolean;
}

let target: FilesTarget | null = null;
let waiting: FilesUpload | null = null;
const listeners = new Set<() => void>();

export function setFilesDropTarget(next: FilesTarget | null): () => void {
  target = next;
  return () => {
    if (target === next) target = null;
  };
}

/** The Files screen on view, if it can take files where it is. */
export function filesDropTarget(): FilesTarget | null {
  return target?.visible() ? target : null;
}

/** Files for the Files screen to upload when it's ready. A newer drop replaces an older one nobody took. */
export function queueFilesUpload(upload: FilesUpload): void {
  waiting = upload;
  for (const listener of listeners) listener();
}

export function takeQueuedFilesUpload(): FilesUpload | null {
  const upload = waiting;
  waiting = null;
  return upload;
}

export function hasQueuedFilesUpload(): boolean {
  return waiting !== null;
}

export function subscribeQueuedFilesUpload(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
