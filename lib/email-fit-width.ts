/**
 * Scale-to-fit for email bodies rendered inside the sandboxed viewer iframes.
 *
 * A lot of mail is authored at a fixed desktop width (the 600-800px table is
 * the newsletter default). On a phone that content is wider than the iframe,
 * so the reader has to swipe sideways through every message - or, where the
 * iframe clips instead of scrolling, never sees the right-hand half at all.
 *
 * Native mail clients solve this by shrinking the whole body to the screen
 * width, which is what these helpers do: lay the body out at its intrinsic
 * width and then `transform: scale()` it down. Layout is preserved exactly
 * (unlike forcing everything to `width: 100%`, which crushes wide data tables
 * into one-character columns - issue #409), and the reader can still pinch-zoom
 * to read the fine print.
 *
 * Only narrow viewports are scaled. On a desktop reading pane a wide table
 * still scrolls horizontally inside the body, which is the better trade-off
 * there: the content is legible at 1:1 and there is a mouse to scroll with.
 *
 * Before any of that, tables whose own fixed width is wider than the body are
 * let go to reflow (see releaseFixedWidthTables) - scaling is for content that
 * can't reflow, not for text the sender merely boxed in at 800px.
 */

/** Widest iframe that still counts as "a phone" for scale-to-fit purposes. */
export const FIT_VIEWPORT_MAX = 640;

/**
 * Never shrink past this. An email that would need more (a 2000px data table
 * on a 390px screen) is unreadable when scaled, so it keeps the horizontal
 * scroll instead and the reader pans through it at a legible size.
 */
export const FIT_MIN_SCALE = 0.4;

export interface FitOptions {
  /**
   * Set false on a desktop layout: a wide mail there is legible at 1:1 and the
   * reading pane can scroll. Any fit already applied is undone. Fixed-width
   * tables are released either way - that is the viewer stylesheet's table cap
   * doing its job, not a phone behaviour.
   */
  enabled?: boolean;
  /** Iframes at least this wide are left at 1:1. */
  viewportMax?: number;
  /** Lower bound on the scale factor. */
  minScale?: number;
}

/**
 * The factor a body of `contentWidth` must be scaled by to fit `viewportWidth`,
 * or 1 when it should be left alone (already fits, not a narrow viewport, or
 * would have to shrink past `minScale`).
 */
export function computeFitScale(
  contentWidth: number,
  viewportWidth: number,
  { viewportMax = FIT_VIEWPORT_MAX, minScale = FIT_MIN_SCALE }: FitOptions = {},
): number {
  if (!(contentWidth > 0) || !(viewportWidth > 0)) return 1;
  if (viewportWidth > viewportMax) return 1;
  // 1px of slack: sub-pixel layout rounding routinely reports a scrollWidth a
  // hair over clientWidth on content that visually fits.
  if (contentWidth <= viewportWidth + 1) return 1;
  const scale = viewportWidth / contentWidth;
  return scale < minScale ? 1 : scale;
}

/** Undo a fit, leaving the body laid out at the iframe's own width. */
function clearFit(body: HTMLElement): void {
  body.style.transform = '';
  body.style.width = '';
  body.style.boxSizing = '';
}

/** Widest thing in the document. */
function measureContentWidth(doc: Document): number {
  return Math.max(doc.body.scrollWidth, doc.documentElement.scrollWidth);
}

const RELEASED_ATTR = 'data-bulwark-fit-released';

/**
 * The width a table pins itself to - a `width="800"` attribute or an inline
 * `width: 700px` - or null for auto/percentage widths, which already give way.
 * Inline style wins over the attribute, as it does in the cascade.
 */
function fixedTableWidth(table: HTMLTableElement): string | null {
  const inline = table.style.width.trim();
  if (inline) return /^\d*\.?\d+[a-z]+$/i.test(inline) ? inline : null;
  const attr = /^\s*(\d*\.?\d+)(?:px)?\s*$/i.exec(table.getAttribute('width') ?? '');
  return attr ? `${attr[1]}px` : null;
}

