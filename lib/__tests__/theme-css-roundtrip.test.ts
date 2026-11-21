/**
 * What the style sanitisers return means the same as what was written.
 *
 * The sanitisers check a sheet with its escapes resolved and write every
 * token back. A selector or a value that is only valid in its escaped form
 * has to come back escaped: an id that starts with a digit (`#\31 st` selects
 * id="1st"; `#1st` is a hash but no identifier, so no browser takes it as an
 * id selector and the whole rule is dropped), a class with a `/` or a `:` in
 * it, a quote or a line break in a string.
 *
 * The selector cases are also put to the page's own selector engine: the
 * selector that comes back has to match the element the written one matches.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeSkinCSS, sanitizeThemeCSS, readStylesheet } from '../theme-loader';
import { sanitizePrintThemeCss } from '../print/print-theme';

const BS = '\\';
const NL = '\n';

describe('an id selector keeps its escape', () => {
  it.each([
    ['#\\31 st{color:red}'],
    ['#\\000031st{color:red}'],
    ['#\\34 2{color:red}'],
    ['#-\\31 a{color:red}'],
  ])('%s', (css) => {
    const out = sanitizeSkinCSS(css).css;
    // After `#` an id is an identifier: no digit first, and no hyphen followed by a digit.
    expect(out).not.toMatch(/#-?[0-9]/);
    expect(out).toContain('{color:red}');
    // A print style goes through the same rewrite.
    expect(sanitizePrintThemeCss(css).css).not.toMatch(/#-?[0-9]/);
  });

  it('control: a class with the same escape, and a colour, come back as written', () => {
    expect(sanitizeSkinCSS('.\\31 st{color:#123}').css).toBe('.\\31 st{color:#123}');
    expect(sanitizeThemeCSS(':root{--color-primary:#123456}').css).toContain('--color-primary:#123456');
  });
});

/** [what it is, the sheet as written, the sheet as it comes back] */
const ROUND_TRIPS: Array<[string, string, string]> = [
  ['an id that starts with a digit', `#${BS}31 st{color:red}`, `#${BS}31 st{color:red}`],
  ['the same in its six-digit form', `#${BS}000031st{color:red}`, `#${BS}31 st{color:red}`],
  ['an id that is a number', `#${BS}34 2{color:red}`, `#${BS}34 2{color:red}`],
  ['an id that starts with a hyphen and a digit', `#-${BS}31 a{color:red}`, `#-${BS}31 a{color:red}`],
  ['an id that is a lone hyphen', `#${BS}-{color:red}`, `#${BS}-{color:red}`],
  ['an id with a colon', `#a${BS}:b{color:red}`, `#a${BS}:b{color:red}`],
  ['an id with a dot, written as a hex escape', `#a${BS}2e b{color:red}`, `#a${BS}.b{color:red}`],
  ['an id with a space', `#a${BS} b{color:red}`, `#a${BS} b{color:red}`],
  ['a class that starts with a digit', `.${BS}31 st{color:red}`, `.${BS}31 st{color:red}`],
  ['a class that starts with a hyphen and a digit', `.-${BS}31 a{color:red}`, `.-${BS}31 a{color:red}`],
  ['a class with a slash', `.w-1${BS}/2{width:50%}`, `.w-1${BS}/2{width:50%}`],
  ['a class with a colon', `.md${BS}:flex{display:flex}`, `.md${BS}:flex{display:flex}`],
  ['a class with brackets and a hash', `.bg-${BS}[${BS}#123${BS}]{color:red}`, `.bg-${BS}[${BS}#123${BS}]{color:red}`],
  ['a letter written as an escape', `.caf${BS}e9 {color:red}`, '.café{color:red}'],
  ['a character outside the basic plane', `.${BS}1F600 x{color:red}`, '.😀x{color:red}'],
  ['an element name with an escaped letter', `${BS}64 iv{color:red}`, 'div{color:red}'],
  ['a no-break space in a class name', `.a${BS}a0 b{color:red}`, `.a${BS}a0 b{color:red}`],
  ['a multiplication sign in a class name', `.w${BS}d7 h{color:red}`, `.w${BS}d7 h{color:red}`],
  ['a zero-width space in a class name', `.a${BS}200b b{color:red}`, `.a${BS}200b b{color:red}`],
  ['a control character from the C1 range', `.a${BS}9a b{color:red}`, `.a${BS}9a b{color:red}`],
  ['a no-break space written plainly, next to an escape', `.a\u00a0${BS}62{color:red}`, '.a\u00a0b{color:red}'],
  ['an emoji written plainly, next to an escape', `.😀${BS}31 x{color:red}`, '.😀1x{color:red}'],
  ['an id with a no-break space', `#a${BS}a0 b{color:red}`, `#a${BS}a0 b{color:red}`],
  ['a quote inside a string', `a::after{content:"say ${BS}"hi${BS}""}`, `a::after{content:"say ${BS}"hi${BS}""}`],
  ['a quote written as a hex escape', `a::after{content:'${BS}27 '}`, `a::after{content:'${BS}''}`],
  ['a line break in generated text', `a::after{content:"a${BS}a b"}`, `a::after{content:"a${BS}a b"}`],
  ['a string continued on the next line', `a::after{content:"a${BS}${NL}b"}`, 'a::after{content:"ab"}'],
  ['a backslash inside a string', `a::after{content:"a${BS}${BS}b"}`, `a::after{content:"a${BS}${BS}b"}`],
  ['an icon font glyph', `a::before{content:"${BS}f101"}`, 'a::before{content:""}'],
  ['an attribute value with an escape', `[data-a="1${BS}/2"]{color:red}`, '[data-a="1/2"]{color:red}'],
  ['a colour with an escaped digit', `a{color:#${BS}31 23}`, `a{color:#${BS}31 23}`],
  ['a colour that starts with a digit', 'a{color:#1a2b3c}', 'a{color:#1a2b3c}'],
  ['a unit whose first letter would read as an exponent', `a{width:1${BS}65 5}`, `a{width:1${BS}65 5}`],
];

