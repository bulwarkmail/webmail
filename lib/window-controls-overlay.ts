/**
 * Window Controls Overlay: an installed app (and the desktop app's
 * titleBarOverlay window) draws the page up to the top of the window and lays
 * the native minimise, maximise and close buttons over it.
 *
 * There's no title bar row. The app's own columns run to the top of the window,
 * the window's controls sit in the top row of whichever column is there, and that
 * row leaves them room. Its empty parts are what the window is dragged by, and a
 * double-click on them maximises, as on a title bar.
 *
 * Which row that is depends on the page and the width: the reader's toolbar, the
 * list's header when there's no reader, a dialog that fills the window. So this
 * looks: an app row that sits at the top of the window gets marked, and CSS in
 * app/globals.css does the rest. A row that starts the window's top row is an h-14
 * (or h-12, h-16) box all over the app; anything else says `data-window-top-row`.
 *
 * Asks navigator.windowControlsOverlay, never the media query:
 * `(display-mode: window-controls-overlay)` is false in Electron with
 * titleBarOverlay, while the API and env(titlebar-area-*) work there.
 */

export interface TitlebarArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface OverlayLike extends EventTarget {
  visible: boolean;
  getTitlebarAreaRect?: () => { x: number; y: number; width: number; height: number };
}

export const TITLEBAR_RIGHT_VAR = '--titlebar-right-inset';
export const TITLEBAR_LEFT_VAR = '--titlebar-left-inset';
export const TITLEBAR_ROW_VAR = '--titlebar-row-height';

/** The window has its controls over the page. */
export const CONTROLS_ATTRIBUTE = 'data-window-controls';
/** They're at the left (macOS): the rail makes room at its top. */
export const CONTROLS_LEFT_ATTRIBUTE = 'data-window-controls-left';
/** This row is at the top of the window: its empty parts drag. */
export const ROW_ATTRIBUTE = 'data-window-row';
/** The window's controls are over this end of it. */
export const ROW_RIGHT_ATTRIBUTE = 'data-window-row-right';
export const ROW_LEFT_ATTRIBUTE = 'data-window-row-left';
/**
 * The end of this row or pane head, where its own close usually goes, is at the
 * window's controls: a close there would read as a second one for the window, so
 * it goes to the other end (hooks/use-close-beside-controls.ts).
 */
export const CLOSE_MOVES_ATTRIBUTE = 'data-window-close-moves';
/** The head of a pane at the window's end, a row below the controls: its close can sit right under the window's. */
export const PANE_HEAD_ATTRIBUTE = 'data-window-pane-head';

function overlay(): OverlayLike | null {
  if (typeof navigator === 'undefined') return null;
  const value = (navigator as Navigator & { windowControlsOverlay?: OverlayLike }).windowControlsOverlay;
  return value ?? null;
}

