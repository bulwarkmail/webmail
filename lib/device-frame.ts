/**
 * "No downloads" inside the reader's own documents (the same-origin message
 * frames) and over previews: a right-click on a picture offers no "Save
 * image as", and pictures can't be dragged out to the desktop. Pictures
 * of the message itself (inline cid parts, remote images once loaded) are
 * otherwise as easy to save as an attachment.
 */

/** Styles for a frame's document: pictures can't be dragged or long-pressed out. */
export const NO_SAVE_MEDIA_CSS = 'img,picture,video,svg{-webkit-user-drag:none;user-drag:none;-webkit-touch-callout:none}';

const MEDIA = 'img,picture,video,svg,canvas';

/** Refuses the context menu and dragging on pictures while `isOn()` says so. */
export function blockMediaSaving(target: Document | HTMLElement, isOn: () => boolean): () => void {
  const block = (event: Event) => {
    if (!isOn()) return;
    const element = event.target as Element | null;
    if (element && typeof element.closest === 'function' && element.closest(MEDIA)) event.preventDefault();
  };
  target.addEventListener('contextmenu', block, true);
  target.addEventListener('dragstart', block, true);
  return () => {
    target.removeEventListener('contextmenu', block, true);
    target.removeEventListener('dragstart', block, true);
  };
}

/** React props for a container whose pictures must not be saved. */
export function noMediaSavingProps(on: boolean) {
  if (!on) return {};
  const block = (event: { target: EventTarget; preventDefault: () => void }) => {
    const element = event.target as Element | null;
    if (element && typeof element.closest === 'function' && element.closest(MEDIA)) event.preventDefault();
  };
  return { onContextMenuCapture: block, onDragStartCapture: block };
}
