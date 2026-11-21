// Keyword filters plugins offer for the message list (`api.ui.setListFilters`).
// The host draws each as a chip in the list header of the folders it applies
// to; a chip the user turns on adds its keyword condition to the folder's
// query (ANDed with the folder, a category tab and the other chips) and can
// be removed again with one click. Which chips are on lasts until the page is
// reloaded, across folders: a chip that doesn't apply to a folder is neither
// shown nor applied there.

import type { MailAccountKind } from './account-kind';
import { MAIL_ACCOUNT_KINDS } from './account-kind';
import { PLUGIN_ICON_RE } from './actions';
import { teamInboxHandedOver } from '@/lib/team-mailboxes/host-flag';

export interface PluginListFilter {
  id: string;
  /** The chip's text, at most 40 characters. */
  label: string;
  /** Name of a host icon (see components/icons). */
  icon?: string;
  /** Only messages with this keyword. */
  hasKeyword?: string;
  /** Only messages without this keyword. */
  notKeyword?: string;
  /** Only in folders of these kinds of mail account (personal, group, shared). */
  accounts?: MailAccountKind[];
  /** Only in folders with these roles, e.g. ["inbox"]. */
  mailboxRoles?: string[];
  /** Lower comes first; default 100. */
  order?: number;
}

export interface RegisteredListFilter extends PluginListFilter {
  pluginId: string;
  pluginName: string;
  /** `<pluginId>:<id>`, unique across plugins. */
  key: string;
}

export const MAX_LIST_FILTERS_PER_PLUGIN = 4;
const ID_RE = /^[a-z0-9][a-z0-9-_.]{0,39}$/i;
const ROLE_RE = /^[a-z]{1,20}$/;
// The keyword rule of the plugin API (host-api.ts PLUGIN_KEYWORD_RE).
const KEYWORD_RE = /^[a-z0-9$][a-z0-9$_.:-]{0,127}$/i;

/** Check and copy what a plugin sent; throws with a message the plugin sees. */
export function checkListFilters(value: unknown): PluginListFilter[] {
  if (!Array.isArray(value)) throw new Error('filters must be a list');
  if (value.length > MAX_LIST_FILTERS_PER_PLUGIN) throw new Error(`At most ${MAX_LIST_FILTERS_PER_PLUGIN} filters per plugin`);
  const seen = new Set<string>();
  return value.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`filters[${i}] must be an object`);
    const f = raw as Record<string, unknown>;
    if (typeof f.id !== 'string' || !ID_RE.test(f.id)) throw new Error(`filters[${i}].id is invalid`);
    if (seen.has(f.id)) throw new Error(`filters[${i}].id is used twice`);
    seen.add(f.id);
    if (typeof f.label !== 'string' || !f.label.trim() || f.label.trim().length > 40) throw new Error(`filters[${i}].label is required (max 40 characters)`);
    const out: PluginListFilter = { id: f.id, label: f.label.trim() };
    for (const field of ['hasKeyword', 'notKeyword'] as const) {
      if (f[field] === undefined) continue;
      if (typeof f[field] !== 'string' || !KEYWORD_RE.test(f[field] as string)) throw new Error(`filters[${i}].${field} must be a keyword`);
      out[field] = (f[field] as string).toLowerCase();
    }
    if (!out.hasKeyword && !out.notKeyword) throw new Error(`filters[${i}] needs hasKeyword or notKeyword`);
    if (f.icon !== undefined) {
      if (typeof f.icon !== 'string' || !PLUGIN_ICON_RE.test(f.icon)) throw new Error(`filters[${i}].icon is invalid`);
      out.icon = f.icon;
    }
    if (f.accounts !== undefined) {
      if (!Array.isArray(f.accounts) || f.accounts.length === 0 || !f.accounts.every((k) => (MAIL_ACCOUNT_KINDS as readonly unknown[]).includes(k))) {
        throw new Error(`filters[${i}].accounts must be a list of "personal", "group" and "shared"`);
      }
      out.accounts = [...new Set(f.accounts as MailAccountKind[])];
    }
    if (f.mailboxRoles !== undefined) {
      if (!Array.isArray(f.mailboxRoles) || f.mailboxRoles.length > 10 || !f.mailboxRoles.every((r) => typeof r === 'string' && ROLE_RE.test(r))) {
        throw new Error(`filters[${i}].mailboxRoles must be a list of folder roles`);
      }
      out.mailboxRoles = [...f.mailboxRoles] as string[];
    }
    if (f.order !== undefined) {
      if (typeof f.order !== 'number' || !Number.isFinite(f.order)) throw new Error(`filters[${i}].order must be a number`);
      out.order = f.order;
    }
    return out;
  });
}

