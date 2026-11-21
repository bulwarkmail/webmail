// @vitest-environment node
/**
 * The check reads a style attribute the way a CSS parser does before it looks for properties the
 * profile doesn't have. A CSS parser sees a comment only where one can start: "/*" inside a quoted
 * string, inside url(...) or after a backslash is ordinary text to it, and the declarations after
 * it still apply. So the check must not skip them either: a logo whose style asks for a filter is
 * refused, or what is handed to the drawing no longer carries the filter.
 *
 * A style attribute may set a short list of properties to plain values. What is drawn is those
 * declarations written out again, not the text that came in.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { validateMarkCertificate } from '@/lib/bimi/certificate';
import { bimiRoots } from '@/lib/bimi/roots';
import { checkedStyle } from '@/lib/bimi/style';
import { checkedSvg } from '@/lib/bimi/svg';

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 100 100"><title>Brand</title>';
const TAIL = '</svg>';
/** A square in the middle; `style` is written into a double-quoted attribute. */
const logo = (style: string) => `${HEAD}<rect x="30" y="30" width="40" height="40" fill="#06c" style="${style}"/>${TAIL}`;
const pixels = (svg: string) => sharp(Buffer.from(svg, 'utf8')).resize(100, 100).ensureAlpha().raw().toBuffer();
const strict = { strictProfile: true };

/**
 * Whether the logo is refused, or else drawn exactly like `plain` (the same logo with the filter
 * left out). Either is fine; a blurred square is not.
 */
async function withoutEffect(style: string, plain: string): Promise<boolean> {
  const checked = checkedSvg(logo(style), strict);
  if (!checked.ok) return true;
  return (await pixels(checked.svg)).equals(await pixels(logo(plain)));
}

