// Advanced Theme API v2 - compiles structured manifest fields (tokens,
// radii, typography, density, extends) into a single CSS string that the
// existing `injectThemeCSS` pipeline can apply unchanged.

import type {
  ThemeDensity,
  ThemeManifest,
  ThemeRadii,
  ThemeTokenSet,
  ThemeTypography,
} from './plugin-types';
import { getLuminance, parseColor } from './color-transform';

export interface CompiledTheme {
  css: string;
  warnings: string[];
  errors: string[];
}

/**
 * Standard tokens whose `*-foreground` counterpart can be auto-derived from
 * contrast when `derive: true` and only the base colour is supplied.
 */
const DERIVE_PAIRS: Array<[base: string, fg: string]> = [
  ['primary', 'primary-foreground'],
  ['secondary', 'secondary-foreground'],
  ['muted', 'muted-foreground'],
  ['accent', 'accent-foreground'],
  ['destructive', 'destructive-foreground'],
  ['popover', 'popover-foreground'],
  ['card', 'card-foreground'],
  ['sidebar', 'sidebar-foreground'],
  ['success', 'success-foreground'],
  ['warning', 'warning-foreground'],
  ['info', 'info-foreground'],
];

/** Pick a foreground colour (white or near-black) by background luminance. */
function pickForeground(bg: string): string {
  const rgb = parseColor(bg);
  if (!rgb) return '#ffffff';
  return getLuminance(rgb.r, rgb.g, rgb.b) >= 0.55 ? '#0f172a' : '#ffffff';
}

/**
 * Resolve a manifest token key to a fully-qualified CSS custom property:
 *   "primary"          → "--color-primary"
 *   "color-primary"    → "--color-primary"
 *   "--color-primary"  → "--color-primary"
 *   "font-sans"        → "--font-sans"
 */
const PREFIXED_NAMESPACES = ['color-', 'font-', 'radius-', 'density-'];
function tokenName(key: string): string {
  if (key.startsWith('--')) return key;
  if (PREFIXED_NAMESPACES.some((ns) => key.startsWith(ns))) return `--${key}`;
  return `--color-${key}`;
}

function emitTokens(
  tokens: Record<string, string>,
  derive: boolean,
): { lines: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const expanded: Record<string, string> = { ...tokens };

  if (derive) {
    for (const [base, fg] of DERIVE_PAIRS) {
      if (expanded[base] && !expanded[fg]) {
        expanded[fg] = pickForeground(expanded[base]);
      }
    }
    // Common alias: --color-foreground used as page text colour.
    if (expanded.background && !expanded.foreground) {
      expanded.foreground = pickForeground(expanded.background);
    }
  }

  const lines: string[] = [];
  for (const [rawKey, value] of Object.entries(expanded)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!isSafeTokenKey(rawKey)) {
      warnings.push(`Token "${rawKey}" dropped - invalid key (only [a-z0-9-] allowed)`);
      continue;
    }
    if (!isSafeTokenValue(value)) {
      warnings.push(`Token "${rawKey}" dropped - value contains unsafe characters`);
      continue;
    }
    lines.push(`  ${tokenName(rawKey)}: ${value.trim()};`);
  }
  return { lines, warnings };
}

const SAFE_KEY_PATTERN = /^(--)?[a-z][a-z0-9-]*$/;
function isSafeTokenKey(key: string): boolean {
  return SAFE_KEY_PATTERN.test(key);
}

/**
 * Token values are emitted verbatim into CSS, so they must not contain
 * anything that could break out of the declaration (`{`, `}`, `;`,
 * `<`/`>`) or pull in remote/scripted content.
 */
