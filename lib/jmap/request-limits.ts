/**
 * A JMAP session advertises hard ceilings on what one request may carry: how
 * many method calls it holds (`maxCallsInRequest`) and how many objects a
 * single /get or /set may touch (`maxObjectsInGet`, `maxObjectsInSet`). Going
 * over any of them fails the *whole* request, not the surplus, so a batch built
 * from a list the user controls - tags, category tabs, a multi-select, an
 * import - is split against the advertised limit before it is sent.
 *
 * Stalwart defaults to 16 method calls and 500 objects, so the ceilings are low
 * enough to reach with ordinary use: nine tags is already 18 calls.
 */

/** Split `items` into consecutive batches of at most `size` entries. */
export function batched<T>(items: T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += step) {
    result.push(items.slice(i, i + step));
  }
  return result;
}

/** How many items fit in one request when each item costs `callsPerItem` method calls. */
export function itemsPerRequest(maxCalls: number, callsPerItem: number): number {
  return Math.max(1, Math.floor(maxCalls / callsPerItem));
}
