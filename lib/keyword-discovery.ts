/**
 * Tags the server carries but this client cannot name.
 *
 * A tag lives in two places: the keyword `$label:<id>` on every message that
 * bears it, which is the server's business, and the `{ id, label, color }`
 * definition in local settings, which is only ever this client's. Lose the
 * settings - a reinstall, a second browser, a cleared profile - and the
 * keywords survive untouched while the tags they belong to vanish from the UI,
 * because nothing left knows that `$label:q3-invoices` was ever called
 * "Q3 Invoices".
 *
 * This module closes that gap from the other end: given the keywords actually
 * found on messages (`IJMAPClient.discoverKeywords`), it works out which ones
 * no definition explains and proposes a name and a colour for each, so the user
 * can adopt them back into settings instead of having to guess the exact id.
 *
 * Everything here is a proposal. The id is the one part that is not negotiable:
 * it is what the messages already say, so importing a tag must never reword it.
 */
import type { KeywordDefinition } from "@/stores/settings-store";
import { KEYWORD_PALETTE, KEYWORD_PALETTE_ROWS } from "@/stores/settings-store";
import { KEYWORD_PREFIX, KEYWORD_PREFIX_LEGACY } from "./thread-utils";
import { KEYWORD_SEPARATOR, keywordLevels } from "./keyword-nesting";
import { nearestKeywordColor } from "./keyword-color-match";

/**
 * A tag the server defines for itself.
 *
 * Most servers keep nothing but the keyword: a tag's name and colour are this
 * client's business and live in its settings. Some do know - a Gmail bridge
 * reports each of its labels as the keyword it writes on messages, the name
 * the user gave it and the colour Gmail shows it in - and when a server is
 * willing to say, its answer beats anything this module can infer from an id.
 */
export interface DescribedTag {
  /** The keyword as written on messages, prefix included: `KeywordInfo.id`. */
  id: string;
  /** What the server calls it, nesting included: "Clienti/Acme". */
  name: string;
  /** A hex colour, if the server keeps one. */
  color?: string | null;
}

/** A keyword found on the server that no tag definition accounts for. */
export interface UnrecognizedKeyword {
  /** The tag id: the keyword with its prefix removed. Fixed - never reworded. */
  id: string;
  /** The keyword as it is stored on messages, prefix included. */
  keyword: string;
  /** Proposed display name, derived from the id. */
  label: string;
  /** Proposed colour, a key of `KEYWORD_PALETTE`. */
  color: string;
  /**
   * How many scanned messages carry the tag, under either prefix. A floor
   * rather than a total when the scan that produced it was incomplete.
   */
  count: number;
}

/**
 * The tag id inside a keyword, or null when the keyword is not a tag.
 *
 * Both the current `$label:` prefix and the legacy `$color:` one are read, so a
 * tag written by an older version is recognised rather than reported as an
 * unrelated keyword. System keywords (`$seen`, `$flagged`, and anything else a
 * server sets) carry neither prefix and are dropped here.
 */
export function tagIdFromKeyword(keyword: string): string | null {
  for (const prefix of [KEYWORD_PREFIX, KEYWORD_PREFIX_LEGACY]) {
    if (keyword.startsWith(prefix)) {
      const id = keyword.slice(prefix.length);
      return id.length > 0 ? id : null;
    }
  }
  return null;
}

/** Turns one level of an id into words: `q3-invoices` -> `Q3 Invoices`. */
function humanizeLevel(level: string): string {
  const words = level
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.length > 0 ? words.join(" ") : level;
}

/**
 * The name to propose for a tag whose definition is gone.
 *
 * With nesting on, a definition names one level and the levels above it supply
 * the rest, so only the innermost level is named here - proposing
 * "Work Clients Acme" for `work/clients/acme` would read as
 * `Work/Clients/Work Clients Acme` once its ancestors are imported too. With
 * nesting off the id is a single opaque token and the whole of it is the name.
 */
export function suggestKeywordLabel(id: string, nested: boolean): string {
  const levels = keywordLevels(id);
  if (levels.length === 0) return id;
  if (!nested) return levels.map(humanizeLevel).join(KEYWORD_SEPARATOR);
  return humanizeLevel(levels[levels.length - 1]);
}

/**
 * The name to show for a tag the server named.
 *
 * With nesting on the ancestors supply their own levels, so only the innermost
 * one is this tag's name - the same rule {@link suggestKeywordLabel} follows,
 * applied to a real name instead of a guessed one.
 */
function describedLabel(name: string, nested: boolean): string {
  const levels = name.split(KEYWORD_SEPARATOR).map((level) => level.trim()).filter(Boolean);
  if (levels.length === 0) return name.trim();
  return nested ? levels[levels.length - 1] : levels.join(KEYWORD_SEPARATOR);
}

