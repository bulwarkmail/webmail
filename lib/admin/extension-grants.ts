/**
 * What an admin approves when a plugin is saved, and what a version adds to
 * what was approved before.
 *
 * Every path that saves a plugin compares what the bundle grants with what
 * the admin was shown or already approved: a marketplace install with the
 * directory's listing (what the quick-install dialog shows), an update with
 * the installed version, a rollback with the installed version too. Anything
 * beyond it is answered with 409 and saved only once the admin accepted it
 * (`acceptPermissions` and `acceptGrants` in the request).
 *
 * A grant is more than the permission list: the hosts a plugin may contact,
 * the app's own routes it may post to, the origins it may embed (they go into
 * the CSP of every page), the servers its credentials are sent to, and the
 * privileged tier, which runs it on the app's own origin. For a theme it is
 * its skin, which restyles every part of the app.
 *
 * No server imports: the admin pages read and describe the same shapes.
 */

import { IMPLICIT_PERMISSIONS } from '@/lib/plugin-types';

/** What a plugin is granted, or what the admin was shown or approved. */
export interface Grants {
  permissions: string[];
  /** Hosts api.http.fetch may reach (httpOrigins). */
  httpOrigins: string[];
  /** The app's own routes api.http.post may call with the user's login (apiPostPaths). */
  apiPostPaths: string[];
  /** Origins the plugin may embed (frameOrigins). */
  frameOrigins: string[];
  /** Servers its credentials go to, where the manifest names them. */
  credentialOrigins: string[];
  /** The privileged tier: a frame on the app's own origin. */
  privileged: boolean;
  /** A theme's skin.css, which may style any part of the app. */
  skin: boolean;
}

/** A validated manifest or a registry entry, as far as grants go. */
export interface GrantSource {
  permissions?: unknown;
  httpOrigins?: unknown;
  apiPostPaths?: unknown;
  frameOrigins?: unknown;
  credentials?: unknown;
  configSchema?: unknown;
  tier?: unknown;
  /** Themes: whether a skin comes with it. */
  hasSkin?: unknown;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string'))] : [];

function urlOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The servers a plugin's credentials go to: a fixed `origin`, or for an admin
 * credential whose server the admin enters (`originKey`), the address the
 * manifest brings as that field's default. A server the admin or the user
 * enters themselves is theirs, not the plugin's.
 */
function credentialOriginsOf(credentials: unknown, configSchema: unknown): string[] {
  if (!credentials || typeof credentials !== 'object') return [];
  const schema = (configSchema && typeof configSchema === 'object' ? configSchema : {}) as Record<string, { default?: unknown } | undefined>;
  const out = new Set<string>();
  for (const spec of Object.values(credentials as Record<string, unknown>)) {
    if (!spec || typeof spec !== 'object') continue;
    const s = spec as { origin?: unknown; originKey?: unknown };
    const origin = urlOrigin(s.origin) ?? (typeof s.originKey === 'string' ? urlOrigin(schema[s.originKey]?.default) : null);
    if (origin) out.add(origin);
  }
  return [...out];
}

/** The grants of a validated manifest or a registry entry. */
export function grantsOf(entry: GrantSource | null | undefined): Grants {
  return {
    permissions: strings(entry?.permissions),
    httpOrigins: strings(entry?.httpOrigins),
    apiPostPaths: strings(entry?.apiPostPaths),
    frameOrigins: strings(entry?.frameOrigins),
    credentialOrigins: credentialOriginsOf(entry?.credentials, entry?.configSchema),
    privileged: entry?.tier === 'privileged',
    skin: entry?.hasSkin === true,
  };
}

/** An origin as compared: host case, a trailing slash and https' own port make no difference. */
function originKey(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, '').replace(/^(https:\/\/[^/]+):443$/, '$1');
}

/**
 * Whether `held` already allows `origin`: the same origin, or a wildcard
 * (`https://*.host`) that matches it the way the host does, one label deep.
 * A wildcard is never covered by a single host.
 */
function originCovered(origin: string, held: readonly string[]): boolean {
  const want = originKey(origin);
  return held.some((entry) => {
    const have = originKey(entry);
    if (have === want) return true;
    const wildcard = /^https:\/\/\*\.(.+)$/.exec(have);
    const host = /^https:\/\/([^.*/:]+)\.(.+)$/.exec(want);
    return !!wildcard && !!host && host[2] === wildcard[1];
  });
}