/**
 * Let fixed-width tables that are wider than the body shrink to it, returning
 * how many were released.
 *
 * The viewer stylesheet caps tables at `max-width: 100%`, but WebKit ignores
 * that cap for a table with a fixed width: it treats the fixed width as the
 * table's minimum. So on iOS every mail wrapped in `<table width="800">` laid
 * its text out 800px wide - one sideways swipe per line (#1020) - where Chrome
 * reflows it. A fixed-width table nested in another table stays wide in every
 * engine, since the percentage cap has nothing definite to resolve against.
 *
 * Swapping the width for `width: 100%` sidesteps both; the old width moves to
 * `max-width` so a pane that later grows puts the table back at its size.
 * Only tables that are too wide are touched, so a mail that fits looks exactly
 * as it did. The table still can't go narrower than its content (a long word,
 * a 20-column data table), so what can't reflow is left to the scale-to-fit.
 */
export function releaseFixedWidthTables(doc: Document): number {
  const body = doc.body;
  const style = doc.defaultView?.getComputedStyle(body);
  const available = body.clientWidth
    - (parseFloat(style?.paddingLeft ?? '') || 0)
    - (parseFloat(style?.paddingRight ?? '') || 0);
  if (!(available > 0)) return 0;

  // Measure every candidate before writing any, so the loop costs one layout
  // rather than one per table.
  const overwide: Array<[HTMLTableElement, string]> = [];
  doc.querySelectorAll('table').forEach((table) => {
    if (table.hasAttribute(RELEASED_ATTR)) return;
    const width = fixedTableWidth(table);
    if (width && table.offsetWidth > available + 1) overwide.push([table, width]);
  });

  for (const [table, width] of overwide) {
    table.setAttribute(RELEASED_ATTR, '');
    // !important so it also beats a `width: 800px !important` in the mail's
    // own <style>.
    table.style.setProperty('width', '100%', 'important');
    table.style.setProperty('max-width', width);
  }
  return overwide.length;
}

/**
 * Fit the document body into its iframe, returning the scale that was applied
 * (1 = untouched). Idempotent: every call re-measures from the unscaled layout,
 * so it can be re-run as images load and the content reflows.
 *
 * The caller owns the iframe height - multiply the measured (unscaled) content
 * height by the returned scale, since a transform does not change layout size.
 */
export function fitEmailBodyWidth(doc: Document, options: FitOptions = {}): number {
  const body = doc.body;
  if (!body) return 1;

  // Measure the intrinsic layout, not the one a previous call left behind.
  clearFit(body);
  releaseFixedWidthTables(doc);
  if (options.enabled === false) return 1;

  const viewport = doc.documentElement.clientWidth;
  let content = measureContentWidth(doc);
  let scale = computeFitScale(content, viewport, options);
  if (scale === 1) return 1;

  // border-box, so the width we set (measured as a scrollWidth, which already
  // covers the body's own padding) doesn't add that padding a second time on
  // every pass and creep wider - which scales the mail down further than it
  // needs to be and leaves a gap down the side.
  body.style.boxSizing = 'border-box';

  // Widening the body to its content width can reveal more width: percentage-
  // sized children re-lay out against the new containing block, and a table
  // with `width: 100%` next to a fixed-width sibling grows with it. Settle over
  // a couple of passes rather than scaling against a stale measurement.
  for (let pass = 0; pass < 3; pass++) {
    body.style.width = `${content}px`;
    const grown = measureContentWidth(doc);
    if (grown <= content + 1) break;
    content = grown;
    scale = computeFitScale(content, viewport, options);
    if (scale === 1) {
      // Grew past the shrink floor - back out and leave it scrolling.
      clearFit(body);
      return 1;
    }
  }

  // Anchor the shrink at the inline start so the content stays flush with the
  // edge the reader's eye starts from.
  const rtl = doc.defaultView?.getComputedStyle(body).direction === 'rtl';
  body.style.transformOrigin = rtl ? 'top right' : 'top left';
  body.style.transform = `scale(${scale})`;
  return scale;
}
