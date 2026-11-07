import { useCallback, useRef, useState, type SetStateAction } from "react";

/**
 * useState whose setter does nothing when handed the value the state already
 * has (or is about to have).
 *
 * React can only skip a same-value update without drawing the component
 * when nothing else is pending on it; right after a commit, as in an effect
 * that resets state for a new message, it calls the component once more to
 * find out. In a large component that is a few milliseconds per reset, for
 * nothing. An updater function is called at once with the latest value.
 */
export function useQuietState<T>(initial: T | (() => T)): [T, (next: SetStateAction<T>) => void] {
  const [value, setValue] = useState(initial);
  // The value last set, not the last one drawn: while a transition holds a
  // set back, a render still shows the old value, and comparing with that
  // dropped a set back to it, so the held-back value won.
  const latest = useRef(value);
  const set = useCallback((next: SetStateAction<T>) => {
    const resolved = typeof next === "function" ? (next as (previous: T) => T)(latest.current) : next;
    if (Object.is(resolved, latest.current)) return;
    latest.current = resolved;
    setValue(() => resolved);
  }, []);
  return [value, set];
}
