/**
 * The style attribute of a logo element, read the way CSS reads it and
 * written out again.
 *
 * A brand logo needs very little CSS: a paint, an opacity, a stroke, a font,
 * a transform. So the value is split into tokens as CSS Syntax does it
 * (comments, quoted strings with their escapes, escapes in names, numbers,
 * functions), every declaration has to name one of the properties below and
 * carry a plain value, and anything else refuses the logo: another property,
 * url(), var() or any function that is not a colour or a transform,
 * !important, an at-rule, a block, and whatever can't be read to its end (a
 * string, comment or function that never closes, a broken escape).
 *
 * What is drawn is `style` of the result: the checked declarations written
 * out from their tokens, without comments or escapes. The text that came in
 * never reaches the drawing library, so there is nothing it could read
 * differently. Each character is looked at once.
 */

export type CheckedStyle = { ok: true; style: string } | { ok: false; reason: string };

type Token =
  | { kind: 'space' }
  | { kind: 'ident'; text: string }
  | { kind: 'function'; name: string }
  | { kind: 'string'; text: string }
  | { kind: 'hash'; text: string }
  /** A number, percentage or dimension: the number as written and its unit in lower case ('' for none). */
  | { kind: 'number'; text: string; unit: string }
  | { kind: 'mark'; char: ':' | ';' | ',' | ')' };

/** What a property's value may hold besides keywords. */
interface Accepts {
  colours?: boolean;
  numbers?: boolean;
  strings?: boolean;
  transforms?: boolean;
}

const PAINT: Accepts = { colours: true };
const NUMBER: Accepts = { numbers: true };
const KEYWORD: Accepts = { colours: false, numbers: false, strings: false, transforms: false };

/** The properties a style attribute may set. Each is also a presentation attribute of the profile. */
const PROPERTIES = new Map<string, Accepts>([
  ['fill', PAINT], ['stroke', PAINT], ['color', PAINT], ['stop-color', PAINT],
  ['fill-opacity', NUMBER], ['stroke-opacity', NUMBER], ['stop-opacity', NUMBER], ['opacity', NUMBER],
  ['fill-rule', KEYWORD],
  ['stroke-width', NUMBER], ['stroke-miterlimit', NUMBER], ['stroke-dasharray', NUMBER], ['stroke-dashoffset', NUMBER],
  ['stroke-linecap', KEYWORD], ['stroke-linejoin', KEYWORD],
  ['font', { numbers: true, strings: true }], ['font-family', { strings: true }], ['font-size', NUMBER],
  ['font-weight', NUMBER], ['font-stretch', NUMBER], ['font-style', KEYWORD], ['font-variant', KEYWORD],
  ['text-anchor', KEYWORD], ['letter-spacing', NUMBER],
  ['display', KEYWORD], ['visibility', KEYWORD],
  ['transform', { transforms: true }],
]);

/** The functions a value may call, by what they make. Their arguments are numbers. */
const FUNCTIONS = new Map<string, 'colours' | 'transforms'>([
  ['rgb', 'colours'], ['rgba', 'colours'], ['hsl', 'colours'], ['hsla', 'colours'],
  ['matrix', 'transforms'], ['translate', 'transforms'], ['translatex', 'transforms'], ['translatey', 'transforms'],
  ['scale', 'transforms'], ['scalex', 'transforms'], ['scaley', 'transforms'], ['rotate', 'transforms'],
  ['skew', 'transforms'], ['skewx', 'transforms'], ['skewy', 'transforms'],
]);

const UNITS = new Set(['', '%', 'px', 'pt', 'pc', 'mm', 'cm', 'in', 'em', 'ex', 'deg', 'rad', 'grad', 'turn']);

