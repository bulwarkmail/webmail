const SVG_NS = 'http://www.w3.org/2000/svg';

// A neutral white band with black digits, rather than the conventional red
// badge. The band guarantees contrast for the count whatever the base icon
// looks like, which matters because `faviconUrl` is admin-overridable and may
// be any artwork. A coloured badge cannot make that guarantee: Bulwark's own
// icon is rgb(219,45,84), so a red badge sat red-on-red.
const BADGE_FILL = '#ffffff';
const BADGE_TEXT_FILL = '#000000';
const BADGE_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// The badge is a Gmail-style band across the bottom of the icon, sized as a
// fraction of the icon's own coordinate space so it lands correctly whatever
// viewBox the base declares.
//
// The fractions below are not invented: they are measured, pixel-by-pixel, off
// Gmail's real 16x16 tab favicon, which is the badge users actually compare this
// one against. Gmail's band is 10 of 16 px tall (0.625 of the icon span), its
// digits have a cap height of 7 of 16 px (0.44, i.e. a font-size of ~0.61 span),
// it is flush — edge to edge, and to the bottom, with no inset margin — and its
// corners carry a slight round, about 1px at 16px, which is roughly 0.1 of the
// band height. Not square, and emphatically not h/2.
//
// The box is sized to the label and centred, as Gmail's is: "5" must not squat
// on as much white as "99+" does.
//
// What keeps a three-glyph label legible is not the width — it is the small
// corner radius, plus budgeting the font against the FULL span rather than
// against the fitted box. The rounded-end pill that preceded this failed for the
// first reason: round ends (rx = h/2) squander their horizontal extent on the
// curve, which is exactly the space three glyphs need, so at 16px "99+" was an
// illegible smudge — and at one digit the same pill read as a plain circle. Do
// not reinstate rx = h/2. Because the font is budgeted against the full span,
// "99+" shrinks to the size that would fit edge to edge, and its box then grows
// to fill the icon width anyway; "9" and "47" render at the cap in a box that
// hugs them.
const BAND_HEIGHT = 0.625; // band height, as a fraction of the icon span
const FONT_MAX = 0.61; // font-size cap, as a fraction of the icon span
const PAD_FACTOR = 0.04; // horizontal padding, as a fraction of the icon span, each side
const CORNER_FACTOR = 0.1; // corner radius, as a fraction of band height
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
    const h = BAND_HEIGHT * span;
    const fontMax = FONT_MAX * span;
    const pad = PAD_FACTOR * span;

    // The font first, budgeted against the FULL span: the largest size that
    // would still leave the padding intact if the box ran edge to edge. That is
    // the cap for one or two glyphs and a modest shrink for "99+".
    const font = Math.min(fontMax, (span - 2 * pad) / (label.length * GLYPH_ADV));
    // The box then hugs the label — never wider than the icon, anchored to the
    // bottom-right corner. A three-glyph label, whose font was budgeted against
    // the whole span, fills that span exactly; shorter labels get a narrower
    // box, leaving the left of the base mark uncovered so the artwork stays
    // recognisable. Gmail's own badge does the same: measured off its 16px
    // favicon, a single digit sits hard right in a box about a third of the
    // icon wide. Centring was tried and rejected — at one digit the box lands
    // under the middle of the mark and bites a hole out of it.
    const textW = label.length * GLYPH_ADV * font;
    const w = Math.min(span, textW + 2 * pad);
    const x = minX + span - w;
    const y = minY + span - h;
    const rx = CORNER_FACTOR * h;

    const bandRect = doc.createElementNS(SVG_NS, 'rect');
    bandRect.setAttribute('x', String(x));
    bandRect.setAttribute('y', String(y));
    bandRect.setAttribute('width', String(w));
    bandRect.setAttribute('height', String(h));
    bandRect.setAttribute('rx', String(rx));
    bandRect.setAttribute('ry', String(rx));
    // Presentation attributes lose to any CSS rule in the same document, and a
    // branded base is free to carry `<style>rect{fill:#db2d54}</style>` — which
    // would paint the badge red-on-red, the exact failure the white band exists
    // to prevent. A style attribute outranks a stylesheet rule, so set both: the
    // attribute as the guarantee, the presentation attribute as the fallback.
    bandRect.setAttribute('fill', BADGE_FILL);
    bandRect.setAttribute('style', `fill:${BADGE_FILL}`);

    const text = doc.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(x + w / 2));
    text.setAttribute('y', String(y + h / 2));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('font-family', BADGE_FONT);
    // 500, not 700: at true 16px a bold count read visibly heavier than the
    // equivalent badge in Gmail's tab, which is the thing users compare it to.
    text.setAttribute('font-weight', '500');
    text.setAttribute('font-size', String(font));
    text.setAttribute('fill', BADGE_TEXT_FILL);
    text.setAttribute(
      'style',
      `fill:${BADGE_TEXT_FILL};font-family:${BADGE_FONT};font-weight:500;font-size:${font}px`,
    );
    text.textContent = label;

    root.appendChild(bandRect);
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
