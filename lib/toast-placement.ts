/**
 * Where the toast stack goes, for the whole app. One rule: at the bottom end
 * corner of the window (bottom left in RTL; across the bottom on a phone),
 * above whatever is docked at the bottom on screen now, and beside a sheet
 * docked at the window's end when there is room for it.
 *
 * The things to keep clear mark themselves:
 *   data-toast-avoid="bottom"  docked at the bottom: the quick reply box, a
 *                              composer's or form's footer, the phone's bars
 *                              (hooks/use-bottom-controls marks those)
 *   data-end-sheet             a panel docked at the window's end: the
 *                              calendar's event and task panels
 *
 * Everything is measured where it is on screen at the moment, never kept from
 * earlier: an offset worked out from a box that then moved, closed or went
 * with a page change left toasts in the middle of the content.
 */

export const TOAST_AVOID_BOTTOM = '[data-toast-avoid="bottom"]';
export const TOAST_AVOID_END = '[data-end-sheet]';

/** Distance from the window's edges (px). */
export const TOAST_EDGE = 20;
/** The same on a phone, where the stack spans the screen. */
export const TOAST_PHONE_EDGE = 12;
/** Room left above something docked at the bottom (px). */
export const TOAST_GAP = 12;
/** The stack's width when it can't be measured (w-[360px] in toast.tsx). */
const STACK_WIDTH = 360;
/** What of a composer's text area must stay free above the stack: three lines (px). */
export const TOAST_EDITOR_FREE = 72;
const COMPOSER_FOOTER = '[data-composer-footer]';
const COMPOSER_ROOT = '[data-testid="email-composer"]';
const COMPOSER_EDITOR = '.ProseMirror, textarea';

export interface ToastPlacement {
  /** From the window's bottom edge to the stack's bottom (px). */
  bottom: number;
  /** From the window's end edge (px); null on a phone, where the stack spans the screen. */
  end: number | null;
}

function shownRect(el: Element): DOMRect | null {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  if (getComputedStyle(el).visibility === 'hidden') return null;
  return r;
}

function viewport(): { width: number; height: number } {
  const root = document.documentElement;
  return {
    width: root.clientWidth || window.innerWidth,
    height: window.innerHeight || root.clientHeight,
  };
}

/** The stack's place, from what is on screen now. */
export function computeToastPlacement(stack: HTMLElement, opts: { phone: boolean; rtl: boolean }): ToastPlacement {
  const { width: vw, height: vh } = viewport();
  const width = Math.min(stack.offsetWidth || STACK_WIDTH, vw);

  // Beside a sheet at the window's end, when the stack fits next to it.
  // Without room it stays in the corner and clears the sheet's footer below.
  let end: number | null = opts.phone ? null : TOAST_EDGE;
  if (end !== null) {
    for (const sheet of document.querySelectorAll(TOAST_AVOID_END)) {
      if (stack.contains(sheet)) continue;
      const r = shownRect(sheet);
      if (!r) continue;
      const atEnd = opts.rtl ? r.left <= 1 : r.right >= vw - 1;
      if (!atEnd) continue;
      const beside = (opts.rtl ? r.right : vw - r.left) + TOAST_EDGE;
      if (beside + width + TOAST_EDGE <= vw) end = Math.max(end, beside);
    }
  }

  // Above what is docked at the bottom under the stack's columns. Only what
  // is on screen and sits in the lower half counts: a box scrolled out of
  // view, or one standing in the middle, would put the toasts over the content.
  const bottomAt = (atEnd: number | null): { bottom: number; lifter: Element | null } => {
    const left = atEnd === null ? TOAST_PHONE_EDGE : opts.rtl ? atEnd : vw - atEnd - width;
    const right = atEnd === null ? vw - TOAST_PHONE_EDGE : left + width;
    let bottom = opts.phone ? TOAST_PHONE_EDGE : TOAST_EDGE;
    let lifter: Element | null = null;
    for (const el of document.querySelectorAll(TOAST_AVOID_BOTTOM)) {
      if (stack.contains(el)) continue;
      const r = shownRect(el);
      if (!r) continue;
      if (r.right <= left || r.left >= right) continue;
      if (r.top >= vh || r.bottom <= 0) continue;
      if (r.top < vh / 2) continue;
      const above = vh - r.top + TOAST_GAP;
      if (above > bottom) {
        bottom = above;
        lifter = el;
      }
    }
    return { bottom, lifter };
  };

  const { bottom, lifter } = bottomAt(end);
  // Above a composer's bottom bar the stack may cover what is being written:
  // "Draft saved" lay over the docked reply's text for its whole time at
  // 1366×768 (compose-p3-14). With less than three lines left free above it,
  // it goes beside the composer, over the list, where there is room.
  if (end !== null && lifter?.matches(COMPOSER_FOOTER)) {
    const root = lifter.closest(COMPOSER_ROOT);
    const editor = root?.querySelector(COMPOSER_EDITOR);
    const rootBox = root ? shownRect(root) : null;
    const editorBox = editor ? shownRect(editor) : null;
    const height = stack.offsetHeight;
    if (rootBox && editorBox && height > 0) {
      const stackTop = vh - bottom - height;
      const free = stackTop - Math.max(editorBox.top, rootBox.top);
      const beside = opts.rtl ? vw - rootBox.right : rootBox.left;
      if (free < TOAST_EDITOR_FREE && beside >= width + 2 * TOAST_EDGE) {
        const besideEnd = opts.rtl ? rootBox.right + TOAST_EDGE : vw - rootBox.left + TOAST_EDGE;
        return { bottom: Math.round(bottomAt(besideEnd).bottom), end: Math.round(besideEnd) };
      }
    }
  }
  return { bottom: Math.round(bottom), end };
}

/**
 * True when the stack, at `place`, would hide at least half of the element
 * that has the focus: a button or a one-line field. A large element it only
 * overlaps at a corner stays usable, and a text area or editor never counts:
 * moving the stack to the top for one put the toasts over the composer's close
 * button and the reader's toolbar.
 */
export function stackWouldCoverFocus(stack: HTMLElement, place: ToastPlacement, rtl = false): boolean {
  const focused = document.activeElement as HTMLElement | null;
  if (!focused || focused === document.body || !focused.isConnected || stack.contains(focused)) return false;
  // Text being written: the caret moves, and the stack over the lower corner
  // of the reply dock's editor sent it to the top, over the toolbar.
  if (focused.tagName === 'TEXTAREA' || focused.isContentEditable || focused.closest('[contenteditable]:not([contenteditable="false"])')) return false;
  const height = stack.offsetHeight || stack.getBoundingClientRect().height;
  if (height === 0) return false;
  const { width: vw, height: vh } = viewport();
  const width = Math.min(stack.offsetWidth || STACK_WIDTH, vw);
  const bottom = vh - place.bottom;
  const top = bottom - height;
  const end = place.end ?? TOAST_PHONE_EDGE;
  const left = rtl ? end : vw - end - width;
  const right = left + width;
  const f = focused.getBoundingClientRect();
  const overlapWidth = Math.min(f.right, right) - Math.max(f.left, left);
  const overlapHeight = Math.min(f.bottom, bottom) - Math.max(f.top, top);
  if (overlapWidth <= 0 || overlapHeight <= 0) return false;
  const area = Math.max(f.width, 0) * Math.max(f.height, 0);
  return area === 0 || overlapWidth * overlapHeight >= area / 2;
}
