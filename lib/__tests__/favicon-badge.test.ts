import { describe, it, expect } from 'vitest';
import { formatBadgeCount, renderBadgedFavicon } from '@/lib/favicon-badge';

const BASE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="1000pt" height="1000pt"><defs><clipPath id="_clip1"><rect width="1000" height="1000"/></clipPath></defs><g clip-path="url(#_clip1)"><rect width="1000" height="1000" fill="#123456"/></g></svg>`;

function decode(dataUrl: string): string {
  return decodeURIComponent(dataUrl.replace('data:image/svg+xml,', ''));
}

/** The badge band: the last <rect> the renderer appends, identified by its fill. */
function band(svg: string): { x: number; y: number; w: number; h: number; rx: number } {
  const match =
    /<rect[^>]*\bx="(-?[\d.]+)"[^>]*\by="(-?[\d.]+)"[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"[^>]*\brx="([\d.]+)"[^>]*fill="#ffffff"/.exec(
      svg,
    );
  expect(match).not.toBeNull();
  const [, x, y, w, h, rx] = match!.map(Number);
  return { x, y, w, h, rx };
}

function fontSize(svg: string): number {
  return Number(/<text[^>]*font-size="([\d.]+)"/.exec(svg)![1]);
}

function viewBoxOf(svg: string): { minX: number; minY: number; width: number; height: number } {
  const [minX, minY, width, height] = /viewBox="([^"]+)"/
    .exec(svg)![1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  return { minX, minY, width, height };
}

describe('formatBadgeCount', () => {
  it('returns an empty string for zero and below', () => {
    expect(formatBadgeCount(0)).toBe('');
    expect(formatBadgeCount(-3)).toBe('');
  });

  it('returns the count verbatim from 1 to 99', () => {
    expect(formatBadgeCount(1)).toBe('1');
    expect(formatBadgeCount(9)).toBe('9');
    expect(formatBadgeCount(47)).toBe('47');
    expect(formatBadgeCount(99)).toBe('99');
  });

  it('caps at 99+ above 99', () => {
    // Gmail caps at 20; matching it was tried and reverted. A lower cap means a
    // typical inbox needs three glyphs almost always, and three glyphs do not
    // fit at the full font size — so "99+" rendered permanently smaller than a
    // real two-digit count would have.
    expect(formatBadgeCount(100)).toBe('99+');
    expect(formatBadgeCount(133)).toBe('99+');
    expect(formatBadgeCount(1000)).toBe('99+');
  });

  it('returns an empty string for non-finite input', () => {
    expect(formatBadgeCount(Number.NaN)).toBe('');
    expect(formatBadgeCount(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('renderBadgedFavicon', () => {
  it('returns null when the count is zero', () => {
    expect(renderBadgedFavicon(BASE_SVG, 0)).toBeNull();
  });

  it('returns null when the source is not SVG', () => {
    expect(renderBadgedFavicon('this is not svg', 3)).toBeNull();
  });

  it('returns null when the root element is not <svg>', () => {
    expect(renderBadgedFavicon('<html><body/></html>', 3)).toBeNull();
  });

  it('returns null when the root has no viewBox', () => {
    const noViewBox = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>`;
    expect(renderBadgedFavicon(noViewBox, 3)).toBeNull();
  });

  it('returns a percent-encoded svg data URL', () => {
    const url = renderBadgedFavicon(BASE_SVG, 3);
    expect(url).not.toBeNull();
    expect(url!.startsWith('data:image/svg+xml,')).toBe(true);
  });

  it('draws a badge band and the count text', () => {
    const svg = decode(renderBadgedFavicon(BASE_SVG, 3)!);
    expect(svg).toContain('<rect');
    expect(svg).toContain('>3<');
  });

  it('renders 99+ for large counts', () => {
    const svg = decode(renderBadgedFavicon(BASE_SVG, 250)!);
    expect(svg).toContain('>99+<');
  });

  it('preserves the base artwork and its clipPath id', () => {
    const svg = decode(renderBadgedFavicon(BASE_SVG, 3)!);
    expect(svg).toContain('id="_clip1"');
    expect(svg).toContain('#123456');
  });

  it('overrides pt-unit width and height with unitless 16 and keeps the viewBox', () => {
    const svg = decode(renderBadgedFavicon(BASE_SVG, 3)!);
    expect(svg).toContain('width="16"');
    expect(svg).toContain('height="16"');
    expect(svg).toContain('viewBox="0 0 1000 1000"');
    expect(svg).not.toContain('1000pt');
  });

  it('draws a white band with black digits, so the count stays legible over any base icon', () => {
    const svg = decode(renderBadgedFavicon(BASE_SVG, 3)!);
    expect(svg).toMatch(/<rect[^>]*fill="#ffffff"/);
    expect(svg).toMatch(/<text[^>]*fill="#000000"/);
  });

  it('shrinks the font as the label grows so three glyphs still fit', () => {
    const one = decode(renderBadgedFavicon(BASE_SVG, 3)!);
    const three = decode(renderBadgedFavicon(BASE_SVG, 250)!);
    expect(fontSize(three)).toBeLessThan(fontSize(one));
  });

  it('returns null rather than throwing when the source contains a lone surrogate', () => {
    const bad = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>abc\uD800def</title></svg>`;
    expect(() => renderBadgedFavicon(bad, 3)).not.toThrow();
    expect(renderBadgedFavicon(bad, 3)).toBeNull();
  });

  it('sizes the band to the label, and only "99+" fills the full icon width', () => {
    // The box is only as wide as its digits need — "5" must not squat on as much
    // white as "99+". It is never wider than the icon, and three glyphs, whose
    // font is budgeted against the full span, grow to exactly fill it.
    const w = (count: number) => band(decode(renderBadgedFavicon(BASE_SVG, count)!)).w;
    expect(w(7)).toBeLessThan(w(47));
    expect(w(47)).toBeLessThan(w(250));
    expect(w(250)).toBeCloseTo(1000, 5);
  });

  it('matches the geometry measured from Gmail\'s 16px favicon', () => {
    // Ground truth, measured pixel-by-pixel off Gmail's tab icon and scaled to a
    // 0 0 1000 1000 viewBox: band 10/16 of the icon (0.625), flush to the bottom
    // edge, corners rounded by 0.1h, width fitted to the label, anchored right.
    // Gmail's own single-digit badge sits hard right in a box about a third of
    // the icon wide, so the box grows leftwards from the corner.
    // w = label.length * 0.6 * font + 2 * 0.04 * 1000, x = 1000 - w.
    const expected: Record<string, { x: number; w: number; font: number }> = {
      '5': { x: 554, w: 446, font: 610 }, // textW = 1 * 0.6 * 610 = 366
      '15': { x: 188, w: 812, font: 610 }, // textW = 2 * 0.6 * 610 = 732
      '250': { x: 0, w: 1000, font: 920 / 1.8 }, // "99+": font = (1000 - 80) / (3 * 0.6)
    };
    for (const [count, want] of Object.entries(expected)) {
      const svg = decode(renderBadgedFavicon(BASE_SVG, Number(count))!);
      const { x, y, w, h, rx } = band(svg);
      expect(x).toBeCloseTo(want.x, 5);
      expect(w).toBeCloseTo(want.w, 5);
      expect(fontSize(svg)).toBeCloseTo(want.font, 5);
      expect(y).toBeCloseTo(375, 5);
      expect(h).toBeCloseTo(625, 5);
      expect(rx).toBeCloseTo(62.5, 5);
    }
  });

  it('anchors the band to the right edge, including on a negative-origin viewBox', () => {
    // Corner-anchored, not centred: the box grows leftwards from the bottom-right
    // corner, so its right edge sits on minX + span whatever the label. Centring
    // was rejected — at a single digit it lands under the middle of the mark.
    const cases: [string, number, number][] = [
      // [base svg, minX, span]
      [BASE_SVG, 0, 1000],
      [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 24 24"><rect x="-4" y="-4" width="24" height="24" fill="#123456"/></svg>`, -4, 24],
    ];
    for (const [svgSource, minX, span] of cases) {
      for (const count of [7, 47, 250]) {
        const { x, w } = band(decode(renderBadgedFavicon(svgSource, count)!));
        expect(x + w).toBeCloseTo(minX + span, 5);
        expect(x).toBeGreaterThanOrEqual(minX);
      }
    }
  });

  it('renders 1- and 2-digit labels at the max font size, and shrinks only for "99+"', () => {
    // The font is budgeted against the full icon span, not against the fitted
    // box, so one or two glyphs always land at FONT_MAX; only three force a
    // shrink — and their box then grows to fill the icon.
    const FONT_MAX = 0.61 * 1000;
    const one = decode(renderBadgedFavicon(BASE_SVG, 7)!);
    const two = decode(renderBadgedFavicon(BASE_SVG, 47)!);
    const three = decode(renderBadgedFavicon(BASE_SVG, 250)!);
    expect(fontSize(one)).toBeCloseTo(FONT_MAX, 5);
    expect(fontSize(two)).toBeCloseTo(FONT_MAX, 5);
    expect(fontSize(three)).toBeLessThan(FONT_MAX);
  });

  it('rounds the band corners slightly — neither an oval nor a hard square', () => {
    // rx = h / 2 was the pill: at one digit it read as a circle, at two an oval,
    // and "99+" was a smudge. rx = 0 is the other failure: Gmail's corners carry
    // a visible ~1px round at 16px. Guard against a silent revert to either.
    for (const count of [7, 47, 250]) {
      const { h, rx } = band(decode(renderBadgedFavicon(BASE_SVG, count)!));
      expect(rx).toBeCloseTo(0.1 * h, 5);
      expect(rx).toBeGreaterThan(0);
      expect(rx).toBeLessThan(h / 2);
    }
  });

  it('draws the digits at font-weight 500, in both the attribute and the style', () => {
    // 700 read visibly heavier than Gmail's equivalent badge.
    const svg = decode(renderBadgedFavicon(BASE_SVG, 3)!);
    expect(svg).toMatch(/<text[^>]*font-weight="500"/);
    expect(svg).toMatch(/<text[^>]*style="[^"]*font-weight:\s*500/);
  });

  it('keeps the badge band entirely inside the viewBox for 1, 2, and 3-glyph labels', () => {
    // The band is flush to the bottom and, at three glyphs, to the left and
    // right edges too — but it must never overflow any of them.
    for (const count of [7, 47, 250]) {
      const svg = decode(renderBadgedFavicon(BASE_SVG, count)!);
      const { x, y, w, h } = band(svg);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(1000);
      expect(y + h).toBeLessThanOrEqual(1000);
    }
  });

  // A previous version of this test used /\bx="([\d.]+)"/, which cannot match a
  // negative number: dropping `minX +` from the anchoring passed it. Anchor
  // against a viewBox whose origin is negative, where the band's own x is
  // legitimately negative, so the offset is genuinely pinned.
  it('anchors the band to the viewBox origin, including a negative origin', () => {
    const NEGATIVE_ORIGIN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-40 -40 240 240"><rect x="-40" y="-40" width="240" height="240" fill="#123456"/></svg>`;
    for (const count of [7, 47, 250]) {
      const svg = decode(renderBadgedFavicon(NEGATIVE_ORIGIN, count)!);
      const { x, y, w, h } = band(svg);
      expect(x).toBeGreaterThanOrEqual(-40);
      expect(y).toBeGreaterThanOrEqual(-40);
      expect(x + w).toBeLessThanOrEqual(200);
      expect(y + h).toBeLessThanOrEqual(200);
      // Anchored to the bottom-right: in a viewBox running from -40 to 200, the
      // band's bottom edge and its right edge both sit well past the midpoint.
      expect(x + w).toBeGreaterThan(80);
      expect(y + h).toBeGreaterThan(80);
    }
  });

  it('fits the label inside the band, with padding, for every label length', () => {
    // The core band invariant: textW + 2 * pad <= w, where the glyph advance and
    // padding are the renderer's own published constants. PAD_FACTOR is a
    // fraction of the icon span, not of the fitted box, so the padding is the
    // same at every label length.
    const GLYPH_ADV = 0.6;
    const PAD_FACTOR = 0.04;
    for (const count of [7, 47, 250]) {
      const svg = decode(renderBadgedFavicon(BASE_SVG, count)!);
      const { w } = band(svg);
      const label = count > 99 ? '99+' : String(count);
      const textW = label.length * GLYPH_ADV * fontSize(svg);
      const pad = PAD_FACTOR * 1000;
      expect(textW + 2 * pad).toBeLessThanOrEqual(w + 1e-6);
    }
  });

  it('percent-encodes the payload, so a "#" in a fill cannot truncate the data URL', () => {
    const url = renderBadgedFavicon(BASE_SVG, 3)!;
    // encodeURI leaves "#" bare, which the browser reads as a fragment
    // delimiter: everything after the first colour would be silently dropped.
    expect(url).toContain('%23');
    expect(url).not.toContain('#');
  });

  it('returns an empty label, and no badge, for a fractional count below one', () => {
    expect(formatBadgeCount(0.5)).toBe('');
    expect(renderBadgedFavicon(BASE_SVG, 0.5)).toBeNull();
  });

  it('returns null when the root svg has no SVG namespace', () => {
    // Non-null but unrenderable: a data URL built from this would show nothing.
    const noNs = `<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>`;
    expect(renderBadgedFavicon(noNs, 3)).toBeNull();
  });

  it('beats a stylesheet in the base SVG, keeping the badge white-on-black', () => {
    // Presentation attributes lose to any CSS rule in the document. A branded
    // base carrying `rect { fill: #db2d54 }` would otherwise paint the band red
    // and the digits red — exactly what the white band exists to prevent.
    const STYLED = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><style>rect{fill:#db2d54}text{fill:#db2d54}</style><rect width="1000" height="1000"/></svg>`;
    const svg = decode(renderBadgedFavicon(STYLED, 3)!);
    expect(svg).toMatch(/<rect[^>]*style="[^"]*fill:\s*#ffffff/);
    expect(svg).toMatch(/<text[^>]*style="[^"]*fill:\s*#000000/);
  });

  it('strips scripts, foreignObject and event handlers from the base SVG', () => {
    // The base may be an admin-uploaded file, which upstream serves under a
    // sandboxing CSP precisely because SVG can carry script. Re-emitting it as a
    // same-origin data: URL would un-fence it, so sanitise before serialising.
    const HOSTILE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" onload="alert(1)"><script>alert(2)</script><foreignObject width="100" height="100"><body xmlns="http://www.w3.org/1999/xhtml">hi</body></foreignObject><rect width="100" height="100" onclick="alert(3)" ONMOUSEOVER="alert(4)" fill="#123456"/></svg>`;
    const url = renderBadgedFavicon(HOSTILE, 3)!;
    expect(url).not.toBeNull();
    const svg = decode(url);
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('foreignObject');
    expect(svg.toLowerCase()).not.toContain('onload');
    expect(svg.toLowerCase()).not.toContain('onclick');
    expect(svg.toLowerCase()).not.toContain('onmouseover');
    expect(svg).not.toContain('alert');
    // The legitimate artwork survives.
    expect(svg).toContain('#123456');
  });

  it('normalises a non-square viewBox to a square, so the badge stays legible', () => {
    // A 100x20 wordmark: span = min(w, h) = 20 previously produced a ~2px-tall
    // smudge on a 16px icon. Squaring the viewBox first sizes the badge against
    // the rendered box instead.
    const WORDMARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20"><rect width="100" height="20" fill="#123456"/></svg>`;
    const svg = decode(renderBadgedFavicon(WORDMARK, 42)!);

    const vb = viewBoxOf(svg);
    expect(vb.width).toBe(100);
    expect(vb.height).toBe(100);
    expect(vb.minX).toBe(0);
    expect(vb.minY).toBe(-40); // centred: (100 - 20) / 2 above and below

    const { x, y, w, h } = band(svg);
    // Sized against the square side (100), not the 20-unit short axis.
    expect(h).toBeCloseTo(0.625 * 100, 5);
    // Two glyphs at FONT_MAX (61) plus padding: 2 * 0.6 * 61 + 2 * 4 = 81.2,
    // anchored to the right of the squared span.
    expect(w).toBeCloseTo(81.2, 5);
    expect(x + w).toBeCloseTo(100, 5);
    // Still in bounds of the normalised viewBox.
    expect(x).toBeGreaterThanOrEqual(vb.minX);
    expect(y).toBeGreaterThanOrEqual(vb.minY);
    expect(x + w).toBeLessThanOrEqual(vb.minX + vb.width);
    expect(y + h).toBeLessThanOrEqual(vb.minY + vb.height);
  });

  it('leaves a square viewBox untouched', () => {
    const svg = decode(renderBadgedFavicon(BASE_SVG, 3)!);
    expect(svg).toContain('viewBox="0 0 1000 1000"');
  });
});
