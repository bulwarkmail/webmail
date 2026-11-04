import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeToastPlacement, TOAST_EDGE, TOAST_GAP } from '../toast-placement';

// compose-p3-14: closing a resumed reply and opening it again from its card
// at 1366×768 left "Draft saved" above the docked composer's bottom bar, over
// the right half of the text being written, for its whole time.

type Box = { top: number; bottom: number; left: number; right: number };
const boxes = new Map<Element, Box>();

function place(el: Element, box: Box) {
  boxes.set(el, box);
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1366, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true, writable: true });
  Object.defineProperty(document.documentElement, 'clientWidth', { value: 1366, configurable: true });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const b = boxes.get(this) ?? { top: 0, bottom: 0, left: 0, right: 0 };
    return { ...b, width: b.right - b.left, height: b.bottom - b.top, x: b.left, y: b.top, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  boxes.clear();
  document.body.innerHTML = '';
});

/** A docked reply in the reading pane, which starts at x = 620, with its text from `editorTop`. */
function dockedComposer(editorTop: number) {
  document.body.innerHTML = `
    <div data-testid="email-composer">
      <div class="ProseMirror" contenteditable="true"></div>
      <div data-composer-footer data-toast-avoid="bottom"></div>
    </div>
    <div data-toast-container><div class="stack"></div></div>`;
  const root = document.querySelector('[data-testid="email-composer"]')!;
  place(root, { top: 480, bottom: 768, left: 620, right: 1366 });
  place(root.querySelector('.ProseMirror')!, { top: editorTop, bottom: 708, left: 620, right: 1366 });
  place(root.querySelector('[data-composer-footer]')!, { top: 708, bottom: 768, left: 620, right: 1366 });
  const stack = document.querySelector<HTMLElement>('.stack')!;
  Object.defineProperty(stack, 'offsetWidth', { value: 360, configurable: true });
  Object.defineProperty(stack, 'offsetHeight', { value: 64, configurable: true });
  return stack;
}

describe('toasts and a composer at the bottom', () => {
  it('go beside the composer, over the list, when they would leave its text less than three lines', () => {
    const stack = dockedComposer(600);
    const placed = computeToastPlacement(stack, { phone: false, rtl: false });
    // Beside the composer's start edge, at the window's bottom.
    expect(placed).toEqual({ bottom: TOAST_EDGE, end: 1366 - 620 + TOAST_EDGE });
  });

  it('stay above the bottom bar when the text keeps its room', () => {
    const stack = dockedComposer(300);
    const placed = computeToastPlacement(stack, { phone: false, rtl: false });
    expect(placed).toEqual({ bottom: 768 - 708 + TOAST_GAP, end: TOAST_EDGE });
  });
});
