// Theme CSS injection and sanitization

import { DISALLOWED_CSS_PATTERNS } from './plugin-types';

const THEME_STYLE_ID = 'active-theme';

/**
 * Sanitize theme CSS: strip dangerous patterns like @import, external url(),
 * JavaScript expressions, and -moz-binding. Returns cleaned CSS.
 */
export function sanitizeThemeCSS(css: string): { css: string; warnings: string[] } {
  const warnings: string[] = [];
  let cleaned = css;

  for (const pattern of DISALLOWED_CSS_PATTERNS) {
    if (pattern.test(cleaned)) {
      warnings.push(`Removed disallowed pattern: ${pattern.source}`);
      cleaned = cleaned.replace(new RegExp(pattern.source, 'gi'), '/* [removed] */');
    }
  }

  return { css: cleaned, warnings };
}

/**
 * Validate that theme CSS only targets :root and .dark selectors.
 * Returns warnings for any other selectors found.
 */
export function validateThemeSelectors(css: string): string[] {
  const warnings: string[] = [];

  // Remove comments
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

  // Find selector blocks (text before { that isn't inside a value)
  const selectorRegex = /([^{}]+)\{/g;
  let match;
  while ((match = selectorRegex.exec(noComments)) !== null) {
    const selector = match[1].trim();
    // Allow :root, .dark, @font-face, @keyframes, @media
    if (
      selector === ':root' ||
      selector === '.dark' ||
      selector.startsWith('@font-face') ||
      selector.startsWith('@keyframes') ||
      selector.startsWith('@media') ||
      selector === ''
    ) {
      continue;
    }

    // Inside @media blocks, also allow :root and .dark
    if (selector === ':root' || selector === '.dark') continue;

    warnings.push(`Non-standard selector "${selector}" - themes should only use :root and .dark`);
  }

  return warnings;
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

  // Check for dangerous patterns
  for (const pattern of DISALLOWED_CSS_PATTERNS) {
    if (pattern.test(css)) {
      errors.push(`Contains disallowed pattern: ${pattern.source}`);
    }
  }

  // Check the CSS actually sets some variables
  if (!css.includes('--color-')) {
    errors.push('Theme CSS should set at least one --color-* variable');
  }

  return { valid: errors.length === 0, errors };
}
