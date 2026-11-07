import type { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { revokeImpersonationCredential } from './app-password';
import { IMPERSONATION_GRANT_COOKIE, openImpersonationGrant } from './grant-cookie';
import { readImpersonationConfig } from './master-config';

/**
 * Forget the impersonation grant cookie and delete the app password it
 * names, so ending an impersonation (sign-out, or returning to one's own
 * account) does not leave that password valid until it expires.
 */
export async function revokeImpersonationGrant(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
): Promise<void> {
  const grant = openImpersonationGrant(cookieStore.get(IMPERSONATION_GRANT_COOKIE)?.value);
  cookieStore.delete(IMPERSONATION_GRANT_COOKIE);
  const config = readImpersonationConfig();
  if (!grant || !config) return;
  try {
    await revokeImpersonationCredential({
      serverUrl: grant.serverUrl,
      mailbox: grant.mailbox,
      masterUser: config.masterUser,
      masterPassword: config.masterPassword,
      id: grant.credentialId,
    });
  } catch (error) {
    // The app password still expires on its own; ending the session must not fail.
    logger.warn('Impersonation credential revocation failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
