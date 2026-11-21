/**
 * FileNode naming rules a server publishes in its filenode capability
 * (`forbiddenNameChars`, `forbiddenNodeNames`, `maxSizeFileNodeName`;
 * Stalwart 0.16.6+). A name that breaks them is refused ("Name contains a
 * forbidden character." / "Name is reserved and cannot be used."), which used
 * to surface only after an upload had started.
 *
 * Stalwart 1.0 checks more than its capability says (`validate_name`,
 * jmap/src/file/node.rs), on every name set over JMAP:
 * - no control characters (Rust's `char::is_control`: U+0000-001F, U+007F-009F);
 * - a reserved name may not be the stem either, the text before the first
 *   "." (unless that is empty): "con.txt" and "Aux.tar.gz" are refused too.
 * 1.0's rules take in 0.16's, so they are applied wherever the server
 * publishes rules; on 0.16.6-0.16.23 "con.txt" is renamed although it would
 * have been taken.
 */
export interface FileNameRules {
  forbiddenChars: string;
  forbiddenNames: string[];
  /** Longest name, in bytes of UTF-8. */
  maxNameBytes: number;
}

export type FileNameProblem =
  | { kind: 'chars'; chars: string }
  | { kind: 'control' }
  | { kind: 'tooLong' }
  | { kind: 'reserved' };

// Every Stalwart release refuses names over 255 bytes.
const DEFAULT_MAX_NAME_BYTES = 255;

export function fileNameRulesFrom(capability: unknown): FileNameRules | null {
  if (!capability || typeof capability !== 'object') return null;
  const cap = capability as { forbiddenNameChars?: unknown; forbiddenNodeNames?: unknown; maxSizeFileNodeName?: unknown };
  const forbiddenChars = typeof cap.forbiddenNameChars === 'string' ? cap.forbiddenNameChars : '';
  const forbiddenNames = Array.isArray(cap.forbiddenNodeNames)
    ? cap.forbiddenNodeNames.filter((n): n is string => typeof n === 'string')
    : [];
  if (!forbiddenChars && forbiddenNames.length === 0) return null;
  const maxNameBytes = typeof cap.maxSizeFileNodeName === 'number' && cap.maxSizeFileNodeName > 0
    ? cap.maxSizeFileNodeName
    : DEFAULT_MAX_NAME_BYTES;
  return { forbiddenChars, forbiddenNames, maxNameBytes };
}

function isControlChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

// Stalwart compares reserved names ignoring ASCII case only.
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, c => c.toLowerCase());
}

function nameStem(name: string): string {
  const dot = name.indexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function isReservedName(name: string, reserved: string[]): boolean {
  const whole = asciiLower(name);
  const stem = asciiLower(nameStem(name));
  return reserved.some(n => asciiLower(n) === whole || asciiLower(n) === stem);
}

export function fileNameProblem(name: string, rules: FileNameRules | null): FileNameProblem | null {
  if (!rules) return null;
  if (utf8Length(name) > rules.maxNameBytes) return { kind: 'tooLong' };
  const bad = [...new Set([...name].filter(c => rules.forbiddenChars.includes(c)))];
  if (bad.length) return { kind: 'chars', chars: bad.join(' ') };
  if ([...name].some(isControlChar)) return { kind: 'control' };
  if (isReservedName(name, rules.forbiddenNames)) return { kind: 'reserved' };
  return null;
}

/**
 * What makes a name unusable as a file name anywhere, with no server rules
 * involved: a path separator, a control character, or more than 255
 * characters. For names the user picks for a copy, such as a renamed attachment.
 */
export function plainFileNameProblem(name: string): FileNameProblem | null {
  if ([...name].length > DEFAULT_MAX_NAME_BYTES) return { kind: 'tooLong' };
  const bad = [...new Set([...name].filter(c => c === '/' || c === '\\'))];
  if (bad.length) return { kind: 'chars', chars: bad.join(' ') };
  if ([...name].some(isControlChar)) return { kind: 'control' };
  return null;
}

/** The longest start of `text` that fits in `maxBytes` of UTF-8, whole characters only. */
function cutToBytes(text: string, maxBytes: number): string {
  let out = '';
  let used = 0;
  for (const ch of text) {
    const bytes = utf8Length(ch);
    if (used + bytes > maxBytes) break;
    out += ch;
    used += bytes;
  }
  return out;
}

/** `name` cut to `maxBytes`, keeping the extension when it leaves room for a stem. */
function fitToBytes(name: string, maxBytes: number): string {
  if (utf8Length(name) <= maxBytes) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const extBytes = utf8Length(ext);
  if (!ext || extBytes >= maxBytes) return cutToBytes(name, maxBytes);
  return cutToBytes(name.slice(0, dot), maxBytes - extBytes) + ext;
}

/**
 * A reserved name made acceptable: "_" after the stem ("con.txt" becomes
 * "con_.txt", "CON" becomes "CON_", ".." becomes ".._"). A name already at
 * the byte limit has the stem's last character replaced instead.
 */
function unreserved(name: string, maxBytes: number): string {
  const stemEnd = nameStem(name).length;
  const marked = `${name.slice(0, stemEnd)}_${name.slice(stemEnd)}`;
  if (utf8Length(marked) <= maxBytes) return marked;
  const stem = [...name.slice(0, stemEnd)];
  stem[stem.length - 1] = '_';
  return stem.join('') + name.slice(stemEnd);
}

/**
 * A variant of `name` the server accepts: forbidden and control characters
 * become "_", a reserved name or stem gets "_" after the stem, and a name over
 * the byte limit is shortened, keeping its extension. Used for uploads,
 * where the name comes from the local file system and cannot be asked for
 * again.
 */
export function acceptedFileName(name: string, rules: FileNameRules | null): string {
  if (!rules) return name;
  let out = [...name].map(c => (isControlChar(c) || rules.forbiddenChars.includes(c) ? '_' : c)).join('');
  out = fitToBytes(out, rules.maxNameBytes);
  if (isReservedName(out, rules.forbiddenNames)) out = unreserved(out, rules.maxNameBytes);
  return out;
}
