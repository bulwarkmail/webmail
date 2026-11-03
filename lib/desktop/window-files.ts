/**
 * Files dropped on a window or pasted from the clipboard. Whatever already handles a
 * drop keeps doing so, which it shows by preventDefault: the composer, the file page,
 * calendar import. The rest becomes an attachment on a new draft, or on the composer
 * that's open.
 */

import { getDesktopBridge } from '@/lib/desktop/bridge';
import { handOffDraft } from '@/lib/launch-handoff';

type ComposerTarget = (files: File[]) => unknown;

let composerTarget: ComposerTarget | null = null;
/** Our own native drag passing over our own window isn't a new file. */
let ownDrag = false;

/** The open composer takes files itself. No effect outside the desktop app: only this file reads it. */
export function setComposerFileTarget(target: ComposerTarget): () => void {
  composerTarget = target;
  return () => {
    if (composerTarget === target) composerTarget = null;
  };
}

export function setOwnDragActive(active: boolean): void {
  ownDrag = active;
}

function take(files: File[]): void {
  if (composerTarget) composerTarget(files);
  else handOffDraft({ files });
}

function hasFiles(event: DragEvent): boolean {
  return !!event.dataTransfer && [...event.dataTransfer.types].includes('Files');
}

export function startWindowFiles(): () => void {
  if (!getDesktopBridge()?.os) return () => {};
  const onDragOver = (event: DragEvent) => {
    if (event.defaultPrevented || ownDrag || !hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (event: DragEvent) => {
    if (event.defaultPrevented || ownDrag || !hasFiles(event)) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) take(files);
  };
  const onPaste = (event: ClipboardEvent) => {
    if (event.defaultPrevented) return;
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    take(files);
  };
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('drop', onDrop);
  window.addEventListener('paste', onPaste);
  return () => {
    window.removeEventListener('dragover', onDragOver);
    window.removeEventListener('drop', onDrop);
    window.removeEventListener('paste', onPaste);
  };
}
