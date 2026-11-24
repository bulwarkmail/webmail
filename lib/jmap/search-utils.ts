export interface SearchFilters {
  from: string;
  to: string;
  subject: string;
  body: string;
  hasAttachment: boolean | null;
  dateAfter: string;
  dateBefore: string;
  isUnread: boolean | null;
  isStarred: boolean | null;
  /** Message size bounds in KB (RFC 8621 §4.4.1 minSize / maxSize); "" = unset. */
  minSizeKb: string;
  maxSizeKb: string;
  /**
   * Only messages without a tag. The tag ids to leave out come from the
   * caller (see buildJMAPFilter): JMAP can't ask for "no keyword with this
   * prefix".
   */
  untagged: boolean;
  /**
   * A raw JMAP Email filter a plugin ran via `api.search.run` (#1024). ANDed
   * into the search like the fields above and cleared with them.
   */
  pluginFilter?: PluginSearchFilter | null;
}

export interface PluginSearchFilter {
  pluginId: string;
  /** Chip text: the plugin's label for the search, or its name. */
  label: string;
  filter: Record<string, unknown>;
  /**
   * The messages a plugin found itself (`api.search.showMessages`, #954),
   * in its order. With these the list shows exactly them and `filter` is
   * empty: no JMAP query asks for messages by id.
   */
  emails?: PluginListedEmail[];
}

/** A message of a plugin's list: its id and, outside the user's own account, the account's id. */
export interface PluginListedEmail {
  id: string;
  accountId?: string;
}

/** Whether the search is a plugin's own list of messages rather than a query. */
export function isPluginMessageList(filters: Pick<SearchFilters, 'pluginFilter'>): boolean {
  return Array.isArray(filters.pluginFilter?.emails);
}

export const DEFAULT_SEARCH_FILTERS: SearchFilters = {
  from: "",
  to: "",
  subject: "",
  body: "",
  hasAttachment: null,
  dateAfter: "",
  dateBefore: "",
  isUnread: null,
  isStarred: null,
  minSizeKb: "",
  maxSizeKb: "",
  untagged: false,
  pluginFilter: null,
};

// Upper bound on a serialized plugin filter. A filter tree bigger than this
// is either a bug or an abuse vector for the JMAP request budget.
export const MAX_PLUGIN_FILTER_JSON_BYTES = 16 * 1024;

// JMAP Metadata filter conditions (metadataExists, privateMetadataTextContains,
// ...). Stalwart 1.0 parses them but its Email/query handler is still
// `todo!()` for them, so one such condition panics the request on the server.
const METADATA_FILTER_KEY_RE = /^(private)?[Mm]etadata/;

/** The first Metadata filter key anywhere in the tree (operators nest conditions). */
function findMetadataFilterKey(filter: unknown): string | null {
  const stack: unknown[] = [filter];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
    } else if (typeof node === "object" && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        if (METADATA_FILTER_KEY_RE.test(key)) return key;
        stack.push(value);
      }
    }
  }
  return null;
}

/**
 * Check a plugin-supplied JMAP Email FilterCondition/FilterOperator and return
 * a plain-data copy. `what` names the value in the error message, e.g.
 * `search.run: query`.
 */
export function normalizePluginFilter(what: string, query: unknown): Record<string, unknown> {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    throw new Error(`${what} must be a JMAP filter object`);
  }
  let json: string;
  try {
    json = JSON.stringify(query);
  } catch {
    throw new Error(`${what} is not serializable`);
  }
  if (json.length > MAX_PLUGIN_FILTER_JSON_BYTES) {
    throw new Error(`${what} exceeds ${MAX_PLUGIN_FILTER_JSON_BYTES} bytes`);
  }
  // Deep-clone via JSON so the stored filter is plain data (no prototypes,
  // functions or getters can cross into request bodies).
  const filter = JSON.parse(json) as Record<string, unknown>;
  const metadataKey = findMetadataFilterKey(filter);
  if (metadataKey) {
    throw new Error(`${what} may not filter on JMAP Metadata ("${metadataKey}")`);
  }
  return filter;
}

/** The KB size field as a positive byte count, or null when unset/invalid. */
export function sizeFilterBytes(value: string | undefined): number | null {
  const kb = Number(value);
  if (!value || !Number.isFinite(kb) || kb <= 0) return null;
  return Math.round(kb * 1024);
}

