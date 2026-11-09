/**
 * Free/busy (Principal/getAvailability) lookups, per client.
 *
 * Whether the server answers free/busy for this user at all is asked once.
 * Stalwart 1.0 refuses every availability lookup while the administrator has
 * directory queries off, which is its default, and says so up front on the
 * user's own principal (`mayGetAvailability: false`). Knowing that before the
 * first lookup keeps the event form from listing every attendee as unknown.
 *
 * Busy periods are cached per principal and window for a few minutes. The
 * event form looks everyone up again whenever the time or the attendees
 * change, and Stalwart 1.0 allows 100 getAvailability calls per account a
 * minute, counting every call however they are batched.
 */

import type { IJMAPClient } from "./client-interface";
import type { PrincipalAvailability } from "./types";

export const AVAILABILITY_TTL_MS = 3 * 60 * 1000;

/**
 * Stalwart counts availability calls in fixed one-minute windows and refuses
 * every call until the window is over, without saying when that is. A full
 * minute after a refusal is always past it.
 */
export const RATE_LIMIT_BACKOFF_MS = 60 * 1000;

/**
 * Stalwart 1.0 allows this many availability calls per account a minute
 * (x:Calendar.availabilityRateLimit, the default). 0.16 has no limit; counting
 * there costs nothing.
 */
export const AVAILABILITY_CALLS_PER_MINUTE = 100;
const MINUTE_MS = 60 * 1000;

const access = new WeakMap<IJMAPClient, boolean>();
const pendingChecks = new WeakMap<IJMAPClient, Promise<boolean>>();

/** What an earlier check learned, or undefined when nothing has been asked yet. */
export function knownAvailabilityAccess(client: IJMAPClient): boolean | undefined {
  return access.get(client);
}

/** Asks the server once per client whether free/busy lookups are allowed. Never rejects. */
export function checkAvailabilityAccess(client: IJMAPClient): Promise<boolean> {
  const known = access.get(client);
  if (known !== undefined) return Promise.resolve(known);
  let check = pendingChecks.get(client);
  if (!check) {
    check = (client.mayGetAvailability ? client.mayGetAvailability() : Promise.resolve(true))
      .then((allowed) => {
        access.set(client, allowed);
        return allowed;
      })
      // A failed check proves nothing either way: look up this time and ask
      // again next time.
      .catch(() => true)
      .finally(() => pendingChecks.delete(client));
    pendingChecks.set(client, check);
  }
  return check;
}

/** The server refused a lookup outright; stop asking for this client. */
export function revokeAvailabilityAccess(client: IJMAPClient): void {
  access.set(client, false);
}

interface CachedLookup {
  requestedAt: number;
  result: Promise<PrincipalAvailability>;
}

interface LookupState {
  cache: Map<string, CachedLookup>;
  backoffUntil: number;
  /** When each call of the last minute went out, oldest first. */
  sent: number[];
}

const lookups = new WeakMap<IJMAPClient, LookupState>();

function lookupStateOf(client: IJMAPClient): LookupState {
  let state = lookups.get(client);
  if (!state) {
    state = { cache: new Map(), backoffUntil: 0, sent: [] };
    lookups.set(client, state);
  }
  return state;
}

/**
 * How many more availability calls this tab can make within the server's
 * limit right now: none while it backs off after a refusal. The limit is per
 * account and other tabs and devices spend from it too, so this is an upper
 * bound; a search that needs more than this is not started.
 */
export function availabilityCallsLeft(client: IJMAPClient, now = Date.now()): number {
  const state = lookupStateOf(client);
  if (now < state.backoffUntil) return 0;
  state.sent = state.sent.filter((at) => now - at < MINUTE_MS);
  return Math.max(0, AVAILABILITY_CALLS_PER_MINUTE - state.sent.length);
}

/**
 * The window a lookup asks the server for: the local days from `start` to
 * `end`, so that moving an event within its day is answered from the cache.
 */
export function availabilityWindow(start: Date, end: Date): { start: Date; end: Date } {
  const from = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const to = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  if (to.getTime() < end.getTime()) to.setDate(to.getDate() + 1);
  return { start: from, end: to };
}

/**
 * The busy periods of each principal over the local days from `start` to
 * `end`, for the caller to match against the exact event window. Fresh
 * answers come from the cache, lookups already on their way are shared, and
 * the rest go out as one batched request. Never rejects: a failed request
 * counts as `serverUnavailable`, and while the server is rate limiting, the
 * answer is `rateLimit` without asking.
 */
export async function lookUpAvailability(
  client: IJMAPClient,
  principalIds: string[],
  start: Date,
  end: Date,
): Promise<Record<string, PrincipalAvailability>> {
  const state = lookupStateOf(client);
  const { cache } = state;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.requestedAt >= AVAILABILITY_TTL_MS) cache.delete(key);
  }

  const days = availabilityWindow(start, end);
  const keyOf = (id: string) => `${id}|${days.start.getTime()}|${days.end.getTime()}`;
  const results = new Map<string, Promise<PrincipalAvailability>>();
  const missing: string[] = [];
  for (const id of new Set(principalIds)) {
    const cached = cache.get(keyOf(id));
    if (cached) results.set(id, cached.result);
    else missing.push(id);
  }

  if (missing.length > 0 && now < state.backoffUntil) {
    for (const id of missing) results.set(id, Promise.resolve({ error: "rateLimit" }));
  } else if (missing.length > 0) {
    for (let i = 0; i < missing.length; i++) state.sent.push(now);
    const batch = client.getPrincipalsAvailability!(missing, days.start, days.end)
      .catch((): Record<string, PrincipalAvailability> => ({}));
    for (const id of missing) {
      const key = keyOf(id);
      const entry: CachedLookup = {
        requestedAt: now,
        result: batch.then((answers) => answers[id] ?? { error: "serverUnavailable" }),
      };
      cache.set(key, entry);
      results.set(id, entry.result);
      void entry.result.then((result) => {
        if (!("error" in result)) return;
        // Only answers are kept: a refused lookup is asked again next time.
        if (cache.get(key) === entry) cache.delete(key);
        if (result.error === "rateLimit") {
          state.backoffUntil = Math.max(state.backoffUntil, Date.now() + RATE_LIMIT_BACKOFF_MS);
        }
      });
    }
  }

  const settled = await Promise.all([...results].map(async ([id, result]) => [id, await result] as const));
  return Object.fromEntries(settled);
}