/** A keyword or font name that can be written out as it is: letters, digits, "-" and "_", no escape needed. */
const PLAIN_IDENT = /^-?[A-Za-z_\u{a0}-\u{d7ff}\u{e000}-\u{fffd}\u{10000}-\u{10ffff}][A-Za-z0-9_\-\u{a0}-\u{d7ff}\u{e000}-\u{fffd}\u{10000}-\u{10ffff}]*$/u;
const HEX_COLOUR = /^[0-9a-fA-F]{3,8}$/;
const CONTROL_CHARACTER = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`);

const SPACE: Token = { kind: 'space' };

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isHex(code: number): boolean {
  return isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

function isNewline(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x0c;
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || isNewline(code);
}

function isNameStart(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f || code >= 0x80;
}

function isNameChar(code: number): boolean {
  return isNameStart(code) || isDigit(code) || code === 0x2d;
}

interface Read {
  text: string;
  /** Index just after what was read. */
  next: number;
}

/** Whether the backslash at `at` starts an escape: anything but a line break or the end follows. */
function isEscape(css: string, at: number): boolean {
  return css.charCodeAt(at) === 0x5c && at + 1 < css.length && !isNewline(css.charCodeAt(at + 1));
}

/**
 * The escape whose backslash is at `at`: up to six hexadecimal digits and
 * one white space after them, or the next character itself. Null for a code
 * that names no character.
 */
function readEscape(css: string, at: number): Read | null {
  let i = at + 1;
  if (!isHex(css.charCodeAt(i))) {
    const point = css.codePointAt(i)!;
    return { text: String.fromCodePoint(point), next: i + (point > 0xffff ? 2 : 1) };
  }
  while (i < at + 7 && isHex(css.charCodeAt(i))) i++;
  const point = parseInt(css.slice(at + 1, i), 16);
  if (point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return null;
  if (css.charCodeAt(i) === 0x0d && css.charCodeAt(i + 1) === 0x0a) i += 2;
  else if (isSpace(css.charCodeAt(i))) i++;
  return { text: String.fromCodePoint(point), next: i };
}

/** Whether a name (a keyword, a property, a unit) starts at `at`. */
function startsName(css: string, at: number): boolean {
  let i = at;
  if (css.charCodeAt(i) === 0x2d) i++;
  const code = css.charCodeAt(i);
  return isNameStart(code) || (i > at && code === 0x2d) || isEscape(css, i);
}

/** The name at `at` with its escapes resolved; null when one of them is broken. */
function readName(css: string, at: number): Read | null {
  let text = '';
  let i = at;
  for (;;) {
    const code = css.charCodeAt(i);
    if (isNameChar(code)) {
      text += css[i];
      i++;
    } else if (isEscape(css, i)) {
      const escape = readEscape(css, i);
      if (!escape) return null;
      text += escape.text;
      i = escape.next;
    } else {
      return { text, next: i };
    }
  }
}

/** Whether a number starts at `at`: a digit, or a sign or a point with a digit behind it. */
function startsNumber(css: string, at: number): boolean {
  let i = at;
  const sign = css.charCodeAt(i);
  if (sign === 0x2b || sign === 0x2d) i++;
  if (css.charCodeAt(i) === 0x2e) i++;
  return isDigit(css.charCodeAt(i));
}

/** The index just after the number that starts at `at`. */
function numberEnd(css: string, at: number): number {
  let i = at;
  const sign = css.charCodeAt(i);
  if (sign === 0x2b || sign === 0x2d) i++;
  while (isDigit(css.charCodeAt(i))) i++;
  if (css.charCodeAt(i) === 0x2e && isDigit(css.charCodeAt(i + 1))) {
    i += 2;
    while (isDigit(css.charCodeAt(i))) i++;
  }
  const e = css.charCodeAt(i);
  if (e === 0x45 || e === 0x65) {
    let j = i + 1;
    const exponentSign = css.charCodeAt(j);
    if (exponentSign === 0x2b || exponentSign === 0x2d) j++;
    if (isDigit(css.charCodeAt(j))) {
      i = j + 1;
      while (isDigit(css.charCodeAt(i))) i++;
    }
  }
  return i;
}

/** The quoted string that opens at `at`, escapes resolved; null when it never closes or a line ends inside it. */
function readString(css: string, at: number): Read | null {
  const quote = css.charCodeAt(at);
  let text = '';
  let i = at + 1;
  for (;;) {
    if (i >= css.length) return null;
    const code = css.charCodeAt(i);
    if (code === quote) return { text, next: i + 1 };
    if (isNewline(code)) return null;
    if (code !== 0x5c) {
      text += css[i];
      i++;
      continue;
    }
    if (i + 1 >= css.length) return null;
    const after = css.charCodeAt(i + 1);
    if (isNewline(after)) {
      // A backslash before a line break continues the string on the next line.
      i += after === 0x0d && css.charCodeAt(i + 2) === 0x0a ? 3 : 2;
      continue;
    }
    const escape = readEscape(css, i);
    if (!escape) return null;
    text += escape.text;
    i = escape.next;
  }
}

/**
 * The value as CSS tokens, or null when it holds something a plain
 * declaration list has no use for or that can't be read to its end. A
 * comment counts as the space it separates its neighbours by.
 */
function tokenize(css: string): Token[] | null {
  const tokens: Token[] = [];
  const space = () => {
    if (tokens.length > 0 && tokens[tokens.length - 1].kind !== 'space') tokens.push(SPACE);
  };
  let i = 0;
  while (i < css.length) {
    const code = css.charCodeAt(i);
    if (code === 0x2f) {
      // "/" opens a comment here and nothing else: no listed value divides.
      if (css.charCodeAt(i + 1) !== 0x2a) return null;
      const end = css.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 2;
      space();
    } else if (isSpace(code)) {
      i++;
      space();
    } else if (code === 0x22 || code === 0x27) {
      const string = readString(css, i);
      if (!string) return null;
      tokens.push({ kind: 'string', text: string.text });
      i = string.next;
    } else if (code === 0x23) {
      if (!isNameChar(css.charCodeAt(i + 1)) && !isEscape(css, i + 1)) return null;
      const name = readName(css, i + 1);
      if (!name) return null;
      tokens.push({ kind: 'hash', text: name.text });
      i = name.next;
    } else if (code === 0x3a || code === 0x3b || code === 0x2c || code === 0x29) {
      tokens.push({ kind: 'mark', char: css[i] as ':' | ';' | ',' | ')' });
      i++;
    } else if (startsNumber(css, i)) {
      const end = numberEnd(css, i);
      const text = css.slice(i, end);
      i = end;
      let unit = '';
      if (css.charCodeAt(i) === 0x25) {
        unit = '%';
        i++;
      } else if (startsName(css, i)) {
        const name = readName(css, i);
        if (!name) return null;
        unit = name.text.toLowerCase();
        i = name.next;
      }
      tokens.push({ kind: 'number', text, unit });
    } else if (startsName(css, i)) {
      const name = readName(css, i);
      if (!name) return null;
      i = name.next;
      if (css.charCodeAt(i) === 0x28) {
        tokens.push({ kind: 'function', name: name.text.toLowerCase() });
        i++;
      } else {
        tokens.push({ kind: 'ident', text: name.text });
      }
    } else {
      // "@", "!", "{", "[", "(", a lone "\\" and every other character.
      return null;
    }
  }
  return tokens;
}

function quoted(text: string): string {
  return `"${text.replace(/["\\]/g, '\\$&')}"`;
}

