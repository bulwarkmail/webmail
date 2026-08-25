const SVG_NS = 'http://www.w3.org/2000/svg';

// A conventional notification badge — deep-rose fill, white digits — wearing a
// thin white keyline ring. Two designs preceded it, and the ring is what
// reconciles their failures:
//
//   - A bare red pill: invisible on Bulwark's own icon, which is itself
//     rgb(219,45,84). `faviconUrl` is admin-overridable, so no fill colour can
//     ever be guaranteed to differ from the artwork behind it.
//   - A flat white band with black digits (Gmail-measured geometry): contrast
//     guaranteed, but it read as a white sticker slapped across the logo — a
//     sharp-cornered slab covering most of the icon, with nothing marking it as
//     a *badge*.
//
// The keyline is the guarantee the white band bought, without the slab: against
// dark or saturated artwork the white ring separates the badge; against white
// or pale artwork the ring vanishes but the deep fill is the edge. The pair
// covers every base icon, so neither half may be dropped. Digit contrast is
// fixed (white on the fill) and independent of the artwork entirely.
//
// The fill is the Bulwark brand red darkened to ~40% lightness: dark enough to
// read as a distinct badge on the brand icon itself (with the ring between
// them), and ~6.9:1 against the white digits.
const BADGE_FILL = '#af1d3f';
const BADGE_RING = '#ffffff';
const BADGE_TEXT_FILL = '#ffffff';
const BADGE_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// Geometry, as fractions of the icon's own coordinate span so it lands
// correctly whatever viewBox the base declares. Reference pixel sizes are for
// the 16px tab rendering, which is what the fractions were tuned at.
//
// What keeps a three-glyph label legible is the modest corner radius plus
// budgeting the font against the FULL span rather than against the fitted box.
// Round ends (rx = h/2) squander their horizontal extent on the curve, which is
// exactly the space three glyphs need — at 16px "99+" was an illegible smudge,
// and at one digit the same pill read as a plain circle. Do not reinstate
// rx = h/2. Because the font is budgeted against the full span, "99+" shrinks
// to the size that fits edge to edge and its badge grows to fill the icon
// width; "9" and "47" render at the cap in a badge that hugs them.
const RING_FACTOR = 0.0625; // keyline width, as a fraction of the icon span (~1px at 16)
const BADGE_HEIGHT = 0.48; // fill-rect height, as a fraction of the icon span (~7.7px at 16)
const FONT_MAX = 0.46; // font-size cap, as a fraction of the icon span
const PAD_FACTOR = 0.045; // horizontal padding inside the fill rect, per side, as a fraction of the span
const CORNER_FACTOR = 0.3; // fill-rect corner radius, as a fraction of the fill-rect height
const GLYPH_ADV = 0.6; // advance width per glyph, in em, for the sans badge font

// Counts above this render as "99+". Gmail caps at 20, and matching it was
// tried and reverted: the cap decides how often the label needs three glyphs,
// and three glyphs do not fit at the full font size. Capping at 20 meant a
// typical inbox showed "20+" at 84% of the cap size essentially always, where
// capping at 99 shows a real two-digit count at full size. Bigger digits and a
// number you can act on beat parity with Gmail's ceiling.
const BADGE_MAX = 99;

/**
 * Formats an unread count for display in the badge.
 * Returns an empty string when there is nothing to show.
 */
export function formatBadgeCount(count: number): string {
  // `< 1`, not `<= 0`: a fractional count such as 0.5 would otherwise floor to
  // 0 and draw a "0" badge, since String(0) is truthy.
  if (!Number.isFinite(count) || count < 1) return '';
  const whole = Math.floor(count);
  return whole > BADGE_MAX ? `${BADGE_MAX}+` : String(whole);
}

/**
 * Strips anything active from the base SVG.
 *
 * The base may be an admin-uploaded file, which the branding route deliberately
 * serves under a sandboxing CSP because SVG can carry script (see
 * app/api/admin/branding/[filename]/route.ts). Re-emitting it verbatim as a
 * same-origin `data:` URL inside our own document would un-fence exactly what
 * that CSP fences, so remove script, foreignObject and every on* handler first.
 */
function sanitiseSvg(doc: Document): void {
  doc.querySelectorAll('script, foreignObject').forEach((el) => el.remove());

  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) {
        el.removeAttributeNS(attr.namespaceURI, attr.localName);
      }
    }
  });
}

/**
 * Composes an unread badge over an SVG favicon and returns it as a data URL.
 *
 * Returns null — meaning "leave the favicon alone" — when the count is zero,
 * or when the source is not usable SVG. Never throws.
 */