// ─── Registry ─────────────────────────────────────────────────

const registry = new Map<string, RegisteredListFilter[]>();
const active = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: RegisteredListFilter[] | null = null;
let activeSnapshot: ReadonlySet<string> = new Set();
/** Moves on whenever the set of applied filters changes, so the list loads again. */
let revision = 0;

function changed(activeChanged: boolean): void {
  snapshot = null;
  if (activeChanged) {
    activeSnapshot = new Set(active);
    revision += 1;
  }
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

export function subscribeListFilters(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setPluginListFilters(pluginId: string, pluginName: string, filters: PluginListFilter[]): void {
  const previous = registry.get(pluginId) ?? [];
  if (filters.length === 0) registry.delete(pluginId);
  else registry.set(pluginId, filters.map((f) => ({ ...f, pluginId, pluginName, key: `${pluginId}:${f.id}` })));
  // A filter that is on and changed its condition or went away loads the list again.
  let activeChanged = false;
  for (const key of [...active]) {
    if (!key.startsWith(`${pluginId}:`)) continue;
    const before = previous.find((f) => f.key === key);
    const after = registry.get(pluginId)?.find((f) => f.key === key);
    if (!after) {
      active.delete(key);
      activeChanged = true;
    } else if (!before || before.hasKeyword !== after.hasKeyword || before.notKeyword !== after.notKeyword) {
      activeChanged = true;
    }
  }
  changed(activeChanged);
}

/** Drop everything a plugin offered (it was turned off or removed). */
export function clearPluginListFilters(pluginId: string): void {
  if (!registry.delete(pluginId)) return;
  let activeChanged = false;
  for (const key of [...active]) {
    if (key.startsWith(`${pluginId}:`)) {
      active.delete(key);
      activeChanged = true;
    }
  }
  changed(activeChanged);
}

function snapshotFilters(): RegisteredListFilter[] {
  if (snapshot) return snapshot;
  const out: RegisteredListFilter[] = [];
  for (const filters of registry.values()) out.push(...filters);
  out.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label));
  snapshot = out;
  return out;
}

/** Every offered filter, in order; the same array until something changes. */
export function listFilters(): RegisteredListFilter[] {
  return snapshotFilters();
}

/** The keys of the filters that are on; the same set until one is turned on or off. */
export function activeListFilterKeys(): ReadonlySet<string> {
  return activeSnapshot;
}

export function listFilterRevision(): number {
  return revision;
}

/** Turn a filter on or off (toggle without `on`). */
export function setListFilterActive(key: string, on?: boolean): void {
  if (!snapshotFilters().some((f) => f.key === key)) return;
  const next = on ?? !active.has(key);
  if (next === active.has(key)) return;
  if (next) active.add(key);
  else active.delete(key);
  changed(true);
}

/** The folder a filter is checked against. */
export interface ListFilterFolder {
  role?: string | null;
  accountKind: MailAccountKind | null;
}

export function listFilterApplies(filter: PluginListFilter, folder: ListFilterFolder): boolean {
  // Team inbox's filters, while Bulwark's own team mailboxes offer them.
  const pluginId = (filter as { pluginId?: string }).pluginId;
  if (pluginId && teamInboxHandedOver(pluginId)) return false;
  if (filter.mailboxRoles && !filter.mailboxRoles.includes(folder.role ?? '')) return false;
  if (filter.accounts && (!folder.accountKind || !filter.accounts.includes(folder.accountKind))) return false;
  return true;
}

/** The JMAP condition of the filters that are on and apply to `folder`, or null. */
export function activeListFilterCondition(folder: ListFilterFolder): Record<string, unknown> | null {
  const conditions: Record<string, unknown>[] = [];
  for (const filter of snapshotFilters()) {
    if (!active.has(filter.key) || !listFilterApplies(filter, folder)) continue;
    if (filter.hasKeyword) conditions.push({ hasKeyword: filter.hasKeyword });
    if (filter.notKeyword) conditions.push({ notKeyword: filter.notKeyword });
  }
  if (conditions.length === 0) return null;
  return conditions.length === 1 ? conditions[0] : { operator: 'AND', conditions };
}

/** The keywords the filters that are on and apply to `folder` test, lowercase. */
export function activeListFilterKeywords(folder: ListFilterFolder): Set<string> {
  const out = new Set<string>();
  for (const filter of snapshotFilters()) {
    if (!active.has(filter.key) || !listFilterApplies(filter, folder)) continue;
    if (filter.hasKeyword) out.add(filter.hasKeyword);
    if (filter.notKeyword) out.add(filter.notKeyword);
  }
  return out;
}

/** Test helper. */
export function resetListFilters(): void {
  registry.clear();
  active.clear();
  changed(true);
}
