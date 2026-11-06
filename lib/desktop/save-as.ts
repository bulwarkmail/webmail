/**
 * Saving messages as files in the desktop app: the OS's own Save dialog for one message,
 * a folder for several, starting where the last save went (the shell's os-save-open.ts).
 * The shell asks where first, on the click, and the bytes follow one file at a time, so
 * the dialog doesn't wait for the downloads. A browser has no bridge: callers download.
 */

import { getDesktopBridge } from './bridge';

export interface SaveAsFile {
  /** The name the dialog suggests. The shell makes it safe and ends it in .eml. */
  name: string;
  /** The file's bytes, fetched once the user has said where. */
  load: () => Promise<Blob | ArrayBuffer | Uint8Array>;
}

export type SaveAsOutcome =
  | { status: 'saved'; saved: number; failed: number }
  | { status: 'cancelled' }
  | { status: 'refused'; reason: 'gesture' | 'policy' | 'locked' | 'invalid' };

/** The desktop app can save through its own dialogs. */
export function nativeSaveAvailable(): boolean {
  return !!getDesktopBridge()?.saveAs;
}

async function bytesOf(data: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  // isView and the tag work across realms, where instanceof doesn't.
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') return new Uint8Array(data as ArrayBuffer);
  return new Uint8Array(await (data as Blob).arrayBuffer());
}

/**
 * Saves the messages through the shell. Null without a shell that can: the caller downloads.
 * A file that can't be fetched counts as failed; the others are saved all the same.
 */
export async function saveMessagesNatively(files: SaveAsFile[]): Promise<SaveAsOutcome | null> {
  const bridge = getDesktopBridge()?.saveAs;
  if (!bridge || files.length === 0) return null;
  const begun = await bridge.begin({ kind: 'message', names: files.map((file) => file.name) });
  if ('cancelled' in begun) return { status: 'cancelled' };
  if ('refused' in begun) return { status: 'refused', reason: begun.refused };
  for (const [index, file] of files.entries()) {
    try {
      await bridge.write(begun.id, index, await bytesOf(await file.load()));
    } catch {
      // Not written: the shell counts it as failed.
    }
  }
  const { saved, failed } = await bridge.end(begun.id);
  return { status: 'saved', saved, failed };
}
