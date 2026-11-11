import { cookies } from 'next/headers';
import { configManager } from '@/lib/admin/config-manager';
import { decryptSession, sessionAuthHeader } from '@/lib/auth/crypto';
import { isPastMaxAge, limitsEnforcedSince, maxSessionHoursFor } from '@/lib/auth/session-age';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { readImpersonationConfig } from '@/lib/impersonation/master-config';
import { readCurrentStalwartAuthContext, type StalwartAuthContext } from '@/lib/stalwart/auth-context';

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/** An idle timeout, or a maximum session length by group: limits only a page can apply. */
export async function limitsOnlyAPageEnforces(): Promise<boolean> {
  await configManager.ensureLoaded?.();
  const policy = configManager.getPolicy();
  if ((policy.organisation?.session?.idleMinutes ?? 0) > 0) return true;
  return (policy.scopes ?? []).some((scope) => {
    const session = scope.policy?.organisation?.session;
    if ((session?.idleMinutes ?? 0) > 0) return true;
    return (session?.maxHours ?? 0) > 0 && (scope.match?.groups?.length ?? 0) > 0;
  });
}

/**
 * The login for a request from the service worker, which has no page to refresh
 * anything. The context cookie goes with the browser session, so a browser that
 * was closed and woken again by a push only has the remembered one, which a page
 * would turn back into a context on load (GET /api/auth/session, with the same
 * checks). Not signed in with "remember me", or by OAuth with an expired token:
 * none, and the worker shows its generic notification.
 *
 * A page also applies limits this can't: the idle timeout and maximums by group
 * end the session when it loads. With either set anywhere, a closed browser's
 * notifications stay generic and its buttons open the app.
 */
export async function readPushAuthContext(cookieStore: CookieStore, slot: number): Promise<StalwartAuthContext | null> {
  const context = await readCurrentStalwartAuthContext(cookieStore, slot);
  if (context) return context;
  const token = cookieStore.get(sessionCookieName(slot))?.value;
  if (!token) return null;
  const credentials = decryptSession(token);
  if (!credentials) return null;
  // Without a domain the login can't be matched against the device policy either,
  // and "Push without sender and subject" could miss it (no account name here).
  if (!credentials.username.includes('@')) return null;
  if (await limitsOnlyAPageEnforces()) return null;
  const impersonation = readImpersonationConfig();
  if (impersonation && credentials.password === impersonation.masterPassword) return null;
  const signedInAt = credentials.signedInAt ?? await limitsEnforcedSince();
  const maxHours = await maxSessionHoursFor(credentials.username.split('%', 1)[0]);
  if (isPastMaxAge(signedInAt, maxHours)) return null;
  return { serverUrl: credentials.serverUrl, username: credentials.username, authHeader: sessionAuthHeader(credentials) };
}
