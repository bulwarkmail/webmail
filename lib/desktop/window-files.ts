/**
 * Who takes files on this window: the composer on screen, for files pasted into it or
 * dropped on its zone of the file drop overlay (lib/file-drop). And whether a drag going
 * on is the app's own native one, which is no new file.
 */

interface ComposerTarget {
  take: (files: File[]) => unknown;
  /** The Pro shell keeps composers mounted on tabs out of sight. */
  visible: () => boolean;
}

const composerTargets: ComposerTarget[] = [];
/** Our own native drag passing over our own window isn't a new file. */
let ownDrag = false;

/** A composer on screen takes files itself. */
export function setComposerFileTarget(take: ComposerTarget['take'], visible: ComposerTarget['visible']): () => void {
  const target = { take, visible };
  composerTargets.push(target);
  return () => {
    const at = composerTargets.indexOf(target);
    if (at !== -1) composerTargets.splice(at, 1);
  };
}

/** The newest composer on screen, if any. */
export function visibleComposer(): ComposerTarget | undefined {
  return [...composerTargets].reverse().find((target) => target.visible());
}

export function setOwnDragActive(active: boolean): void {
  ownDrag = active;
}

export function isOwnDragActive(): boolean {
  return ownDrag;
}

function isEditable(target: EventTarget | null): boolean {
  const element = target as Partial<HTMLElement> & { closest?: (selector: string) => Element | null } | null;
  return !!element?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

/**
 * Where a pasted file goes, if anywhere. Pasting a file is only meant where text isn't. A
 * spreadsheet's cells also come as a picture of them, and a field that takes text wants
 * the text. The one editable place a bare file belongs in is the composer it's being
 * pasted into.
 */
export function pasteTarget(event: ClipboardEvent): 'composer' | 'choose' | null {
  if (event.defaultPrevented) return null;
  if ((event.clipboardData?.files?.length ?? 0) === 0) return null;
  const types = [...(event.clipboardData?.types ?? [])];
  if (types.includes('text/plain') || types.includes('text/html')) return null;
  if (!isEditable(event.target)) return 'choose';
  const inComposer = !!(event.target as Partial<Element> | null)?.closest?.('[data-testid="email-composer"]');
  return inComposer && visibleComposer() ? 'composer' : null;
}
