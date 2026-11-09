import { onSharedChange } from '@/lib/shared-store/changes';

/**
 * Images rendered from the branding (og-image, pwa-icon, pwa-screenshot),
 * kept so each is made once. Keyed by the source URL, which for an upload
 * carries the file's version (`?v=`), so a re-upload renders anew. Each
 * cache holds at most MAX_ENTRIES (the least recently used goes first; a
 * deployment with many domains used to grow it without bound), and all of
 * them are dropped when the branding or config changes, on this instance or
 * another one (#1066).
 *
 * On globalThis: one set of caches per process, whichever module copy asks.
 */

export const MAX_ENTRIES = 256;

export interface RenderCache {
  has(key: string): boolean;
  get(key: string): Blob | undefined;
  set(key: string, value: Blob): void;
  readonly size: number;
}

const KEY = Symbol.for('bulwark.admin.renderCaches');

function caches(): Map<string, Map<string, Blob>> {
  const g = globalThis as typeof globalThis & { [KEY]?: Map<string, Map<string, Blob>> };
  return (g[KEY] ??= new Map());
}

export function clearRenderCaches(): void {
  for (const cache of caches().values()) cache.clear();
}

for (const area of ['branding', 'config']) onSharedChange(area, () => clearRenderCaches());

export function renderCache(name: string): RenderCache {
  const entries = () => {
    const all = caches();
    let cache = all.get(name);
    if (!cache) all.set(name, (cache = new Map()));
    return cache;
  };
  return {
    has: (key) => entries().has(key),
    get(key) {
      const cache = entries();
      const value = cache.get(key);
      if (value !== undefined) {
        // Most recently used last.
        cache.delete(key);
        cache.set(key, value);
      }
      return value;
    },
    set(key, value) {
      const cache = entries();
      cache.delete(key);
      cache.set(key, value);
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    },
    get size() {
      return entries().size;
    },
  };
}