/** Filter properties whose value the server reads as free text. */
export type SearchTextProperty = "text" | "from" | "to" | "subject" | "body";

// A "quoted phrase" (the closing quote may still be missing while the user
// types) or a run of non-space characters.
const SEARCH_PART_RE = /"([^"]*)"?|(\S+)/g;

/**
 * Splits typed search text into the values to send as separate text
 * conditions, ANDed together.
 *
 * Stalwart 1.0 reads a whole filter value that starts and ends with `"` (or
 * `'`) as one exact phrase, and a value ending in `*` as one prefix over
 * everything before it (not split into words, at most 16 bytes). Sent as one
 * value, `"annual report" 2024 "draft"` is a single phrase and
 * `project budg*` a prefix containing a space: both find nothing. So:
 * - every `"phrase"` is a part of its own, kept quoted; empty quotes are
 *   dropped;
 * - every word ending in `*` is a part of its own; a lone `*` is dropped;
 * - all other words stay together in one part, joined by single spaces, so
 *   they still have to match within one field and the server detects the
 *   language on the whole string. Without quotes or stars, that part is the
 *   query as typed.
 * Outer `'` quotes are stripped from that last part, since they would make
 * it a phrase too. The built-in index of 0.16 has neither phrases nor
 * prefixes: a quoted part is an AND of its words, matched without stemming,
 * and `*` only separates words.
 */
export function splitSearchText(raw: string): string[] {
  const parts: string[] = [];
  const words: string[] = [];
  let wordsAt = -1;
  for (const [, phrase, word] of raw.matchAll(SEARCH_PART_RE)) {
    if (phrase !== undefined) {
      const trimmed = phrase.trim();
      if (trimmed) parts.push(`"${trimmed}"`);
    } else if (word.endsWith("*")) {
      if (!/^\*+$/.test(word)) parts.push(word);
    } else {
      if (wordsAt < 0) wordsAt = parts.length;
      words.push(word);
    }
  }
  let bare = words.join(" ");
  while (bare.length > 1 && bare.startsWith("'") && bare.endsWith("'")) {
    bare = bare.slice(1, -1).trim();
  }
  // Keep the parts in the order they were typed.
  if (bare) parts.splice(wordsAt, 0, bare);
  return parts;
}

/**
 * One `{ [property]: part }` condition per part of `raw` (see
 * splitSearchText). When no part is left (`""`, a lone `*`), the input is
 * sent as one condition as before: dropping it would widen the search to
 * every message.
 */
export function textConditions(raw: string, property: SearchTextProperty = "text"): Record<string, string>[] {
  const parts = splitSearchText(raw);
  if (parts.length === 0) return [{ [property]: raw.trim() }];
  return parts.map((part) => ({ [property]: part }));
}

/** `textConditions` as one filter: the single condition, or an AND of them. */
export function textFilter(raw: string, property: SearchTextProperty = "text"): Record<string, unknown> {
  const conditions = textConditions(raw, property);
  return conditions.length === 1 ? conditions[0] : { operator: "AND", conditions };
}

// The tag keyword prefixes, current and legacy (KEYWORD_PREFIX and
// KEYWORD_PREFIX_LEGACY in lib/thread-utils.ts).
const TAG_KEYWORD_PREFIXES = ["$label:", "$color:"] as const;

/**
 * One `notKeyword` per tag id and prefix: JMAP has no condition for "no
 * keyword starting with", so leaving out tagged mail means naming every tag.
 * No ids, no conditions.
 */
export function untaggedConditions(tagIds: readonly string[]): Record<string, string>[] {
  return tagIds.flatMap((id) => TAG_KEYWORD_PREFIXES.map((prefix) => ({ notKeyword: `${prefix}${id}` })));
}

/**
 * `tagIds` are the tags the "No tags" filter (`untagged`) leaves out, see
 * knownTagIds in lib/known-tag-ids.ts. Without them it adds no condition.
 */
