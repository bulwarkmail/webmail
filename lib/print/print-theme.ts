/**
 * How printouts can be styled beyond the standard look.
 *
 * Two sources:
 *
 * - The app's theme (Settings > Appearance > Theme, theme plugins) sets the
 *   `--print-*` variables below on `:root`, in its theme.css or through the
 *   `print` tokens of a Theme API v2 manifest. app/print.css reads them for
 *   the print copy, and the Print window copies them over.
 * - A plugin registers a print style (`api.ui.registerPrintTheme`): its own
 *   CSS for the printout and a letterhead (a header and a footer). The user
 *   picks it under Settings > Appearance > Printing.
 *
 * Nothing set and Standard picked: the printout looks as it always did.
 */

import { cssTextOf, readCssTokens, sanitizeSkinCSS, splitCssRules, type CssToken } from '@/lib/theme-loader';

/** The variables a theme may set for printouts, with what each changes. */
export const PRINT_THEME_VARS = [
  /** Text of the printout: header, details and the body's default font. */
  '--print-font-family',
  /** The subject line. */
  '--print-heading-font-family',
  /** Text colour. */
  '--print-text-color',
  /** Colour of the subject line. */
  '--print-heading-color',
  /** The rule under the header and other lines. */
  '--print-rule-color',
  /** Page margins of a printed message (1 to 4 lengths in mm, cm, in, pt or px). */
  '--print-page-margin',
] as const;

export type PrintThemeVar = typeof PRINT_THEME_VARS[number];

const MAX_VALUE = 300;

/**
 * A variable's value as it may go into another document's <style>: no way
 * out of the declaration or the element, and nothing that loads.
 */
