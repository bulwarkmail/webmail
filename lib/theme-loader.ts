// Theme CSS injection and sanitization

import { DISALLOWED_CSS_PATTERNS } from './plugin-types';
import { syncThemeColorMeta } from './theme-color-meta';
import { THEME_CACHE_KEY, THEME_CACHE_MAX } from './boot-skeleton/keys';

const THEME_STYLE_ID = 'active-theme';
const THEME_SKIN_STYLE_ID = 'active-theme-skin';
const THEME_SKIN_BODY_ATTR = 'data-theme-skin';

// ─── Reading a stylesheet the way the browser does ──────────────
//
// A tokenizer after CSS Syntax Level 3 (section 4), as far as checking needs it.
// Every token is written back in a canonical form: escapes resolved, and a
// character escaped again only where it can't stand plainly (a `/` or `:` in
// a class name, a leading digit, a quote in a string). In that text every
// function, at-rule and property name is spelled out, so a check on it sees
// what the browser sees. A token without a backslash is kept as written.

class UnreadableCSS extends Error {}

const isNewline = (c: string | undefined) => c === '\n' || c === '\r' || c === '\f';
const isWhitespace = (c: string | undefined) => isNewline(c) || c === ' ' || c === '\t';
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isHexDigit = (c: string | undefined) => c !== undefined && /^[0-9A-Fa-f]$/.test(c);
/**
 * The characters beyond ASCII that may stand in a name unescaped (CSS Syntax,
 * "non-ASCII ident code point"). Any other one, such as a no-break space or a
 * C1 control, is a character of its own to a browser that follows the list
 * and part of the name to one that predates it. So it is read as written
 * when it stands plainly, and written as an escape when it came as one:
 * either way both kinds of browser read what they read before.
 */
function isNonAsciiIdentCodePoint(code: number): boolean {
  return code === 0xb7 || (code >= 0xc0 && code <= 0xd6) || (code >= 0xd8 && code <= 0xf6) || (code >= 0xf8 && code <= 0x37d)
    || (code >= 0x37f && code <= 0x1fff) || code === 0x200c || code === 0x200d || code === 0x203f || code === 0x2040
    || (code >= 0x2070 && code <= 0x218f) || (code >= 0x2c00 && code <= 0x2fef) || (code >= 0x3001 && code <= 0xd7ff)
    || (code >= 0xf900 && code <= 0xfdcf) || (code >= 0xfdf0 && code <= 0xfffd) || code >= 0x10000;
}
/** `c` is one whole character (both halves of a surrogate pair). */
const isNameStart = (c: string | undefined) => c !== undefined && c !== ''
  && (/^[A-Za-z_]$/.test(c) || isNonAsciiIdentCodePoint(c.codePointAt(0)!));
const isNameChar = (c: string | undefined) => isNameStart(c) || isDigit(c) || c === '-';
const isNonPrintable = (code: number) => code <= 8 || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f;

/** `\XX ` for a character that has to be written as a hex escape. */
const hexEscape = (ch: string) => `\\${ch.codePointAt(0)!.toString(16)} `;

/** An identifier as CSSOM serialises one: escapes only where a character can't stand plainly. */
function serializeIdent(name: string): string {
  const chars = [...name];
  return chars.map((ch, i) => {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f || (i === 0 && isDigit(ch)) || (i === 1 && isDigit(ch) && chars[0] === '-')) return hexEscape(ch);
    if (i === 0 && ch === '-' && chars.length === 1) return '\\-';
    if (code >= 0x80) return isNonAsciiIdentCodePoint(code) ? ch : hexEscape(ch);
    if (ch === '-' || ch === '_' || /^[0-9A-Za-z]$/.test(ch)) return ch;
    return `\\${ch}`;
  }).join('');
}

/** A name after `#` that is no identifier (a colour such as `#1a2b3c`): a digit may come first. */
function serializeName(name: string): string {
  return [...name].map((ch) => {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && !isNonAsciiIdentCodePoint(code))) return hexEscape(ch);
    return isNameChar(ch) ? ch : `\\${ch}`;
  }).join('');
}