function isSafeTokenValue(value: string): boolean {
  if (/[{}<>]/.test(value)) return false;
  if (value.includes(';')) return false;
  // A token is a colour, length or font stack: it never needs an escape,
  // and escapes are how `\75rl(` slips past a pattern check.
  if (value.includes('\\')) return false;
  if (/url\s*\(|image-set\s*\(/i.test(value)) return false;
  if (/expression\s*\(/i.test(value)) return false;
  if (/-moz-binding/i.test(value)) return false;
  if (/javascript\s*:/i.test(value)) return false;
  return true;
}

function emitRadii(radii: ThemeRadii): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(radii)) {
    if (typeof v === 'string' && isSafeTokenValue(v)) {
      out.push(`  --radius-${k}: ${v.trim()};`);
    }
  }
  return out;
}

function emitTypography(typography: ThemeTypography): string[] {
  const out: string[] = [];
  if (typography.fontSans && isSafeTokenValue(typography.fontSans)) {
    out.push(`  --font-sans: ${typography.fontSans.trim()};`);
  }
  if (typography.fontMono && isSafeTokenValue(typography.fontMono)) {
    out.push(`  --font-mono: ${typography.fontMono.trim()};`);
  }
  if (typography.fontDisplay && isSafeTokenValue(typography.fontDisplay)) {
    out.push(`  --font-display: ${typography.fontDisplay.trim()};`);
  }
  if (typography.baseFontSize && isSafeTokenValue(typography.baseFontSize)) {
    out.push(`  --font-size-base: ${typography.baseFontSize.trim()};`);
  }
  return out;
}

const DENSITY_VARS: Record<ThemeDensity, Record<string, string>> = {
  compact: {
    '--density-row-height': '28px',
    '--density-control-height': '28px',
    '--density-spacing-1': '2px',
    '--density-spacing-2': '4px',
    '--density-spacing-3': '6px',
  },
  normal: {
    '--density-row-height': '36px',
    '--density-control-height': '32px',
    '--density-spacing-1': '4px',
    '--density-spacing-2': '8px',
    '--density-spacing-3': '12px',
  },
  touch: {
    '--density-row-height': '44px',
    '--density-control-height': '40px',
    '--density-spacing-1': '6px',
    '--density-spacing-2': '12px',
    '--density-spacing-3': '18px',
  },
};

function emitDensity(density: ThemeDensity): string[] {
  return Object.entries(DENSITY_VARS[density]).map(([k, v]) => `  ${k}: ${v};`);
}

export interface CompileOptions {
  /**
   * Resolves a `extends: <id>` chain to that base theme's compiled CSS.
   * Implementations should return null for unknown ids; circular refs are
   * the caller's problem (we don't recurse - just one level of inheritance).
   */
  resolveExtends?: (id: string) => string | null;
  /**
   * Optional hand-written CSS appended after compiled tokens. Use this for
   * the rare overrides the structured API can't express (extra `@font-face`,
   * `@keyframes`, `@media (prefers-contrast)` blocks, etc.).
   */
  userCSS?: string;
}

/**
 * Compile an advanced theme manifest into a single safe CSS string.
 *
 * Output layout:
 *   1. parent (extends) CSS, if any
 *   2. `:root { common + light + radii + typography + density }`
 *   3. `.dark { common + dark }` (only when the theme declares a dark variant)
 *   4. user-supplied `theme.css` content (sanitized upstream)
 *
 * The compiler never emits selectors other than `:root` and `.dark`, so the
 * existing CSS sanitizer/selector validator continues to apply.
 */
export function compileAdvancedTheme(
  manifest: ThemeManifest,
  opts: CompileOptions = {},
): CompiledTheme {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!isAdvancedManifest(manifest)) {
    return { css: '', warnings, errors: ['Manifest does not declare any advanced theme fields'] };
  }

  const tokens: ThemeTokenSet = manifest.tokens ?? {};
  const derive = manifest.derive === true;
  const wantsDark = manifest.variants.includes('dark');
  const wantsLight = manifest.variants.includes('light');

  const sections: string[] = [];

  // 1. extends - prepend parent CSS verbatim
  if (manifest.extends && opts.resolveExtends) {
    const parentCSS = opts.resolveExtends(manifest.extends);
    if (parentCSS == null) {
      warnings.push(`extends: parent theme "${manifest.extends}" not found - skipping`);
    } else {
      sections.push(`/* inherited from ${manifest.extends} */\n${parentCSS}`);
    }
  } else if (manifest.extends) {
    warnings.push(`extends: no resolver provided - "${manifest.extends}" ignored`);
  }

  // 2. :root block (light + common + structural)
  const rootLines: string[] = [];

  if (tokens.common) {
    const { lines, warnings: w } = emitTokens(tokens.common, derive);
    rootLines.push(...lines);
    warnings.push(...w);
  }
  if (wantsLight && tokens.light) {
    const { lines, warnings: w } = emitTokens(tokens.light, derive);
    rootLines.push(...lines);
    warnings.push(...w);
  }
  if (manifest.radii) rootLines.push(...emitRadii(manifest.radii));
  if (manifest.typography) rootLines.push(...emitTypography(manifest.typography));
  if (manifest.density) rootLines.push(...emitDensity(manifest.density));

  if (rootLines.length > 0) {
    sections.push(`:root {\n${rootLines.join('\n')}\n}`);
  }

  // 3. .dark block
  if (wantsDark) {
    const darkLines: string[] = [];
    if (tokens.common) {
      const { lines, warnings: w } = emitTokens(tokens.common, derive);
      darkLines.push(...lines);
      warnings.push(...w);
    }
    if (tokens.dark) {
      const { lines, warnings: w } = emitTokens(tokens.dark, derive);
      darkLines.push(...lines);
      warnings.push(...w);
    }
    if (darkLines.length > 0) {
      sections.push(`.dark {\n${darkLines.join('\n')}\n}`);
    }
  }

  // 4. hand-written overrides
  if (opts.userCSS && opts.userCSS.trim()) {
    sections.push(`/* user overrides */\n${opts.userCSS.trim()}`);
  }

  if (sections.length === 0) {
    errors.push('Compiled theme is empty - no tokens, radii, typography, or density supplied');
  }

  return {
    css: sections.join('\n\n'),
    warnings,
    errors,
  };
}

/**
 * True if a manifest opts into Theme API v2 by setting `apiVersion: 2` or by
 * declaring any of the structured fields.
 */
export function isAdvancedManifest(manifest: ThemeManifest): boolean {
  return (
    manifest.apiVersion === 2 ||
    !!manifest.tokens ||
    !!manifest.extends ||
    !!manifest.derive ||
    !!manifest.density ||
    !!manifest.radii ||
    !!manifest.typography
  );
}
