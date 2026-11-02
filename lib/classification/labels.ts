/**
 * Classification labels on the wire (enterprise pack item 3). Pure
 * functions: the headers a label writes, reading a received label back,
 * the subject prefix, and the draft marker.
 *
 * Headers written:
 * - `SIO-Label` (RFC 7444) in the marking-only form with colours, as a raw
 *   header: `marking="CONFIDENTIAL"; fgcolor=#000000; bgcolor=#d97706`.
 *   A marking with non-ASCII characters uses RFC 2231
 *   (`marking*=utf-8''VS-NUR%20F%C3%9CR...`): an RFC 2047 encoded word
 *   inside a quoted parameter is invalid (RFC 2047 §5), which is what the
 *   server's text form would produce.
 * - `Sensitivity` (RFC 2156 §5.3.4), what Outlook shows, when the label
 *   sets one.
 * - The admin's extra header (X-Classification, msip_labels) when the label
 *   has a value for it.
 * No SIO-Label-History: it needs who changed it and when, and RFC 7444
 * says it may leak.
 *
 * Drafts keep the user's choice in `X-Bulwark-Label` (the label id, or
 * `none` for a choice of no label), the way they keep the priority.
 */

import type { ClassificationLabel, OrganisationPolicy } from '@/lib/admin/organisation-policy';
import { stripSubjectPrefixes } from '@/lib/subject-prefix';

export type LabelsPolicy = OrganisationPolicy['labels'];

export const SIO_LABEL_HEADER = 'SIO-Label';
export const SENSITIVITY_HEADER = 'Sensitivity';
export const DRAFT_LABEL_HEADER = 'X-Bulwark-Label';
/** A draft whose sender picked "no label". */
export const NO_LABEL = 'none';

/** The marking a label writes: its own, else its name. */
export function labelMarking(label: Pick<ClassificationLabel, 'marking' | 'name'>): string {
  return (label.marking || label.name).trim();
}

/** Black or white, whichever reads better on `bg` (#rrggbb). */
export function textColorOn(bg: string): '#000000' | '#ffffff' {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(bg);
  if (!m) return '#ffffff';
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.179 ? '#000000' : '#ffffff';
}

// RFC 2231 attribute-char: anything but specials, space, controls, *, ' and %.
const ATTRIBUTE_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

