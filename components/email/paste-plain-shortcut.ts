import type { EditorView } from "@tiptap/pm/view";
import { isApplePlatform } from "@/lib/shortcut-keys";

/**
 * Mod+Shift+V pastes without formatting (#1890).
 *
 * Ctrl+Shift+V on Windows and Linux, and Cmd+Option+Shift+V on a Mac, are
 * the browsers' own "paste as plain text": the browser fires a paste with
 * the text, and ProseMirror pastes it as text because Shift is down (through
 * PlainTextPaste, one paragraph per line). Those are left to the browser.
 *
 * Cmd+Shift+V on a Mac has no browser action, so no paste event comes. That
 * one reads the clipboard text and pastes it the same way. Safari may first
 * show its own Paste button, which the user clicks to allow it.
 */
export function isMacPlainPasteKey(event: KeyboardEvent, apple = isApplePlatform()): boolean {
  if (!apple || !event.metaKey || !event.shiftKey || event.altKey || event.ctrlKey) return false;
  // event.code: the V key on any layout (Dvorak, Cyrillic) still reads "KeyV".
  return event.code === "KeyV" || event.key.toLowerCase() === "v";
}

/** Handles the Mac Cmd+Shift+V; returns true when it took the key. */
export function handlePlainPasteKey(view: EditorView, event: KeyboardEvent, apple = isApplePlatform()): boolean {
  if (!isMacPlainPasteKey(event, apple)) return false;
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clipboard?.readText) return false;
  event.preventDefault();
  clipboard.readText().then(
    (text) => {
      if (text && !view.isDestroyed) view.pasteText(text);
    },
    // Refused (the user dismissed Safari's Paste button, or the browser
    // denied clipboard access): nothing is pasted, as with an empty clipboard.
    () => {},
  );
  return true;
}
