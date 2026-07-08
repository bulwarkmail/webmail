// Single source of truth for which execution tier a plugin runs in.
//
// The decision is security-critical: granting 'privileged' creates a
// same-origin iframe (full WebCrypto + IndexedDB + access to the host origin),
// so it must NEVER be granted to an unsigned or unapproved bundle. This helper
// is called by BOTH the loader (load gate, before the same-origin iframe is
// created) and the plugin store (enable gate), so the rules live in one place.
//
// A plugin that *requests* privileged but fails any gate is REFUSED (returns
// `{ tier: null, error }`), never silently downgraded — a crypto plugin cannot
// run in a null-origin sandbox, and a silent downgrade would mask tampering.

import type { InstalledPlugin, PluginTier } from '../plugin-types';

export type TierResolution =
  | { tier: PluginTier; error?: undefined }
  | { tier: null; error: string };

/**
 * Resolves the execution tier for a plugin. Returns `{ tier }` on success or
 * `{ tier: null, error }` when a requested tier cannot be granted (the caller
 * should put the plugin into an error state and NOT create an iframe).
 *
 * Privileged tier gates (ALL required):
 *  1. Manifest declares the umbrella high-risk permission `crypto:full`.
 *  2. Signed bundle: only bundles delivered through the admin/server channel
 *     are Ed25519-signed (verified at download time — see `verifySignature`
 *     usage in the plugin store). Self-uploaded bundles are unsigned and can
 *     therefore never reach the privileged tier. `managed` is the signal that
 *     the bundle came through that signed channel.
 *  3. Admin approval pins operator trust in this specific bundle.
 *  4. Explicit high-risk consent for `crypto:full` (granted via the consent
 *     dialog at enable time; admin-managed plugins are pre-approved).
 */
export function resolvePluginTier(plugin: InstalledPlugin): TierResolution {
  if (plugin.tier !== 'privileged') {
    return { tier: 'untrusted' };
  }

  // 1. Must declare the umbrella high-risk permission.
  if (!plugin.permissions.includes('crypto:full')) {
    return { tier: null, error: 'Privileged tier requires the "crypto:full" permission' };
  }

  // 2 + 3. Trust root: signed (managed) bundle AND admin approval. A bundle
  // uploaded by the user directly carries no signature, so it cannot be
  // privileged regardless of what its manifest claims.
  if (!plugin.managed) {
    return { tier: null, error: 'Privileged tier requires a signed bundle delivered through the admin channel' };
  }
  if (!(plugin.adminApproved || plugin.managed)) {
    return { tier: null, error: 'Privileged tier requires administrator approval' };
  }

  // 4. Explicit high-risk consent. Admin-managed plugins are pre-approved by
  // the operator and skip the per-user prompt (mirrors the existing consent
  // gate in the plugin store); otherwise the user must have granted crypto:full.
  const consented = plugin.managed || (plugin.grantedPermissions ?? []).includes('crypto:full');
  if (!consented) {
    return { tier: null, error: 'Privileged tier requires explicit consent for "crypto:full"' };
  }

  return { tier: 'privileged' };
}
