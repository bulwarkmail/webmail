/**
 * Company calendar feeds as the server last fetched them, by address: the
 * body, its validators and when it was fetched. In memory, once per process
 * (not per bundle copy), and at most MAX_ENTRIES feeds; a replica that
 * starts fetches again.
 */

export interface CachedFeed {
  body: ArrayBuffer;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number;
}

/** What a fetch of a feed gave: its body, or the error to answer with. */
export type FeedResult = { body: ArrayBuffer } | { status: number; error: string };

const MAX_ENTRIES = 200;
/** How long a failed feed answers with its error before it is asked again. */
export const FAILURE_TTL_MS = 60_000;
const KEY = Symbol.for('bulwark.companyFeedCache');

interface CacheState {
  feeds: Map<string, CachedFeed>;
  failures: Map<string, { at: number; result: { status: number; error: string } }>;
  inFlight: Map<string, Promise<FeedResult>>;
}

function cacheState(): CacheState {
  const g = globalThis as typeof globalThis & { [KEY]?: CacheState };
  g[KEY] ??= { feeds: new Map(), failures: new Map(), inFlight: new Map() };
  return g[KEY];
}

function store(): Map<string, CachedFeed> {
  return cacheState().feeds;
}

export const companyFeedCache = {
  get(url: string): CachedFeed | undefined {
    return store().get(url);
  },
  set(url: string, entry: CachedFeed): void {
    const map = store();
    map.delete(url);
    map.set(url, entry);
    // The oldest entry goes first.
    while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string);
  },
  /** The error a feed failed with less than a minute ago, if it did. */
  failure(url: string): { status: number; error: string } | null {
    const failures = cacheState().failures;
    const entry = failures.get(url);
    if (!entry) return null;
    if (Date.now() - entry.at >= FAILURE_TTL_MS) {
      failures.delete(url);
      return null;
    }
    return entry.result;
  },
  fail(url: string, result: { status: number; error: string }): void {
    cacheState().failures.set(url, { at: Date.now(), result });
  },
  /** Run `fetch` for a feed once at a time: callers meanwhile share its result. */
  once(url: string, fetch: () => Promise<FeedResult>): Promise<FeedResult> {
    const inFlight = cacheState().inFlight;
    let running = inFlight.get(url);
    if (!running) {
      running = fetch().finally(() => inFlight.delete(url));
      inFlight.set(url, running);
    }
    return running;
  },
  clear(): void {
    const state = cacheState();
    state.feeds.clear();
    state.failures.clear();
    state.inFlight.clear();
  },
};
