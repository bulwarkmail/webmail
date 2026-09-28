import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { stalwartJmap, requireResult } from '@/lib/stalwart/jmap-passthrough';
import { debug } from '@/lib/debug';
import { fetchConfig } from '@/hooks/use-config';

export const STALWART_JMAP_CAPABILITY = 'urn:stalwart:jmap';

/**
 * Whether the server-side /api/account/stalwart/jmap passthrough is enabled
 * (STALWART_JMAP_PASSTHROUGH_ENABLED, also off when Stalwart features are
 * disabled). Callers skip the passthrough entirely when it is off instead of
 * collecting a 404 on every login. Unknown config counts as enabled. (#904)
 */
export async function isStalwartJmapPassthroughEnabled(): Promise<boolean> {
  try {
    const config = await fetchConfig();
    return config.stalwartFeaturesEnabled !== false && config.stalwartJmapPassthroughEnabled !== false;
  } catch {
    return true;
  }
}

interface AccountSettingsGetResponse {
  list?: Array<{ description?: string | null }>;
}

/**
 * Live "Full name" of the authenticated Stalwart principal (#900).
 *
 * Stalwart seeds the default JMAP Identity's `name` from the principal
 * description only once, when the identity is first created. An admin
 * renaming the user afterwards never propagates to `Identity/get`, so the
 * identity name is a stale snapshot. The current value is the `description`
 * of `x:AccountSettings`, the account's own settings object, read through the
 * server-side passthrough (the browser never holds the credentials).
 * (`x:Account/get` holds it too, but is forbidden for everyone but admins.)
 *
 * `slot` addresses the account's cookie slot explicitly so the lookup works
 * for accounts that are being restored in the background, not just the
 * active one.
 *
 * Returns null when the server is not Stalwart, the call is not permitted
 * for this user, or the principal has no description - callers fall back to
 * the identity name in that case.
 */
export async function fetchPrincipalDisplayName(
  client: IJMAPClient,
  slot?: number,
): Promise<string | null> {
  if (!client.hasAccountCapability?.(STALWART_JMAP_CAPABILITY)) return null;
  if (!(await isStalwartJmapPassthroughEnabled())) return null;

  try {
    const accountId = client.getAccountId();
    const responses = await stalwartJmap(
      [['x:AccountSettings/get', { accountId, ids: ['singleton'] }, '0']],
      { slot },
    );
    const result = requireResult<AccountSettingsGetResponse>(responses, 'x:AccountSettings/get');
    const description = result.list?.[0]?.description;
    const name = typeof description === 'string' ? description.trim() : '';
    return name || null;
  } catch (error) {
    // Not fatal: the cached display name (or the identity name) stays in use.
    debug.warn('auth', 'Failed to read principal display name:', error);
    return null;
  }
}
