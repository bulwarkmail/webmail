// A function a slot gets as a prop is called by the host with whatever the
// plugin's frame sends (host-bridge.ts, callback-invoke). A callback that
// sets host state therefore checks what it is handed: a slot never gets a
// state setter or a store action as it is.

/**
 * A slot callback that hands a string on to `set`, cut to `max` characters,
 * and ignores anything else (an object, a number, nothing).
 */
export function textCallback(set: (value: string) => void, max: number): (value: unknown) => void {
  return (value) => {
    if (typeof value === 'string') set(value.slice(0, max));
  };
}
