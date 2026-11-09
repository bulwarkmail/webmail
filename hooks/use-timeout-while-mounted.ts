import { useCallback, useEffect, useRef } from "react";

/**
 * setTimeout whose pending timers are cleared when the component unmounts.
 *
 * A toolbar that kept its buttons disabled for a moment after an action
 * called setState from a bare timer. When the component was gone by then,
 * the call still reached React; in a test whose environment had already
 * been torn down that threw "window is not defined" and failed the run.
 */
export function useTimeoutWhileMounted(): (callback: () => void, ms: number) => void {
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  return useCallback((callback: () => void, ms: number) => {
    const id = setTimeout(() => {
      timers.current.delete(id);
      callback();
    }, ms);
    timers.current.add(id);
  }, []);
}
