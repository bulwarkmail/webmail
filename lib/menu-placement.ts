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
 * gets a max height and scrolls inside. In the desktop app the window starts below
 * its title row (windowTopEdge). Submenus: placeSubmenu.
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
  /** Where the window's usable part starts: below the desktop app's title row (windowTopEdge). */
  topEdge?: number;
}

export interface MenuPlacement {
  x: number;
  y: number;
  /** Set when the menu is taller than the room it has: it scrolls inside. */
  maxHeight?: number;
}

export const MENU_VIEWPORT_MARGIN = 10;
export const MENU_ANCHOR_GAP = 4;

function clamp(value: number, size: number, room: number, margin: number): number {
  return Math.max(margin, Math.min(value, room - size - margin));
}

/** The highest a menu may go: the window's top, or below the desktop app's title row. */
function topLimit(margin: number, gap: number, topEdge: number): number {
  return topEdge > 0 ? Math.max(margin, topEdge + gap) : margin;
}

/**
 * The bottom of what covers the window's top in the desktop app: its menu bar
 * (z-[100002], over every menu), or the row the window's own buttons sit over.
 * 0 in a browser.
 */
export function windowTopEdge(doc: Document = document): number {
  let edge = 0;
  const root = doc.documentElement;
  if (root.hasAttribute("data-window-controls")) {
    // Set in px by lib/window-controls-overlay.ts while the controls are over the page.
    const row = parseFloat(root.style.getPropertyValue("--titlebar-row-height"));
    if (row > 0) edge = row;
  }
  const bar = doc.querySelector("[data-window-menu-bar]");
  if (bar) edge = Math.max(edge, bar.getBoundingClientRect().bottom);
  return edge;
}

export function placeMenu({
  point,
  anchor,
  size,
  viewport,
  rtl = false,
  margin = MENU_VIEWPORT_MARGIN,
  gap = MENU_ANCHOR_GAP,
  topEdge = 0,
}: MenuPlacementInput): MenuPlacement {
  const { width: w } = size;
  let h = size.height;
  const { width: vw, height: vh } = viewport;
  const top = topLimit(margin, gap, topEdge);
  const fitsX = (x: number) => x >= margin && x + w <= vw - margin;
  const fitsY = (y: number) => y >= top && y + h <= vh - margin;

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
    else {
      // Neither fits whole: the side with more room, as tall as that room, and
      // the menu scrolls. Clamped instead, it would cover its own button.
      const roomBelow = vh - margin - below;
      const roomAbove = anchor.top - gap - top;
      const maxHeight = Math.max(roomBelow, roomAbove);
      h = Math.min(h, maxHeight);
      y = roomBelow >= roomAbove ? below : anchor.top - gap - h;
      return { x: clamp(x, w, vw, margin), y: Math.max(top, y), maxHeight };
    }
  } else {
    const towardEnd = rtl ? point.x - w : point.x;
    const towardStart = rtl ? point.x : point.x - w;
    x = fitsX(towardEnd) || !fitsX(towardStart) ? towardEnd : towardStart;
    const down = point.y;
    const up = point.y - h;
    y = fitsY(down) || !fitsY(up) ? down : up;
  }
  return { x: clamp(x, w, vw, margin), ...fitVertically(y, h, top, vh - margin) };
}

/** Moved up until its bottom is inside, never above `top`; taller than the room, it scrolls. */
function fitVertically(y: number, h: number, top: number, bottom: number): { y: number; maxHeight?: number } {
  if (h > bottom - top) return { y: top, maxHeight: Math.max(0, bottom - top) };
  return { y: Math.max(top, Math.min(y, bottom - h)) };
}

export interface SubmenuPlacementInput {
  /** The entry the submenu belongs to, in viewport coordinates. */
  item: { left: number; top: number; right: number; bottom: number };
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  rtl?: boolean;
  /** The side of the entry it opens on when there's room: end is the right in LTR. */
  side?: "start" | "end";
  margin?: number;
  gap?: number;
  topEdge?: number;
}

/**
 * Where a submenu goes: beside its entry, its top level with the entry's, on the
 * entry's end side (left in RTL), on the other side when there's no room there.
 * Then it moves up as far as it needs to so its bottom stays inside the window,
 * never above the window's top (or the desktop app's title row). Taller than all
 * that room, it gets a max height and scrolls inside, as a long menu does.
 */
export function placeSubmenu({
  item,
  size,
  viewport,
  rtl = false,
  side = "end",
  margin = MENU_VIEWPORT_MARGIN,
  gap = MENU_ANCHOR_GAP,
  topEdge = 0,
}: SubmenuPlacementInput): MenuPlacement {
  const { width: w, height: h } = size;
  const { width: vw, height: vh } = viewport;
  const right = item.right + w <= vw - margin ? item.right : null;
  const left = item.left - w >= margin ? item.left - w : null;
  const rightFirst = (side === "end") !== rtl;
  let x = rightFirst ? (right ?? left) : (left ?? right);
  if (x === null) {
    // No room on either side: the side with more room, kept inside the window.
    const roomRight = vw - margin - item.right;
    const roomLeft = item.left - margin;
    x = clamp(roomRight >= roomLeft ? item.right : item.left - w, w, vw, margin);
  }
  return { x, ...fitVertically(item.top, h, topLimit(margin, gap, topEdge), vh - margin) };
}
