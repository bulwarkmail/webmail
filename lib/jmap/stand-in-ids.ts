/**
 * Stand-in ids: what the local store hands out for an event created offline.
 *
 * A page can hold one long after the event reached the server: an open dialog,
 * a list not refetched yet, a plugin. So the client swaps them for the real ids
 * on the way to the network, and swaps them back in the answer, because callers
 * look up the outcome under the id they asked about.
 */

import type { OfflineMethodCall, OfflineResponse } from './offline-hooks';

const STAND_IN_PREFIX = 'local-';

export function isStandInId(id: string): boolean {
  return id.startsWith(STAND_IN_PREFIX);
}

export function newStandInId(): string {
  return `${STAND_IN_PREFIX}${crypto.randomUUID()}`;
}

/** The stand-in ids a request names. */
export function standInsIn(calls: readonly OfflineMethodCall[]): string[] {
  const found = new Set<string>();
  for (const [name, args] of calls) {
    if (name === 'CalendarEvent/set') {
      for (const id of Object.keys((args.update ?? {}) as object)) if (isStandInId(id)) found.add(id);
      for (const id of (args.destroy ?? []) as string[]) if (isStandInId(id)) found.add(id);
    } else if (name === 'CalendarEvent/get') {
      for (const id of (args.ids ?? []) as string[]) if (isStandInId(id)) found.add(id);
    }
  }
  return [...found];
}

function renamedKeys<T>(map: Record<string, T>, rename: (id: string) => string): Record<string, T> {
  return Object.fromEntries(Object.entries(map).map(([id, value]) => [rename(id), value]));
}

/** The request with every stand-in swapped for its real id. */
export function withRealIds<T extends OfflineMethodCall>(calls: readonly T[], real: Readonly<Record<string, string>>): T[] {
  const rename = (id: string) => real[id] ?? id;
  return calls.map((call) => {
    const [name, args, callId] = call;
    if (name === 'CalendarEvent/set') {
      const next = { ...args };
      if (args.update) next.update = renamedKeys(args.update as Record<string, unknown>, rename);
      if (args.destroy) next.destroy = (args.destroy as string[]).map(rename);
      return [name, next, callId] as unknown as T;
    }
    if (name === 'CalendarEvent/get' && args.ids) {
      return [name, { ...args, ids: (args.ids as string[]).map(rename) }, callId] as unknown as T;
    }
    return call;
  });
}

/** The answer as if the caller's ids had gone out. The objects in a get's list keep their real id. */
export function withStandInsBack<T extends OfflineResponse>(response: T, real: Readonly<Record<string, string>>): T {
  const back = new Map(Object.entries(real).map(([standIn, id]) => [id, standIn]));
  const rename = (id: string) => back.get(id) ?? id;
  return {
    ...response,
    methodResponses: response.methodResponses.map(([name, result, callId]) => {
      if (name !== 'CalendarEvent/set' && name !== 'CalendarEvent/get') return [name, result, callId];
      const next = { ...result };
      for (const key of ['updated', 'notUpdated', 'notDestroyed']) {
        if (next[key]) next[key] = renamedKeys(next[key], rename);
      }
      for (const key of ['destroyed', 'notFound']) {
        if (next[key]) next[key] = next[key].map(rename);
      }
      return [name, next, callId];
    }),
  };
}
