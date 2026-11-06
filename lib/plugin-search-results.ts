// Results plugins add to a search through onProvideSearchResults, drawn as a
// block above the search's message list (components/email/plugin-search-results.tsx).
// Each plugin is asked on its own, so every entry keeps the plugin it came
// from: a click goes back to that plugin as onAction, unless the entry names a
// message, which the click opens. What a plugin returns crosses from its
// sandbox, so it is checked and cut here, never trusted.

import { emailHooks } from './plugin-hooks';
import type { ExternalSearchResult, SearchResultEmail } from './plugin-types';
import { parseSearchSnippet } from './search-snippet';

/** An entry as the host keeps it: checked, with the plugin that gave it. */
export interface ProvidedSearchResult extends ExternalSearchResult {
  pluginId: string;
}

/** Most entries one plugin may add to one search. */
export const MAX_RESULTS_PER_PLUGIN = 20;
const MAX_KEY = 200;
const MAX_TITLE = 200;
const MAX_SNIPPET = 300;
const MAX_SOURCE = 40;
const MAX_FROM = 100;
/** "2026-11-03T10:02:00.000+01:00" and the like; anything longer is no date. */
const MAX_DATE = 40;
/** JMAP ids are at most 255 octets (RFC 8620 §1.2). */
const MAX_ID = 255;

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `&`, `<` and `>` escaped as SearchSnippet/get escapes them, so parseSearchSnippet reads the text back as written. */
function escaped(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A snippet in SearchSnippet/get's form: text with `<mark>` around what
 * matched. Flattened and cut to `max` characters of its text as text() cuts,
 * each mark kept and closed, everything else escaped, so the list renders it
 * with parseSearchSnippet and never as HTML.
 */
function markedText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const segments = parseSearchSnippet(value.replace(/\s+/g, ' ')).filter((segment) => segment.text);
  if (segments.length > 0) {
    segments[0] = { ...segments[0], text: segments[0].text.trimStart() };
    const last = segments.length - 1;
    segments[last] = { ...segments[last], text: segments[last].text.trimEnd() };
  }
  const length = segments.reduce((n, segment) => n + segment.text.length, 0);
  let left = length > max ? max - 1 : length;
  let out = '';
  for (const { text: part, marked } of segments) {
    const kept = part.slice(0, left);
    left -= kept.length;
    if (kept) out += marked ? `<mark>${escaped(kept)}</mark>` : escaped(kept);
  }
  return length > max ? `${out}…` : out;
}

function jmapId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID ? value : null;
}

/** A date-time Date can read, as given, or null. */
function dateTime(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_DATE) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/** A score within 0 to 1, or null for anything that is not a number. */
function score(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

/** The message an entry names, or null for anything that is not one. */
function email(value: unknown): SearchResultEmail | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = jmapId(raw.id);
  if (!id) return null;
  if (raw.accountId === undefined) return { id };
  const accountId = jmapId(raw.accountId);
  return accountId ? { id, accountId } : null;
}

/**
 * One plugin's answer, checked: a list of entries with a key and a title,
 * plain text cut to its limits (the snippet with its marks), a date Date can
 * read, a score within 0 to 1, keys unique, at most MAX_RESULTS_PER_PLUGIN.
 * Anything else is dropped without failing the rest.
 */
export function checkSearchResults(pluginId: string, value: unknown): ProvidedSearchResult[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: ProvidedSearchResult[] = [];
  for (const raw of value) {
    if (out.length >= MAX_RESULTS_PER_PLUGIN) break;
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const key = typeof entry.key === 'string' ? entry.key : '';
    const title = text(entry.title, MAX_TITLE);
    if (!key || key.length > MAX_KEY || seen.has(key) || !title) continue;
    seen.add(key);
    const source = text(entry.source, MAX_SOURCE);
    const message = email(entry.email);
    const from = text(entry.from, MAX_FROM);
    const date = dateTime(entry.date);
    const fit = score(entry.score);
    out.push({
      pluginId, key, title, snippet: markedText(entry.snippet, MAX_SNIPPET),
      ...(source ? { source } : {}),
      ...(message ? { email: message } : {}),
      ...(from ? { from } : {}),
      ...(date ? { date } : {}),
      ...(fit !== null ? { score: fit } : {}),
    });
  }
  return out;
}

/**
 * Ask every plugin for results to a search. Returns the plugins asked, in
 * their order; each answer goes to `onAnswer` as it comes, checked (empty for
 * a plugin that throws or runs out of time), so a slow plugin keeps no other
 * waiting.
 */
export function provideSearchResults(
  query: string,
  filters: unknown,
  onAnswer: (pluginId: string, results: ProvidedSearchResult[]) => void,
): string[] {
  if (emailHooks.onProvideSearchResults.size === 0) return [];
  const asked = emailHooks.onProvideSearchResults.collect([] as ExternalSearchResult[], { query, filters });
  for (const { pluginId, answer } of asked) {
    void answer.then((given) => onAnswer(pluginId, given ? checkSearchResults(pluginId, given.value) : []));
  }
  return asked.map(({ pluginId }) => pluginId);
}
