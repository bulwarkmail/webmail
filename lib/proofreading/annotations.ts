// What a text checker sends back, checked before anything is drawn.
//
// A checker is a plugin; its answer is untrusted data. Every annotation must
// name a segment the host sent, sit inside that segment's text, cover
// neither a line break nor an inline object, and not cut a character in
// half. Strings are cut to size and the count is capped. Anything else is
// dropped, not repaired, except a range that runs past the end of its
// segment, which is cut at the end.

import { OBJECT_CHAR } from './segments';

export const CHECK_KINDS = ['spelling', 'grammar', 'style', 'other'] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export const MAX_ANNOTATIONS = 300;
export const MAX_REPLACEMENTS = 5;
const MAX_MESSAGE = 500;
const MAX_SHORT = 100;
const MAX_REPLACEMENT = 100;
const MAX_RULE = 100;
const MAX_ID = 100;

export interface Annotation {
  segmentId: string;
  offset: number;
  length: number;
  kind: CheckKind;
  message: string;
  shortMessage?: string;
  replacements: string[];
  ruleId?: string;
  ruleLabel?: string;
  /** The checker's own id for it, given back in onAction. */
  id?: string;
  /** The text the annotation covers (filled in by the host). */
  text: string;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Text shown in the popup: no control characters, and no bidi overrides,
 * which could make a message read differently from what it says.
 */
function stripControls(s: string): string {
  return s.replace(/[\p{Cc}\p{Bidi_Control}]/gu, (ch) => (ch === '\t' || ch === '\n' ? ch : ''));
}

/**
 * Text that goes into the message: what a user could type. No control or
 * format characters (zero-width, bidi, a watermark nobody sees), no line or
 * paragraph separators, no object placeholder.
 */
function insertable(s: string): boolean {
  return !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s) && !s.includes(OBJECT_CHAR);
}

/** The first `max` characters, never half a character. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - 1;
  if (isHigh(s.charCodeAt(end - 1))) end--;
  return `${s.slice(0, end)}…`;
}

const isKind = (v: unknown): v is CheckKind => typeof v === 'string' && (CHECK_KINDS as readonly string[]).includes(v);

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = stripControls(v).trim();
  if (!s) return undefined;
  return cut(s, max);
}


/**
 * The annotations of a checker's answer that may be drawn. `segments` maps
 * the ids of the request to their text; `kinds` are the kinds the checker
 * registered (others are dropped).
 */
export function validateAnnotations(
  raw: unknown,
  segments: ReadonlyMap<string, string>,
  kinds: readonly CheckKind[],
  max = MAX_ANNOTATIONS,
): { annotations: Annotation[]; dropped: number } {
  const out: Annotation[] = [];
  let dropped = 0;
  if (!Array.isArray(raw)) return { annotations: out, dropped };
  for (const item of raw) {
    if (out.length >= max) { dropped = raw.length - out.length; break; }
    const a = item as Record<string, unknown> | null;
    if (!a || typeof a !== 'object') { dropped++; continue; }
    const text = typeof a.segmentId === 'string' ? segments.get(a.segmentId) : undefined;
    const kind = isKind(a.kind) && kinds.includes(a.kind) ? a.kind : null;
    const message = str(a.message, MAX_MESSAGE);
    if (text === undefined || !kind || !message
      || !Number.isSafeInteger(a.offset) || !Number.isSafeInteger(a.length)) { dropped++; continue; }
    const offset = a.offset as number;
    let length = a.length as number;
    if (offset < 0 || length < 1 || offset >= text.length) { dropped++; continue; }
    if (offset + length > text.length) length = text.length - offset;
    const covered = text.slice(offset, offset + length);
    if (covered.includes('\n') || covered.includes(OBJECT_CHAR) || !covered.trim()
      || isLow(text.charCodeAt(offset)) || isHigh(text.charCodeAt(offset + length - 1))) { dropped++; continue; }
    const replacements: string[] = [];
    if (Array.isArray(a.replacements)) {
      for (const r of a.replacements) {
        if (replacements.length >= MAX_REPLACEMENTS) break;
        // A replacement is put in the text as typed.
        if (typeof r !== 'string' || r.length > MAX_REPLACEMENT || !insertable(r)) continue;
        if (r === covered || replacements.includes(r)) continue;
        replacements.push(r);
      }
    }
    const ann: Annotation = { segmentId: a.segmentId as string, offset, length, kind, message, replacements, text: covered };
    const short = str(a.shortMessage, MAX_SHORT);
    if (short) ann.shortMessage = short;
    const ruleId = str(a.ruleId, MAX_RULE);
    if (ruleId) ann.ruleId = ruleId;
    const ruleLabel = str(a.ruleLabel, MAX_RULE);
    if (ruleLabel) ann.ruleLabel = ruleLabel;
    const id = str(a.id, MAX_ID);
    if (id) ann.id = id;
    out.push(ann);
  }
  return { annotations: out, dropped };
}

/** What the checker said back besides annotations. */
export interface CheckOutcome {
  annotations: unknown;
  status: 'ok' | 'unavailable' | 'paused';
  message?: string;
  retryAfterMs?: number;
}

/** A checker's answer: an array of annotations or { annotations, status, message, retryAfterMs }. */
export function readCheckResult(raw: unknown): CheckOutcome {
  if (Array.isArray(raw)) return { annotations: raw, status: 'ok' };
  if (!raw || typeof raw !== 'object') return { annotations: [], status: 'ok' };
  const r = raw as Record<string, unknown>;
  const status = r.status === 'unavailable' || r.status === 'paused' ? r.status : 'ok';
  const out: CheckOutcome = { annotations: r.annotations ?? [], status };
  const message = str(r.message, MAX_MESSAGE);
  if (message) out.message = message;
  if (typeof r.retryAfterMs === 'number' && Number.isFinite(r.retryAfterMs) && r.retryAfterMs > 0) {
    out.retryAfterMs = Math.min(r.retryAfterMs, 10 * 60_000);
  }
  return out;
}
