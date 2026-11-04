// Pure helpers behind the search-bar suggestion dropdown (#845): merging
// recent searches with contact/sender matches, and splitting a label into
// highlighted / plain segments for the matched substring.

export interface ContactSuggestion {
  name: string;
  email: string;
}

export type SearchSuggestion =
  | { kind: "recent"; query: string }
  | { kind: "contact"; name: string; email: string };

/** Recent searches shown when the search bar is focused but empty. */
export const MAX_RECENT_IDLE = 5;
/** Recent searches shown alongside contact matches while typing. */
export const MAX_RECENT_TYPING = 3;
/** Contact / sender matches shown while typing. */
export const MAX_CONTACT_SUGGESTIONS = 5;

/**
 * Build the flat, keyboard-navigable suggestion list for a query.
 *
 * - Empty query: the most recent searches only.
 * - Non-empty query: recent searches containing the query (minus an exact
 *   match, which would just re-run what is already typed), followed by
 *   contact matches. Contact groups (no address) are dropped — a sender
 *   filter needs a concrete address — and duplicate addresses collapse.
 */
export function buildSearchSuggestions(
  query: string,
  recentSearches: readonly string[],
  contacts: readonly ContactSuggestion[],
): SearchSuggestion[] {
  const q = query.trim().toLowerCase();
  const suggestions: SearchSuggestion[] = [];

  if (!q) {
    for (const recent of recentSearches.slice(0, MAX_RECENT_IDLE)) {
      suggestions.push({ kind: "recent", query: recent });
    }
    return suggestions;
  }

  let recentCount = 0;
  for (const recent of recentSearches) {
    if (recentCount >= MAX_RECENT_TYPING) break;
    const lower = recent.toLowerCase();
    if (lower === q || !lower.includes(q)) continue;
    suggestions.push({ kind: "recent", query: recent });
    recentCount++;
  }

  const seen = new Set<string>();
  for (const contact of contacts) {
    if (seen.size >= MAX_CONTACT_SUGGESTIONS) break;
    const email = contact.email.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({ kind: "contact", name: contact.name.trim(), email });
  }

  return suggestions;
}

/**
 * Senders of the messages already loaded whose name or address contains the
 * query, for when the address book knows nobody who matches (mail-16). An
 * account without contacts otherwise offers nothing while typing.
 */
export function listSenderMatches(
  emails: ReadonlyArray<{ from?: ReadonlyArray<{ name?: string | null; email?: string | null }> | null }>,
  query: string,
  limit = MAX_CONTACT_SUGGESTIONS,
): ContactSuggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const found: ContactSuggestion[] = [];
  const seen = new Set<string>();
  for (const email of emails) {
    const sender = email.from?.[0];
    const address = sender?.email?.trim();
    if (!address) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    const name = sender?.name?.trim() ?? "";
    if (!key.includes(q) && !name.toLowerCase().includes(q)) continue;
    seen.add(key);
    found.push({ name, email: address });
    if (found.length >= limit) break;
  }
  return found;
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Split `text` into segments, flagging every case-insensitive occurrence of
 * `query` so the UI can emphasise the matched substring. An empty query yields
 * the whole text as a single non-matching segment.
 */
export function splitHighlight(text: string, query: string): HighlightSegment[] {
  const needle = query.trim().toLowerCase();
  if (!needle || !text) return [{ text, match: false }];

  const segments: HighlightSegment[] = [];
  const haystack = text.toLowerCase();
  let cursor = 0;
  let idx = haystack.indexOf(needle, cursor);
  while (idx !== -1) {
    if (idx > cursor) segments.push({ text: text.slice(cursor, idx), match: false });
    segments.push({ text: text.slice(idx, idx + needle.length), match: true });
    cursor = idx + needle.length;
    idx = haystack.indexOf(needle, cursor);
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}
