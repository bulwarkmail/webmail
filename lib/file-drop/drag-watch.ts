/**
 * Notices files dragged into the window from outside, and only those. A drag that started
 * in this page (a message to a folder, an attachment to the composer, a tab) fires
 * `dragstart` here first, and the app's own native drag of an attachment says so through
 * setOwnDragActive. Neither shows the overlay.
 *
 * Listens in the capture phase, so a component's own drop zone doesn't hide the drag from
 * it. Once the overlay is up it's on top of everything and takes the drag's events itself.
 * A file dropped anywhere else does nothing: the browser's own default would leave the app
 * to show the file.
 */

import { isOwnDragActive } from '@/lib/desktop/window-files';
import { kindForType, type DropFiles } from './zones';

/** Chromium sends dragover every 50 ms and Firefox about every 350 ms while the pointer is still. */
export const DRAG_STALE_MS = 1000;

export interface DragWatchHandlers {
  /** Files came in from outside. Return false to leave the drag alone (locked, a dialog open). */
  enter: (files: DropFiles) => boolean;
  /** Out of the window, Esc, a drop, or no word for a while. */
  leave: () => void;
}

export function draggedFiles(transfer: DataTransfer | null | undefined): DropFiles | null {
  if (!transfer || !Array.from(transfer.types ?? []).includes('Files')) return null;
  const items = Array.from(transfer.items ?? []).filter((item) => item.kind === 'file');
  if (items.length === 0) return { count: null, kinds: null, bytes: null };
  return { count: items.length, kinds: items.map((item) => kindForType(item.type)), bytes: null };
}

export function startDragWatch(handlers: DragWatchHandlers): () => void {
  let internal = false;
  let active = false;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = null;
    if (!active) return;
    active = false;
    handlers.leave();
  };
  const keepAlive = () => {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(stop, DRAG_STALE_MS);
  };

  const fromOutside = (event: DragEvent) => !internal && !isOwnDragActive() && draggedFiles(event.dataTransfer) !== null;

  const onDragStart = () => {
    internal = true;
  };
  // dragend goes to the source, which may have left the page by then (a message that moved).
  // No pointer events reach a page during a drag, so the first one after says it's over.
  const onDragEnd = () => {
    internal = false;
  };
  const onPointer = () => {
    internal = false;
  };

  const onDragEnter = (event: DragEvent) => {
    if (!fromOutside(event)) return;
    event.preventDefault();
    if (active) {
      keepAlive();
      return;
    }
    if (handlers.enter(draggedFiles(event.dataTransfer)!)) {
      active = true;
      // The component under the pointer would start its own highlight for a moment.
      event.stopPropagation();
      keepAlive();
    }
  };
  const onDragOver = (event: DragEvent) => {
    if (!fromOutside(event)) return;
    // Without this a drop anywhere opens the file in place of the app.
    event.preventDefault();
    if (active) keepAlive();
  };
  const onDragLeave = (event: DragEvent) => {
    // Leaving the window, or the drag cancelled with Esc: no element is next.
    if (active && event.relatedTarget === null) stop();
  };
  const onDrop = (event: DragEvent) => {
    internal = false;
    if (draggedFiles(event.dataTransfer) === null) return;
    // The overlay's zones handle their own drop before this runs (bubble, after capture),
    // so here it only stops the browser's default and ends the overlay.
    event.preventDefault();
    queueMicrotask(stop);
  };

  window.addEventListener('dragstart', onDragStart, true);
  window.addEventListener('dragend', onDragEnd, true);
  window.addEventListener('pointermove', onPointer, true);
  window.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('dragenter', onDragEnter, true);
  window.addEventListener('dragover', onDragOver, true);
  window.addEventListener('dragleave', onDragLeave, true);
  window.addEventListener('drop', onDrop);
  return () => {
    stop();
    window.removeEventListener('dragstart', onDragStart, true);
    window.removeEventListener('dragend', onDragEnd, true);
    window.removeEventListener('pointermove', onPointer, true);
    window.removeEventListener('pointerdown', onPointer, true);
    window.removeEventListener('dragenter', onDragEnter, true);
    window.removeEventListener('dragover', onDragOver, true);
    window.removeEventListener('dragleave', onDragLeave, true);
    window.removeEventListener('drop', onDrop);
  };
}