function serializeString(value: string, quote: string): string {
  return quote + [...value].map((ch) => {
    const code = ch.codePointAt(0)!;
    if (ch === '\\' || ch === quote) return `\\${ch}`;
    if (isNewline(ch) || isNonPrintable(code)) return hexEscape(ch);
    return ch;
  }).join('') + quote;
}

function serializeUrl(value: string): string {
  return [...value].map((ch) => {
    const code = ch.codePointAt(0)!;
    if (ch === '\\' || ch === '"' || ch === "'" || ch === '(' || ch === ')') return `\\${ch}`;
    if (isWhitespace(ch) || isNonPrintable(code)) return hexEscape(ch);
    return ch;
  }).join('');
}

/** A dimension's unit; an `e` that would read as an exponent is escaped. */
function serializeUnit(unit: string): string {
  const ident = serializeIdent(unit);
  return /^[eE](?:[0-9]|[+-][0-9])/.test(unit) ? hexEscape(unit[0]) + ident.slice(1) : ident;
}

/** One token of a stylesheet: as written (`plain`) and in its canonical form (`text`). */
export interface CssToken {
  kind: 'comment' | 'space' | 'other';
  plain: string;
  text: string;
  /** Set on a token that opens or closes a bracket: `(` (also a function's `name(`), `[`, `{`, `)`, `]`, `}`. */
  bracket?: string;
}

