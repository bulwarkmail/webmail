// How permissions are shown to people: the consent dialog and the plugin list
// in Settings. The text itself lives in the locale files under
// `plugins.permissions.<key>.{title,body}`.

import { ALL_PERMISSIONS, IMPLICIT_PERMISSIONS } from '../plugin-types';

/**
 * Permissions that let a plugin read or send mail content, change what is
 * sent or shown, run with full access, or move data off the device. The
 * consent dialog lists them first and marks them.
 */
export const HIGH_RISK_PERMISSIONS: ReadonlySet<string> = new Set([
  'crypto:full',
  // Signs and decrypts in the user's name with their certificates.
  'keystore',
  // email.get reads any message in the account, not only the open one.
  'email:read',
  'email:send',
  'email:raw-send',
  // Sends mail in the user's name; the host asks once per address.
  'email:forward',
  'email:blob-read',
  'email:blob-write',
  'email:render-takeover',
  'http:fetch',
  'http:post',
  'filters:write',
  'http:proxy',
  // Reads everything the user writes, as they write it, and may send it on.
  'compose:check',
  // A plugin can point the reply-to of a sender address elsewhere, so
  // answers to the user's mail go to someone else.
  'identity:write',
  // The out-of-office reply goes out to everyone who writes, in the user's
  // name, with whatever text the plugin set.
  'vacation:write',
  // Answering an invitation sends a reply to the organiser in the user's name.
  'calendar:respond',
  // Changes how the app behaves for the user (lib/settings-schema.ts).
  'settings:change',
]);

/** Locale key segment for a permission: `email:read` → `email_read`. */
export function permissionKey(perm: string): string {
  return perm.replace(/[:-]/g, '_');
}

/** Permissions worth showing: known, not implicit, high-risk first. */
export function visiblePermissions(perms: readonly string[]): string[] {
  const known = new Set<string>(ALL_PERMISSIONS);
  const implicit = new Set<string>(IMPLICIT_PERMISSIONS);
  return [...new Set(perms)]
    .filter((p) => known.has(p) && !implicit.has(p))
    .sort((a, b) => Number(HIGH_RISK_PERMISSIONS.has(b)) - Number(HIGH_RISK_PERMISSIONS.has(a)));
}
