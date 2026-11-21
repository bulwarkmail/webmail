// @vitest-environment node
/**
 * The logo check reads attribute values as they are written. An XML parser reads them after
 * decoding character references (&#97; is "a"), and a CSS parser after dropping comments and
 * decoding escapes. So the check has to judge the value the drawing library will see:
 *  1. a <use> may not point at something that holds a <use>, however the id or the reference is
 *     spelled;
 *  2. a style attribute may not ask for a filter, however the property name is spelled.
 *
 * The drawing cases show what the library makes of each spelling, so a logo that the check accepts
 * is known to be drawn the way the check thinks it refused.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { checkedSvg, checkSvg } from '@/lib/bimi/svg';

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.2" baseProfile="tiny-ps" viewBox="0 0 100 100"><title>Brand</title>';
const TAIL = '</svg>';
const refused = (svg: string) => checkSvg(svg, { strictProfile: true }) !== null;

/** Alpha of the pixel at x, y of the logo drawn at 100 x 100. */
async function alphaAt(svg: string, x: number, y: number): Promise<number> {
  const raw = await sharp(Buffer.from(svg)).resize(100, 100).ensureAlpha().raw().toBuffer();
  return raw[(y * 100 + x) * 4 + 3];
}

/** A group of two <use> (id `id`), used once more through `href`: the square at 50,50 exists only through both levels. */
const twoLevels = (id: string, href: string) => `${HEAD}<defs><g id="a0"><rect width="10" height="10"/></g>`
  + `<g id="${id}"><use href="#a0"/><use href="#a0" x="50"/></g></defs><use href="${href}" y="50"/>${TAIL}`;

/** `10 ** levels` uses of one square, each level's id written with a character reference. */
function multiplied(levels: number): string {
  let defs = '<g id="&#97;0"><rect width="1" height="1"/></g>';
  for (let i = 1; i <= levels; i++) defs += `<g id="&#97;${i}">${`<use href="#a${i - 1}"/>`.repeat(10)}</g>`;
  return `${HEAD}<defs>${defs}</defs><use href="#a${levels}"/>${TAIL}`;
}

describe('a <use> of something that holds a <use>', () => {
  // Control: the plain spelling is refused today.
  it('is refused when written plainly', () => {
    expect(refused(twoLevels('a1', '#a1'))).toBe(true);
  });

  it.each([
    ['the id written with a character reference', twoLevels('&#97;1', '#a1')],
    ['the id written with a hexadecimal character reference', twoLevels('&#x61;1', '#a1')],
    ['the reference written with a character reference', twoLevels('a1', '#&#97;1')],
    ['both written with different references to the same character', twoLevels('a&amp;1', '#a&#38;1')],
  ])('is refused with %s', async (_name, svg) => {
    // The drawing library follows both levels: the inner square is painted.
    expect(await alphaAt(svg, 55, 55)).toBe(255);
    expect(refused(svg)).toBe(true);
  });

  it('is refused for a logo of 2 KB that multiplies one square a billion times', () => {
    const svg = multiplied(9);
    expect(Buffer.byteLength(svg)).toBeLessThan(2048);
    expect(refused(svg)).toBe(true);
  });
});

describe('a style attribute that asks for a filter', () => {
  const styled = (style: string) => `${HEAD}<rect x="40" y="40" width="20" height="20" style="${style}"/>${TAIL}`;

  // Control: the plain spelling is refused today, and without a filter nothing is painted outside the square.
  it('is refused when written plainly', async () => {
    expect(refused(styled('fill:#000;filter:blur(8px)'))).toBe(true);
    expect(await alphaAt(styled('fill:#000'), 33, 50)).toBe(0);
  });

  it.each([
    ['a character reference in the property name', 'fill:#000;&#102;ilter:blur(8px)'],
    ['a comment before the property name', 'fill:#000;/**/filter:blur(8px)'],
    ['a CSS escape in the property name', 'fill:#000;f\\69lter:blur(8px)'],
  ])('is refused with %s', async (_name, style) => {
    // The drawing library applies the filter: the blur paints outside the square.
    expect(await alphaAt(styled(style), 33, 50)).toBeGreaterThan(0);
    expect(refused(styled(style))).toBe(true);
  });

  it('is refused when an attribute is a character reference away from a filter or an outside address', () => {
    expect(refused(`${HEAD}<rect width="10" height="10" style="&#x66;&#x69;lter : blur(8px)"/>${TAIL}`)).toBe(true);
    expect(refused(`${HEAD}<rect width="10" height="10" fill="u&#114;l(https://pictures.example/p)"/>${TAIL}`)).toBe(true);
    expect(refused(`${HEAD}<use href="&#104;ttps://pictures.example/a.svg#x"/>${TAIL}`)).toBe(true);
  });
});

describe('what is drawn', () => {
  const honest = '<?xml version="1.0" encoding="utf-8"?>\n<!-- Made with a drawing tool -->\n'
    + '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.2" baseProfile="tiny-ps" viewBox="0 0 100 100">'
    + '<title>Brand &amp; Co</title><defs><circle id="&#100;ot" cx="5" cy="5" r="5" fill="#0a6"/></defs>'
    + '<rect width="40" height="40" style="fill:#06c"/><use xlink:href="#dot" x="60" y="60"/><![CDATA[ ]]></svg>';

  it('is the checked document: no comments, no instructions, references resolved', () => {
    const checked = checkedSvg(honest, { strictProfile: true });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.svg).not.toContain('<!--');
    expect(checked.svg).not.toContain('<?');
    expect(checked.svg).toContain('id="dot"');
    expect(checked.svg).toContain('<title>Brand &amp; Co</title>');
    // Checking what is drawn gives the same document again.
    expect(checkedSvg(checked.svg, { strictProfile: true })).toEqual(checked);
  });

  it('draws the same picture as the logo that came in', async () => {
    const checked = checkedSvg(honest, { strictProfile: true });
    if (!checked.ok) throw new Error(checked.reason);
    const pixels = (svg: string) => sharp(Buffer.from(svg)).resize(100, 100).ensureAlpha().raw().toBuffer();
    expect((await pixels(checked.svg)).equals(await pixels(honest))).toBe(true);
  });

  it('accepts a logo that starts with a byte order mark', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(checkSvg(`${bom}${HEAD}<rect width="100" height="100"/>${TAIL}`, { strictProfile: true })).toBeNull();
  });

  it('refuses what an XML parser would not read: stray characters, unknown entities, references to nothing', () => {
    for (const body of [
      `<rect width="1" height="1"/>${String.fromCharCode(1)}`,
      '<rect id="&nbsp;" width="1" height="1"/>',
      '<rect id="&#0;" width="1" height="1"/>',
      '<rect id="a &amp b" width="1" height="1"/>',
    ]) expect(refused(`${HEAD}${body}${TAIL}`)).toBe(true);
  });
});
