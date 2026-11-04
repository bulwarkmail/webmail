/**
 * Where a menu goes: next to what opened it, inside the window.
 *
 * - Opened from a button (an anchor): under it, lined up with its start edge, or its
 *   end edge for a button at the end of a toolbar. In RTL start and end swap. When it
 *   doesn't fit on that side it lines up with the other edge, and when there's no room
 *   below it goes above.
 * - Opened by a right-click (a point): its corner at the pointer, opening to the right
 *   and down (to the left in RTL), and towards the other side where there's no room, as
 *   the OS does with its own menus.
 *
 * Whatever is left over is clamped into the window. A menu taller than the window
 * scrolls inside (the menu caps its own height).
 */

export interface MenuAnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Line up with the anchor's start (default) or end edge. */
  align?: "start" | "end";
}

export interface MenuPlacementInput {
  /** Where a right-click happened. Ignored when there's an anchor. */
  point: { x: number; y: number };
  anchor?: MenuAnchorRect;
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  rtl?: boolean;
  /** Room kept free along the window's edges. */
  margin?: number;
  /** Between the anchor and the menu. */
  gap?: number;
}

export const MENU_VIEWPORT_MARGIN = 10;
export const MENU_ANCHOR_GAP = 4;

function clamp(value: number, size: number, room: number, margin: number): number {
  return Math.max(margin, Math.min(value, room - size - margin));
}

export function placeMenu({
  point,
  anchor,
  size,
  viewport,
  rtl = false,
  margin = MENU_VIEWPORT_MARGIN,
  gap = MENU_ANCHOR_GAP,
}: MenuPlacementInput): { x: number; y: number } {
  const { width: w, height: h } = size;
  const { width: vw, height: vh } = viewport;
  const fitsX = (x: number) => x >= margin && x + w <= vw - margin;
  const fitsY = (y: number) => y >= margin && y + h <= vh - margin;

  let x: number;
  let y: number;
  if (anchor) {
    const alignEnd = (anchor.align === "end") !== rtl;
    const startEdge = anchor.left;
    const endEdge = anchor.right - w;
    const preferred = alignEnd ? endEdge : startEdge;
    const other = alignEnd ? startEdge : endEdge;
    x = fitsX(preferred) || !fitsX(other) ? preferred : other;
    const below = anchor.bottom + gap;
    const above = anchor.top - gap - h;
    if (fitsY(below)) y = below;
    else if (fitsY(above)) y = above;
    // Neither fits whole: the side with more room, and the menu scrolls.
    else y = vh - anchor.bottom >= anchor.top ? below : above;
  } else {
    const towardEnd = rtl ? point.x - w : point.x;
    const towardStart = rtl ? point.x : point.x - w;
    x = fitsX(towardEnd) || !fitsX(towardStart) ? towardEnd : towardStart;
    const down = point.y;
    const up = point.y - h;
    y = fitsY(down) || !fitsY(up) ? down : up;
  }
  return { x: clamp(x, w, vw, margin), y: clamp(y, h, vh, margin) };
}
