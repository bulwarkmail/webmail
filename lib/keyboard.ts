// Shared helper for global key listeners to decide whether a keyboard event
// originated from a typing context (input, textarea, select, contentEditable).
//
// Checking `document.activeElement` / `event.target` is NOT enough: inside a
// shadow root both are retargeted to the host element, so the QuotedHtml
// island's inner contentEditable (components/email/quoted-html.ts) looks like
// a plain <div> from outside. Single-key mailbox shortcuts then fire while the
// user is editing quoted text — up to and including deleting the open email on
// Backspace (#654). `composedPath()` sees through the shadow boundary and
// starts at the real inner target, so it is the reliable signal.
export function isEditableEventTarget(event: Event): boolean {
  const path =
    typeof event.composedPath === "function"
      ? event.composedPath()
      : [event.target];
  return path.some((node) => {
    if (!(node instanceof HTMLElement)) return false;
    const tag = node.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (node.isContentEditable) return true;
    // jsdom (tests) doesn't implement isContentEditable; browsers reflect the
    // property into the attribute, so this also covers "plaintext-only".
    const attr = node.getAttribute("contenteditable");
    return attr === "" || attr === "true" || attr === "plaintext-only";
  });
}

/**
 * Whether a key event comes from a control that Enter or Space activates
 * itself (a link, a button): a page-wide shortcut on those keys must leave it
 * alone, or a focused "Skip to message list" link opens a message instead.
 */
export function isActivatableEventTarget(event: Event): boolean {
  const path =
    typeof event.composedPath === "function"
      ? event.composedPath()
      : [event.target];
  return path.some(
    (node) =>
      node instanceof HTMLElement &&
      node.matches('a[href], button, summary, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="option"], [role="tab"], [role="switch"]'),
  );
}

// Open layers that own the keyboard while they're up: a modal dialog, a menu,
// and the popup of a menu button, listbox button or combobox. A permanent
// listbox or grid (a list on the page) is not one of them.
const KEYBOARD_LAYER_SELECTOR = [
  '[aria-modal="true"]',
  '[role="menu"]',
  '[role="combobox"][aria-expanded="true"]',
  '[aria-haspopup="menu"][aria-expanded="true"]',
  '[aria-haspopup="listbox"][aria-expanded="true"]',
  '[aria-haspopup="true"][aria-expanded="true"]',
].join(", ");

/** Whether a modal dialog, a menu or a listbox popup is open on the page. */
export function isKeyboardLayerOpen(root: ParentNode = document): boolean {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(KEYBOARD_LAYER_SELECTOR))) {
    // Kept mounted but hidden (a closed drawer, an inert pane) doesn't count.
    if (!el.closest('[hidden], [inert], [aria-hidden="true"]')) return true;
  }
  return false;
}

/**
 * Whether a page-wide app shortcut (Mail's j/k/Delete, the calendar's
 * letters, Files' arrows) must leave this key press alone: someone already
 * handled it, the user is typing, or a dialog, menu or popup is open and the
 * key belongs to that. Without the last check Delete in the shortcuts help
 * deleted the message behind it.
 */
export function isAppShortcutBlocked(event: KeyboardEvent): boolean {
  return event.defaultPrevented || isEditableEventTarget(event) || isKeyboardLayerOpen();
}

/**
 * A shortcut that is one printable character with no Ctrl, Alt or ⌘
 * (j, #, ?, /). WCAG 2.1.4 asks that these can be turned off, since speech
 * input types them by accident; Delete, the arrows, Enter and Escape are not
 * character keys and stay.
 */
export function isSingleCharacterKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return [...event.key].length === 1;
}

/**
 * The key a shortcut matches for this press, lowercased: "e", "/", "#",
 * "arrowdown". The character the key types wins, so `e` archives on Colemak,
 * Dvorak and AZERTY where `e` is printed on the key (#1714). Where the layout
 * types no ASCII character there (Cyrillic, Greek, Hebrew, Arabic, or a Mac's
 * Option layer, where Alt+A types "å"), the key's place on a US keyboard
 * stands in, so those layouts keep their shortcuts.
 */
export function shortcutKey(event: Pick<KeyboardEvent, "key" | "code" | "shiftKey">): string {
  const key = event.key ?? "";
  if (key.length === 1 && key > " " && key <= "~") return key.toLowerCase();
  const code = event.code ?? "";
  if (/^Key[A-Z]$/.test(code)) return code.charAt(3).toLowerCase();
  if (code === "Slash") return event.shiftKey ? "?" : "/";
  if (code === "Digit1" && event.shiftKey) return "!";
  if (code === "Digit3" && event.shiftKey) return "#";
  return key.toLowerCase();
}

/** Whether the key press started inside an element that matches `selector`. */
export function isEventInside(event: Event, selector: string): boolean {
  const path =
    typeof event.composedPath === "function"
      ? event.composedPath()
      : [event.target];
  return path.some((node) => node instanceof Element && node.matches(selector));
}

/**
 * Controls that use the arrow keys themselves: a page-wide arrow shortcut
 * must not take them from a slider, a resize handle, tabs, a grid or a menu.
 */
export function isArrowKeyWidgetTarget(event: Event): boolean {
  return isEventInside(
    event,
    'select, [role="slider"], [role="separator"], [role="scrollbar"], [role="spinbutton"], [role="tablist"], [role="radiogroup"], [role="grid"], [role="treegrid"], [role="tree"], [role="listbox"], [role="menu"], [role="menubar"], [role="toolbar"]',
  );
}

/**
 * Focuses an element that may not take the focus by itself (a landmark, a
 * pane): it gets tabindex="-1" until the focus leaves it again. Kept only
 * while focused, since a container with tabindex keeps the focus on a click
 * inside it, and the arrow keys then no longer scroll the list in it.
 */
export function focusTemporarily(el: HTMLElement, options?: FocusOptions): void {
  const focusable = el.matches("a[href], button, input, select, textarea, [tabindex]");
  if (!focusable) {
    el.setAttribute("tabindex", "-1");
    el.addEventListener("blur", () => el.removeAttribute("tabindex"), { once: true });
  }
  el.focus(options);
}
