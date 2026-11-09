/**
 * Parameters for plugins in a link that opens the composer: a mailto: link
 * (in a message, on a web page, from another program through the desktop
 * app) or a Bulwark link (`/?compose=1&...`, `bulwark://new?...`).
 *
 *   mailto:a@b.de?subject=Mahnung&x-akte-case=01%2F2026
 *
 * A query parameter named `x-<plugin id>-<name>` belongs to the plugin with
 * that id: once the composer is open, that plugin alone hears
 * onComposeFromLink({ composerId, params: { <name>: <value> } }), with the
 * prefix gone. Other plugins see nothing of it, and Bulwark itself ignores
 * the parameter. Plugin ids may hold hyphens, so a parameter goes to the
 * plugin with the longest id it starts with.
 *
 * A link can come from anyone, so this is input to check, never a command.
 * Names are lower case (mailto: header names are case-insensitive); control
 * characters go; sizes and counts are capped.
 */

/** `x-<plugin id>-<name>` (lower case) → value, as the link carried them. */
export type LinkParams = Record<string, string>;

export const LINK_PARAM_PREFIX = 'x-';
/** At most this many plugin parameters per link. */
export const MAX_LINK_PARAMS = 50;
/** A name, prefix and plugin id included. */
const MAX_NAME_LENGTH = 128;
export const MAX_LINK_PARAM_VALUE = 2048;
/** Letters, digits, `-`, `_` and `.` in a name; the plugin id is lower-case letters, digits and hyphens. */
const NAME = /^x-[a-z0-9][a-z0-9._-]*$/;

/**
 * The plugin parameters among a link's query parameters (already decoded),
 * or undefined when there are none. The first value of a name wins.
 */
export function linkParamsFrom(params: Iterable<readonly [string, string]>): LinkParams | undefined {
  const out: LinkParams = {};
  let count = 0;
  for (const [rawName, rawValue] of params) {
    const name = rawName.trim().toLowerCase();
    if (!name.startsWith(LINK_PARAM_PREFIX) || name.length > MAX_NAME_LENGTH || !NAME.test(name)) continue;
    if (Object.prototype.hasOwnProperty.call(out, name)) continue;
    if (count >= MAX_LINK_PARAMS) break;
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    out[name] = rawValue.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_LINK_PARAM_VALUE);
    count += 1;
  }
  return count > 0 ? out : undefined;
}

/** The names of a URL's query that are plugin parameters, to take out of the address bar. */
export function isLinkParamName(name: string): boolean {
  return name.toLowerCase().startsWith(LINK_PARAM_PREFIX);
}

/**
 * Who gets what: each parameter goes to the plugin among `pluginIds` with the
 * longest id it starts with (`x-<id>-`), without that prefix. Parameters no
 * plugin listed claims are dropped.
 */
export function splitLinkParams(params: LinkParams, pluginIds: readonly string[]): Map<string, Record<string, string>> {
  const byLength = [...new Set(pluginIds)].sort((a, b) => b.length - a.length);
  const out = new Map<string, Record<string, string>>();
  for (const [name, value] of Object.entries(params)) {
    const owner = byLength.find((id) => name.startsWith(`${LINK_PARAM_PREFIX}${id}-`) && name.length > LINK_PARAM_PREFIX.length + id.length + 1);
    if (!owner) continue;
    const own = out.get(owner) ?? {};
    own[name.slice(LINK_PARAM_PREFIX.length + owner.length + 1)] = value;
    out.set(owner, own);
  }
  return out;
}