function tokenizeCSS(s: string): CssToken[] {
  const tokens: CssToken[] = [];
  const push = (kind: CssToken['kind'], start: number, end: number, canonical?: () => string) => {
    const plain = s.slice(start, end);
    tokens.push({ kind, plain, text: canonical && plain.includes('\\') ? canonical() : plain });
  };
  const validEscape = (i: number) => s[i] === '\\' && i + 1 < s.length && !isNewline(s[i + 1]);
  const charAt = (i: number) => String.fromCodePoint(s.codePointAt(i)!);
  /** The whole character at `i`, or undefined past the end. */
  const peek = (i: number) => (i < s.length ? charAt(i) : undefined);

  /** The character a valid escape (its backslash at i - 1) stands for, and where it ends. */
  const consumeEscape = (i: number): [string, number] => {
    if (isHexDigit(s[i])) {
      let j = i;
      while (j < s.length && j - i < 6 && isHexDigit(s[j])) j++;
      const code = parseInt(s.slice(i, j), 16);
      if (s[j] === '\r' && s[j + 1] === '\n') j += 2;
      else if (isWhitespace(s[j])) j++;
      if (code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) throw new UnreadableCSS();
      return [String.fromCodePoint(code), j];
    }
    const ch = charAt(i);
    return [ch, i + ch.length];
  };
  const consumeName = (i: number): [string, number] => {
    let name = '';
    let j = i;
    for (;;) {
      if (isNameChar(peek(j))) {
        const ch = charAt(j);
        name += ch;
        j += ch.length;
      } else if (validEscape(j)) {
        const [ch, end] = consumeEscape(j + 1);
        name += ch;
        j = end;
      } else {
        return [name, j];
      }
    }
  };
  const startsIdent = (i: number) => {
    if (s[i] === '-') return isNameStart(peek(i + 1)) || s[i + 1] === '-' || validEscape(i + 1);
    if (isNameStart(peek(i))) return true;
    return validEscape(i);
  };
  const startsNumber = (i: number) => {
    if (s[i] === '+' || s[i] === '-') return isDigit(s[i + 1]) || (s[i + 1] === '.' && isDigit(s[i + 2]));
    if (s[i] === '.') return isDigit(s[i + 1]);
    return isDigit(s[i]);
  };
  const numeric = (start: number): number => {
    let j = start;
    if (s[j] === '+' || s[j] === '-') j++;
    while (isDigit(s[j])) j++;
    if (s[j] === '.' && isDigit(s[j + 1])) { j++; while (isDigit(s[j])) j++; }
    if ((s[j] === 'e' || s[j] === 'E') && (isDigit(s[j + 1]) || ((s[j + 1] === '+' || s[j + 1] === '-') && isDigit(s[j + 2])))) {
      j += isDigit(s[j + 1]) ? 1 : 2;
      while (isDigit(s[j])) j++;
    }
    const number = s.slice(start, j);
    if (startsIdent(j)) {
      const [unit, end] = consumeName(j);
      push('other', start, end, () => number + serializeUnit(unit));
      return end;
    }
    if (s[j] === '%') j++;
    push('other', start, j);
    return j;
  };
  const string = (start: number): number => {
    const quote = s[start];
    let value = '';
    let j = start + 1;
    for (;;) {
      const c = s[j];
      if (c === undefined || isNewline(c)) throw new UnreadableCSS();
      if (c === quote) { j++; break; }
      if (c === '\\') {
        if (j + 1 >= s.length) throw new UnreadableCSS();
        if (isNewline(s[j + 1])) { j += s[j + 1] === '\r' && s[j + 2] === '\n' ? 3 : 2; continue; }
        const [ch, end] = consumeEscape(j + 1);
        value += ch;
        j = end;
        continue;
      }
      const ch = charAt(j);
      value += ch;
      j += ch.length;
    }
    push('other', start, j, () => serializeString(value, quote));
    return j;
  };
  const url = (start: number, from: number): number => {
    let j = from;
    while (isWhitespace(s[j])) j++;
    let value = '';
    for (;;) {
      const c = s[j];
      if (c === undefined) throw new UnreadableCSS();
      if (c === ')') { j++; break; }
      if (isWhitespace(c)) {
        while (isWhitespace(s[j])) j++;
        if (s[j] !== ')') throw new UnreadableCSS();
        j++;
        break;
      }
      if (c === '"' || c === "'" || c === '(' || isNonPrintable(c.charCodeAt(0))) throw new UnreadableCSS();
      if (c === '\\') {
        if (!validEscape(j)) throw new UnreadableCSS();
        const [ch, end] = consumeEscape(j + 1);
        value += ch;
        j = end;
        continue;
      }
      const ch = charAt(j);
      value += ch;
      j += ch.length;
    }
    push('other', start, j, () => `url(${serializeUrl(value)})`);
    return j;
  };
  const identLike = (start: number): number => {
    const [name, end] = consumeName(start);
    if (s[end] === '(') {
      if (name.toLowerCase() === 'url') {
        let k = end + 1;
        while (isWhitespace(s[k])) k++;
        if (s[k] !== '"' && s[k] !== "'") return url(start, end + 1);
      }
      push('other', start, end + 1, () => `${serializeIdent(name)}(`);
      tokens[tokens.length - 1].bracket = '(';
      return end + 1;
    }
    push('other', start, end, () => serializeIdent(name));
    return end;
  };

  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end === -1) throw new UnreadableCSS();
      tokens.push({ kind: 'comment', plain: '', text: '' });
      i = end + 2;
    } else if (isWhitespace(c)) {
      const start = i;
      while (isWhitespace(s[i])) i++;
      push('space', start, i);
    } else if (c === '"' || c === "'") {
      i = string(i);
    } else if (c === '#' && (isNameChar(peek(i + 1)) || validEscape(i + 1))) {
      // A name that starts as an identifier makes the hash an id (`#\31 st`
      // selects id="1st"); written back it has to start as one again, or no
      // selector takes it. Any other hash (a colour) may start with a digit.
      const isId = startsIdent(i + 1);
      const [name, end] = consumeName(i + 1);
      push('other', i, end, () => `#${isId ? serializeIdent(name) : serializeName(name)}`);
      i = end;
    } else if ((c === '+' || c === '.' || c === '-') && startsNumber(i)) {
      i = numeric(i);
    } else if (c === '-' && s.startsWith('-->', i)) {
      push('other', i, i + 3);
      i += 3;
    } else if (c === '-' && startsIdent(i)) {
      i = identLike(i);
    } else if (c === '<' && s.startsWith('<!--', i)) {
      push('other', i, i + 4);
      i += 4;
    } else if (c === '@' && startsIdent(i + 1)) {
      const [name, end] = consumeName(i + 1);
      push('other', i, end, () => `@${serializeIdent(name)}`);
      i = end;
    } else if (c === '\\') {
      if (!validEscape(i)) throw new UnreadableCSS();
      i = identLike(i);
    } else if (isDigit(c)) {
      i = numeric(i);
    } else if (isNameStart(peek(i))) {
      i = identLike(i);
    } else {
      // Any other character stands for itself, a pair of surrogates as one.
      const width = charAt(i).length;
      push('other', i, i + width);
      if (width === 1 && '()[]{}'.includes(c)) tokens[tokens.length - 1].bracket = c;
      i += width;
    }
  }
  return tokens;
}

