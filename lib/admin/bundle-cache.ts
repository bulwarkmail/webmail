/**
 * Plugin bundles this replica served lately, keyed by their SHA-256
 * (`bundleHash`), so serving a bundle in shared mode (#1066) doesn't fetch
 * up to 5 MB from the shared store on every request. Content-addressed: a
 * new install has a new hash, so nothing here can go stale; entries are only
 * added after the bytes were checked against the hash. Least recently used
 * entries go first once the cache holds more than MAX_BYTES.
 *
 * Per process, on globalThis (one cache for every module copy).
 */

export const MAX_BYTES = 64 * 1024 * 1024;

export interface CachedBundle {
  code: string;
  /** The stored signature; undefined until it was read once. */
  signature?: string | null;
}

interface BundleCacheState {
  entries: Map<string, CachedBundle & { bytes: number }>;
  bytes: number;
}

const KEY = Symbol.for('bulwark.admin.bundleCache');

function state(): BundleCacheState {
  const g = globalThis as typeof globalThis & { [KEY]?: BundleCacheState };
  return (g[KEY] ??= { entries: new Map(), bytes: 0 });
}

export function getCachedBundle(hash: string): CachedBundle | undefined {
  const s = state();
  const entry = s.entries.get(hash);
  if (!entry) return undefined;
  // Most recently used last.
  s.entries.delete(hash);
  s.entries.set(hash, entry);
  return entry;
}

export function cacheBundle(hash: string, code: string, signature?: string | null): void {
  const s = state();
  const previous = s.entries.get(hash);
  if (previous) {
    s.entries.delete(hash);
    s.bytes -= previous.bytes;
  }
  const bytes = Buffer.byteLength(code, 'utf-8');
  if (bytes > MAX_BYTES) return;
  s.entries.set(hash, { code, signature: signature ?? previous?.signature, bytes });
  s.bytes += bytes;
  for (const [oldest, entry] of s.entries) {
    if (s.bytes <= MAX_BYTES) break;
    s.entries.delete(oldest);
    s.bytes -= entry.bytes;
  }
}

/** How much the cache holds (tests). */
export function bundleCacheSize(): { entries: number; bytes: number } {
  const s = state();
  return { entries: s.entries.size, bytes: s.bytes };
}

export function clearBundleCache(): void {
  const s = state();
  s.entries.clear();
  s.bytes = 0;
}
