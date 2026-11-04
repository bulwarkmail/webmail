/**
 * Utilities for handling drag-and-drop of files and folders.
 * Uses the File and Directory Entries API (webkitGetAsEntry) to
 * recursively read dropped directory trees, preserving relative paths.
 */

interface FileWithPath extends File {
  readonly webkitRelativePath: string;
}

/**
 * Read all File entries from a FileSystemDirectoryEntry recursively.
 * Each returned File has its webkitRelativePath set to the relative path
 * within the dropped folder (e.g. "folder/sub/file.txt").
 */
function readDirectoryEntries(dirEntry: FileSystemDirectoryEntry): Promise<FileWithPath[]> {
  return new Promise((resolve, reject) => {
    const reader = dirEntry.createReader();
    const allEntries: FileSystemEntry[] = [];

    // readEntries may return results in batches; keep reading until empty
    const readBatch = () => {
      reader.readEntries(
        (entries) => {
          if (entries.length === 0) {
            resolveFiles(allEntries).then(resolve, reject);
          } else {
            allEntries.push(...entries);
            readBatch();
          }
        },
        reject,
      );
    };
    readBatch();
  });
}

function resolveFiles(entries: FileSystemEntry[]): Promise<FileWithPath[]> {
  const promises = entries.map((entry) => {
    if (entry.isFile) {
      return new Promise<FileWithPath[]>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(
          (file) => {
            // Set webkitRelativePath directly on the original File object.
            // The property lives on File.prototype as a getter, so defining
            // an own data property on the instance safely shadows it.
            try {
              Object.defineProperty(file, 'webkitRelativePath', {
                value: entry.fullPath.replace(/^\//, ''),
                writable: false,
                configurable: true,
              });
            } catch {
              // Fallback: some environments may prevent overriding.
              // The store also falls back to file.name, which still works
              // for flat files (though nested paths would be lost).
            }
            resolve([file as unknown as FileWithPath]);
          },
          reject,
        );
      });
    } else if (entry.isDirectory) {
      return readDirectoryEntries(entry as FileSystemDirectoryEntry);
    }
    return Promise.resolve([]);
  });
  return Promise.all(promises).then((arrays) => arrays.flat());
}

/**
 * Result of processing a drop event's DataTransfer.
 */
export interface DropResult {
  files: File[];
  hasDirectories: boolean;
}

/**
 * Process a drop event's DataTransfer, detecting folders and recursively
 * reading their contents. Returns the list of files and whether any
 * directories were found.
 *
 * Falls back to e.dataTransfer.files when webkitGetAsEntry is unavailable.
 */
export async function getDroppedFilesAndFolders(dataTransfer: DataTransfer): Promise<DropResult> {
  const items = dataTransfer.items;

  // Check if the browser supports webkitGetAsEntry
  const entries: FileSystemEntry[] = [];
  if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
  }
  // Files a page made itself have no entries: they come through `files` below.
  if (entries.length > 0) {

    let hasDirectories = false;
    const filePromises: Promise<FileWithPath[]>[] = [];

    for (const entry of entries) {
      if (entry.isDirectory) {
        hasDirectories = true;
        filePromises.push(readDirectoryEntries(entry as FileSystemDirectoryEntry));
      } else if (entry.isFile) {
        filePromises.push(
          new Promise<FileWithPath[]>((resolve, reject) => {
            (entry as FileSystemFileEntry).file(
              (file) => resolve([file as FileWithPath]),
              reject,
            );
          }),
        );
      }
    }

    const allFiles = (await Promise.all(filePromises)).flat();
    return { files: allFiles, hasDirectories };
  }

  // Fallback: no entry API support
  return {
    files: Array.from(dataTransfer.files),
    hasDirectories: false,
  };
}