function percentEncode(value: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(value)) {
    const ch = String.fromCharCode(byte);
    out += byte < 0x80 && ATTRIBUTE_CHAR.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** The marking parameter(s): quoted when ASCII, RFC 2231 (with continuations when long) otherwise. */
function markingParameters(marking: string): string[] {
  const clean = marking.replace(/["\\\r\n]/g, '');

  if (/^[\x20-\x7e]*$/.test(clean)) return [`marking="${clean}"`];
  const encoded = percentEncode(clean);
  const MAX = 60;
  if (encoded.length + 15 <= MAX) return [`marking*=utf-8''${encoded}`];
  // Split between encoded characters, never inside a %XX.
  const units = encoded.match(/%[0-9A-F]{2}|[^%]/g) ?? [];
  const pieces: string[] = [];
  let piece = '';
  for (const unit of units) {
    if (piece.length + unit.length > MAX - 15) {
      pieces.push(piece);
      piece = '';
    }
    piece += unit;
  }
  if (piece) pieces.push(piece);
  return pieces.map((piece, i) => (i === 0 ? `marking*0*=utf-8''${piece}` : `marking*${i}*=${piece}`));
}

/** The SIO-Label value after "SIO-Label:", folded (leading space included). */
export function sioLabelValue(label: Pick<ClassificationLabel, 'marking' | 'name' | 'color'>): string {
  const params = [...markingParameters(labelMarking(label)), `fgcolor=${textColorOn(label.color)}`, `bgcolor=${label.color}`];
  // "SIO-Label: " is 11 characters; fold between parameters past 78.
  let line = 11;
  let out = '';
  params.forEach((param, i) => {
    const piece = i === params.length - 1 ? param : `${param};`;
    if (i > 0 && line + 1 + piece.length > 78) {
      out += `\r\n ${piece}`;
      line = 1 + piece.length;
    } else {
      out += ` ${piece}`;
      line += 1 + piece.length;
    }
  });
  return out;
}

/** The label's headers as [name, value] pairs, the extra header's value as plain text. */
function labelHeaderPairs(label: ClassificationLabel, extraHeader: string): Array<[string, string, 'raw' | 'text']> {
  const pairs: Array<[string, string, 'raw' | 'text']> = [[SIO_LABEL_HEADER, sioLabelValue(label), 'raw']];
  if (label.sensitivity) pairs.push([SENSITIVITY_HEADER, label.sensitivity, 'text']);
  const extraValue = label.extraHeaderValue.trim();
  if (extraHeader && extraValue) pairs.push([extraHeader, extraValue, 'text']);
  return pairs;
}

/** The label's headers as JMAP Email/set create properties (RFC 8621 §4.1.3). */
export function labelHeaderProperties(label: ClassificationLabel, extraHeader: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value, form] of labelHeaderPairs(label, extraHeader)) {
    // The server writes "Name: " itself; a raw value keeps only its own folds.
    out[form === 'raw' ? `header:${name}:asRaw` : `header:${name}:asText`] = form === 'raw' ? value.trimStart() : value;
  }
  return out;
}

/**
 * A header value for raw MIME, folded under 78 columns: ASCII as it is,
 * folded between words; anything else as RFC 2047 encoded words of at
 * most 75 characters each, split between characters.
 */
function foldedValue(name: string, value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) {
    let line = name.length + 1;
    let out = '';
    for (const word of value.split(' ')) {
      if (out && line + 1 + word.length > 78) {
        out += `\r\n ${word}`;
        line = 1 + word.length;
      } else {
        out += ` ${word}`;
        line += 1 + word.length;
      }
    }
    return out;
  }
  const encoder = new TextEncoder();
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = () => {
    if (chunk.length === 0) return;
    words.push(`=?UTF-8?B?${btoa(String.fromCharCode(...chunk))}?=`);
    chunk = [];
  };
  // 45 bytes are 60 base64 characters: 72 with "=?UTF-8?B?" and "?=",
  // which fits a folded line. The first word shares its line with the name.
  const firstLimit = Math.max(3, Math.min(45, Math.floor((78 - name.length - 2 - 12) / 4) * 3));
  for (const char of value) {
    const bytes = encoder.encode(char);
    if (chunk.length + bytes.length > (words.length === 0 ? firstLimit : 45)) flush();
    chunk.push(...bytes);
  }
  flush();
  return ` ${words.join('\r\n ')}`;
}

/** The label's headers as raw header lines (folded with CRLF and a space), for raw MIME. */
export function labelHeaderLines(label: ClassificationLabel, extraHeader: string): string[] {
  return labelHeaderPairs(label, extraHeader).map(([name, value, form]) =>
    form === 'raw' ? `${name}:${value}` : `${name}:${foldedValue(name, value)}`);
}

/** The draft marker property: the label id, or `none` for no label. */
export function draftLabelProperty(choice: string | null | undefined): Record<string, string> {
  if (choice === undefined) return {};
  return { [`header:${DRAFT_LABEL_HEADER}:asText`]: choice ?? NO_LABEL };
}

type HeaderRecord = Record<string, string | string[]> | null | undefined;

function header(headers: HeaderRecord, name: string): string | undefined {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') return first;
  }
  return undefined;
}

/**
 * The choice a re-opened draft carries: a label id, null for "no label",
 * undefined when the draft says nothing (a draft of another client, or one
 * saved before labels).
 */
export function draftLabelChoice(headers: HeaderRecord): string | null | undefined {
  const value = header(headers, DRAFT_LABEL_HEADER)?.trim();
  if (!value) return undefined;
  return value === NO_LABEL ? null : value;
}

function decodePercent(value: string, charset: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '%' && /^[0-9a-f]{2}$/i.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(value.charCodeAt(i) & 0xff);
    }
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(Uint8Array.from(bytes));
  } catch {
    return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
  }
}

/** Decodes RFC 2047 encoded words a server may have put into a value. */
function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, enc: string, text: string) => {
    try {
      let bytes: Uint8Array;
      if (enc.toLowerCase() === 'b') bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
      else bytes = Uint8Array.from(text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))), (c) => c.charCodeAt(0));
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return whole;
    }
  });
}

