// Results plugins add to a search through onProvideSearchResults, drawn as a
// block above the search's message list (components/email/plugin-search-results.tsx).
// Each plugin is asked on its own, so every entry keeps the plugin it came
// from: a click goes back to that plugin as onAction, unless the entry names a
// message, which the click opens. What a plugin returns crosses from its
// sandbox, so it is checked and cut here, never trusted.

import { emailHooks } from './plugin-hooks';
import type { ExternalSearchResult, SearchResultEmail } from './plugin-types';

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
/** JMAP ids are at most 255 octets (RFC 8620 §1.2). */
const MAX_ID = 255;

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function jmapId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID ? value : null;
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
 * plain text cut to its limits, keys unique, at most MAX_RESULTS_PER_PLUGIN.
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
    out.push({
      pluginId, key, title, snippet: text(entry.snippet, MAX_SNIPPET),
      ...(source ? { source } : {}),
      ...(message ? { email: message } : {}),
    });
  }
  return out;
}

/** Ask every plugin for results to a search; each answer checked, in the plugins' order. */
export async function provideSearchResults(query: string, filters: unknown): Promise<ProvidedSearchResult[]> {
  if (emailHooks.onProvideSearchResults.size === 0) return [];
  const answers = await emailHooks.onProvideSearchResults.collect([] as ExternalSearchResult[], { query, filters });
  return answers.flatMap(({ pluginId, value }) => checkSearchResults(pluginId, value));
}