/** The strip the page may draw in next to the window's controls, or null when there is no overlay. */
export function readTitlebarArea(): TitlebarArea | null {
  const current = overlay();
  if (!current?.visible) return null;
  const rect = current.getTitlebarAreaRect?.();
  if (!rect || !(rect.height > 0)) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** What the controls take of each side, from the strip they leave. */
export function controlsInsets(area: TitlebarArea, viewportWidth: number): { left: number; right: number } {
  return { left: Math.max(0, area.x), right: Math.max(0, viewportWidth - area.x - area.width) };
}

/**
 * Says where the controls are, for the CSS. With no area the inline values go, so
 * what the stylesheet has from env() (nothing without an overlay) counts again.
 */
export function applyControlsArea(area: TitlebarArea | null, root: HTMLElement = document.documentElement): void {
  if (!area) {
    for (const name of [TITLEBAR_RIGHT_VAR, TITLEBAR_LEFT_VAR, TITLEBAR_ROW_VAR]) root.style.removeProperty(name);
    root.removeAttribute(CONTROLS_ATTRIBUTE);
    root.removeAttribute(CONTROLS_LEFT_ATTRIBUTE);
    return;
  }
  const { left, right } = controlsInsets(area, root.ownerDocument.defaultView?.innerWidth ?? 0);
  root.style.setProperty(TITLEBAR_RIGHT_VAR, `${right}px`);
  root.style.setProperty(TITLEBAR_LEFT_VAR, `${left}px`);
  root.style.setProperty(TITLEBAR_ROW_VAR, `${area.height}px`);
  root.setAttribute(CONTROLS_ATTRIBUTE, '');
  root.toggleAttribute(CONTROLS_LEFT_ATTRIBUTE, left > 0);
}

/**
 * Calls `listener` now and whenever the overlay's size or visibility changes
 * (`geometrychange`). Without the API it calls it once with null and listens
 * to nothing, so a browser without it runs no extra code. Returns the
 * unsubscribe.
 */
export function watchTitlebarArea(listener: (area: TitlebarArea | null) => void): () => void {
  listener(readTitlebarArea());
  const current = overlay();
  if (!current) return () => {};
  const onChange = () => listener(readTitlebarArea());
  current.addEventListener('geometrychange', onChange);
  return () => current.removeEventListener('geometrychange', onChange);
}

const ROW_CANDIDATES = '[data-window-top-row], [data-composer-header], header, div.h-14, div.min-h-14, div.h-12, div.h-16, div.min-h-16';
/** No toolbar is taller than this: past it, it's a tile or a pane that happens to sit at the top. */
const MAX_ROW_HEIGHT = 96;

/**
 * Marks the rows at the top of the window, for what lies over them, and returns them.
 * One pass, cheap: a dozen rects.
 */
export function markWindowRows(area: TitlebarArea, doc: Document = document): HTMLElement[] {
  const viewportWidth = doc.defaultView?.innerWidth ?? 0;
  const { left, right } = controlsInsets(area, viewportWidth);
  // A row's own close is at its end: the right, or the left in a right-to-left page.
  const rtl = doc.documentElement.dir === 'rtl';
  const seen = new Set<HTMLElement>();
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(ROW_CANDIDATES))) {
    const rect = el.getBoundingClientRect();
    const explicit = el.hasAttribute('data-window-top-row');
    const shaped = rect.height > 0 && rect.width > 0 && (explicit || rect.height <= MAX_ROW_HEIGHT);
    const atTop = shaped && rect.top <= 1;
    // A row a line above pushed down (a note that the message moved, that the app is
    // offline, an update) still starts beside the controls and needs the same room.
    // It isn't what the window is dragged by, though: that's the top. A list's row
    // scrolled up under its header isn't one of these.
    const underControls = shaped && !atTop && rect.top < area.height && !inScrolledList(el);
    // The outermost box of a row: an inner one sits inside its padding already.
    const nested = (atTop || underControls) && [...seen].some((outer) => outer.contains(el));
    if ((!atTop && !underControls) || nested) {
      el.removeAttribute(ROW_ATTRIBUTE);
      el.removeAttribute(ROW_RIGHT_ATTRIBUTE);
      el.removeAttribute(ROW_LEFT_ATTRIBUTE);
      el.removeAttribute(CLOSE_MOVES_ATTRIBUTE);
      continue;
    }
    seen.add(el);
    const onRight = right > 0 && rect.right > viewportWidth - right;
    const onLeft = left > 0 && rect.left < left;
    el.toggleAttribute(ROW_ATTRIBUTE, atTop);
    el.toggleAttribute(ROW_RIGHT_ATTRIBUTE, onRight);
    el.toggleAttribute(ROW_LEFT_ATTRIBUTE, onLeft);
    el.toggleAttribute(CLOSE_MOVES_ATTRIBUTE, rtl ? onLeft : onRight);
  }
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(`[${PANE_HEAD_ATTRIBUTE}]`))) {
    const rect = el.getBoundingClientRect();
    const near = rect.height > 0 && rect.top < area.height * 2;
    el.toggleAttribute(CLOSE_MOVES_ATTRIBUTE, near && (rtl ? left > 0 && rect.left < left : right > 0 && rect.right > viewportWidth - right));
  }
  return [...seen];
}

/** Inside something scrolled away from its top: a row passing under, not a toolbar. */
function inScrolledList(el: HTMLElement): boolean {
  for (let at = el.parentElement; at && at !== el.ownerDocument.body; at = at.parentElement) {
    if (at.scrollTop > 0) return true;
  }
  return false;
}

/**
 * Keeps those marks right as the page changes, before the next paint. Mutation and
 * resize callbacks both run ahead of painting, so a row never shows without its room.
 * A pane can also change width with no change to the page, in a transition or by
 * being dragged, so the rows themselves are watched too, and transitions' ends.
 */
export function watchWindowRows(area: TitlebarArea, doc: Document = document): () => void {
  let queued = false;
  let watched = new Set<HTMLElement>();
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => queue());
  const run = () => {
    queued = false;
    const rows = new Set(markWindowRows(area, doc));
    if (!resize) return;
    for (const row of watched) if (!rows.has(row)) resize.unobserve(row);
    for (const row of rows) if (!watched.has(row)) resize.observe(row);
    watched = rows;
  };
  function queue() {
    if (queued) return;
    queued = true;
    queueMicrotask(run);
  }
  run();
  const mutations = new MutationObserver((records) => {
    // Our own marks changing say nothing new.
    if (records.some((record) => record.type !== 'attributes' || !record.attributeName?.startsWith('data-window-'))) queue();
  });
  mutations.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
  resize?.observe(doc.documentElement);
  doc.addEventListener('transitionend', queue, true);
  return () => {
    mutations.disconnect();
    resize?.disconnect();
    doc.removeEventListener('transitionend', queue, true);
  };
}
