// A function a slot gets as a prop is called by the host with whatever the
// plugin's frame sends (host-bridge.ts, callback-invoke). A callback that
// sets host state therefore checks what it is handed: a slot never gets a
// state setter or a store action as it is.

/** White space, control and format characters (line breaks, direction marks, zero-width spaces). */
const NOT_IN_A_LINK = /[\s\p{Cc}\p{Cf}]/u;

/**
 * Whether `value` is a web link the host may take from a plugin: a string of
 * at most `max` characters, without white space, control or format
 * characters, that parses as an absolute http: or https: address with a host
 * and without a user name or password before it.
 */
export function isWebLink(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return false;
  if (NOT_IN_A_LINK.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' && !url.username && !url.password;
}

/**
 * A slot callback that hands a web link (see isWebLink) on to `set` and
 * ignores anything else, which leaves the field as it is. It answers the
 * plugin true when it took the link and false when it didn't.
 */
export function linkCallback(set: (value: string) => void, max: number): (value: unknown) => boolean {
  return (value) => {
    if (!isWebLink(value, max)) return false;
    set(value);
    return true;
  };
}
