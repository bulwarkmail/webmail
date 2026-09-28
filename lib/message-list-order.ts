import type { Email } from './jmap/types';

/**
 * Configurable message-list ordering (#718).
 *
 * An ordering is a prioritised list of up to MAX_SORT_LEVELS sort levels. Each
 * level is a {criterion, direction} pair; the list maps 1:1 onto the JMAP
 * Email/query `sort` array (RFC 8621 §4.4.2), so the server orders the whole
 * mailbox and pagination stays consistent. This module owns every piece of
 * that mapping so the UI only ever deals in semantic choices ("unread first",
 * "newest first") and the isAscending polarity is decided in exactly one place.
 */

export type SortCriterion =
  | 'unread'
  | 'starred'
  | 'tag'
  | 'receivedAt'
  | 'sentAt'
  | 'from'
  | 'subject'
  | 'size';

/**
 * Direction of the criterion's *value*: `desc` puts the higher / true value
 * first. For the boolean criteria the value is "is unread" / "is starred" /
 * "has the tag", so `desc` means "unread first", "starred first", "tagged
 * first". For dates `desc` is newest first; for size largest first; for
 * sender / subject `asc` is A→Z.
 */
export type SortDirection = 'asc' | 'desc';

export interface SortLevel {
  criterion: SortCriterion;
  direction: SortDirection;
  /** Only for criterion 'tag': the KeywordDefinition id (JMAP keyword $label:<id>). */
  tagId?: string;
}

/** Which folders the configured order applies to. */
export type MessageListOrderScope = 'inbox' | 'all';

/**
 * How the server interprets `isAscending` on the keyword comparators.
 *
 * RFC 8621 §4.4.2: hasKeyword is a boolean value (false < true), so
 * `isAscending: false` puts messages that HAVE the keyword first - the RFC's
 * own `$flagged` example "would sort Emails in flagged Threads first" with
 * isAscending false. Stalwart (verified on 0.16.8, reported upstream) does the
 * opposite: `isAscending: true` puts has-keyword first. The client probes the
 * server once per account (see JMAPClient.resolveKeywordSortPolarity) and
 * feeds the result in here, so a fixed server flips back automatically.
 */
export type KeywordSortPolarity = 'rfc' | 'inverted';

export const MAX_SORT_LEVELS = 3;

export const SORT_CRITERIA: readonly SortCriterion[] = [
  'unread',
  'starred',
  'tag',
  'receivedAt',
  'sentAt',
  'from',
  'subject',
  'size',
];

const KEYWORD_CRITERIA: ReadonlySet<SortCriterion> = new Set(['unread', 'starred', 'tag']);

export function isKeywordCriterion(criterion: SortCriterion): boolean {
  return KEYWORD_CRITERIA.has(criterion);
}

/** The direction a freshly added level gets: the one people mean by default. */
export function defaultDirection(criterion: SortCriterion): SortDirection {
  return criterion === 'from' || criterion === 'subject' ? 'asc' : 'desc';
}

export interface JMAPEmailComparator {
  property: string;
  isAscending: boolean;
  keyword?: string;
}