const CLOSING_BRACKET: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/**
 * The tokens of a sheet that reads cleanly, without its comments: a comment
 * between two tokens that would otherwise run together stays as an empty
 * one. Null when the sheet doesn't read cleanly: an unterminated
 * comment, string or url, a line break inside a string, a backslash before a
 * line break or at the end, an escape that names no character, a NUL, or
 * brackets that don't pair up (a block or a bracket left open, or closed by
 * another kind or never opened). A browser recovers from each of these by
 * its own rules and reads the rest of the sheet differently from any simpler
 * reading, so nothing is taken from such a sheet.
 */
export function readCssTokens(css: string): CssToken[] | null {
  if (css.includes('\0')) return null;
  let tokens: CssToken[];
  try {
    tokens = tokenizeCSS(css);
  } catch (error) {
    if (error instanceof UnreadableCSS) return null;
    throw error;
  }
  const open: string[] = [];
  for (const token of tokens) {
    if (!token.bracket) continue;
    if (CLOSING_BRACKET[token.bracket]) open.push(CLOSING_BRACKET[token.bracket]);
    else if (open.pop() !== token.bracket) return null;
  }
  if (open.length > 0) return null;

  const out: CssToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'comment') {
      out.push(token);
      continue;
    }
    let next = i;
    while (tokens[next + 1]?.kind === 'comment') next++;
    const before = tokens[i - 1];
    const after = tokens[next + 1];
    if (before && after && before.kind !== 'space' && after.kind !== 'space') {
      out.push({ kind: 'comment', plain: '/**/', text: '/**/' });
    }
    i = next;
  }
  return out;
}

/** The text of a run of tokens, as it is checked and written back. */
export const cssTextOf = (tokens: readonly CssToken[]): string => tokens.map((token) => token.text).join('');

/**
 * A stylesheet as the browser reads it. `text` has every escape resolved
 * (see above) and no comments; `plain` is the same sheet with each token as
 * written. Null when the sheet doesn't read cleanly (readCssTokens).
 */
export function readStylesheet(css: string): { text: string; plain: string } | null {
  const tokens = readCssTokens(css);
  if (!tokens) return null;
  return { text: cssTextOf(tokens), plain: tokens.map((token) => token.plain).join('') };
}

/** A rule of a sheet or of a block: what stands before its `{}` block, and the block's content. */
export interface CssRule {
  prelude: CssToken[];
  /** Null for a statement that has no block (`@charset "x";`, or text the sheet ends in). */
  body: CssToken[] | null;
}

/** Index of the token closing the bracket that `tokens[start]` opens. The brackets pair up (readCssTokens). */
function closingIndex(tokens: readonly CssToken[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const bracket = tokens[i].bracket;
    if (!bracket) continue;
    if (CLOSING_BRACKET[bracket]) depth++;
    else if (--depth === 0) return i;
  }
  return tokens.length - 1;
}

/**
 * The rules of a sheet, or of a block's content: a rule runs to the first
 * `{}` block outside parentheses and brackets, a statement to a `;` there.
 * A string or a comment is one token here, so nothing inside one can open or
 * close a rule. Each rule is judged and written back by itself, so text in
 * front of a `;` (what is left of a removed `@import`) costs only itself.
 */
export function splitCssRules(tokens: readonly CssToken[]): CssRule[] {
  const rules: CssRule[] = [];
  let prelude: CssToken[] = [];
  const hasText = () => prelude.some((token) => token.kind === 'other');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.bracket === '{') {
      const end = closingIndex(tokens, i);
      rules.push({ prelude, body: tokens.slice(i + 1, end) });
      prelude = [];
      i = end;
    } else if (token.bracket === '(' || token.bracket === '[') {
      const end = closingIndex(tokens, i);
      prelude.push(...tokens.slice(i, end + 1));
      i = end;
    } else if (token.text === ';') {
      if (hasText()) rules.push({ prelude, body: null });
      prelude = [];
    } else {
      prelude.push(token);
    }
  }
  if (hasText()) rules.push({ prelude, body: null });
  return rules;
}

