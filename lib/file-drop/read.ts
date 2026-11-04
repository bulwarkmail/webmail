/**
 * The files of a drop, read while the drop event lasts. A dropped folder only shows up
 * through the entry API, and only Files can take one: its upload keeps the folder's
 * layout. Everywhere else a folder is left out.
 */

import { getDroppedFilesAndFolders } from '@/lib/webdav/drop-utils';

export interface DroppedFiles {
  /** Files at the top of the drop, no folders. */
  plain: File[];
  /** Everything, folders walked, with their paths: for Files. */
  all: File[];
  folders: boolean;
}

/** Call from the drop handler itself: the browser empties the transfer once it returns. */
export function readDroppedFiles(transfer: DataTransfer): Promise<DroppedFiles> {
  const items = Array.from(transfer.items ?? []);
  const entries = items.map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null));
  const plainNow = items.flatMap((item, index) => {
    if (item.kind !== 'file' || entries[index]?.isDirectory) return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
  const plain = items.length > 0 ? plainNow : Array.from(transfer.files ?? []);
  const folders = entries.some((entry) => entry?.isDirectory);
  if (!folders) return Promise.resolve({ plain, all: plain, folders: false });
  return getDroppedFilesAndFolders(transfer).then(({ files }) => ({ plain, all: files, folders: true }));
}