/**
 * The style value checked and written out again, or why the logo can't be
 * shown. `style` holds only listed properties with plain values.
 */
export function checkedStyle(value: string): CheckedStyle {
  const refuse = (reason: string): CheckedStyle => ({ ok: false, reason });
  const tokens = tokenize(value);
  if (!tokens) return refuse('unreadable style');
  const isMark = (token: Token | undefined, char: string) => token?.kind === 'mark' && token.char === char;
  const number = (token: Extract<Token, { kind: 'number' }>) => (UNITS.has(token.unit) ? `${token.text}${token.unit}` : null);

  const declarations: string[] = [];
  let i = 0;
  const skipSpace = () => {
    while (tokens[i]?.kind === 'space') i++;
  };
  for (;;) {
    skipSpace();
    if (i >= tokens.length) break;
    const first = tokens[i++];
    if (isMark(first, ';')) continue;
    if (first.kind !== 'ident') return refuse('unreadable style');
    skipSpace();
    if (!isMark(tokens[i++], ':')) return refuse('unreadable style');
    const property = first.text.toLowerCase();
    const accepts = PROPERTIES.get(property);
    if (!accepts) return refuse('forbidden style property');

    const parts: string[] = [];
    for (; i < tokens.length && !isMark(tokens[i], ';'); i++) {
      const token = tokens[i];
      if (token.kind === 'space') continue;
      let part: string | null = null;
      if (token.kind === 'ident') {
        part = PLAIN_IDENT.test(token.text) ? token.text : null;
      } else if (token.kind === 'number') {
        part = accepts.numbers ? number(token) : null;
      } else if (token.kind === 'hash') {
        part = accepts.colours && HEX_COLOUR.test(token.text) ? `#${token.text}` : null;
      } else if (token.kind === 'string') {
        part = accepts.strings && !CONTROL_CHARACTER.test(token.text) ? quoted(token.text) : null;
      } else if (token.kind === 'mark') {
        part = token.char === ',' && (accepts.numbers || accepts.strings) ? ',' : null;
      } else {
        const makes = FUNCTIONS.get(token.name);
        if (!makes || !accepts[makes]) return refuse('forbidden style value');
        // Its arguments, up to the ")" that closes it.
        const args: string[] = [];
        for (i++; ; i++) {
          const arg = tokens[i];
          if (!arg) return refuse('unreadable style');
          if (isMark(arg, ')')) break;
          if (arg.kind === 'space') continue;
          const text = arg.kind === 'number' ? number(arg) : isMark(arg, ',') ? ',' : null;
          if (text === null) return refuse('forbidden style value');
          args.push(text);
        }
        part = `${token.name}(${args.join(' ')})`;
      }
      if (part === null) return refuse('forbidden style value');
      parts.push(part);
    }
    if (parts.length === 0) return refuse('forbidden style value');
    declarations.push(`${property}:${parts.join(' ')}`);
  }
  return { ok: true, style: declarations.join(';') };
}