/** Whether `held` already allows `path`: the same path, or a prefix entry (ending in `/`) it starts with. */
function pathCovered(path: string, held: readonly string[]): boolean {
  return held.some((entry) => entry === path || (entry.endsWith('/') && path.startsWith(entry)));
}

/**
 * What `after` grants beyond `before`. Implicit permissions every plugin
 * holds are never an addition, and neither is anything `after` dropped.
 */
export function grantsAdded(before: Partial<Grants>, after: Partial<Grants>): Grants {
  const held = new Set<string>([...strings(before.permissions), ...IMPLICIT_PERMISSIONS]);
  const origins = (want: unknown, have: unknown) => strings(want).filter((o) => !originCovered(o, strings(have)));
  return {
    permissions: strings(after.permissions).filter((p) => !held.has(p)),
    httpOrigins: origins(after.httpOrigins, before.httpOrigins),
    apiPostPaths: strings(after.apiPostPaths).filter((p) => !pathCovered(p, strings(before.apiPostPaths))),
    frameOrigins: origins(after.frameOrigins, before.frameOrigins),
    credentialOrigins: origins(after.credentialOrigins, before.credentialOrigins),
    privileged: after.privileged === true && before.privileged !== true,
    skin: after.skin === true && before.skin !== true,
  };
}

export function anyGrants(grants: Grants): boolean {
  return grants.privileged || grants.skin
    || [grants.permissions, grants.httpOrigins, grants.apiPostPaths, grants.frameOrigins, grants.credentialOrigins].some((l) => l.length > 0);
}

/** Both together: what someone saw in two places. */
export function mergeGrants(a: Partial<Grants>, b: Partial<Grants>): Grants {
  const both = (x: unknown, y: unknown) => [...new Set([...strings(x), ...strings(y)])];
  return {
    permissions: both(a.permissions, b.permissions),
    httpOrigins: both(a.httpOrigins, b.httpOrigins),
    apiPostPaths: both(a.apiPostPaths, b.apiPostPaths),
    frameOrigins: both(a.frameOrigins, b.frameOrigins),
    credentialOrigins: both(a.credentialOrigins, b.credentialOrigins),
    privileged: a.privileged === true || b.privileged === true,
    skin: a.skin === true || b.skin === true,
  };
}

/** Only the kinds that hold something, for an audit entry. */
export function compactGrants(grants: Grants): Partial<Grants> {
  return Object.fromEntries(
    Object.entries(grants).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v === true)),
  ) as Partial<Grants>;
}

/**
 * What the admin accepted, from an install request body: `acceptPermissions`
 * (a list of permissions) and `acceptGrants` (an object of the shape above).
 * A list given as anything but a list counts for nothing.
 */
export function acceptedGrants(body: { acceptPermissions?: unknown; acceptGrants?: unknown } | null | undefined): Grants {
  const rest = (body?.acceptGrants && typeof body.acceptGrants === 'object' ? body.acceptGrants : {}) as Partial<Record<keyof Grants, unknown>>;
  return {
    permissions: [...new Set([...strings(body?.acceptPermissions), ...strings(rest.permissions)])],
    httpOrigins: strings(rest.httpOrigins),
    apiPostPaths: strings(rest.apiPostPaths),
    frameOrigins: strings(rest.frameOrigins),
    credentialOrigins: strings(rest.credentialOrigins),
    privileged: rest.privileged === true,
    skin: rest.skin === true,
  };
}

/** The part of `added` the admin has not accepted yet. */
export function notAccepted(added: Grants, accepted: Grants): Grants {
  return grantsAdded(accepted, added);
}

/**
 * One sentence per kind of reach in `added` (not the permissions, which
 * callers name in their own words). `firstInstall`: compared with a listing,
 * not with an installed version.
 */
export function describeReachAdded(added: Grants, firstInstall = false): string[] {
  const now = firstInstall ? '' : ' now';
  const lines: string[] = [];
  if (added.httpOrigins.length > 0) lines.push(`May${now} contact ${added.httpOrigins.join(', ')}.`);
  if (added.apiPostPaths.length > 0) lines.push(`May${now} post to ${added.apiPostPaths.join(', ')} with the user's login.`);
  if (added.frameOrigins.length > 0) lines.push(`May${now} embed ${added.frameOrigins.join(', ')}.`);
  if (added.credentialOrigins.length > 0) lines.push(`May${now} send its credentials to ${added.credentialOrigins.join(', ')}.`);
  if (added.privileged) lines.push('Runs with full access to the app.');
  if (added.skin) lines.push('Brings a skin that restyles every part of the app.');
  return lines;
}