/** A small stable spread over `range`, so the same id always starts at the same hue. */
function hashIndex(id: string, range: number): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % Math.max(1, range);
}

/**
 * The colour to propose for a tag whose definition is gone.
 *
 * An id that is itself a palette key keeps that colour: the tags shipped by
 * default are named after their colour (`$label:blue`), so recovering them
 * should give back the blue tag rather than a blue-labelled green one.
 *
 * Otherwise a hue is picked from the base row by hashing the id, then walked
 * forward past any colour in `taken` - a batch of recovered tags that all come
 * out the same shade is far harder to tell apart in the sidebar than one whose
 * hues merely differ from the originals, which are unknowable anyway. When
 * every hue is taken the hashed pick stands.
 */
export function suggestKeywordColor(id: string, taken: Iterable<string> = []): string {
  const levels = keywordLevels(id);
  const own = levels.length > 0 ? levels[levels.length - 1] : id;
  if (own in KEYWORD_PALETTE) return own;

  const hues = KEYWORD_PALETTE_ROWS[1] ?? Object.keys(KEYWORD_PALETTE);
  const used = new Set(taken);
  const start = hashIndex(id, hues.length);
  for (let step = 0; step < hues.length; step++) {
    const candidate = hues[(start + step) % hues.length];
    if (!used.has(candidate)) return candidate;
  }
  return hues[start];
}

/**
 * The tags in `keywords` - a keyword-to-message-count map, as
 * `IJMAPClient.discoverKeywords` returns - that no definition in `defined`
 * explains, each with a name and colour to propose.
 *
 * Keywords are compared case-insensitively: RFC 8621 leaves the case of a
 * keyword to whoever set it, so `$label:Work` and `$label:work` are one tag and
 * a definition for either covers both. The spelling that reaches the result is
 * the one the server actually uses, since that is what an id has to match to
 * keep pointing at the same messages, and the counts of every spelling are
 * added up - `$label:work` and the legacy `$color:work` are one tag whose
 * messages happen to be split across two ways of writing it.
 *
 * Results are ordered by descending count, then by id: the tag on a thousand
 * messages is the one whose name was worth knowing. Colours are proposed
 * against the definitions *and* the earlier proposals together, so importing
 * the whole list at once still yields tags that can be told apart.
 */
export function findUnrecognizedKeywords(
  keywords: Record<string, number>,
  defined: KeywordDefinition[],
  nested: boolean,
  described: DescribedTag[] = [],
): UnrecognizedKeyword[] {
  const known = new Set(defined.map((keyword) => keyword.id.toLowerCase()));
  const taken = new Set(defined.map((keyword) => keyword.color));
  const byId = new Map<string, DescribedTag>();
  for (const tag of described) {
    const id = tagIdFromKeyword(tag.id);
    if (id && !known.has(id.toLowerCase())) byId.set(id.toLowerCase(), tag);
  }

  // One entry per tag, keyed by the id folded to lower case: `$label:work` and
  // `$color:Work` are the same tag reached two ways, and offering it twice
  // would let the user create a definition that cannot apply to both. The first
  // spelling seen names the tag; the rest only add to its count.
  const unrecognized = new Map<string, { id: string; count: number }>();
  for (const [keyword, count] of Object.entries(keywords)) {
    const id = tagIdFromKeyword(keyword);
    if (!id) continue;
    const folded = id.toLowerCase();
    if (known.has(folded)) continue;
    const existing = unrecognized.get(folded);
    if (existing) existing.count += count;
    else unrecognized.set(folded, { id, count });
  }
  // A tag the server describes is a tag whether or not the scan happened to
  // meet it: an empty label, or one used only on mail older than the window,
  // is still one the user made and will want named.
  for (const [folded, tag] of byId) {
    const id = tagIdFromKeyword(tag.id)!;
    if (!unrecognized.has(folded)) unrecognized.set(folded, { id, count: 0 });
  }

  return [...unrecognized.values()]
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .map(({ id, count }) => {
      const tag = byId.get(id.toLowerCase());
      // What the server calls the tag beats what its id looks like; its colour
      // is taken as given, duplicates included, because two labels sharing a
      // colour upstream is the user's choice, not a collision to work around.
      const color =
        (tag ? nearestKeywordColor(tag.color) : null) ??
        suggestKeywordColor(id, taken);
      taken.add(color);
      return {
        id,
        keyword: KEYWORD_PREFIX + id,
        label: tag ? describedLabel(tag.name, nested) : suggestKeywordLabel(id, nested),
        color,
        count,
      };
    });
}
