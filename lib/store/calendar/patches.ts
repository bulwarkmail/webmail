/**
 * Reading a PatchObject against the server's copy of an event.
 *
 * What goes in doesn't read back the same (measured on both Stalwarts,
 * 2026-11-03). 1.0 keeps only what an override changes against its series, a
 * participant as a pointer key such as `participants/me/participationStatus`.
 * 0.16 keeps the whole entry, moves `updated` in every entry on any change of the
 * series, and drops an attendee-only `roles`. Both drop `@type` from a recurrence
 * rule and add `iCalendar` to a location. So a value counts as held when the
 * server's has what was sent, and an override is read as its occurrence.
 */

import { applyPatchObject } from '@/lib/jmap/patch-object';
import { pointerToken, pointerTokenValue } from '@/lib/jmap/patch-pointer';
import { applyOverridePatch, stableJson } from '@/lib/recurrence-instances';
import { valueAtPointer } from './records';

type Patch = Record<string, unknown>;

const OVERRIDE_POINTER = /^recurrenceOverrides\/([^/]+)(?:\/(.+))?$/;
const IGNORED_MEMBERS = new Set(['@type']);

function isEmptyDefault(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return true;
  return typeof value === 'object' && Object.keys(value as object).length === 0;
}

/** Whether `actual` has what `sent` says. Extra members in `actual` don't matter. */
function contains(actual: unknown, sent: unknown, member?: string): boolean {
  if (actual === null || actual === undefined) {
    if (isEmptyDefault(sent)) return true;
    return member === 'roles' && stableJson(sent) === stableJson({ attendee: true });
  }
  if (Array.isArray(sent)) {
    return Array.isArray(actual) && actual.length === sent.length && sent.every((item, i) => contains(actual[i], item));
  }
  if (sent !== null && typeof sent === 'object') {
    if (typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(sent).every(([name, value]) => IGNORED_MEMBERS.has(name)
      || contains((actual as Record<string, unknown>)[name], value, name));
  }
  return actual === sent;
}

function overrideEntry(server: Patch, key: string): Patch | undefined {
  return (server.recurrenceOverrides as Record<string, Patch> | null | undefined)?.[key];
}

/** Whether the server's copy holds `value` at PatchObject key `key`. */
export function holdsValue(server: Patch, key: string, value: unknown): boolean {
  if (key === 'recurrenceOverrides') {
    const entries = Object.entries((value ?? {}) as Record<string, unknown>);
    if (entries.length === 0) return Object.keys((server.recurrenceOverrides ?? {}) as object).length === 0;
    return entries.every(([id, entry]) => holdsValue(server, `recurrenceOverrides/${pointerToken(id)}`, entry));
  }
  const match = OVERRIDE_POINTER.exec(key);
  if (!match) return contains(valueAtPointer(server, key), value);
  const id = pointerTokenValue(match[1]);
  const entry = overrideEntry(server, id);
  const inEntry = match[2];
  if (value === null && !inEntry) return !entry;
  if (!entry) return false;
  if (!inEntry && (entry.excluded || (value as Patch).excluded)) return Boolean(entry.excluded) === Boolean((value as Patch).excluded);
  // `start` as the rule puts it: a server leaves it out of an unmoved override.
  const occurrence = applyOverridePatch({ ...server, start: id } as Patch, entry);
  return contains(inEntry ? valueAtPointer(occurrence, inEntry) : occurrence, value);
}

/** Whether a row's write is already on the server, whoever put it there. */
export function holdsPatch(server: Patch, patch: Patch): boolean {
  return Object.entries(patch).every(([key, value]) => holdsValue(server, key, value));
}

// `updated` inside an override moves on 0.16 when any part of the series changes.
function comparable(key: string, value: unknown): string {
  if (OVERRIDE_POINTER.test(key) && value && typeof value === 'object') {
    const { updated: _updated, ...rest } = value as Patch;
    return stableJson(rest);
  }
  return stableJson(value);
}

export interface PatchState {
  patch: Patch;
  /** The server's value at each key when this was queued. */
  base: Patch;
  /** Values of ours that may have reached the server: a send whose answer was lost, an earlier row of the same event. */
  sent: Patch | null;
}

/** Whether the server moved a value this patch writes, to something that isn't ours. */
export function collides({ patch, base, sent }: PatchState, server: Patch): boolean {
  return Object.keys(patch).some((key) => {
    if (holdsValue(server, key, patch[key])) return false;
    if (sent && key in sent && holdsValue(server, key, sent[key])) return false;
    return comparable(key, valueAtPointer(server, key)) !== comparable(key, base[key]);
  });
}

/**
 * A whole overrides map becomes one key per entry that differs from what the
 * writer could see. Written whole, it would erase any override someone else
 * added while the write waited; this way that one collides only on the same entry.
 */
export function asOverridePointers(patch: Patch, shown: Patch): Patch {
  if (!('recurrenceOverrides' in patch)) return patch;
  const { recurrenceOverrides: map, ...rest } = patch;
  const entries = (map ?? {}) as Record<string, unknown>;
  const known = (shown.recurrenceOverrides ?? {}) as Record<string, unknown>;
  const out: Patch = { ...rest };
  for (const [id, entry] of Object.entries(entries)) {
    if (stableJson(entry) !== stableJson(known[id])) out[`recurrenceOverrides/${pointerToken(id)}`] = entry;
  }
  for (const id of Object.keys(known)) {
    if (!(id in entries)) out[`recurrenceOverrides/${pointerToken(id)}`] = null;
  }
  return out;
}

/**
 * The patch as it can go out now. A pointer into overrides fails while a series
 * has none, on both Stalwarts, so they go as a whole map then, which erases
 * nothing. Removing an entry the server doesn't have is nothing to send.
 */
export function patchForServer(patch: Patch, server: Patch): Patch {
  const pointers = Object.keys(patch).filter((key) => OVERRIDE_POINTER.test(key));
  if (pointers.length === 0) return patch;
  const out: Patch = {};
  for (const [key, value] of Object.entries(patch)) if (!OVERRIDE_POINTER.test(key)) out[key] = value;
  if (Object.keys((server.recurrenceOverrides ?? {}) as object).length === 0) {
    const built = applyPatchObject({ recurrenceOverrides: {} }, Object.fromEntries(pointers.map((key) => [key, patch[key]])));
    if (Object.keys(built.recurrenceOverrides).length > 0) out.recurrenceOverrides = built.recurrenceOverrides;
    return out;
  }
  for (const key of pointers) {
    const entry = overrideEntry(server, pointerTokenValue((OVERRIDE_POINTER.exec(key) as RegExpExecArray)[1]));
    if (patch[key] === null && !entry) continue;
    out[key] = patch[key];
  }
  return out;
}
