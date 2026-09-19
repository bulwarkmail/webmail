import type { ICalSubscription } from '@/stores/calendar-store';

/**
 * Tombstones older than this are pruned from the synced blob. A device that
 * stays offline longer than this may resurrect a deletion - the accepted
 * trade-off for keeping the blob bounded.
 */
export const SUBSCRIPTION_TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface SyncedSubscriptionState {
  icalSubscriptions: ICalSubscription[];
  /** Subscription id -> ISO time it was deleted. */
  deletedSubscriptionIds: Record<string, string>;
}

/**
 * Structurally validates an `icalSubscriptions` value from a synced settings blob or
 * settings-file import. Returns null when the value is not an array (a blob
 * from a build that predates subscription sync), so callers can leave the local
 * store untouched; malformed entries are dropped, ids are preserved.
 */
export function parseSyncedSubscriptions(value: unknown): ICalSubscription[] | null {
  if (!Array.isArray(value)) return null;

  const subscriptions: ICalSubscription[] = [];
  const seen = new Set<string>();
  const now = new Date().toISOString();

  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const s = item as Record<string, unknown>;
    if (typeof s.id !== 'string' || !s.id || seen.has(s.id)) continue;
    if (typeof s.url !== 'string' || !s.url.trim()) continue;
    if (typeof s.calendarId !== 'string' || !s.calendarId.trim()) continue;
    if (typeof s.name !== 'string' || !s.name.trim()) continue;
    seen.add(s.id);

    const refreshInterval = typeof s.refreshInterval === 'number' && Number.isFinite(s.refreshInterval) && s.refreshInterval > 0
      ? s.refreshInterval
      : 60;

    subscriptions.push({
      id: s.id,
      url: s.url.trim().replace(/^webcals?:\/\//i, 'https://'),
      calendarId: s.calendarId.trim(),
      name: s.name.trim(),
      color: typeof s.color === 'string' && s.color ? s.color : '#3b82f6',
      refreshInterval,
      lastRefreshed: typeof s.lastRefreshed === 'string' ? s.lastRefreshed : null,
      accountId: typeof s.accountId === 'string' && s.accountId ? s.accountId : undefined,
      updatedAt: typeof s.updatedAt === 'string' && s.updatedAt ? s.updatedAt : (typeof s.lastRefreshed === 'string' && s.lastRefreshed ? s.lastRefreshed : now),
    });
  }
  return subscriptions;
}

/** Structurally validates a `deletedSubscriptionIds` map from a synced blob. */
export function parseSubscriptionTombstones(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [id, deletedAt] of Object.entries(value as Record<string, unknown>)) {
    if (typeof deletedAt === 'string' && !Number.isNaN(Date.parse(deletedAt))) {
      out[id] = deletedAt;
    }
  }
  return out;
}

/**
 * Merges a synced subscription state into the local one. Per subscription id the
 * newer `updatedAt` wins (ties keep the local copy); a deletion tombstone
 * beats a subscription unless the subscription was edited after the deletion, which
 * resurrects it and clears the tombstone. Merging (rather than replacing)
 * keeps a stale per-account blob from wiping subscriptions created under another
 * account or on another device.
 */
export function mergeSyncedSubscriptions(
  local: SyncedSubscriptionState,
  incoming: SyncedSubscriptionState,
  now: Date = new Date()
): SyncedSubscriptionState {
  const cutoff = now.getTime() - SUBSCRIPTION_TOMBSTONE_TTL_MS;

  // Union of tombstones, newest deletion time per id, pruned by TTL.
  const tombstones: Record<string, string> = {};
  for (const source of [local.deletedSubscriptionIds, incoming.deletedSubscriptionIds]) {
    for (const [id, deletedAt] of Object.entries(source)) {
      if (Date.parse(deletedAt) < cutoff) continue;
      if (!tombstones[id] || Date.parse(deletedAt) > Date.parse(tombstones[id])) {
        tombstones[id] = deletedAt;
      }
    }
  }

  const byId = new Map<string, ICalSubscription>();
  for (const s of local.icalSubscriptions) byId.set(s.id, s);
  for (const s of incoming.icalSubscriptions) {
    const existing = byId.get(s.id);
    const existingTime = existing?.updatedAt ? Date.parse(existing.updatedAt) : 0;
    const incomingTime = s.updatedAt ? Date.parse(s.updatedAt) : 0;
    if (!existing || incomingTime > existingTime) {
      byId.set(s.id, s);
    }
  }

  const icalSubscriptions: ICalSubscription[] = [];
  for (const s of byId.values()) {
    const deletedAt = tombstones[s.id];
    if (deletedAt !== undefined) {
      const updatedTime = s.updatedAt ? Date.parse(s.updatedAt) : 0;
      if (updatedTime <= Date.parse(deletedAt)) continue;
      delete tombstones[s.id];
    }
    icalSubscriptions.push(s);
  }

  return { icalSubscriptions, deletedSubscriptionIds: tombstones };
}
