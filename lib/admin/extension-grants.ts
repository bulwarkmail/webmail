/**
 * What an admin approves when a plugin is saved, and what a version adds to
 * what was approved before.
 *
 * Every path that saves a plugin compares what the bundle grants with what
 * the admin was shown or already approved: a marketplace install with the
 * directory's listing (what the quick-install dialog shows), an update with
 * the installed version. Anything beyond it is answered with 409 and saved
 * only once the admin accepted it (`acceptPermissions` in the request).
 *
 * No server imports: the admin pages read the same shapes.
 */

import { IMPLICIT_PERMISSIONS } from '@/lib/plugin-types';

/** What a plugin is granted, or what the admin was shown or approved. */
export interface Grants {
  permissions: string[];
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string'))] : [];

/** The grants of a validated manifest or a registry entry. */
export function grantsOf(entry: { permissions?: unknown } | null | undefined): Grants {
  return { permissions: strings(entry?.permissions) };
}

/**
 * What `after` grants beyond `before`. Implicit permissions every plugin
 * holds are never an addition.
 */
export function grantsAdded(before: Partial<Grants>, after: Partial<Grants>): Grants {
  const held = new Set<string>([...strings(before.permissions), ...IMPLICIT_PERMISSIONS]);
  return { permissions: strings(after.permissions).filter((p) => !held.has(p)) };
}

export function anyGrants(grants: Grants): boolean {
  return grants.permissions.length > 0;
}

/** What the admin accepted, from an install request body. A list given as a string counts for nothing. */
export function acceptedGrants(body: { acceptPermissions?: unknown } | null | undefined): Grants {
  return { permissions: strings(body?.acceptPermissions) };
}

/** The part of `added` the admin has not accepted yet. */
export function notAccepted(added: Grants, accepted: Grants): Grants {
  return grantsAdded(accepted, added);
}
