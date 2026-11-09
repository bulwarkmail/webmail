// The assistant's host API areas, merged, inside the plugin sandbox (see README.md).

import { runtime as b } from './b.runtime';
import { runtime as c } from './c.runtime';
import { runtime as d } from './d.runtime';
import { runtime as f } from './f.runtime';

export type CallApi = (method: string, args: unknown[], timeoutMs?: number) => Promise<unknown>;
/** Methods by namespace: { email: { getThread: (...) => ... } }. */
export type RuntimeAdditions = Record<string, Record<string, (...args: never[]) => unknown>>;

/** Adds every area's methods to the plugin's api, namespace by namespace. */
export function withAssistantRuntime<T extends object>(api: T, callApi: CallApi): T {
  const target = api as unknown as Record<string, Record<string, unknown>>;
  for (const area of [b, c, d, f]) {
    for (const [ns, methods] of Object.entries(area(callApi))) {
      target[ns] = Object.assign(target[ns] ?? {}, methods);
    }
  }
  return api;
}
