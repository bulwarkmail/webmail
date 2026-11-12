// Where a plugin dialog opened with `anchor: 'trigger'` is drawn: next to
// what the user just clicked, as a popover, instead of the centred modal.
//
// A plugin never sees the host's DOM, so it can't name an element. The host
// remembers the user's last activation instead - the control under a
// pointerdown, or the focused one on Enter / Space - and a dialog asking for
// it within TRIGGER_WINDOW_MS takes that place. Any other key forgets it, so
// a keyboard shortcut (s to star) never borrows an older click's place.
// Without one the dialog is centred as before.
//
// `anchor: 'frame'` needs no activation: the popover stands beside the
// plugin frame that asked for it (a rail button's frame), at the frame's end
// side with its bottom lined up with the frame's bottom. So it is placed the
// same when opened by keyboard or again after another dialog.

/** A place in viewport coordinates; a point has left === right, top === bottom. */
export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How long after the activation a dialog may still open at its place. */
export const TRIGGER_WINDOW_MS = 2000;
/** Space kept to the window's edges and to the anchor. */
export const POPOVER_MARGIN = 8;
export const POPOVER_GAP = 4;

const CONTROL = 'button, a[href], [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="checkbox"], [role="tab"]';

interface Trigger {
  element: Element | null;
  rect: AnchorRect;
  at: number;
}

let last: Trigger | null = null;

function rectOf(element: Element): AnchorRect {
  const r = element.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

function isEmpty(r: AnchorRect): boolean {
  return r.right - r.left <= 0 && r.bottom - r.top <= 0 && r.left === 0 && r.top === 0;
}

/**
 * Remember an activation. A control in a menu is placed by the pointer, not
 * by itself: the menu closes on the click, and the dialog should stand
 * where the menu was opened, not beside an entry that is gone.
 */
export function noteTrigger(target: Element, point?: { x: number; y: number }, now = Date.now()): void {
  const control = target.closest(CONTROL) ?? target;
  const inMenu = !!control.closest('[role="menu"]');
  if (inMenu && point) {
    last = { element: null, rect: { left: point.x, top: point.y, right: point.x, bottom: point.y }, at: now };
    return;
  }
  last = { element: control, rect: rectOf(control), at: now };
}

/** Forget the last activation (another key, tests). */
export function forgetTrigger(): void {
  last = null;
}

/**
 * The place of the activation that led to a dialog opening now, or null
 * when there was none within TRIGGER_WINDOW_MS. A control still on the page
 * is measured again (the list may have scrolled while the plugin worked).
 */
export function triggerAnchor(now = Date.now()): AnchorRect | null {
  if (!last || now - last.at > TRIGGER_WINDOW_MS) return null;
  if (last.element?.isConnected) {
    const r = rectOf(last.element);
    if (!isEmpty(r)) return r;
  }
  return last.rect;
}

/**
 * The place of the plugin frame that asked for a dialog, or null when it is
 * not on the page or has no size (a background frame).
 */
export function frameAnchor(frame: Element | null | undefined): AnchorRect | null {
  if (!frame?.isConnected) return null;
  const r = rectOf(frame);
  if (r.right - r.left <= 1 || r.bottom - r.top <= 1) return null;
  return r;
}

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/** Follow the user's activations on the page; returns the way to stop. */
export function trackTriggers(doc: Document = document): () => void {
  const onPointerDown = (e: PointerEvent | MouseEvent) => {
    if (e.target instanceof Element) noteTrigger(e.target, { x: e.clientX, y: e.clientY });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const active = doc.activeElement;
      if (active instanceof Element && active !== doc.body) noteTrigger(active);
      else forgetTrigger();
    } else if (!MODIFIERS.has(e.key)) {
      forgetTrigger();
    }
  };
  // Capture: a menu entry closes its menu (and is gone) during the click.
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('keydown', onKeyDown, true);
  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('keydown', onKeyDown, true);
  };
}

/** Which side of the anchor a popover stands at. */
export type PopoverSide = 'below' | 'end';

/**
 * Top-left corner of a popover of `size` next to `anchor`, always inside the
 * viewport.
 *
 * `below` (the default): below it, lined up with its start (its end in
 * RTL); above when it doesn't fit below and does above.
 *
 * `end`: at its end side (right in LTR, left in RTL), its bottom lined up
 * with the anchor's bottom; at the start side when it doesn't fit at the end
 * and does there.
 */
export function placePopover(
  anchor: AnchorRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  rtl = false,
  side: PopoverSide = 'below',
): { left: number; top: number } {
  const m = POPOVER_MARGIN;
  let left: number;
  let top: number;
  if (side === 'end') {
    const right = anchor.right + POPOVER_GAP;
    const leftOf = anchor.left - POPOVER_GAP - size.width;
    const fitsRight = right + size.width <= viewport.width - m;
    const fitsLeft = leftOf >= m;
    if (rtl) left = fitsLeft || !fitsRight ? leftOf : right;
    else left = fitsRight || !fitsLeft ? right : leftOf;
    top = anchor.bottom - size.height;
  } else {
    left = rtl ? anchor.right - size.width : anchor.left;
    top = anchor.bottom + POPOVER_GAP;
    const above = anchor.top - POPOVER_GAP - size.height;
    if (top + size.height > viewport.height - m && above >= m) top = above;
  }
  left = Math.min(left, viewport.width - m - size.width);
  left = Math.max(m, left);
  top = Math.min(top, viewport.height - m - size.height);
  top = Math.max(m, top);
  return { left, top };
}
