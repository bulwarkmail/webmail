import { useLayoutEffect, useRef } from "react";

type Handler = (...args: never[]) => unknown;

/**
 * Handlers that keep their identity one by one and forward to the latest
 * ones, for a memoised child. Unlike useStableHandlers, a handler coming or
 * going (next and previous at the ends of the list) changes only that key.
 *
 * Only for handlers invoked after render (clicks, effects): the latest set
 * is published in a layout effect.
 */
export function useStableEach(handlers: Record<string, Handler>): Record<string, Handler> {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  const forwarders = useRef(new Map<string, Handler>()).current;
  const stable: Record<string, Handler> = {};
  for (const key of Object.keys(handlers)) {
    let forward = forwarders.get(key);
    if (!forward) {
      forward = ((...args: never[]) => latest.current[key]?.(...args)) as Handler;
      forwarders.set(key, forward);
    }
    stable[key] = forward;
  }
  return stable;
}
