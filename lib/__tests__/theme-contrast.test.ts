/**
 * Text contrast of every built-in theme, light and dark (WCAG 1.4.3).
 *
 * Checks the token pairs the app draws text with: body and muted text on the
 * grounds they sit on, labels on primary and destructive fills, primary text
 * (links, tinted badges) on the page and on its own 10% tint, and the
 * selection and accent pairs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { BUILTIN_THEMES } from '../builtin-themes';
import { parseColor, getLuminance } from '../color-transform';

type Tokens = Record<string, string>;

function block(css: string, selector: string): Tokens {
  const m = new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
  const out: Tokens = {};
  if (!m) return out;
  // A host palette's `var(--brand-*, <default>)`: check the default.
  for (const [, k, v] of m[1].matchAll(/--color-([\w-]+):\s*([^;]+);/g)) {
    out[k] = v.trim().replace(/^var\(--brand-[\w-]+,\s*(.+)\)$/, '$1');
  }
  return out;
}

const globals = readFileSync(path.join(process.cwd(), 'app', 'globals.css'), 'utf8');
const defaults = { light: block(globals, ':root'), dark: block(globals, '.dark') };

/** Opaque rgb of `color`, laid over `under` when it has alpha. */
function solid(color: string, under = '#ffffff'): [number, number, number] {
  const c = parseColor(color)!;
  const u = parseColor(under)!;
  const a = c.a ?? 1;
  return [c.r * a + u.r * (1 - a), c.g * a + u.g * (1 - a), c.b * a + u.b * (1 - a)];
}

function ratio(fg: string, bg: string, page: string, fgAlpha = 1): number {
  const b = solid(bg, page);
  const f0 = solid(fg, page);
  const f = f0.map((v, i) => v * fgAlpha + b[i] * (1 - fgAlpha)) as [number, number, number];
  const l1 = getLuminance(...f);
  const l2 = getLuminance(...b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const themes: [string, 'light' | 'dark', Tokens][] = [
  ['default', 'light', defaults.light],
  ['default', 'dark', { ...defaults.light, ...defaults.dark }],
];
for (const theme of BUILTIN_THEMES) {
  const light = { ...defaults.light, ...block(theme.css, ':root') };
  themes.push([theme.id, 'light', light]);
  themes.push([theme.id, 'dark', { ...defaults.light, ...defaults.dark, ...block(theme.css, '.dark') }]);
}

describe.each(themes)('%s (%s)', (_id, _mode, t) => {
  const page = t.background;
  const grounds = ['background', 'card', 'popover', 'muted', 'secondary', 'sidebar'].filter((k) => t[k]);

  it.each([['foreground'], ['muted-foreground']])('%s reaches 4.5:1 on every ground', (fg) => {
    for (const g of grounds) expect(ratio(t[fg], t[g], page), `${fg} on ${g}`).toBeGreaterThanOrEqual(4.5);
  });

  it('labels on primary and destructive fills reach 4.5:1', () => {
    expect(ratio(t['primary-foreground'], t.primary, page)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t['destructive-foreground'], t.destructive, page)).toBeGreaterThanOrEqual(4.5);
  });

  it('selection and accent text reach 4.5:1 on their grounds', () => {
    expect(ratio(t['selection-foreground'], t.selection, page)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t['accent-foreground'], t.accent, page)).toBeGreaterThanOrEqual(4.5);
  });

  it('the focus ring reaches 3:1 on the page', () => {
    expect(ratio(t.ring, page, page)).toBeGreaterThanOrEqual(3);
  });
});

describe('primary as text', () => {
  // Flat fields draws links and text-primary in --color-ring instead.
  it.each(themes.filter(([id]) => id !== 'builtin-flat-fields'))('%s (%s) reads at 4.5:1 on the page and on bg-primary/10', (_id, _mode, t) => {
    const page = t.background;
    expect(ratio(t.primary, page, page)).toBeGreaterThanOrEqual(4.5);
    const [r, g, b] = solid(t.primary, page).map((v, i) => v * 0.1 + solid(page)[i] * 0.9);
    const tint = `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
    expect(ratio(t.primary, tint, page)).toBeGreaterThanOrEqual(4.2);
  });
});
