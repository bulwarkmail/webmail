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

import { sanitizeSkinCSS } from '@/lib/theme-loader';

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

/** Index of the `}` closing the block opened just before `start`, or -1. */
function blockEnd(css: string, start: number): number {
  let depth = 1;
  for (let i = start; i < css.length; i++) {
    const c = css[i];
    if (c === '\\') i++;
    else if (c === '"' || c === "'") {
      for (i++; i < css.length && css[i] !== c; i++) if (css[i] === '\\') i++;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Splits at commas outside brackets and parentheses. */
function splitSelectors(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < prelude.length; i++) {
    const c = prelude[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(prelude.slice(start, i));
      start = i + 1;
    }
  }
  out.push(prelude.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The selector outside parentheses and brackets, where a sibling combinator would leave the scope. */
function topLevel(selector: string): string {
  let depth = 0;
  let out = '';
  for (const c of selector) {
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0) out += c;
  }
  return out;
}

/**
 * One selector moved inside the scope: `:root`, `html` and `body` name the
 * printout itself, anything else is looked for inside it. Null when it could
 * reach outside: a sibling combinator, a shadow-tree or page selector.
 */
function scopeSelector(selector: string): string | null {
  const top = topLevel(selector);
  if (/[~+|]/.test(top) || /::?(?:host|slotted|part)\b/i.test(selector) || /&/.test(selector)) return null;
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

function filterRules(css: string, state: FilterState, nested: boolean): string {
  const { warnings } = state;
  const out: string[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    const semi = css.indexOf(';', i);
    if (open === -1 || (semi !== -1 && semi < open)) {
      const end = semi === -1 ? css.length : semi + 1;
      const statement = css.slice(i, end).trim();
      if (statement && statement !== ';') warnings.push(`removed "${statement.slice(0, 60)}"`);
      i = end;
      continue;
    }
    const close = blockEnd(css, open + 1);
    if (close === -1) {
      warnings.push('removed an unterminated rule');
      break;
    }
    const prelude = css.slice(i, open).trim();
    const body = css.slice(open + 1, close);
    i = close + 1;

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
      const inner = filterRules(body, state, true);
      if (inner.trim()) out.push(`${prelude} {${inner}}`);
    } else if (prelude.startsWith('@')) {
      warnings.push(`removed "${prelude.slice(0, 60)}": at-rules other than @media, @supports and @page aren't allowed`);
    } else if (body.includes('{')) {
      warnings.push(`removed the rule for "${prelude.slice(0, 60)}": nested rules aren't allowed`);
    } else {
      const scoped = splitSelectors(prelude).map(scopeSelector);
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
 */
export function sanitizePrintThemeCss(css: string): { css: string; pageMargin: string | null; warnings: string[] } {
  if (css.length > MAX_CSS) return { css: '', pageMargin: null, warnings: [`the CSS is larger than ${MAX_CSS / 1024} KB`] };
  const stripped = sanitizeSkinCSS(css.replace(/\/\*[\s\S]*?\*\//g, ' '));
  const warnings = [...stripped.warnings];
  let text = stripped.css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (text.includes('<')) {
    warnings.push('removed "<" characters');
    text = text.replace(/</g, '');
  }
  const state: FilterState = { warnings, pageMargin: null };
  return { css: filterRules(text, state, false), pageMargin: state.pageMargin, warnings };
}
