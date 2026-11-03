/**
 * Mail as real files from the page's side: a native drag or a copy to the clipboard.
 * Later agents' calls for the taskbar's progress bar live here too.
 */

import { getDesktopBridge } from '@/lib/desktop/bridge';
import { setOwnDragActive } from '@/lib/desktop/window-files';

/** The page's CSP keeps fetch off blob: URLs, so a file travels as its Blob. */
export interface DragFile {
  name: string;
  blob: Blob;
}

const keptBlobs = new Map<string, Blob>();

/** In the app, remembers what's behind an object URL made for dragging. */
export function keepDragBlob(url: string, blob: Blob): string {
  if (canDragNativeFiles()) keptBlobs.set(url, blob);
  return url;
}

export function keptDragBlob(url: string): Blob | undefined {
  return keptBlobs.get(url);
}

export function forgetDragBlob(url: string): void {
  keptBlobs.delete(url);
}

export function canDragNativeFiles(): boolean {
  return !!getDesktopBridge()?.os?.startDrag;
}

async function toBytes(file: DragFile): Promise<{ name: string; data: Uint8Array }> {
  return { name: file.name, data: new Uint8Array(await file.blob.arrayBuffer()) };
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
