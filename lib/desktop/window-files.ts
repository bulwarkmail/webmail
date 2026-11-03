/**
 * Files dropped on a window or pasted from the clipboard. Whatever already handles a
 * drop keeps doing so, which it shows by preventDefault: the composer, the file page,
 * calendar import. The rest becomes an attachment on a new draft, or on the composer
 * that's open.
 */

import { getDesktopBridge } from '@/lib/desktop/bridge';
import { handOffDraft } from '@/lib/launch-handoff';

interface ComposerTarget {
  take: (files: File[]) => unknown;
  /** The Pro shell keeps composers mounted on tabs out of sight. */
  visible: () => boolean;
}

const composerTargets: ComposerTarget[] = [];
/** Our own native drag passing over our own window isn't a new file. */
let ownDrag = false;

/** A composer on screen takes files itself. No effect outside the desktop app: only this file reads it. */
export function setComposerFileTarget(take: ComposerTarget['take'], visible: ComposerTarget['visible']): () => void {
  const target = { take, visible };
  composerTargets.push(target);
  return () => {
    const at = composerTargets.indexOf(target);
    if (at !== -1) composerTargets.splice(at, 1);
  };
}

function visibleComposer(): ComposerTarget | undefined {
  return [...composerTargets].reverse().find((target) => target.visible());
}

export function setOwnDragActive(active: boolean): void {
  ownDrag = active;
}

function take(files: File[]): void {
  const composer = visibleComposer();
  if (composer) composer.take(files);
  else handOffDraft({ files });
}

function isEditable(target: EventTarget | null): boolean {
  const element = target as Partial<HTMLElement> & { closest?: (selector: string) => Element | null } | null;
  return !!element?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

/**
 * Pasting a file is only meant where text isn't. A spreadsheet's cells also come as a
 * picture of them, and a field that takes text wants the text. The one editable place a
 * bare file belongs in is the composer it's being pasted into.
 */
function pasteIsForUs(event: ClipboardEvent): boolean {
  const types = [...(event.clipboardData?.types ?? [])];
  if (types.includes('text/plain') || types.includes('text/html')) return false;
  if (!isEditable(event.target)) return true;
  const inComposer = !!(event.target as Partial<Element> | null)?.closest?.('[data-testid="email-composer"]');
  return inComposer && !!visibleComposer();
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
    if (files.length === 0 || !pasteIsForUs(event)) return;
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