export function buildJMAPFilter(
  textQuery: string,
  filters: SearchFilters,
  mailboxId?: string,
  tagIds: readonly string[] = []
): Record<string, unknown> {
  const conditions: Record<string, unknown>[] = [];

  // Quoted phrases and `word*` prefixes become conditions of their own (see
  // splitSearchText); the other words go out as one condition, as typed.
  // The field filters follow the same rules on the server.
  if (textQuery.trim()) {
    conditions.push(...textConditions(textQuery));
  }

  if (filters.from) {
    conditions.push(...textConditions(filters.from, "from"));
  }

  if (filters.to) {
    conditions.push(...textConditions(filters.to, "to"));
  }

  if (filters.subject) {
    conditions.push(...textConditions(filters.subject, "subject"));
  }

  if (filters.body) {
    conditions.push(...textConditions(filters.body, "body"));
  }

  if (filters.hasAttachment === true) {
    conditions.push({ hasAttachment: true });
  } else if (filters.hasAttachment === false) {
    conditions.push({ hasAttachment: false });
  }

  if (filters.dateAfter) {
    const date = new Date(filters.dateAfter);
    if (!isNaN(date.getTime())) {
      conditions.push({ after: date.toISOString() });
    }
  }

  if (filters.dateBefore) {
    const endOfDay = new Date(filters.dateBefore);
    if (!isNaN(endOfDay.getTime())) {
      endOfDay.setHours(23, 59, 59, 999);
      conditions.push({ before: endOfDay.toISOString() });
    }
  }

  if (filters.isUnread === true) {
    conditions.push({ notKeyword: "$seen" });
  } else if (filters.isUnread === false) {
    conditions.push({ hasKeyword: "$seen" });
  }

  if (filters.isStarred === true) {
    conditions.push({ hasKeyword: "$flagged" });
  } else if (filters.isStarred === false) {
    conditions.push({ notKeyword: "$flagged" });
  }

  // minSize is inclusive, maxSize exclusive (RFC 8621 §4.4.1).
  const minSize = sizeFilterBytes(filters.minSizeKb);
  if (minSize !== null) {
    conditions.push({ minSize });
  }
  const maxSize = sizeFilterBytes(filters.maxSizeKb);
  if (maxSize !== null) {
    conditions.push({ maxSize });
  }

  if (filters.untagged) {
    conditions.push(...untaggedConditions(tagIds));
  }

  if (filters.pluginFilter && !filters.pluginFilter.emails) {
    conditions.push(filters.pluginFilter.filter);
  }

  if (mailboxId) {
    conditions.push({ inMailbox: mailboxId });
  }

  if (conditions.length === 0) {
    return mailboxId ? { inMailbox: mailboxId } : {};
  }

  if (conditions.length === 1) {
    return conditions[0];
  }

  return {
    operator: "AND",
    conditions,
  };
}

type JmapFilter = Record<string, unknown>;

/** `AND` two JMAP filters, flattening into an existing top-level `AND`. */
export function andFilters(base: JmapFilter, extra: JmapFilter | null): JmapFilter {
  if (!extra || Object.keys(extra).length === 0) return base;
  if (Object.keys(base).length === 0) return extra;
  if (base.operator === 'AND' && Array.isArray(base.conditions)) {
    return { operator: 'AND', conditions: [...(base.conditions as JmapFilter[]), extra] };
  }
  return { operator: 'AND', conditions: [base, extra] };
}

export function isFilterEmpty(filters: SearchFilters): boolean {
  return (
    !filters.from &&
    !filters.to &&
    !filters.subject &&
    !filters.body &&
    filters.hasAttachment === null &&
    !filters.dateAfter &&
    !filters.dateBefore &&
    filters.isUnread === null &&
    filters.isStarred === null &&
    sizeFilterBytes(filters.minSizeKb) === null &&
    sizeFilterBytes(filters.maxSizeKb) === null &&
    !filters.untagged &&
    !filters.pluginFilter
  );
}

export function activeFilterCount(filters: SearchFilters): number {
  let count = 0;
  if (filters.from) count++;
  if (filters.to) count++;
  if (filters.subject) count++;
  if (filters.body) count++;
  if (filters.hasAttachment !== null) count++;
  if (filters.dateAfter) count++;
  if (filters.dateBefore) count++;
  if (filters.isUnread !== null) count++;
  if (filters.isStarred !== null) count++;
  if (sizeFilterBytes(filters.minSizeKb) !== null) count++;
  if (sizeFilterBytes(filters.maxSizeKb) !== null) count++;
  if (filters.untagged) count++;
  if (filters.pluginFilter) count++;
  return count;
}