/**
 * The `marking` of a raw SIO-Label value (RFC 7444 §2): a quoted or token
 * value, or the RFC 2231 forms (encoded and continued). Null without one.
 */
export function parseSioLabelMarking(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const value = raw.replace(/\r?\n[ \t]+/g, ' ');
  const params = new Map<string, string>();
  const re = /([A-Za-z0-9*-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;\s]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
    params.set(m[1].toLowerCase(), v);
  }
  if (params.has('marking')) return decodeEncodedWords(params.get('marking')!).trim() || null;
  if (params.has('marking*')) {
    const [charset, , text] = splitExtended(params.get('marking*')!);
    return decodePercent(text, charset).trim() || null;
  }
  // Continuations: marking*0*, marking*1, ... joined before decoding (a
  // character's bytes may be split across two of them, RFC 2231 §4.1).
  let joinedEncoded = '';
  let charset = 'utf-8';
  for (let i = 0; i < 100; i++) {
    const encoded = params.get(`marking*${i}*`);
    const plain = params.get(`marking*${i}`);
    if (encoded === undefined && plain === undefined) break;
    if (encoded !== undefined) {
      let text = encoded;
      if (i === 0) [charset, , text] = splitExtended(encoded);
      joinedEncoded += text;
    } else {
      joinedEncoded += percentEncode(plain!);
    }
  }
  const joined = decodePercent(joinedEncoded, charset).trim();
  return joined || null;
}

function splitExtended(value: string): [string, string, string] {
  const first = value.indexOf("'");
  const second = first >= 0 ? value.indexOf("'", first + 1) : -1;
  if (first < 0 || second < 0) return ['utf-8', '', value];
  return [value.slice(0, first), value.slice(first + 1, second), value.slice(second + 1)];
}

const normalise = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The known label a received message carries: by its SIO-Label marking
 * first, then by the admin's extra header value. Unknown values show
 * nothing. Shown as information only: anyone can write these headers.
 */
export function receivedLabel(headers: HeaderRecord, policy: LabelsPolicy | null | undefined): ClassificationLabel | null {
  if (!policy || policy.list.length === 0) return null;
  const marking = parseSioLabelMarking(header(headers, SIO_LABEL_HEADER));
  if (marking) {
    const wanted = normalise(marking);
    const byMarking = policy.list.find((label) => normalise(labelMarking(label)) === wanted);
    if (byMarking) return byMarking;
  }
  if (policy.extraHeader) {
    const raw = header(headers, policy.extraHeader);
    if (raw) {
      const wanted = normalise(decodeEncodedWords(raw.replace(/\r?\n[ \t]+/g, ' ')));
      const byExtra = policy.list.find((label) => label.extraHeaderValue && normalise(label.extraHeaderValue) === wanted);
      if (byExtra) return byExtra;
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The subject with `label`'s prefix in front, once: every known label
 * prefix in the leading chain of reply and forward prefixes is taken out
 * first ("Re: [Confidential] x" → "[Strictly confidential] Re: x"), so a
 * reply doesn't double it and a changed label replaces the old one.
 */
export function applyLabelPrefix(subject: string, label: ClassificationLabel | null, labels: ClassificationLabel[]): string {
  const prefixes = [...new Set(labels.map((l) => l.subjectPrefix.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  let rest = subject.trimStart();
  const kept: string[] = [];
  const labelRes = prefixes.map((p) => new RegExp(`^${escapeRegExp(p)}(?:\\s*:)?(?:\\s+|$)`, 'i'));
  for (let i = 0; i < 40; i++) {
    const labelMatch = labelRes.map((re) => re.exec(rest)).find(Boolean);
    if (labelMatch) {
      rest = rest.slice(labelMatch[0].length).trimStart();
      continue;
    }
    const stripped = stripSubjectPrefixes(rest);
    if (stripped === rest) break;
    // Keep the reply/forward prefix as written, one token at a time.
    const token = rest.slice(0, rest.length - stripped.length);
    const one = /^\s*[^:：]+[:：]\s*/.exec(token)?.[0] ?? token;
    kept.push(one.trim());
    rest = rest.slice(one.length).trimStart();
  }
  const chain = [...kept, rest].filter(Boolean).join(' ');
  const prefix = label?.subjectPrefix.trim();
  return prefix ? (chain ? `${prefix} ${chain}` : prefix) : chain;
}
