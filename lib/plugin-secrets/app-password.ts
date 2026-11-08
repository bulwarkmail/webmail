// The app password the server makes when a user connects a credential that
// declares `appPassword`: on the mail server the user is signed in to, made
// with their own session and only the permissions the manifest lists, stored
// with the account's login name. The user types nothing, sees it named in
// their security settings, and the secret never reaches the browser.

import { createAppPassword, deleteAppPassword } from '@/lib/impersonation/app-password';
import { logger } from '@/lib/logger';
import { appPasswordPermissions } from '@/lib/plugin-secrets/app-password-permissions';
import { fetchJmapSession } from '@/lib/stalwart/jmap-api';
import type { StalwartCredentials } from '@/lib/stalwart/credentials';

type Session = Pick<StalwartCredentials, 'serverUrl' | 'authHeader' | 'accountName' | 'trusted'>;

export async function makePluginAppPassword(
  session: Session,
  description: string,
  permissions: readonly string[],
): Promise<{ id: string; secret: string; username: string }> {
  // Stalwart takes an app password only together with the account's login
  // name. After an OAuth sign-in that is the JMAP session's `username`, which
  // need not be what the sign-in called the user.
  const jmap = await fetchJmapSession(session.serverUrl, session.authHeader, { trusted: session.trusted });
  const login = (jmap as { username?: unknown } | null)?.username;
  const username = typeof login === 'string' && login ? login : session.accountName;
  const created = await createAppPassword({
    serverUrl: session.serverUrl,
    authHeader: session.authHeader,
    description,
    permissions: appPasswordPermissions(permissions),
    trusted: session.trusted,
  });
  return { ...created, username };
}

/** Best effort: one the user deleted already, or a server that is down, only logs. */
export async function revokePluginAppPassword(session: Session, id: string): Promise<void> {
  try {
    await deleteAppPassword({ serverUrl: session.serverUrl, authHeader: session.authHeader, id, trusted: session.trusted });
  } catch (error) {
    logger.warn('Plugin app password was not deleted', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
