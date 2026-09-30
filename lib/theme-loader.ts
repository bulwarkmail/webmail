// Theme CSS injection and sanitization

import { DISALLOWED_CSS_PATTERNS } from './plugin-types';
import { syncThemeColorMeta } from './theme-color-meta';

const THEME_STYLE_ID = 'active-theme';
const THEME_SKIN_STYLE_ID = 'active-theme-skin';
const THEME_SKIN_BODY_ATTR = 'data-theme-skin';

/**
 * Resolve CSS escapes (`\69mport`, `\75rl(`, `\:`) so a keyword spelled with
 * escapes is recognised for what the browser will read. For detection only:
 * the output is not safe to inject, since a decoded `\"` would end a string.
 */
function decodeCssEscapes(css: string): string {
  return css.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([^\n\r\f0-9a-fA-F])/g, (_match, hex: string | undefined, ch: string | undefined) => {
    if (hex === undefined) return ch ?? '';
    const codePoint = parseInt(hex, 16);
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '�';
  });
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** A disallowed construct that only appears once escapes are resolved. */
function hasEscapedDisallowedPattern(css: string): boolean {
  const decoded = decodeCssEscapes(stripComments(css));
  return DISALLOWED_CSS_PATTERNS.some((pattern) => pattern.test(decoded) && !pattern.test(css));
}

function stripDisallowedPatterns(css: string, label: string): { css: string; warnings: string[] } {
  // Escapes that spell out a banned construct have no honest use, and where
  // the construct ends can't be found without a full parser: drop it all.
  if (hasEscapedDisallowedPattern(css)) {
    return { css: '', warnings: [`${label}removed the stylesheet: it hides a disallowed pattern behind CSS escapes`] };
  }

  const warnings: string[] = [];
  let cleaned = css;
  for (const pattern of DISALLOWED_CSS_PATTERNS) {
    if (pattern.test(cleaned)) {
      warnings.push(`${label}removed disallowed pattern: ${pattern.source}`);
      cleaned = removeMatches(cleaned, new RegExp(pattern.source, 'gi'));
    }
  }
  return { css: cleaned, warnings };
}

/**
 * Replace each match with a comment. A match that opens a function
 * (`url(`, `image-set(`) takes its arguments along, up to the closing `)`.
 */
function removeMatches(css: string, pattern: RegExp): string {
  let out = '';
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    let end = match.index + match[0].length;
    if (match[0].endsWith('(')) end = findParenEnd(css, end);
    out += css.slice(last, match.index) + '/* [removed] */';
    last = end;
    pattern.lastIndex = Math.max(end, match.index + 1);
  }
  return out + css.slice(last);
}

/** Index just past the `)` closing a call whose arguments start at `start`. */
function findParenEnd(css: string, start: number): number {
  let depth = 1;
  for (let i = start; i < css.length; i++) {
    const c = css[i];
    if (c === '\\') {
      i++;
    } else if (c === '"' || c === "'") {
      for (i++; i < css.length && css[i] !== c; i++) {
        if (css[i] === '\\') i++;
      }
    } else if (c === '(') {
      depth++;
    } else if (c === ')' && --depth === 0) {
      return i + 1;
    } else if (c === ';' || c === '}' || c === '{') {
      return i;
    }
  }
  return css.length;
}

/**
 * Sanitize theme CSS: strip dangerous patterns like @import, url(),
 * image-set(), JavaScript expressions and -moz-binding, then drop every
 * rule whose selector is not `:root` or `.dark` (see restrictThemeSelectors).
 */
export function sanitizeThemeCSS(css: string): { css: string; warnings: string[] } {
  const stripped = stripDisallowedPatterns(css, '');
  const scoped = restrictThemeSelectors(stripped.css);
  return { css: scoped.css, warnings: [...stripped.warnings, ...scoped.warnings] };
}

const THEME_SELECTORS = new Set([':root', '.dark']);
const OPAQUE_AT_RULES = /^@(?:-webkit-)?keyframes\b|^@font-face\b/i;
const NESTING_AT_RULES = /^@(?:media|supports)\b/i;

