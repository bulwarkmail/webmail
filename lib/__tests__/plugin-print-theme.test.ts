// Print styles: a theme's --print-* tokens and a plugin's print style
// (api.ui.registerPrintTheme). The plugin's CSS goes into the app's page
// while printing, so it must load nothing, run nothing and touch nothing
// outside the printout.
import { beforeEach, describe, expect, it } from 'vitest';
import type { InstalledPlugin, ThemeManifest } from '../plugin-types';
import { dispatchApiCall } from '../plugin-sandbox/host-api';
import { clearPrintThemes, findPrintTheme, listPrintThemes, resetPrintThemes } from '../plugin-sandbox/print-themes';
import { printPageMargin, printThemeVarsCss, sanitizePrintThemeCss } from '../print/print-theme';
import { compileAdvancedTheme } from '../theme-compiler';

function plugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'letterhead', name: 'Letterhead', version: '1.0.0', author: '', description: '', type: 'hook',
    permissions: [], entrypoint: 'index.js', enabled: true, status: 'running', settings: {}, managed: true,
    ...overrides,
  };
}

beforeEach(() => resetPrintThemes());

describe('sanitizePrintThemeCss', () => {
  it('scopes every rule to the printout', () => {
    const { css } = sanitizePrintThemeCss(':root { --print-font-family: Georgia; } body { color: navy } .pr-title, h1 > b { font-size: 18pt }');
    expect(css).toContain('[data-print-theme] { --print-font-family: Georgia; }');
    expect(css).toContain('[data-print-theme] {');
    expect(css).toContain('[data-print-theme] .pr-title, [data-print-theme] h1 > b {');
    expect(css).not.toMatch(/(^|[\s,}])(body|:root)\s*\{/);
  });

  it('removes everything that loads or runs, and "<"', () => {
    const { css, warnings } = sanitizePrintThemeCss([
      '@import url("https://evil.example/x.css");',
      '.pr-header { background: url(https://evil.example/logo.png); color: red }',
      '.pr-title { background-image: image-set("https://evil.example/a.png" 1x) }',
      "@font-face { font-family: X; src: local('Arial') }",
      '.pr-root { content: "</style><script>alert(1)</script>" }',
      '.x { behavior: url(x.htc) }',
    ].join('\n'));
    expect(css).not.toMatch(/evil\.example|@import|@font-face|<|url\(|image-set|behavior/i);
    expect(css).toContain('color: red');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('drops a stylesheet that hides url() behind escapes', () => {
    expect(sanitizePrintThemeCss('.a { background: \\75rl(https://evil.example/x) }').css).toBe('');
  });

  it("refuses selectors that reach outside the printout", () => {
    const { css } = sanitizePrintThemeCss('.pr-root ~ * { display: block } :root + div { color: red } :host { color: red } .ok { color: green }');
    expect(css).toBe('[data-print-theme] .ok { color: green }');
  });

  it('keeps @media and @supports with their rules scoped, and takes the @page margin out', () => {
    const { css, pageMargin } = sanitizePrintThemeCss('@page { margin: 20mm 15mm; size: A3 } @media print { .pr-title { color: #003366 } } @keyframes x { from { opacity: 0 } }');
    expect(pageMargin).toBe('20mm 15mm');
    expect(css).toContain('@media print {[data-print-theme] .pr-title { color: #003366 }}');
    expect(css).not.toMatch(/@page|@keyframes|A3/);
  });

  it('accepts only plain lengths as a page margin', () => {
    expect(printPageMargin('20mm')).toBe('20mm');
    expect(printPageMargin('1in 2cm 3pt 4px')).toBe('1in 2cm 3pt 4px');
    expect(printPageMargin('calc(1px + 1px)')).toBeNull();
    expect(printPageMargin('20mm; } body { display: none')).toBeNull();
  });
});

describe('api.ui.registerPrintTheme', () => {
  it('lists the print style with its CSS sanitised and its letterhead as text', async () => {
    const result = await dispatchApiCall(plugin(), 'ui.registerPrintTheme', [{
      id: 'company',
      label: 'Company letterhead',
      css: '@import "https://evil.example/a.css"; .pr-letterhead-header { font-weight: bold; background: url(https://evil.example/logo.png) }',
      header: 'Example GmbH\nMain Street 1',
      footer: 'example.org',
    }]) as { warnings: string[] };
    expect(result.warnings.length).toBeGreaterThan(0);

    const [theme] = listPrintThemes();
    expect(theme).toMatchObject({ key: 'letterhead/company', label: 'Company letterhead', pluginName: 'Letterhead', header: 'Example GmbH\nMain Street 1', footer: 'example.org' });
    expect(theme.css).toContain('[data-print-theme] .pr-letterhead-header');
    expect(theme.css).not.toContain('evil.example');
    expect(findPrintTheme('letterhead/company')).toBe(theme);
    expect(findPrintTheme('standard')).toBeNull();
  });

  it('replaces a style with the same id, removes it, and drops all of a stopped plugin', async () => {
    await dispatchApiCall(plugin(), 'ui.registerPrintTheme', [{ id: 'a', label: 'One' }]);
    await dispatchApiCall(plugin(), 'ui.registerPrintTheme', [{ id: 'a', label: 'One again' }]);
    await dispatchApiCall(plugin(), 'ui.registerPrintTheme', [{ id: 'b', label: 'Two' }]);
    expect(listPrintThemes().map((t) => t.label)).toEqual(['One again', 'Two']);
    await dispatchApiCall(plugin(), 'ui.unregisterPrintTheme', ['a']);
    expect(listPrintThemes().map((t) => t.label)).toEqual(['Two']);
    clearPrintThemes('letterhead');
    expect(listPrintThemes()).toEqual([]);
  });

  it('refuses bad input', async () => {
    await expect(dispatchApiCall(plugin(), 'ui.registerPrintTheme', [{ id: 'has space', label: 'x' }])).rejects.toThrow(/id must be/);
    await expect(dispatchApiCall(plugin(), 'ui.registerPrintTheme', [{ id: 'a', label: '' }])).rejects.toThrow(/label/);
    await expect(dispatchApiCall(plugin(), 'ui.registerPrintTheme', [{ id: 'a', label: 'x', header: 5 }])).rejects.toThrow(/header/);
  });
});

describe("a theme's print tokens", () => {
  it('compile into the --print-* variables the printout reads', () => {
    const manifest = {
      id: 't', name: 'T', version: '1.0.0', author: '', description: '', type: 'theme', variants: ['light'], apiVersion: 2,
      print: { fontFamily: 'Georgia, serif', headingColor: '#1373d9', pageMargin: '18mm', ruleColor: 'url(https://evil.example/x)' },
    } as unknown as ThemeManifest;
    const { css } = compileAdvancedTheme(manifest);
    expect(css).toContain('--print-font-family: Georgia, serif;');
    expect(css).toContain('--print-heading-color: #1373d9;');
    expect(css).toContain('--print-page-margin: 18mm;');
    expect(css).not.toContain('evil.example');
  });

  it('go into a document of its own as :root variables, checked', () => {
    expect(printThemeVarsCss({ '--print-font-family': 'Georgia', '--print-text-color': 'red; } body {' })).toBe(':root { --print-font-family: Georgia; }');
    expect(printThemeVarsCss({})).toBe('');
  });
});