describe('a sheet with escapes comes back meaning the same', () => {
  it.each(ROUND_TRIPS)('%s', (_name, written, expected) => {
    const out = sanitizeSkinCSS(written);
    expect(out.warnings).toEqual([]);
    expect(out.css).toBe(expected);
  });

  it.each(ROUND_TRIPS)('and reads the same a second time: %s', (_name, written) => {
    const once = sanitizeSkinCSS(written).css;
    expect(sanitizeSkinCSS(once).css).toBe(once);
    // What came back is what the checks ran on.
    expect(readStylesheet(once)?.text).toBe(once);
  });

  it('a print style keeps them too, inside its scope', () => {
    expect(sanitizePrintThemeCss(`#${BS}31 st, .w-1${BS}/2 { color: red }`).css)
      .toBe(`[data-print-theme] #${BS}31 st, [data-print-theme] .w-1${BS}/2 { color: red }`);
  });

  it('theme.css keeps an escaped string value', () => {
    expect(sanitizeThemeCSS(`:root{--color-x:"a${BS}a b";--font:"say ${BS}"hi${BS}""}`).css)
      .toBe(`:root {--color-x:"a${BS}a b";--font:"say ${BS}"hi${BS}""}`);
  });
});

describe('the selector that comes back matches the element the written one matches', () => {
  const selectorOf = (written: string) => sanitizeSkinCSS(`${written}{color:red}`).css.replace(/\{color:red\}$/, '');
  const element = (attrs: Record<string, string>) => {
    const el = document.createElement('div');
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    return el;
  };

  it.each([
    [`#${BS}31 st`, { id: '1st' }],
    [`#${BS}000031st`, { id: '1st' }],
    [`#${BS}34 2`, { id: '42' }],
    [`#-${BS}31 a`, { id: '-1a' }],
    [`#a${BS}:b`, { id: 'a:b' }],
    [`#a${BS}2e b`, { id: 'a.b' }],
    [`.${BS}31 st`, { class: '1st' }],
    [`.-${BS}31 a`, { class: '-1a' }],
    [`.w-1${BS}/2`, { class: 'w-1/2' }],
    [`.md${BS}:flex`, { class: 'md:flex' }],
    [`.caf${BS}e9 `, { class: 'café' }],
    [`.a${BS}a0 b`, { class: 'a\u00a0b' }],
    [`.w${BS}d7 h`, { class: 'w×h' }],
    [`#${BS}1F600 ${BS}31`, { id: '😀1' }],
    [`div#${BS}31 st.md${BS}:flex[data-a="1${BS}/2"]`, { id: '1st', class: 'md:flex', 'data-a': '1/2' }],
  ])('%s', (written, attrs) => {
    const el = element(attrs);
    expect(el.matches(written), 'the selector as written').toBe(true);
    expect(el.matches(selectorOf(written)), `the selector as returned: ${selectorOf(written)}`).toBe(true);
  });

  it('control: an id written back without its escape is no selector at all', () => {
    expect(() => element({ id: '1st' }).matches('#1st')).toThrow();
  });
});
