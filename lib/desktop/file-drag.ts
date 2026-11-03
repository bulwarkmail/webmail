/**
 * Mail as real files from the page's side: a native drag or a copy to the clipboard.
 * Later agents' calls for the taskbar's progress bar live here too.
 */

import { getDesktopBridge } from '@/lib/desktop/bridge';
import { setOwnDragActive } from '@/lib/desktop/window-files';

export interface DragFile {
  name: string;
  /** A blob: URL the page already holds. */
  url?: string;
  data?: Uint8Array;
}

export function canDragNativeFiles(): boolean {
  return !!getDesktopBridge()?.os?.startDrag;
}

async function toBytes(file: DragFile): Promise<{ name: string; data: Uint8Array }> {
  if (file.data) return { name: file.name, data: file.data };
  if (!file.url) throw new Error('A file needs its bytes or a URL');
  const response = await fetch(file.url);
  return { name: file.name, data: new Uint8Array(await response.arrayBuffer()) };
}

/**
 * Hands the file to main, which writes it to its private folder and starts the OS's
 * drag. The mouse is still down, so this has to come straight from `dragstart`.
 */
export async function startNativeFileDrag(files: readonly DragFile[]): Promise<boolean> {
  const os = getDesktopBridge()?.os;
  if (!os?.startDrag) return false;
  setOwnDragActive(true);
  try {
    return await os.startDrag(await Promise.all(files.map(toBytes)));
  } finally {
    setOwnDragActive(false);
  }
}

/** Copy attachments as files, for pasting into Explorer or Finder. */
export async function copyFilesToClipboard(files: readonly DragFile[]): Promise<boolean> {
  const os = getDesktopBridge()?.os;
  if (!os?.copyFiles) return false;
  return os.copyFiles(await Promise.all(files.map(toBytes)));
}

/**
 * The taskbar's progress bar, for an import, an export or a big send. 0 to 1, or null
 * to take it away. Does nothing in a browser.
 */
export function setTaskbarProgress(progress: number | null, mode?: 'normal' | 'indeterminate' | 'paused' | 'error'): void {
  getDesktopBridge()?.os?.setProgress(progress, mode);
}
