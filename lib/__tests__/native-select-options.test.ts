import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { BUILTIN_THEMES } from '@/lib/builtin-themes';

/**
 * The browser paints a native <select>'s option list itself; the Tailwind
 * classes on the control (bg-muted / text-foreground) never reach it. It only
 * honours `color-scheme` and an explicit option background/colour. Themes with
 * a translucent --color-muted (Aurora Glass dark) therefore composited to a
 * light popup with near-white text (#999). globals.css pins options to the
 * popover tokens, so every theme must define those as an opaque surface.
 *
 * jsdom does not render native popups, so lock the stylesheet rules.
 */
const css = readFileSync(path.join(process.cwd(), 'app', 'globals.css'), 'utf8');

/** Return the body of the first top-level `selector { ... }` rule. */
function ruleBody(selector: string): string {
  const idx = css.indexOf('\n' + selector + ' {');
  expect(idx, 'no `' + selector + '` rule in globals.css').toBeGreaterThan(-1);
  const open = css.indexOf('{', idx);
  return css.slice(open + 1, css.indexOf('}', open));
}

/** True when a CSS colour value has no alpha channel below 1. */
function isOpaque(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return false;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(v)) return true;
  if (/^#[0-9a-f]{4}$/.test(v)) return v.endsWith('f');
  if (/^#[0-9a-f]{8}$/.test(v)) return v.endsWith('ff');
  const fn = v.match(/^(rgb|hsl)a?\((.*)\)$/);
  if (fn) {
    const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 4) return true;
    const alpha = parts[3];
    return alpha.endsWith('%') ? parseFloat(alpha) >= 100 : parseFloat(alpha) >= 1;
  }
  return false;
}

/** Concrete `--color-popover` values, skipping the `@theme` alias `var(--color-popover)`. */
function popoverValues(source: string): string[] {
  return [...source.matchAll(/--color-popover:\s*([^;]+);/g)]
    .map((m) => m[1].trim())
    .filter((v) => !v.startsWith('var('));
}

describe('native <select> option colours (#999)', () => {
  it('pins option backgrounds and text to the popover tokens', () => {
    const body = ruleBody('option');
    expect(body).toMatch(/background-color:\s*var\(--color-popover\)/);
    expect(body).toMatch(/(?:^|[^-])color:\s*var\(--color-popover-foreground\)/);
  });

  it('asks the browser for a dark popup in dark mode', () => {
    expect(ruleBody('.dark select')).toMatch(/color-scheme:\s*dark/);
  });

  it('keeps the base light and dark popover surfaces opaque', () => {
    const values = popoverValues(css);
    expect(values.length).toBeGreaterThanOrEqual(2);
    for (const v of values) expect(isOpaque(v), `globals.css --color-popover: ${v}`).toBe(true);
  });

  it.each(BUILTIN_THEMES.map((t) => [t.name, t] as const))(
    '%s defines an opaque popover in every variant',
    (_name, theme) => {
      const values = popoverValues(theme.css);
      expect(values.length, 'theme css should set --color-popover').toBeGreaterThanOrEqual(
        theme.variants.length
      );
      for (const v of values) expect(isOpaque(v), `--color-popover: ${v}`).toBe(true);
    }
  );
});
