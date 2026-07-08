// Process-wide registry of active sandboxed plugins. The loader populates it
// after a successful boot; PluginIframeSlot reads it to spawn slot iframes
// and to call evaluateShouldShow on the background instance.
//
// `offersForSlot` results are memoised per slot name so that
// `useSyncExternalStore` sees a stable reference between unrelated renders.
// The cache is invalidated whenever the set of active plugins changes.

import type { Disposable, InstalledPlugin, SlotName, PluginTier } from '../plugin-types';
import type { SandboxInstance } from './host-bridge';

export interface SlotOffer {
  name: SlotName;
  order: number;
  hasShouldShow: boolean;
}

export interface ActivePlugin {
  plugin: InstalledPlugin;
  /** Verified bundle source. Reused when spinning up slot iframes. */
  code: string;
  /** Resolved execution tier. Slot iframes must use the SAME tier as the
   * background instance, so `PluginIframeSlot` reads it from here. */
  tier: PluginTier;
  background: SandboxInstance;
  slotOffers: SlotOffer[];
  hookDisposables: Disposable[];
}

export interface ResolvedSlotOffer {
  pluginId: string;
  order: number;
  hasShouldShow: boolean;
}

const active = new Map<string, ActivePlugin>();
const listeners = new Set<() => void>();

// Per-slot snapshot cache. Cleared on any registry mutation.
const offersCache = new Map<SlotName, readonly ResolvedSlotOffer[]>();
const EMPTY: readonly ResolvedSlotOffer[] = Object.freeze([]);

function invalidate(): void {
  offersCache.clear();
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

export function register(entry: ActivePlugin): void {
  active.set(entry.plugin.id, entry);
  invalidate();
}

export function deregister(pluginId: string): ActivePlugin | undefined {
  const e = active.get(pluginId);
  if (!e) return undefined;
  active.delete(pluginId);
  invalidate();
  return e;
}

export function get(pluginId: string): ActivePlugin | undefined {
  return active.get(pluginId);
}

export function all(): ActivePlugin[] {
  return [...active.values()];
}

/**
 * Returns the cached, frozen list of plugins offering this slot, sorted by
 * `order`. The returned array is referentially stable until the active-plugin
 * set changes, so it is safe to pass to `useSyncExternalStore`.
 */
export function offersForSlot(slot: SlotName): readonly ResolvedSlotOffer[] {
  const cached = offersCache.get(slot);
  if (cached) return cached;
  const out: ResolvedSlotOffer[] = [];
  for (const entry of active.values()) {
    for (const offer of entry.slotOffers) {
      if (offer.name === slot) {
        out.push({ pluginId: entry.plugin.id, order: offer.order, hasShouldShow: offer.hasShouldShow });
      }
    }
  }
  out.sort((a, b) => a.order - b.order);
  const snapshot = out.length === 0 ? EMPTY : Object.freeze(out);
  offersCache.set(slot, snapshot);
  return snapshot;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
