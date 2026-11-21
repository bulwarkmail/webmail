/**
 * An address written without quotes goes with its whole `url()`, and the
 * sheet around it stays. Such an address may hold a `;` (every data: address
 * does), a `{` or a `}`; cut off at one of them, the rest of it would be left
 * behind with a closing bracket nothing opened, and a sheet whose brackets
 * don't pair up is refused whole.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeSkinCSS, sanitizeThemeCSS, readStylesheet } from '../theme-loader';
import { sanitizePrintThemeCss } from '../print/print-theme';

const DATA = 'data:image/png;base64,iVBORw0KGgo=';
const URL_WARNING = expect.stringContaining('removed disallowed pattern: url');

describe('a skin with an unquoted address keeps its other rules', () => {
  it.each([
    ['a data: address', `.a{background:url(${DATA})}.b{color:red}`, '.a{background:/* [removed] */}.b{color:red}'],
    ['the same with spaces inside the brackets', `.a{background:url( ${DATA} );color:blue}.b{color:red}`, '.a{background:/* [removed] */;color:blue}.b{color:red}'],
    ['an address with braces', '.a{background:url(a{b}c)}.b{color:red}', '.a{background:/* [removed] */}.b{color:red}'],
    ['an address with an escaped bracket', '.a{background:url(a\\)b;c)}.b{color:red}', '.a{background:/* [removed] */}.b{color:red}'],
    ['two of them in one value', `.a{background:url(${DATA}),url(x;y)}.b{color:red}`, '.a{background:/* [removed] */,/* [removed] */}.b{color:red}'],
    ['inside image-set()', '.a{background:image-set(url(a;1.png) 1x, url(b;2.png) 2x)}.b{color:red}', '.a{background:/* [removed] */}.b{color:red}'],
    ['in @font-face', `@font-face{font-family:"X";src:url(${DATA}) format("woff2")}.b{color:red}`, '@font-face{font-family:"X";src:/* [removed] */ format("woff2")}.b{color:red}'],
    ['a space between the name and the bracket', '.a{background:url (a;b)}.b{color:red}', '.a{background:/* [removed] */}.b{color:red}'],
  ])('%s', (_name, css, expected) => {
    const out = sanitizeSkinCSS(css);
    expect(out.css).toBe(expected);
    expect(out.warnings).toEqual(expect.arrayContaining([URL_WARNING]));
    expect(out.warnings.join(' ')).not.toMatch(/could not be read cleanly/);
    expect(readStylesheet(out.css)).not.toBeNull();
    expect(out.css).not.toMatch(/base64|png/);
  });

  it('control: a quoted address and a fragment come back as before', () => {
    expect(sanitizeSkinCSS(`.a{background:url("${DATA}")}.b{color:red}`).css).toBe('.a{background:/* [removed] */}.b{color:red}');
    expect(sanitizeSkinCSS('.a{filter:url(#blur)}.b{color:red}').css).toBe('.a{filter:url(#blur)}.b{color:red}');
  });
});

describe('theme.css and a print style with an unquoted address', () => {
  it('theme.css keeps the rule and its other variables', () => {
    const out = sanitizeThemeCSS(`:root{--color-a:#123;--logo:url(${DATA});--color-b:#456}\n.dark{--color-a:#000}`);
    expect(out.css).toBe(':root {--color-a:#123;--logo:/**/;--color-b:#456}\n.dark {--color-a:#000}');
    expect(out.warnings).toEqual([URL_WARNING]);
  });

  it('a print style keeps its rules, and the page margin', () => {
    const out = sanitizePrintThemeCss(`.pr-letterhead-header{background:url(${DATA});color:#333}h1{font-size:14pt}@page{margin:20mm}`);
    expect(out.css).toBe('[data-print-theme] .pr-letterhead-header {background:/**/;color:#333}\n[data-print-theme] h1 {font-size:14pt}');
    expect(out.pageMargin).toBe('20mm');
    expect(out.warnings).toEqual([URL_WARNING]);
  });
});
