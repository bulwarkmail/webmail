import { useCallback, useRef, useState } from "react";

/**
 * useState whose setter does nothing when handed the value the state already
 * has (or is about to have).
 *
 * React can only skip a same-value update without drawing the component
 * when nothing else is pending on it; right after a commit, as in an effect
 * that resets state for a new message, it calls the component once more to
 * find out. In a large component that is a few milliseconds per reset, for
 * nothing. For values set directly, not through an updater function.
 */
export function useQuietState<T>(initial: T | (() => T)): [T, (next: T) => void] {
  const [value, setValue] = useState(initial);
  const latest = useRef(value);
  latest.current = value;
  const set = useCallback((next: T) => {
    if (Object.is(next, latest.current)) return;
    latest.current = next;
    setValue(() => next);
  }, []);
  return [value, set];
}
