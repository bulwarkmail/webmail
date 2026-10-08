import type { EmailTemplate } from './template-types';

/**
 * Tombstones older than this are pruned from the synced blob. A device that
 * stays offline longer than this may resurrect a deletion - the accepted
 * trade-off for keeping the blob bounded.
 */
export const TEMPLATE_TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface SyncedTemplateState<T extends { id: string; updatedAt: string } = EmailTemplate> {
  templates: T[];
  /** Template id -> ISO time it was deleted. */
  deletedTemplateIds: Record<string, string>;
}

/**
 * Merges a synced template state into the local one. Per template id the
 * newer `updatedAt` wins (ties keep the local copy); a deletion tombstone
 * beats a template unless the template was edited after the deletion, which
 * resurrects it and clears the tombstone. Merging (rather than replacing)
 * keeps a stale per-account blob from wiping templates created under another
 * account or on another device.
 */
export function mergeSyncedTemplates<T extends { id: string; updatedAt: string }>(
  local: SyncedTemplateState<T>,
  incoming: SyncedTemplateState<T>,
  now: Date = new Date()
): SyncedTemplateState<T> {
  const cutoff = now.getTime() - TEMPLATE_TOMBSTONE_TTL_MS;

  // Union of tombstones, newest deletion time per id, pruned by TTL.
  const tombstones: Record<string, string> = {};
  for (const source of [local.deletedTemplateIds, incoming.deletedTemplateIds]) {
    for (const [id, deletedAt] of Object.entries(source)) {
      if (Date.parse(deletedAt) < cutoff) continue;
      if (!tombstones[id] || Date.parse(deletedAt) > Date.parse(tombstones[id])) {
        tombstones[id] = deletedAt;
      }
    }
  }

  const byId = new Map<string, T>();
  for (const t of local.templates) byId.set(t.id, t);
  for (const t of incoming.templates) {
    const existing = byId.get(t.id);
    if (!existing || Date.parse(t.updatedAt) > Date.parse(existing.updatedAt)) {
      byId.set(t.id, t);
    }
  }

  const templates: T[] = [];
  for (const t of byId.values()) {
    const deletedAt = tombstones[t.id];
    if (deletedAt !== undefined) {
      if (Date.parse(t.updatedAt) <= Date.parse(deletedAt)) continue;
      delete tombstones[t.id];
    }
    templates.push(t);
  }

  return { templates, deletedTemplateIds: tombstones };
}

type RawTemplate = Record<string, unknown> & { id: string; updatedAt: string };

function rawTemplates(value: unknown): RawTemplate[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (t): t is RawTemplate =>
      typeof t === 'object' && t !== null &&
      typeof (t as Record<string, unknown>).id === 'string' &&
      typeof (t as Record<string, unknown>).updatedAt === 'string'
  );
}

function rawTombstones(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [id, deletedAt] of Object.entries(value as Record<string, unknown>)) {
    if (typeof deletedAt === 'string' && !Number.isNaN(Date.parse(deletedAt))) out[id] = deletedAt;
  }
  return out;
}

/**
 * Server-side counterpart of the client merge, applied when a settings blob
 * is saved. A push carries the pushing tab's whole template list, so without
 * this a tab or device that has not loaded since another one added a template
 * overwrites the stored blob and the template is gone for every device that
 * loads afterwards. A push without a `templates` array (a client whose
 * template store had not registered yet, or an older build) keeps the stored
 * templates instead of dropping them.
 *
 * Returns the blob to store; the template entries are passed through as they
 * are, clients validate them when they apply a blob.
 */
export function mergeStoredTemplates(
  stored: Record<string, unknown> | null,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const storedTemplates = stored ? rawTemplates(stored.templates) : null;
  if (!storedTemplates) return incoming;

  const incomingTemplates = rawTemplates(incoming.templates);
  if (!incomingTemplates) {
    return {
      ...incoming,
      templates: stored!.templates,
      deletedTemplateIds: stored!.deletedTemplateIds ?? {},
    };
  }

  const merged = mergeSyncedTemplates(
    { templates: storedTemplates, deletedTemplateIds: rawTombstones(stored!.deletedTemplateIds) },
    { templates: incomingTemplates, deletedTemplateIds: rawTombstones(incoming.deletedTemplateIds) }
  );
  return { ...incoming, ...merged };
}