/** Index of the `}` closing the block opened just before `start`, or -1. */
function findBlockEnd(css: string, start: number): number {
  let depth = 1;
  for (let i = start; i < css.length; i++) {
    const c = css[i];
    if (c === '\\') {
      i++;
    } else if (c === '"' || c === "'") {
      for (i++; i < css.length && css[i] !== c; i++) {
        if (css[i] === '\\') i++;
      }
    } else if (c === '{') {
      depth++;
    } else if (c === '}' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

function filterThemeRules(css: string, warnings: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    const semi = css.indexOf(';', i);
    if (open === -1 || (semi !== -1 && semi < open)) {
      // A statement without a block (`@charset`, `@namespace`, stray text).
      const end = semi === -1 ? css.length : semi + 1;
      const statement = css.slice(i, end).trim();
      if (statement && statement !== ';') warnings.push(`Removed "${statement.slice(0, 60)}" - themes only set :root and .dark variables`);
      i = end;
      continue;
    }
    const close = findBlockEnd(css, open + 1);
    if (close === -1) {
      warnings.push('Removed an unterminated rule');
      break;
    }
    const prelude = css.slice(i, open).trim();
    const body = css.slice(open + 1, close);
    i = close + 1;

    if (OPAQUE_AT_RULES.test(prelude)) {
      out.push(`${prelude} {${body}}`);
    } else if (NESTING_AT_RULES.test(prelude)) {
      out.push(`${prelude} {${filterThemeRules(body, warnings)}}`);
    } else if (prelude.split(',').every((selector) => THEME_SELECTORS.has(selector.trim())) && !body.includes('{')) {
      out.push(`${prelude} {${body}}`);
    } else {
      warnings.push(`Removed rule for "${prelude.slice(0, 60)}" - themes only set :root and .dark variables`);
    }
  }
  return out.join('\n');
}

/**
 * Keep only rules for `:root` and `.dark` (declarations only, no nested
 * rules), plus `@font-face`, `@keyframes`, and `@media` / `@supports`
 * wrapping such rules. Theme CSS is injected into the app document; any
 * other selector could restyle or hide real UI, or read form state through
 * attribute selectors. Component-level styling belongs in a v2 skin.
 */
export function restrictThemeSelectors(css: string): { css: string; warnings: string[] } {
  const warnings: string[] = [];
  const filtered = filterThemeRules(stripComments(css), warnings);
  return { css: filtered, warnings };
}

/**
 * Validate that theme CSS only targets :root and .dark selectors.
 * Returns a warning for every rule restrictThemeSelectors() would drop.
 */
export function validateThemeSelectors(css: string): string[] {
  return restrictThemeSelectors(css).warnings;
}

/**
 * Inject theme CSS into the document head.
 * Inserted after globals.css so theme variables win specificity.
 */
export function injectThemeCSS(css: string): void {
  if (typeof document === 'undefined') return;

  let styleEl = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;

  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = THEME_STYLE_ID;
    document.head.appendChild(styleEl);
  }

  styleEl.textContent = css;
  syncThemeColorMeta();
}

/**
 * Remove injected theme CSS, reverting to default.
 */
export function removeThemeCSS(): void {
  if (typeof document === 'undefined') return;

  const styleEl = document.getElementById(THEME_STYLE_ID);
  if (styleEl) {
    styleEl.remove();
  }
  syncThemeColorMeta();
}

/**
 * Inject a theme's *skin* CSS - component-level overrides shipped by Theme
 * API v2 themes via `skin.css`. Lives in a separate `<style>` tag so it can
 * be removed cleanly without touching the colour-token block, and is placed
 * AFTER the colour block so component rules win specificity.
 *
 * Also sets `body[data-theme-skin="<themeId>"]` so authors can scope their
 * own `:not(...)` overrides if they want belt-and-braces specificity.
 */
export function injectThemeSkinCSS(css: string, themeId: string): void {
  if (typeof document === 'undefined') return;

  let styleEl = document.getElementById(THEME_SKIN_STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = THEME_SKIN_STYLE_ID;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = css;

  if (document.body) {
    document.body.setAttribute(THEME_SKIN_BODY_ATTR, themeId);
  }
  syncThemeColorMeta();
}

export function removeThemeSkinCSS(): void {
  if (typeof document === 'undefined') return;

  const styleEl = document.getElementById(THEME_SKIN_STYLE_ID);
  if (styleEl) styleEl.remove();
  if (document.body) document.body.removeAttribute(THEME_SKIN_BODY_ATTR);
  syncThemeColorMeta();
}

/**
 * Sanitize a theme *skin* - looser than `sanitizeThemeCSS` because skins
 * intentionally target real component selectors (toolbars, lists, buttons),
 * not just `:root`/`.dark`. The same script-injection / external-resource
 * prohibitions still apply.
 */
export function sanitizeSkinCSS(css: string): { css: string; warnings: string[] } {
  const stripped = stripDisallowedPatterns(css, 'Skin: ');
  const warnings = stripped.warnings;
  let cleaned = stripped.css;

  // `@import` is already covered by DISALLOWED_CSS_PATTERNS, but skins also
  // get an explicit no-`@charset`/`@namespace` policy so they can't change
  // how the host stylesheet parses subsequent rules.
  cleaned = cleaned.replace(/@(charset|namespace)\b[^;]*;?/gi, () => {
    warnings.push('Skin: removed @charset/@namespace directive');
    return '/* [removed] */';
  });

  return { css: cleaned, warnings };
}

/**
 * Check if a theme CSS string is valid and safe.
 */
export function validateThemeCSSSafety(css: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!css.trim()) {
    errors.push('Theme CSS is empty');
    return { valid: false, errors };
  }

  // Check for dangerous patterns, also when spelled with CSS escapes
  const decoded = decodeCssEscapes(stripComments(css));
  for (const pattern of DISALLOWED_CSS_PATTERNS) {
    if (pattern.test(decoded)) {
      errors.push(`Contains disallowed pattern: ${pattern.source}`);
    }
  }
  errors.push(...restrictThemeSelectors(css).warnings);

  // Check the CSS actually sets some variables
  if (!css.includes('--color-')) {
    errors.push('Theme CSS should set at least one --color-* variable');
  }

  return { valid: errors.length === 0, errors };
}