export function renderBadgedFavicon(baseSvgSource: string, count: number): string | null {
  const label = formatBadgeCount(count);
  if (!label) return null;

  try {
    const doc = new DOMParser().parseFromString(baseSvgSource, 'image/svg+xml');

    if (doc.querySelector('parsererror')) return null;

    const root = doc.documentElement;
    // The namespace, not just the tag name: an <svg> with no xmlns parses fine
    // but renders as nothing, so it would yield a non-null, blank data URL.
    if (!root || root.localName !== 'svg' || root.namespaceURI !== SVG_NS) return null;

    const viewBox = root.getAttribute('viewBox');
    if (!viewBox) return null;

    const [rawMinX, rawMinY, rawWidth, rawHeight] = viewBox.trim().split(/[\s,]+/).map(Number);
    if (
      ![rawMinX, rawMinY, rawWidth, rawHeight].every(Number.isFinite) ||
      rawWidth <= 0 ||
      rawHeight <= 0
    ) {
      return null;
    }

    sanitiseSvg(doc);

    // The base declares "1000pt"; point units in a favicon are unreliable.
    // Unitless 16 with the viewBox retained lets the browser rasterise cleanly
    // at any size it asks for.
    root.setAttribute('width', '16');
    root.setAttribute('height', '16');

    // Normalise the viewBox to a square, centred on the original, before doing
    // any badge maths. Sizing the badge off min(width, height) double-penalised
    // a non-square base: a 100x20 wordmark produced a ~2px-tall smudge on a
    // 16px icon. Squaring first sizes the badge against the box the icon is
    // actually painted into. It is a no-op for a square viewBox (Bulwark's own
    // is 0 0 1000 1000). Caveat: a base that pairs a non-square viewBox with
    // preserveAspectRatio="none" will now letterbox rather than stretch — an
    // acceptable, arguably better, trade for a favicon, which is always square.
    const side = Math.max(rawWidth, rawHeight);
    const minX = rawMinX - (side - rawWidth) / 2;
    const minY = rawMinY - (side - rawHeight) / 2;
    root.setAttribute('viewBox', `${minX} ${minY} ${side} ${side}`);

    const span = side;
    const ring = RING_FACTOR * span;
    const h = BADGE_HEIGHT * span;
    const fontMax = FONT_MAX * span;
    const pad = PAD_FACTOR * span;

    // The font first, budgeted against the FULL span: the largest size that
    // would still leave the ring and padding intact if the badge ran edge to
    // edge. That is the cap for one or two glyphs and a modest shrink for "99+".
    const font = Math.min(fontMax, (span - 2 * ring - 2 * pad) / (label.length * GLYPH_ADV));
    // The badge then hugs the label — never wider than the icon, anchored to
    // the bottom-right corner. A three-glyph label, whose font was budgeted
    // against the whole span, fills that span exactly; shorter labels get a
    // narrower badge, leaving the left of the base mark uncovered so the
    // artwork stays recognisable. Centring was tried and rejected — at one
    // digit the badge lands under the middle of the mark and bites a hole out
    // of it.
    const textW = label.length * GLYPH_ADV * font;
    const w = Math.min(span - 2 * ring, textW + 2 * pad);
    // The ring is drawn as a white rect underneath the fill rect, inflated by
    // the ring width on every side, not as a stroke: a stroke straddles the
    // edge, halving the visible keyline and shrinking the fill. The halo is
    // flush to the icon's bottom-right corner; the fill rect sits inset within
    // it, so the ring shows on all four sides.
    const haloW = w + 2 * ring;
    const haloH = h + 2 * ring;
    const haloX = minX + span - haloW;
    const haloY = minY + span - haloH;
    const x = haloX + ring;
    const y = haloY + ring;
    const rx = CORNER_FACTOR * h;

    // Presentation attributes lose to any CSS rule in the same document, and a
    // branded base is free to carry `<style>rect{fill:#db2d54}</style>` — which
    // would repaint the badge in the artwork's own colour, the exact failure
    // the keyline exists to prevent. A style attribute outranks a stylesheet
    // rule, so set both: the attribute as the fallback, the style as the
    // guarantee.
    const haloRect = doc.createElementNS(SVG_NS, 'rect');
    haloRect.setAttribute('x', String(haloX));
    haloRect.setAttribute('y', String(haloY));
    haloRect.setAttribute('width', String(haloW));
    haloRect.setAttribute('height', String(haloH));
    haloRect.setAttribute('rx', String(rx + ring));
    haloRect.setAttribute('ry', String(rx + ring));
    haloRect.setAttribute('fill', BADGE_RING);
    haloRect.setAttribute('style', `fill:${BADGE_RING}`);

    const fillRect = doc.createElementNS(SVG_NS, 'rect');
    fillRect.setAttribute('x', String(x));
    fillRect.setAttribute('y', String(y));
    fillRect.setAttribute('width', String(w));
    fillRect.setAttribute('height', String(h));
    fillRect.setAttribute('rx', String(rx));
    fillRect.setAttribute('ry', String(rx));
    fillRect.setAttribute('fill', BADGE_FILL);
    fillRect.setAttribute('style', `fill:${BADGE_FILL}`);

    const text = doc.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(x + w / 2));
    text.setAttribute('y', String(y + h / 2));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('font-family', BADGE_FONT);
    // 600, not the 500 the black-on-white band used: light-on-dark digits lose
    // stroke weight to anti-aliasing at 16px, so they need the extra grade to
    // read as crisply as dark-on-light ones did.
    text.setAttribute('font-weight', '600');
    text.setAttribute('font-size', String(font));
    text.setAttribute('fill', BADGE_TEXT_FILL);
    text.setAttribute(
      'style',
      `fill:${BADGE_TEXT_FILL};font-family:${BADGE_FONT};font-weight:600;font-size:${font}px`,
    );
    text.textContent = label;

    root.appendChild(haloRect);
    root.appendChild(fillRect);
    root.appendChild(text);

    const serialised = new XMLSerializer().serializeToString(doc);

    // Percent-encoding rather than base64: btoa throws on any character outside
    // Latin-1, which a branded SVG may well contain. encodeURIComponent itself
    // throws on an unpaired surrogate, so this whole tail is guarded. It must be
    // encodeURIComponent, not encodeURI: the latter leaves "#" bare, and a bare
    // "#" in a colour truncates the data URL at the first fill.
    return `data:image/svg+xml,${encodeURIComponent(serialised)}`;
  } catch {
    return null;
  }
}
