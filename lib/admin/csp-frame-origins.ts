/**
 * Computes the union of CSP `frame-src` origins declared by installed and
 * enabled plugins. The proxy reads this on each request so that plugins can
 * embed external content (YouTube, Vimeo, Jitsi, …) without us hard-coding
 * domains in the host CSP.
 *
 * Origins are validated at install time and re-validated here as defense in
 * depth - any malformed value is dropped so a corrupted registry can never
 * inject arbitrary CSP fragments.
 */

import { getPluginRegistry } from './plugin-registry';
import { sanitizeFrameOrigins } from '../extension-origins';
import { isNoThirdPartyTrafficOn } from './third-party-mode';
import { onSharedChange } from '@/lib/shared-store/changes';

export {
  isValidFrameOrigin,
  sanitizeFrameOrigins,
  sanitizeHttpOrigins,
  isValidApiPostPath,
  sanitizeApiPostPaths,
} from '../extension-origins';

// In-memory cache. The proxy fires on every page navigation; reading the
// registry JSON every time is fine but cheap to skip when nothing has
// changed. Five seconds is short enough to make plugin install/uninstall
// feel snappy without measurable overhead.
//
// On globalThis: the proxy has its own copy of this module, and an install
// handled by a route must clear the proxy's cache too, not only the route's.
// Dropped at once when the plugins (or the config and policy that gate
// them) change, on this replica or another one (#1066).
interface FrameOriginsCache {
  at: number;
  origins: string[];
  /** Bumped on every invalidation, so a read that started before can't store stale origins. */
  generation: number;
}
const CACHE_KEY = Symbol.for('bulwark.admin.cspFrameOrigins');
const CACHE_TTL_MS = 5_000;

function cache(): FrameOriginsCache {
  const g = globalThis as typeof globalThis & { [CACHE_KEY]?: FrameOriginsCache };
  return (g[CACHE_KEY] ??= { at: 0, origins: [], generation: 0 });
}

for (const area of ['plugins', 'config', 'policy']) onSharedChange(area, () => invalidateFrameOriginsCache());

/**
 * Returns the union of frame origins declared by every enabled plugin in
 * the server-side registry, deduped and validated.
 *
 * Returns an empty array on any failure (missing file, parse error, …) so
 * a broken registry only ever shrinks the CSP - never widens it.
 */
export async function getEnabledPluginFrameOrigins(): Promise<string[]> {
  const c = cache();
  const now = Date.now();
  if (now - c.at < CACHE_TTL_MS) return c.origins;
  const generation = c.generation;
  const remember = (origins: string[]) => {
    if (c.generation !== generation) return;
    c.origins = origins;
    c.at = now;
  };

  try {
    // No outside frames at all while the server stays off outside hosts (#903).
    if (await isNoThirdPartyTrafficOn()) {
      remember([]);
      return [];
    }
    const registry = await getPluginRegistry();
    // Dev plugins (PLUGIN_DEV_DIR) are served next to the installed ones and
    // need their embeds allowed too.
    const { listDevPlugins } = await import('./plugin-dev');
    const devPlugins = (await listDevPlugins()).map((e) => e.plugin);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const plugin of [...registry.plugins, ...devPlugins]) {
      if (!plugin.enabled) continue;
      const origins = sanitizeFrameOrigins(plugin.frameOrigins);
      for (const o of origins) {
        const key = o.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(o);
      }
    }
    remember(out);
    return out;
  } catch {
    remember([]);
    return [];
  }
}

/** Force the next call (in every module copy) to re-read the registry. Used by install/uninstall. */
export function invalidateFrameOriginsCache(): void {
  const c = cache();
  c.at = 0;
  c.origins = [];
  c.generation++;
}
