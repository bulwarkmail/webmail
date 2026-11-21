/**
 * A plugin's print style loses its `<` characters, and it is checked for
 * addresses (url(), image-set(), image(), src()). Taking a `<` out can turn
 * what follows it into an escape: `\<75 rl(` is `\75 rl(` without its `<`,
 * which every browser reads as `url(`. So the `<` goes first and the check
 * runs on what is left, and on the text that is returned.
 *
 * What the sanitiser returns is read here with its escapes resolved, and
 * that reading must spell none of the removed constructs.
 */
import { describe, expect, it } from 'vitest';
import { sanitizePrintThemeCss } from '../print/print-theme';
import { DISALLOWED_CSS_PATTERNS } from '../plugin-types';

const BS = '\\';
const HOST = 'https://attacker.invalid/a';

/** CSS escapes resolved, the way a browser reads names (enough for these sheets). */
function decoded(css: string): string {
  return css.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([^\n\r\f0-9a-fA-F])/g, (_m, hex: string | undefined, ch: string | undefined) =>
    (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch!));
}
function spelled(css: string): string[] {
  const text = decoded(css);
  return DISALLOWED_CSS_PATTERNS.filter((pattern) => new RegExp(pattern.source, 'i').test(text)).map((pattern) => pattern.source);
}

describe('a print style names no address after its "<" characters were taken out', () => {
  it.each([
    ['url()', `.a{background:${BS}<75 rl(${HOST})}`],
    ['url() with a quoted address', `.a{background:${BS}<75 rl("${HOST}")}`],
    ['url(), the escape further in', `.a{background:u${BS}<72 l(${HOST})}`],
    ['image-set()', `.a{background:${BS}<69 mage-set("${HOST}" 1x)}`],
    ['image()', `.a{background:${BS}<69 mage("${HOST}")}`],
    ['url() inside @media', `@media print{.a{background:${BS}<75 rl(${HOST})}}`],
  ])('%s', (_name, css) => {
    const out = sanitizePrintThemeCss(css).css;
    expect({ out, spelled: spelled(out) }).toEqual({ out, spelled: [] });
  });

  it('control: the plain and the escaped spelling are removed', () => {
    for (const css of [`.a{background:url(${HOST})}`, `.a{background:${BS}75 rl(${HOST})}`, `.a{background:url(${HOST})} .b{background:${BS}75rl(${HOST})}`]) {
      expect(spelled(sanitizePrintThemeCss(css).css)).toEqual([]);
    }
  });

  it('control: a fragment url and an honest "<" in generated text', () => {
    expect(sanitizePrintThemeCss('.a{filter:url(#blur)}').css).toContain('url(#blur)');
    expect(sanitizePrintThemeCss('.a::before{content:"a < b"}').css).toBe('[data-print-theme] .a::before {content:"a  b"}');
  });

  it.each([
    ['url() in upper case', `.a{background:${BS}<55 RL(${HOST})}`],
    ['url(), two "<" in front of the escape', `.a{background:${BS}<<75 rl(${HOST})}`],
    ['url(), the "<" between the digits', `.a{background:${BS}7<5 rl(${HOST})}`],
    ['url(), every letter behind a "<"', `.a{background:${BS}<75 ${BS}<72 ${BS}<6c (${HOST})}`],
    ['url() next to a plain one', `.z{background:url(x)}.a{background:${BS}<75 rl(${HOST})}`],
    ['-webkit-image-set()', `.a{background:-webkit-${BS}<69 mage-set("${HOST}" 1x)}`],
    ['src()', `.a{background:${BS}<73 rc("${HOST}")}`],
    ['@import', `@${BS}<69 mport "${HOST}";.a{color:red}`],
    ['@import inside @media', `@media print{@${BS}<69 mport "${HOST}";.a{color:red}}`],
    ['url() in the condition of @supports', `@supports (background:${BS}<75 rl(${HOST})){.a{color:red}}`],
    ['expression()', `.a{width:${BS}<65 xpression(alert(1))}`],
    ['a "<" inside the name and no escape', `.a{background:ur<l(${HOST})}`],
    ['a "<" between the name and the bracket', `.a{background:url<(${HOST})}`],
  ])('more spellings: %s', (_name, css) => {
    const out = sanitizePrintThemeCss(css).css;
    expect({ out, spelled: spelled(out) }).toEqual({ out, spelled: [] });
    expect(out).not.toContain('attacker.invalid');
  });

  it('a backslash that is itself escaped hides nothing and is left alone', () => {
    // `\\<75 rl(` is a backslash, then `75`, then the function `rl(`: no url() with or without the "<".
    const out = sanitizePrintThemeCss(`.a{font-family:x${BS}${BS}<75 rl(a)}`).css;
    expect(out).toBe(`[data-print-theme] .a {font-family:x${BS}${BS}75 rl(a)}`);
  });
});
