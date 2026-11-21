/**
 * A plugin's print style goes into the Print window as part of an HTML string
 * (components/email/message-print-window.ts: `<style data-print-theme-css>`),
 * so what sanitizePrintThemeCss returns must hold no `<`: the HTML reader ends
 * the style element at `</style` whatever stands in front of it.
 *
 * A `<` is taken out of the text before anything reads it. One that only
 * comes into being when escapes are resolved (`\<3c ` is `\3c ` without its
 * `<`, which is the character again) is still there in the text that would
 * be returned, and such a sheet is refused whole.
 */
import { describe, expect, it } from 'vitest';
import { sanitizePrintThemeCss } from '../print/print-theme';

const BS = '\\';
// `\<` followed by `3c ` reads as the name `<3c`; with the `<` taken out it is the escape `\3c `.
const LT = `${BS}<3c `;

describe('a print style comes back without any "<"', () => {
  it.each([
    ['in a selector', `.a${LT}/style>${LT}p>x{color:red}`],
    ['in a selector, as an element', `.a${LT}/style>${LT}img src=x>{color:red}`],
    ['in a value', `.a{font-family:x${LT}/style>${LT}b>}`],
    ['in a property name', `.a{x${LT}/style>:1}`],
    ['inside @media', `@media print{.a${LT}/style>{color:red}}`],
    ['in the condition of @media', `@media x${LT}/style>{.a{color:red}}`],
    ['in the condition of @supports', `@supports (x:y${LT}/style>){.a{color:red}}`],
  ])('%s', (_name, css) => {
    const out = sanitizePrintThemeCss(css).css;
    // Only the character itself counts: `\3c /style>` is harmless in an HTML string, `\</style>` ends the element.
    expect(out).not.toContain('<');
  });

  it('control: a "<" written plainly or as one escape is removed, as before', () => {
    for (const css of ['.a</style>{color:red}', `.a${BS}3c /style>{color:red}`, `.a${BS}</style>{color:red}`, '.a{content:"</style>"}', `.a{content:"${BS}3c /style>"}`]) {
      expect(sanitizePrintThemeCss(css).css).not.toContain('<');
    }
  });

  it('control: an honest print style keeps its rules', () => {
    const out = sanitizePrintThemeCss('h1{font-size:14pt}.pr-letterhead-header>p{margin:0}@media print{a[href^="http"]::after{content:" (" attr(href) ")"}}').css;
    expect(out).toContain('[data-print-theme] h1 {font-size:14pt}');
    expect(out).toContain('[data-print-theme] .pr-letterhead-header>p {margin:0}');
    expect(out).toContain('attr(href)');
  });

  it.each([
    ['the escape in upper case', `.a${BS}<3C /style>{color:red}`],
    ['the escape with six digits', `.a${BS}<00003c/style>{color:red}`],
    ['the escape ended by a line break', `.a${BS}<3c\n/style>{color:red}`],
    ['two "<" in front of the escape', `.a${BS}<<3c /style>{color:red}`],
    ['a "<" between the digits', `.a${BS}3<c /style>{color:red}`],
    ['in a string', `.a{content:"${BS}<3c /style>"}`],
    ['in a string, after a plain one', `.a{content:"<${BS}<3c /style>"}`],
    ['in a custom property', `.a{--x:${BS}<3c /style>}`],
    ['in an attribute selector', `a[title=${BS}<3c x]{color:red}`],
    ['behind a rule that is removed', `html ~ *{color:red}.a${BS}<3c /style>{color:blue}`],
  ])('nor with %s', (_name, css) => {
    expect(sanitizePrintThemeCss(css).css).not.toContain('<');
  });

  it('a sheet that would still hold one is refused whole, and says why', () => {
    const out = sanitizePrintThemeCss(`h1{color:red}.a${BS}<3c /style>{color:blue}`);
    expect(out.css).toBe('');
    expect(out.warnings).toEqual(['removed "<" characters', 'removed the stylesheet: it holds a "<" written as an escape']);
    // Written as an escape with no "<" near it: the same.
    expect(sanitizePrintThemeCss(`h1{color:red}.a::after{content:"${BS}3c "}`)).toMatchObject({ css: '', pageMargin: null });
  });

  it('a plain "<" costs only itself: the rules around it stay', () => {
    const out = sanitizePrintThemeCss('h1{color:red}.a::after{content:"a < b"}@page{margin:20mm}');
    expect(out).toEqual({
      css: '[data-print-theme] h1 {color:red}\n[data-print-theme] .a::after {content:"a  b"}',
      pageMargin: '20mm',
      warnings: ['removed "<" characters'],
    });
  });
});