describe('a style attribute that asks for a filter behind something that only looks like a comment', () => {
  // Controls: the plain spelling is refused, and an honest style with a quoted font name is drawn.
  it('refuses the plain spelling', () => {
    expect(checkedSvg(logo('filter:blur(9px)'), strict).ok).toBe(false);
    expect(checkedSvg(logo('/* soft */ filter:blur(9px)'), strict).ok).toBe(false);
  });

  it('accepts a style with a quoted font name', () => {
    expect(checkedSvg(logo("font-family:'Helvetica Neue', Arial; stroke:#000"), strict).ok).toBe(true);
  });

  it.each([
    ['"/*" inside a quoted string, never closed', "font-family:'/*';filter:blur(9px)", "font-family:'/*'"],
    ['"/*" inside a quoted string, "*/" inside a later one', "font-family:'/*';filter:blur(9px);font-family:'*/'", "font-family:'/*';font-family:'*/'"],
    ['"/*" inside a string in the other quotes', 'font-family:&quot;/*&quot;;filter:blur(9px)', 'font-family:&quot;/*&quot;'],
    ['"/*" after a backslash', 'x\\/*;filter:blur(9px)', 'x\\/*'],
    ['"/*" inside url(...)', 'stroke:url(#/*);filter:blur(9px)', 'stroke:url(#/*)'],
    ['the same with drop-shadow', "font-family:'/*';filter:drop-shadow(0 0 9px #000)", "font-family:'/*'"],
    ['the same with spaces around the colon', "font-family:'/*'; filter : blur(9px)", "font-family:'/*'"],
    // A string that holds the other kind of quote, an escaped quote, or a line break behind a backslash.
    ['"/*" after a quote of the other kind inside the string', "font-family:'&quot;/*';filter:blur(9px)", "font-family:'&quot;/*'"],
    ['"/*" after an escaped quote inside the string', "font-family:'a\\'/*';filter:blur(9px)", "font-family:'a\\'/*'"],
    ['"/*" in a string after one that ends on an escaped backslash', "font-family:'a\\\\';filter:blur(9px);font-family:'/*'", "font-family:'a\\\\';font-family:'/*'"],
    ['"/*" in a string continued over a line break', "font-family:'/*\\&#10;';filter:blur(9px)", "font-family:'/*\\&#10;'"],
    ['the property name written with an escape behind the string', "font-family:'/*';f\\69lter:blur(9px)", "font-family:'/*'"],
    ['an at-rule in front', "@media all{};font-family:'/*';filter:blur(9px)", "font-family:'/*'"],
    ['an @import with the opener in its string', "@import '/*';filter:blur(9px)", ''],
    ['a comment that closes inside what looks like a string', "/* ' */filter:blur(9px)/* ' */", ''],
  ])('%s', async (_name, style, plain) => {
    expect(await withoutEffect(style, plain)).toBe(true);
  });

  it('takes the same text in another attribute as that attribute\'s value and nothing more', async () => {
    // A presentation attribute sets one property; a declaration behind it is not one.
    const attribute = (value: string) => `${HEAD}<rect x="30" y="30" width="40" height="40" fill="#06c" font-family="${value}"/>${TAIL}`;
    const checked = checkedSvg(attribute("'/*';filter:blur(9px)"), strict);
    if (checked.ok) expect((await pixels(checked.svg)).equals(await pixels(attribute("'/*'")))).toBe(true);
    // An address outside the document behind such a string is found all the same.
    expect(checkedSvg(`${HEAD}<rect width="40" height="40" fill="&#39;/*&#39; &#117;rl(https://pictures.example/p)"/>${TAIL}`, strict))
      .toEqual({ ok: false, reason: 'external reference' });
    expect(checkedSvg(`${HEAD}<rect width="40" height="40" stroke="&#39;/*&#39; u\\72l(https://pictures.example/p)"/>${TAIL}`, strict).ok).toBe(false);
  });

  it('refuses a style sheet, also as CDATA and with the same text inside', () => {
    for (const sheet of [
      "<style>rect{font-family:'/*';filter:blur(9px)}</style>",
      "<style><![CDATA[rect{font-family:'/*';filter:blur(9px)}]]></style>",
      '<style type="text/css">@media all{rect{filter:blur(9px)}}</style>',
      "<style>@font-face{font-family:'/*'}rect{filter:blur(9px)}</style>",
    ]) {
      const checked = checkedSvg(`${HEAD}${sheet}<rect x="30" y="30" width="40" height="40" fill="#06c"/>${TAIL}`, strict);
      expect(checked, sheet).toEqual({ ok: false, reason: 'forbidden element <style>' });
    }
  });
});