export function isSafePrintValue(value: string): boolean {
  if (!value || value.length > MAX_VALUE) return false;
  if (/[<>{};\\]/.test(value)) return false;
  return !/url\s*\(|image-set\s*\(|expression\s*\(|javascript:|@import/i.test(value);
}

const LENGTH = String.raw`(?:0|\d{1,3}(?:\.\d{1,2})?(?:mm|cm|in|pt|px))`;
const MARGIN_RE = new RegExp(`^${LENGTH}(?:\\s+${LENGTH}){0,3}$`);

/** A page margin a theme asked for, or null when it is not 1 to 4 plain lengths. */
export function printPageMargin(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return MARGIN_RE.test(v) ? v : null;
}

/** The `--print-*` variables the page's theme sets, checked. */
export function readPrintThemeVars(el: Element | null = typeof document === 'undefined' ? null : document.documentElement): Partial<Record<PrintThemeVar, string>> {
  if (!el || typeof getComputedStyle !== 'function') return {};
  const style = getComputedStyle(el);
  const out: Partial<Record<PrintThemeVar, string>> = {};
  for (const name of PRINT_THEME_VARS) {
    const value = style.getPropertyValue(name).trim();
    if (!value || !isSafePrintValue(value)) continue;
    if (name === '--print-page-margin' && !printPageMargin(value)) continue;
    out[name] = value;
  }
  return out;
}

/** `:root { ... }` with the variables, for a document of its own (the Print window), or ''. */
export function printThemeVarsCss(vars: Partial<Record<PrintThemeVar, string>>): string {
  const lines = PRINT_THEME_VARS
    .filter((name) => vars[name] && isSafePrintValue(vars[name]!))
    .map((name) => `${name}: ${vars[name]};`);
  return lines.length ? `:root { ${lines.join(' ')} }` : '';
}

/** The element a plugin print style's rules are scoped to: the print copy, or the Print window's body. */
export const PRINT_THEME_SCOPE = '[data-print-theme]';

const MAX_CSS = 64 * 1024;
const NESTING_AT_RULES = /^@(?:media|supports)\b/i;
const PAGE_RULE = /^@page\b/i;

/** The selectors of a rule: its tokens divided at the commas outside parentheses and brackets. */
function splitSelectors(prelude: readonly CssToken[]): CssToken[][] {
  const out: CssToken[][] = [[]];
  let depth = 0;
  for (const token of prelude) {
    if (token.bracket === '(' || token.bracket === '[') depth++;
    else if (token.bracket === ')' || token.bracket === ']') depth--;
    if (token.text === ',' && depth === 0) out.push([]);
    else out[out.length - 1].push(token);
  }
  return out.filter((selector) => selector.some((token) => token.kind === 'other'));
}

/** Whether a selector has a sibling or namespace combinator outside parentheses and brackets, where it would leave the scope. */
function leavesScope(selector: readonly CssToken[]): boolean {
  let depth = 0;
  for (const token of selector) {
    if (token.bracket === '(' || token.bracket === '[') depth++;
    else if (token.bracket === ')' || token.bracket === ']') depth--;
    else if (depth === 0 && (token.text === '~' || token.text === '+' || token.text === '|')) return true;
  }
  return false;
}

/**
 * One selector moved inside the scope: `:root`, `html` and `body` name the
 * printout itself, anything else is looked for inside it. Null when it could
 * reach outside: a sibling combinator, a shadow-tree or page selector.
 */
function scopeSelector(tokens: readonly CssToken[]): string | null {
  const selector = cssTextOf(tokens).trim();
  if (leavesScope(tokens) || /::?(?:host|slotted|part)\b/i.test(selector) || /&/.test(selector)) return null;
  const root = /^(?::root|html|body)(?:\s*>?\s*body)?(?=$|[\s>])/i;
  if (root.test(selector)) {
    const rest = selector.replace(root, '').trim();
    return rest ? `${PRINT_THEME_SCOPE} ${rest}` : PRINT_THEME_SCOPE;
  }
  return `${PRINT_THEME_SCOPE} ${selector}`;
}

interface FilterState {
  warnings: string[];
  /** The margin of a top-level `@page` rule. */
  pageMargin: string | null;
}

/**
 * The rules of a sheet, or of an `@media` or `@supports` block, each moved
 * inside the scope. They are taken from the sheet's tokens, so a string, a
 * comment or an escape is read here as the browser reads it.
 */
function filterRules(tokens: readonly CssToken[], state: FilterState, nested: boolean): string {
  const { warnings } = state;
  const out: string[] = [];
  for (const rule of splitCssRules(tokens)) {
    const prelude = cssTextOf(rule.prelude).trim();
    if (!rule.body) {
      warnings.push(`removed "${prelude.slice(0, 60)}"`);
      continue;
    }
    const body = cssTextOf(rule.body);

    if (PAGE_RULE.test(prelude) && !nested) {
      if (prelude !== '@page') {
        warnings.push(`removed "${prelude.slice(0, 60)}": only a plain @page rule is allowed`);
        continue;
      }
      for (const decl of body.split(';').map((d) => d.trim()).filter(Boolean)) {
        const [prop, ...value] = decl.split(':');
        const margin = prop.trim().toLowerCase() === 'margin' ? printPageMargin(value.join(':').replace(/!important/i, '')) : null;
        if (margin) state.pageMargin = margin;
        else warnings.push(`removed "@page { ${decl.slice(0, 40)} }": only a margin in plain lengths`);
      }
    } else if (NESTING_AT_RULES.test(prelude)) {
      const inner = filterRules(rule.body, state, true);
      if (inner.trim()) out.push(`${prelude} {${inner}}`);
    } else if (prelude.startsWith('@')) {
      warnings.push(`removed "${prelude.slice(0, 60)}": at-rules other than @media, @supports and @page aren't allowed`);
    } else if (rule.body.some((token) => token.bracket === '{')) {
      warnings.push(`removed the rule for "${prelude.slice(0, 60)}": nested rules aren't allowed`);
    } else {
      const scoped = splitSelectors(rule.prelude).map(scopeSelector);
      if (scoped.length === 0 || scoped.some((s) => s === null)) {
        warnings.push(`removed the rule for "${prelude.slice(0, 60)}": it could reach outside the printout`);
        continue;
      }
      out.push(`${scoped.join(', ')} {${body}}`);
    }
  }
  return out.join('\n');
}

/**
 * A plugin's print style CSS, made safe to put into the app's page and into
 * the Print window: nothing that loads (no url(), @import, image-set), no
 * script constructs, no `<` that could end the <style> element, and every
 * rule scoped to the printout (`[data-print-theme] ...`), so it can't touch
 * the app around it. `@media` and `@supports` stay, with their rules scoped
 * too. A top-level `@page { margin }` comes back as `pageMargin`, for printed
 * messages (the calendar views fill one sheet each). Every other at-rule goes.
 * Nothing is kept of a sheet that doesn't read cleanly (an unterminated
 * comment, string or block).
 */
export function sanitizePrintThemeCss(css: string): { css: string; pageMargin: string | null; warnings: string[] } {
  if (css.length > MAX_CSS) return { css: '', pageMargin: null, warnings: [`the CSS is larger than ${MAX_CSS / 1024} KB`] };
  const stripped = sanitizeSkinCSS(css);
  const warnings = [...stripped.warnings];
  let text = stripped.css;
  if (text.includes('<')) {
    warnings.push('removed "<" characters');
    text = text.replace(/</g, '');
  }
  // Read once more, as it stands now: the rules are taken from exactly the
  // text the removals left.
  const tokens = readCssTokens(text);
  if (!tokens) {
    return { css: '', pageMargin: null, warnings: [...warnings, 'removed the stylesheet: it could not be read cleanly'] };
  }
  const state: FilterState = { warnings, pageMargin: null };
  return { css: filterRules(tokens, state, false), pageMargin: state.pageMargin, warnings };
}