const UNREADABLE = 'it could not be read cleanly (an unterminated comment, string, url or block, or a broken escape)';

const countMatches = (text: string, pattern: RegExp) => (text.match(new RegExp(pattern.source, 'gi')) ?? []).length;

/**
 * The removed constructs are looked for in the sheet as the browser reads it
 * (readStylesheet), and that reading is what comes back. A sheet that can't
 * be read cleanly, or that spells a removed construct with escapes, is
 * dropped whole: neither has an honest use. What comes back is text again:
 * a caller reads it once more before it takes rules from it or hands it on.
 */
function stripDisallowedPatterns(css: string, label: string): { css: string; warnings: string[] } {
  const read = readStylesheet(css);
  if (!read) {
    return { css: '', warnings: [`${label}removed the stylesheet: ${UNREADABLE}`] };
  }
  if (DISALLOWED_CSS_PATTERNS.some((pattern) => countMatches(read.text, pattern) > countMatches(read.plain, pattern))) {
    return { css: '', warnings: [`${label}removed the stylesheet: it hides a disallowed pattern behind CSS escapes`] };
  }

  const warnings: string[] = [];
  let cleaned = read.text;
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
 * (`url(`, `image-set(`, `image(`, `src(`) takes its arguments along, up to
 * the closing `)`.
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
 * image-set(), image(), src(), JavaScript expressions and -moz-binding, then
 * drop every rule whose selector is not `:root` or `.dark` (see
 * restrictThemeSelectors).
 */
export function sanitizeThemeCSS(css: string): { css: string; warnings: string[] } {
  const stripped = stripDisallowedPatterns(css, '');
  const scoped = restrictThemeSelectors(stripped.css);
  return { css: scoped.css, warnings: [...stripped.warnings, ...scoped.warnings] };
}

const THEME_SELECTORS = new Set([':root', '.dark']);
const OPAQUE_AT_RULES = /^@(?:-webkit-)?keyframes\b|^@font-face\b/i;
const NESTING_AT_RULES = /^@(?:media|supports)\b/i;

function filterThemeRules(tokens: readonly CssToken[], warnings: string[]): string {
  const out: string[] = [];
  for (const rule of splitCssRules(tokens)) {
    // Compared and written back without the empty comments that only kept two tokens apart.
    const prelude = cssTextOf(rule.prelude.filter((token) => token.kind !== 'comment')).trim();
    if (!rule.body) {
      // A statement without a block (`@charset`, `@namespace`, stray text).
      warnings.push(`Removed "${prelude.slice(0, 60)}" - themes only set :root and .dark variables`);
      continue;
    }
    const body = cssTextOf(rule.body);
    if (OPAQUE_AT_RULES.test(prelude)) {
      out.push(`${prelude} {${body}}`);
    } else if (NESTING_AT_RULES.test(prelude)) {
      out.push(`${prelude} {${filterThemeRules(rule.body, warnings)}}`);
    } else if (
      prelude.split(',').every((selector) => THEME_SELECTORS.has(selector.trim()))
      && !rule.body.some((token) => token.bracket === '{')
    ) {
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
 *
 * The rules are taken from the sheet's tokens (readCssTokens), so a string,
 * a comment or an escape is read here as the browser reads it. Nothing is
 * kept of a sheet that doesn't read cleanly.
 */
export function restrictThemeSelectors(css: string): { css: string; warnings: string[] } {
  const tokens = readCssTokens(css);
  if (!tokens) return { css: '', warnings: [`removed the stylesheet: ${UNREADABLE}`] };
  const warnings: string[] = [];
  const filtered = filterThemeRules(tokens, warnings);
  return { css: filtered, warnings };
}

/**
 * Validate that theme CSS only targets :root and .dark selectors.
 * Returns a warning for every rule restrictThemeSelectors() would drop.
 */
export function validateThemeSelectors(css: string): string[] {
  return restrictThemeSelectors(css).warnings;
}

interface ThemeCache {
  v: 1;
  css?: string;
  skin?: string;
  skinId?: string;
}

function readThemeCache(): ThemeCache {
  try {
    const parsed = JSON.parse(localStorage.getItem(THEME_CACHE_KEY) || 'null');
    if (parsed && typeof parsed === 'object' && parsed.v === 1) return parsed as ThemeCache;
  } catch { /* corrupt or blocked: start over */ }
  return { v: 1 };
}

/**
 * Keeps a copy of the injected theme for the next page load: the boot script
 * in app/(main)/layout.tsx (applyBootTheme) recreates the same <style>
 * elements before the first paint, so a themed page never paints in the
 * default palette first. Too large to cache, or storage full: no copy, and
 * the page paints the default palette until the theme loads, as before.
 */
function updateThemeCache(change: Partial<Omit<ThemeCache, 'v'>>): void {
  try {
    const next: ThemeCache = { ...readThemeCache(), ...change };
    if (!next.css) delete next.css;
    if (!next.skin || !next.skinId) { delete next.skin; delete next.skinId; }
    const size = (next.css?.length ?? 0) + (next.skin?.length ?? 0);
    if ((!next.css && !next.skin) || size > THEME_CACHE_MAX) {
      localStorage.removeItem(THEME_CACHE_KEY);
      return;
    }
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(next));
  } catch {
    try { localStorage.removeItem(THEME_CACHE_KEY); } catch { /* storage blocked */ }
  }
}

/**
 * The skin as the boot script can apply it. <body> doesn't exist when that
 * script runs, so selectors on `body[data-theme-skin=...]` are rewritten to
 * hang off <html>, where the script sets the same attribute.
 */
export function bootSkinCSS(css: string): string {
  return css.replace(/\bbody(\[data-theme-skin(?:[~|^$*]?=[^\]]*)?\])/g, 'html$1 body');
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
  updateThemeCache({ css });
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
  updateThemeCache({ css: undefined });
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
  // The boot copy's attribute on <html> has done its job once <body> has it.
  document.documentElement.removeAttribute(THEME_SKIN_BODY_ATTR);
  updateThemeCache({ skin: bootSkinCSS(css), skinId: themeId });
  syncThemeColorMeta();
}

export function removeThemeSkinCSS(): void {
  if (typeof document === 'undefined') return;

  const styleEl = document.getElementById(THEME_SKIN_STYLE_ID);
  if (styleEl) styleEl.remove();
  if (document.body) document.body.removeAttribute(THEME_SKIN_BODY_ATTR);
  document.documentElement.removeAttribute(THEME_SKIN_BODY_ATTR);
  updateThemeCache({ skin: undefined, skinId: undefined });
  syncThemeColorMeta();
}

/**
 * Sanitize a theme *skin* - looser than `sanitizeThemeCSS` because skins
 * intentionally target real component selectors (toolbars, lists, buttons),
 * not just `:root`/`.dark`. The same script-injection / external-resource
 * prohibitions still apply: no value in a skin may carry an address.
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

  // What is left has to read cleanly too: a removal that cut into a string
  // would leave a sheet the browser reads its own way.
  if (!readCssTokens(cleaned)) {
    return { css: '', warnings: [...warnings, `Skin: removed the stylesheet: ${UNREADABLE}`] };
  }
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

  // Check the sheet as the browser reads it, so escapes hide nothing.
  const read = readStylesheet(css);
  if (!read) {
    errors.push('Theme CSS could not be read cleanly (an unterminated comment, string, url or block, or a broken escape)');
    return { valid: false, errors };
  }
  for (const pattern of DISALLOWED_CSS_PATTERNS) {
    if (pattern.test(read.text)) {
      errors.push(`Contains disallowed pattern: ${pattern.source}`);
    }
  }
  errors.push(...restrictThemeSelectors(read.text).warnings);

  // Check the CSS actually sets some variables
  if (!css.includes('--color-')) {
    errors.push('Theme CSS should set at least one --color-* variable');
  }

  return { valid: errors.length === 0, errors };
}
