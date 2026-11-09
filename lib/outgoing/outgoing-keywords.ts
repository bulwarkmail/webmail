/**
 * Keywords a plugin puts on a message the user sends (OutgoingEmail.keywords
 * in onTransformOutgoingEmail). They go on the Email/set create of the
 * message, so its copy in Sent carries them from the start: a case number, a
 * "filed" marker, the user's own tag.
 *
 * Only custom keywords, in the syntax of RFC 8621 section 4.1.1. Keywords
 * starting with `$` belong to the system: `$seen`, `$draft`, `$answered`,
 * `$junk` and the rest change how the app and the server treat a message,
 * and the host sets them itself. Two kinds are allowed anyway, because they
 * only label the copy, the user changes them with one click, and a plugin
 * with email:write can already set them on any message:
 * - `$flagged`, the star (flag the Sent copy for a follow-up);
 * - `$label:<id>`, Bulwark's own tags (file the Sent copy under the user's tag).
 */

import { KEYWORD_PREFIX } from '@/lib/thread-utils';

/** At most this many keywords per message, from all plugins together. */
export const MAX_OUTGOING_KEYWORDS = 10;
/** RFC 8621 section 4.1.1. */
const MAX_KEYWORD_LENGTH = 255;
/** `$` keywords a plugin may set; see the top of this file. */
export const ALLOWED_SYSTEM_KEYWORDS: ReadonlySet<string> = new Set(['$flagged']);

/**
 * Printable ASCII without the characters IMAP atoms can't hold (RFC 8621
 * section 4.1.1): ( ) { ] % * " and the backslash.
 */
const KEYWORD_SYNTAX = /^[\x21-\x7e]+$/;
const FORBIDDEN = /[(){\]%*"\\]/;

/** Why `keyword` can't go on an outgoing message, or null when it can. */
export function outgoingKeywordProblem(keyword: unknown): string | null {
  if (typeof keyword !== 'string') return 'a keyword must be a string';
  if (keyword.length === 0 || keyword.length > MAX_KEYWORD_LENGTH) return `"${keyword.slice(0, 40)}" must be 1-${MAX_KEYWORD_LENGTH} characters`;
  if (!KEYWORD_SYNTAX.test(keyword) || FORBIDDEN.test(keyword)) return `"${keyword}" is not a valid keyword (RFC 8621: printable ASCII without spaces or ( ) { ] % * " \\)`;
  const lower = keyword.toLowerCase();
  if (lower.startsWith('$') && !ALLOWED_SYSTEM_KEYWORDS.has(lower) && !(lower.startsWith(KEYWORD_PREFIX) && lower.length > KEYWORD_PREFIX.length)) {
    return `"${keyword}" is a system keyword; only custom keywords, $flagged and $label: tags can be set`;
  }
  return null;
}

/**
 * The keywords that go out: valid ones only, each once (keywords are
 * case-insensitive), at most MAX_OUTGOING_KEYWORDS. `warn` hears about each
 * one left out.
 */
export function cleanOutgoingKeywords(value: unknown, warn?: (message: string) => void): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warn?.('keywords must be an array of strings');
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const keyword of value) {
    const problem = outgoingKeywordProblem(keyword);
    if (problem) {
      warn?.(problem);
      continue;
    }
    const key = (keyword as string).toLowerCase();
    if (seen.has(key)) continue;
    if (out.length >= MAX_OUTGOING_KEYWORDS) {
      warn?.(`at most ${MAX_OUTGOING_KEYWORDS} keywords go on a message; "${keyword as string}" was left out`);
      continue;
    }
    seen.add(key);
    out.push(keyword as string);
  }
  return out;
}

/** As an Email `keywords` map. */
export function outgoingKeywordMap(value: unknown): Record<string, true> {
  return Object.fromEntries(cleanOutgoingKeywords(value).map((keyword) => [keyword, true as const]));
}