export const DEFAULT_COMPARATOR: JMAPEmailComparator = { property: 'receivedAt', isAscending: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerces an untrusted value (persisted state, a synced settings blob, a file
 * import) into a valid level list: unknown criteria and directions are dropped,
 * a tag level without a tag id is dropped, duplicate criteria are dropped (a
 * second "unread" level can never change the order), and the list is capped.
 */
export function sanitizeSortLevels(value: unknown): SortLevel[] {
  if (!Array.isArray(value)) return [];
  const out: SortLevel[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const criterion = raw.criterion;
    if (typeof criterion !== 'string' || !SORT_CRITERIA.includes(criterion as SortCriterion)) continue;
    const direction: SortDirection = raw.direction === 'asc' || raw.direction === 'desc'
      ? raw.direction
      : defaultDirection(criterion as SortCriterion);
    const level: SortLevel = { criterion: criterion as SortCriterion, direction };
    if (criterion === 'tag') {
      if (typeof raw.tagId !== 'string' || raw.tagId.length === 0) continue;
      level.tagId = raw.tagId;
    }
    const key = criterion === 'tag' ? `tag:${level.tagId}` : criterion;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(level);
    if (out.length >= MAX_SORT_LEVELS) break;
  }
  return out;
}

/** The JMAP keyword a boolean level sorts on, or null for value criteria. */
export function levelKeyword(level: SortLevel): string | null {
  switch (level.criterion) {
    case 'unread': return '$seen';
    case 'starred': return '$flagged';
    case 'tag': return level.tagId ? `$label:${level.tagId}` : null;
    default: return null;
  }
}

/** Every keyword the order sorts on: changing one of them can move a message. */
export function orderKeywords(levels: SortLevel[]): string[] {
  return levels.map(levelKeyword).filter((keyword): keyword is string => keyword !== null);
}

/**
 * Whether messages that HAVE the level's keyword should come first. "Unread
 * first" is the absence of $seen first, so it inverts relative to the others.
 */
export function keywordFirst(level: SortLevel): boolean {
  const wantsTrueFirst = level.direction === 'desc';
  return level.criterion === 'unread' ? !wantsTrueFirst : wantsTrueFirst;
}

/** True when the order (or pinned-first) needs a keyword comparator server-side. */
export function hasKeywordLevels(levels: SortLevel[], pinnedFirst = false): boolean {
  return pinnedFirst || levels.some(l => levelKeyword(l) !== null);
}

/** A "chronological" order: nothing configured, or only newest-first. */
export function isDefaultOrder(levels: SortLevel[]): boolean {
  return levels.length === 0
    || (levels.length === 1 && levels[0].criterion === 'receivedAt' && levels[0].direction === 'desc');
}

/**
 * Builds the Email/query `sort` array for a level list.
 *
 * - `pinnedFirst` prepends the existing $pinned-on-top comparator.
 * - `polarity` is the server's keyword comparator polarity (see
 *   KeywordSortPolarity); defaults to the RFC reading.
 * - `keywordSortSupported: false` drops every keyword comparator (the server
 *   advertises no hasKeyword support or refused it with unsupportedSort); the
 *   remaining value comparators still apply.
 * - A trailing receivedAt-desc tie-breaker is always present so the order is
 *   total and stable across pages.
 */
export function buildEmailSort(
  levels: SortLevel[],
  opts: { pinnedFirst?: boolean; polarity?: KeywordSortPolarity; keywordSortSupported?: boolean } = {},
): JMAPEmailComparator[] {
  const polarity = opts.polarity ?? 'rfc';
  const keywordsOk = opts.keywordSortSupported !== false;
  const keywordComparator = (keyword: string, first: boolean): JMAPEmailComparator => ({
    property: 'hasKeyword',
    keyword,
    // RFC: false < true, so has-keyword first is descending. Inverted servers
    // read it the other way round.
    isAscending: polarity === 'rfc' ? !first : first,
  });

  const sort: JMAPEmailComparator[] = [];
  if (opts.pinnedFirst && keywordsOk) {
    sort.push(keywordComparator('$pinned', true));
  }
  let hasDateLevel = false;
  for (const level of levels) {
    const keyword = levelKeyword(level);
    if (keyword) {
      if (keywordsOk) sort.push(keywordComparator(keyword, keywordFirst(level)));
      continue;
    }
    if (level.criterion === 'receivedAt') hasDateLevel = true;
    sort.push({ property: level.criterion, isAscending: level.direction === 'asc' });
  }
  if (!hasDateLevel) sort.push({ ...DEFAULT_COMPARATOR });
  return sort;
}

/** RFC 8621 "from"/"to" sort value: the first address's name, else its email. */
function addressSortValue(email: Email): string {
  const first = email.from?.[0];
  if (!first) return '';
  return (first.name || first.email || '').toLowerCase();
}

/** RFC 5256 §2.1 base subject, approximated: strip reply/forward prefixes. */
function baseSubject(subject: string | undefined): string {
  return (subject ?? '')
    .replace(/^\s*(?:(?:re|fwd?|aw|wg|sv|vs|tr)\s*(?:\[\d+\])?\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();
}

function time(value: string | undefined): number {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function levelValue(level: SortLevel, email: Email): number | string {
  switch (level.criterion) {
    case 'unread': return email.keywords?.$seen ? 0 : 1;
    case 'starred': return email.keywords?.$flagged ? 1 : 0;
    case 'tag': return level.tagId && email.keywords?.[`$label:${level.tagId}`] ? 1 : 0;
    case 'receivedAt': return time(email.receivedAt);
    case 'sentAt': return time(email.sentAt || email.receivedAt);
    case 'size': return email.size ?? 0;
    case 'from': return addressSortValue(email);
    case 'subject': return baseSubject(email.subject);
  }
}

function compareValues(a: number | string, b: number | string): number {
  if (typeof a === 'string' || typeof b === 'string') {
    return String(a).localeCompare(String(b));
  }
  return a - b;
}

/**
 * Client-side mirror of `buildEmailSort` for the same level list. Used as the
 * within-page safety net (some servers ignore the sort on unfiltered queries),
 * for merging per-account pages in the unified view, for the demo client, and
 * to keep thread grouping from undoing the server order.
 */
export function compareEmails(
  levels: SortLevel[],
  opts: { pinnedFirst?: boolean } = {},
): (a: Email, b: Email) => number {
  const hasDateLevel = levels.some(l => l.criterion === 'receivedAt');
  return (a, b) => {
    if (opts.pinnedFirst) {
      const pa = a.keywords?.['$pinned'] ? 1 : 0;
      const pb = b.keywords?.['$pinned'] ? 1 : 0;
      if (pa !== pb) return pb - pa;
    }
    for (const level of levels) {
      const diff = compareValues(levelValue(level, a), levelValue(level, b));
      if (diff !== 0) return level.direction === 'asc' ? diff : -diff;
    }
    if (!hasDateLevel) {
      const diff = time(b.receivedAt) - time(a.receivedAt);
      if (diff !== 0) return diff;
    }
    return 0;
  };
}

/**
 * The order to use for a given folder: the configured levels when they apply
 * to every folder, or to the Inbox when scoped to it; chronological otherwise.
 */
export function orderForMailbox(
  levels: SortLevel[],
  scope: MessageListOrderScope,
  role: string | null | undefined,
): SortLevel[] {
  if (levels.length === 0) return [];
  if (scope === 'all' || role === 'inbox') return levels;
  return [];
}

export type OrderPreset = 'chronological' | 'unread_first' | 'starred_first' | 'tagged_first' | 'custom';

export const ORDER_PRESETS: readonly OrderPreset[] = ['chronological', 'unread_first', 'starred_first', 'tagged_first'];

/** Levels for a simple preset; `tagId` is required for `tagged_first`. */
export function presetLevels(preset: OrderPreset, tagId?: string): SortLevel[] {
  switch (preset) {
    case 'unread_first': return [{ criterion: 'unread', direction: 'desc' }];
    case 'starred_first': return [{ criterion: 'starred', direction: 'desc' }];
    case 'tagged_first': return tagId ? [{ criterion: 'tag', direction: 'desc', tagId }] : [];
    default: return [];
  }
}

/** The preset a level list corresponds to, or 'custom' for anything else. */
export function detectPreset(levels: SortLevel[]): OrderPreset {
  // A trailing newest-first level is implicit and doesn't make an order custom.
  const core = levels.length > 1
    && levels[levels.length - 1].criterion === 'receivedAt'
    && levels[levels.length - 1].direction === 'desc'
    ? levels.slice(0, -1)
    : levels;
  if (isDefaultOrder(core)) return 'chronological';
  if (core.length !== 1 || core[0].direction !== 'desc') return 'custom';
  switch (core[0].criterion) {
    case 'unread': return 'unread_first';
    case 'starred': return 'starred_first';
    case 'tag': return 'tagged_first';
    default: return 'custom';
  }
}
