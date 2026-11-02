import { parseStack } from './stack';

/**
 * The debug ID of each loaded bundle file, by scrubbed path.
 *
 * Turbopack (`turbopack.debugIds`) and `sentry-cli sourcemaps inject` (the
 * webpack build in Docker) start every chunk with a line that stores
 * `globalThis[KEY][new Error().stack] = "<debug id>"`. The first frame of that
 * stack is the chunk itself, so its path maps to the id. The error tracker
 * finds the uploaded source map by that id alone.
 */

const KEYS = ['_debugIds', '_sentryDebugIds'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cache: { size: number; ids: Map<string, string> } | null = null;

function registered(): Array<[string, string]> {
  const g = globalThis as Record<string, unknown>;
  const out: Array<[string, string]> = [];
  for (const key of KEYS) {
    const map = g[key];
    if (!map || typeof map !== 'object') continue;
    for (const [stack, id] of Object.entries(map as Record<string, unknown>)) {
      if (typeof id === 'string' && UUID.test(id)) out.push([stack, id.toLowerCase()]);
    }
  }
  return out;
}

/** Path -> debug ID for every chunk loaded so far. Chunks load lazily, so this is rebuilt when more have registered. */
export function debugIdsByPath(): Map<string, string> {
  const entries = registered();
  if (cache && cache.size === entries.length) return cache.ids;
  const ids = new Map<string, string>();
  for (const [stack, id] of entries) {
    const first = parseStack(stack).find((frame) => frame.path !== '[other]');
    if (first) ids.set(first.path, id);
  }
  cache = { size: entries.length, ids };
  return ids;
}

/** For tests. */
export function resetDebugIdCache(): void {
  cache = null;
}