describe('what a style attribute may hold', () => {
  it.each([
    ['a string that never closes', "font-family:'Brand Sans"],
    ['a comment that never closes', 'fill:#06c /* blue'],
    ['a function that never closes', 'fill:rgb(0, 102, 204'],
    ['a line break inside a string', "font-family:'Brand&#10;Sans'"],
    ['a backslash at the end', 'fill:#06c\\'],
    ['an escape that names no character', 'fill:\\110000 red'],
    ['a block', 'fill:#06c;{stroke:#000}'],
    ['a bracket', 'fill:[red]'],
    ['an at-rule', '@media print{fill:#000}'],
    ['a declaration without a colon', 'fill #06c'],
    ['a declaration without a value', 'fill:;stroke:#000'],
  ])('refuses %s', (_name, style) => {
    expect(checkedSvg(logo(style), strict).ok).toBe(false);
  });

  it.each([
    ['a filter', 'filter:url(#f)'],
    ['a mask', 'mask:url(#m)'],
    ['a clip path', 'clip-path:url(#c)'],
    ['a marker', 'marker-end:url(#m)'],
    ['a blend mode', 'mix-blend-mode:multiply'],
    ['a custom property', '--brand:#06c'],
    ['a property with a vendor prefix', '-webkit-filter:blur(2px)'],
    ['url() in a listed property', 'fill:url(#g)'],
    ['var()', 'fill:var(--brand)'],
    ['calc()', 'stroke-width:calc(1px + 2px)'],
    ['a function inside a colour', 'fill:rgb(var(--r), 0, 0)'],
    ['!important', 'fill:#06c !important'],
    ['a colour function where no colour belongs', 'opacity:rgb(0, 0, 0)'],
    ['a string where no font name belongs', "fill:'#06c'"],
    ['a unit CSS does not have', 'stroke-width:2furlongs'],
    ['a division', 'font:12px/14px Arial'],
  ])('refuses %s', (_name, style) => {
    expect(checkedSvg(logo(style), strict).ok).toBe(false);
  });

  it('writes out the declarations it checked, not the text that came in', () => {
    const written = (style: string) => {
      const checked = checkedStyle(style);
      return checked.ok ? checked.style : checked.reason;
    };
    expect(written('fill:#06c')).toBe('fill:#06c');
    expect(written(' /* brand */ FILL : #06C ;; stroke:rgb( 0 , 0,0 ) ; ')).toBe('fill:#06C;stroke:rgb(0 , 0 , 0)');
    expect(written('f\\69ll-opacity:.5;str\\6f ke-width:1.5PX')).toBe('fill-opacity:.5;stroke-width:1.5px');
    expect(written("font-family:'Helvetica Neue',Arial;font-size:12pt")).toBe('font-family:"Helvetica Neue" , Arial;font-size:12pt');
    expect(written("font-family:'say \\22 hi\\22  /* not a comment */'")).toBe('font-family:"say \\"hi\\" /* not a comment */"');
    expect(written('transform:translate(10,20) rotate(-45deg)/**/scale(1e1)')).toBe('transform:translate(10 , 20) rotate(-45deg) scale(1e1)');
    expect(written('fill:red/**/blue')).toBe('fill:red blue');
    expect(written('stroke-dasharray:1,2 3;display:none')).toBe('stroke-dasharray:1 , 2 3;display:none');
    expect(written('')).toBe('');
    // In the document: no comment and no escape is left in what the drawing gets.
    const checked = checkedSvg(logo('/* a */f\\69ll:#0a6/* b */;stroke:#000'), strict);
    expect(checked.ok && checked.svg).toContain('style="fill:#0a6;stroke:#000"');
    // Checking what is drawn gives the same document again.
    expect(checked.ok && checkedSvg(checked.svg, strict)).toEqual(checked);
  });

  it.each([
    ['paint and stroke', 'fill:#0a6;stroke:rgb(0,0,0);stroke-width:4;stroke-linejoin:round;stroke-opacity:.5'],
    ['a comment and escapes', '/* brand */ f\\69ll : #0A6 ; opacity:0.5'],
    ['a transform', 'fill:#c00;transform:translate(10px, 5px) rotate(10deg)'],
    ['a dash pattern', 'fill:none;stroke:#000;stroke-width:3;stroke-dasharray:6,3;stroke-linecap:round'],
    ['hidden', 'display:none'],
  ])('draws an honest style as it came in: %s', async (_name, style) => {
    const checked = checkedSvg(logo(style), strict);
    if (!checked.ok) throw new Error(checked.reason);
    expect((await pixels(checked.svg)).equals(await pixels(logo(style)))).toBe(true);
  });
});

describe('logos of real senders', () => {
  const pem = (name: string) => readFileSync(path.join(__dirname, 'fixtures', 'bimi', `${name}.pem`), 'utf8');
  const NOW = Date.UTC(2026, 9, 29);

  it('accepts the logo in CNN\'s mark certificate and draws it as it came in', async () => {
    const result = await validateMarkCertificate(pem('cnn-vmc'), { domains: ['cnn.com'], selector: 'default', roots: bimiRoots(), now: NOW });
    if (!result.ok) throw new Error(result.reason);
    for (const options of [{ strictProfile: false }, strict]) {
      const checked = checkedSvg(result.mark.svg, options);
      if (!checked.ok) throw new Error(checked.reason);
      expect((await pixels(checked.svg)).equals(await pixels(result.mark.svg))).toBe(true);
    }
  });
});
