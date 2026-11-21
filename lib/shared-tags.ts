/**
 * Shared tags of a group account: the tag names and colors every member of
 * a shared mailbox sees, kept in the metadata of the group's Inbox
 * (namespace `org.bulwarkmail.tags`, lib/jmap/bulwark-metadata.ts).
 *
 * Keywords in a group account are the same for every member
 * (local-data/org-features-facts.md §1), so `$label:urgent` on a team
 * message is the team's tag, not one member's. A personal definition only
 * names it for the member who made it; the shared definitions name it for
 * everyone.
 *
 * Stored as a map by tag id, `{ "tags": { "<id>": { "label", "color", ... } } }`,
 * so a change patches one tag (`metadata/org.bulwarkmail.tags/tags/<id>`)
 * and two members adding different tags at the same time both keep theirs.
 * Fields this version doesn't know are kept. Earlier shapes (`{ "list": [...] }`
 * or a bare array) are read, and converted once by the first save.
 *
 * Pure functions only.
 */

import {
  FALLBACK_KEYWORD_COLOR,
  KEYWORD_PALETTE,
  type KeywordDefinition,
  type KeywordVisibility,
} from '@/stores/settings-store';
import { findUnrecognizedKeywords } from './keyword-discovery';
import { MAX_KEYWORD_ID_LENGTH } from './keyword-nesting';
import { MAX_METADATA_ENTRY_BYTES, MetadataTooLargeError, metadataValueBytes } from './jmap/bulwark-metadata';

/** The metadata key (namespace `org.bulwarkmail.tags`). */
export const SHARED_TAGS_KEY = 'tags';

/** Longest name a shared tag keeps, as in the personal tag editor. */
export const MAX_SHARED_TAG_LABEL = 30;

const VISIBILITIES: readonly KeywordVisibility[] = ['show', 'hide', 'unread'];

/**
 * Characters RFC 8621 keywords can't hold (and whitespace), so a tag id
 * from the server that could never be on a message is dropped.
 */
