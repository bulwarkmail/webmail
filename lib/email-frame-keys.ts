/**
 * An HTML message renders in a frame, and a key pressed after a click into it
 * goes to the frame's own window: j, k, e, # and the rest stopped working
 * until the user clicked back into the list. This hands those keys on to the
 * page as a copy of the key press, sent from the frame element, so the app's
 * shortcut handlers (hooks/use-keyboard-shortcuts, hooks/use-undo-shortcut)
 * take it with their usual checks: an open menu or dialog, single-key
 * shortcuts turned off. Escape puts the focus back on the message's row in
 * the list, as Escape in a dialog gives the focus back.
 *
 * Left to the frame: anything typed into a form in the mail, keys with Ctrl,
 * Alt or ⌘ (copy, select all), and the keys that scroll the body or move
 * through its links (arrows, Space, Tab, Enter, Page Up and Down).
 */

import { focusTemporarily } from "@/lib/keyboard";

/** Keys that aren't one character but are mail shortcuts. */
const NAMED_KEYS = new Set(["Delete", "Backspace", "Escape"]);

const EDITABLE =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/**
 * Whether a key press in the frame came from a place that takes text. By tag
 * and attribute: the frame's elements belong to another window, so
 * `instanceof HTMLElement` (lib/keyboard) is false for all of them.
 */
function typedInFrame(event: KeyboardEvent, doc: Document): boolean {
  if (doc.designMode === "on") return true;
  const target = event.target as Node | null;
  const el = target && target.nodeType === 1 ? (target as Element) : target?.parentElement ?? null;
  if (!el) return false;
  if (el.closest(EDITABLE)) return true;
  return (el as HTMLElement).isContentEditable === true;
}

/** Whether this key press in the frame belongs to the app. */
export function isFrameKeyForApp(event: KeyboardEvent, doc: Document): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.key === " " || (event.key.length !== 1 && !NAMED_KEYS.has(event.key))) return false;
  return !typedInFrame(event, doc);
}

/**
 * The open message's row in the message list, or the list itself when no row
 * is open. Null where there is no list (a message window).
 */
function listFocusTarget(doc: Document): HTMLElement | null {
  const list = doc.getElementById("message-list");
  if (!list) return null;
  return (
    list.querySelector<HTMLElement>('[role="row"][aria-current="true"]') ??
    list.querySelector<HTMLElement>('[role="row"][tabindex="0"]') ??
    list
  );
}

/**
 * Hands the app's keys from a message frame's document to the page. Returns a
 * function that stops it; a frame whose document is replaced stops by itself.
 */
export function forwardFrameKeys(doc: Document, frame: HTMLIFrameElement): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isFrameKeyForApp(event, doc)) return;
    if (event.key === "Escape") {
      const target = listFocusTarget(frame.ownerDocument);
      if (target) {
        event.preventDefault();
        focusTemporarily(target, { preventScroll: true });
        return;
      }
    }
    const copy = new KeyboardEvent("keydown", {
      key: event.key,
      code: event.code,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    frame.dispatchEvent(copy);
    // A shortcut ran: the frame doesn't act on the key as well.
    if (copy.defaultPrevented) event.preventDefault();
  };
  doc.addEventListener("keydown", onKeyDown);
  return () => doc.removeEventListener("keydown", onKeyDown);
}