const BAD_ID_CHARS = /[\s(){\]%*"\\]/;

/** Whether a tag id from the server can be a keyword (no control characters either). */
function isKeywordSafe(id: string): boolean {
  if (!id || id.length > MAX_KEYWORD_ID_LENGTH || BAD_ID_CHARS.test(id)) return false;
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** What the server holds, as read. */
export interface StoredSharedTags {
  /** The raw entry of each tag by id, unknown fields included. */
  entries: Record<string, Record<string, unknown>>;
  /** Other values of the namespace next to `tags`, kept as they are. */
  extra: Record<string, unknown>;
  /** The map shape is on the server, so changes can patch one tag. */
  patchable: boolean;
}

export const EMPTY_SHARED_TAGS: StoredSharedTags = { entries: {}, extra: {}, patchable: false };

/**
 * Reads the namespace value: the map shape, or the earlier `{ list }` and
 * bare-array shapes (converted to entries; `patchable` stays false so the
 * first save writes the map shape).
 */
export function readSharedTags(value: unknown): StoredSharedTags {
  if (isObject(value) && isObject(value.tags)) {
    const entries: Record<string, Record<string, unknown>> = {};
    for (const [id, entry] of Object.entries(value.tags)) {
      if (isKeywordSafe(id) && isObject(entry)) entries[id] = entry;
    }
    const { tags: _tags, ...extra } = value;
    void _tags;
    return { entries, extra, patchable: true };
  }
  const items = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.list) ? value.list : [];
  const entries: Record<string, Record<string, unknown>> = {};
  const seen = new Set<string>();
  for (const item of items) {
    if (!isObject(item) || typeof item.id !== 'string') continue;
    const id = item.id.trim();
    if (!isKeywordSafe(id) || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    const { id: _id, ...rest } = item;
    void _id;
    entries[id] = rest;
  }
  return { entries, extra: {}, patchable: false };
}

/**
 * A stored color this version can draw: a palette key, or `#` and six hex
 * digits (any case, returned lowercase). Null for anything else.
 */
export function knownSharedTagColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (KEYWORD_PALETTE[value]) return value;
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

/**
 * One tag as the app shows it. A palette key or a `#rrggbb` color is kept
 * (lowercased); any other color shows grey but stays stored.
 */
function definitionOf(id: string, entry: Record<string, unknown>): KeywordDefinition {
  const label = typeof entry.label === 'string' ? entry.label.trim().slice(0, MAX_SHARED_TAG_LABEL) : '';
  const color = knownSharedTagColor(entry.color) ?? FALLBACK_KEYWORD_COLOR;
  const definition: KeywordDefinition = { id, label: label || id, color };
  if (typeof entry.visibility === 'string' && (VISIBILITIES as readonly string[]).includes(entry.visibility)) {
    definition.visibility = entry.visibility as KeywordVisibility;
  }
  return definition;
}

/** The shared definitions, by name (a map has no order of its own). */
export function sharedDefinitions(stored: StoredSharedTags): KeywordDefinition[] {
  return Object.entries(stored.entries)
    .map(([id, entry]) => definitionOf(id, entry))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/** The shared definitions in a metadata value (any shape). */
export function parseSharedTags(value: unknown): KeywordDefinition[] {
  return sharedDefinitions(readSharedTags(value));
}

/**
 * One change: a tag's new name and, when the member picked one, its color;
 * null deletes the tag. Other fields of the entry are kept.
 */
export interface SharedTagChange {
  id: string;
  value: { label: string; color?: string } | null;
}

/** The id under which `id` is stored, in any case, or `id` itself. */
function storedId(entries: Record<string, unknown>, id: string): string {
  const folded = id.toLowerCase();
  return Object.keys(entries).find((key) => key.toLowerCase() === folded) ?? id;
}

/** The stored tags with the changes applied, nothing else touched. */
export function applySharedTagChanges(stored: StoredSharedTags, changes: SharedTagChange[]): StoredSharedTags {
  const entries = { ...stored.entries };
  for (const change of changes) {
    const id = storedId(entries, change.id);
    if (change.value === null) {
      delete entries[id];
      continue;
    }
    const { label, color } = change.value;
    entries[id] = { ...(entries[id] ?? {}), label, ...(color !== undefined ? { color } : {}) };
  }
  return { ...stored, entries };
}

/**
 * The Mailbox/set patches for the changes, and what the server holds after
 * them. On the map shape each changed tag is one patch and no other tag is
 * written; on an older shape (or none) the whole namespace is written once
 * in the map shape. Throws MetadataTooLargeError when the result would take
 * more than the 8 KB of one namespace (UTF-8 bytes of its JSON).
 */
export function planSharedTagsSave(
  stored: StoredSharedTags,
  changes: SharedTagChange[],
): { patches: Array<{ path: string[]; value: unknown }>; result: StoredSharedTags } {
  const next = applySharedTagChanges(stored, changes);
  const namespace = { ...next.extra, tags: next.entries };
  if (metadataValueBytes(namespace) > MAX_METADATA_ENTRY_BYTES) {
    throw new MetadataTooLargeError(`The shared tags take more than ${MAX_METADATA_ENTRY_BYTES} bytes`);
  }
  if (!stored.patchable) {
    return { patches: [{ path: [], value: namespace }], result: { ...next, patchable: true } };
  }
  const ids = [...new Set(changes.map((change) => storedId(stored.entries, change.id)))];
  return {
    patches: ids.map((id) => ({ path: ['tags', id], value: next.entries[id] ?? null })),
    result: next,
  };
}

/**
 * What a group account shows as its tags: the shared definitions, then
 * every tag found on its messages that no definition names, with the name
 * and color keyword discovery proposes for it. A keyword that is on a
 * message is never hidden because nobody defined it.
 */
export function groupAccountTags(
  shared: KeywordDefinition[],
  discovered: Record<string, number>,
  nested: boolean,
): { definitions: KeywordDefinition[]; discoveredIds: string[] } {
  const found = findUnrecognizedKeywords(discovered, shared, nested);
  return {
    definitions: [...shared, ...found.map(({ id, label, color }) => ({ id, label, color }))],
    discoveredIds: found.map((entry) => entry.id),
  };
}
