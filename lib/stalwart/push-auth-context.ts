import { cookies } from 'next/headers';
import { decryptSession, sessionAuthHeader } from '@/lib/auth/crypto';
import { isPastMaxAge, limitsEnforcedSince, maxSessionHoursFor } from '@/lib/auth/session-age';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { readImpersonationConfig } from '@/lib/impersonation/master-config';
import { readStalwartAuthContextFromStore, type StalwartAuthContext } from '@/lib/stalwart/auth-context';

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/**
 * The login for a request from the service worker, which has no page to refresh
 * anything. The context cookie goes with the browser session, so a browser that
 * was closed and woken again by a push only has the remembered one, which a page
 * would turn back into a context on load (GET /api/auth/session, with the same
 * checks). Not signed in with "remember me", or by OAuth with an expired token:
 * none, and the worker shows its generic notification.
 */
export async function readPushAuthContext(cookieStore: CookieStore, slot: number): Promise<StalwartAuthContext | null> {
  const context = readStalwartAuthContextFromStore(cookieStore, slot);
  if (context) return context;
  const token = cookieStore.get(sessionCookieName(slot))?.value;
  if (!token) return null;
  const credentials = decryptSession(token);
  if (!credentials) return null;
  const impersonation = readImpersonationConfig();
  if (impersonation && credentials.password === impersonation.masterPassword) return null;
  const signedInAt = credentials.signedInAt ?? await limitsEnforcedSince();
  const maxHours = await maxSessionHoursFor(credentials.username.split('%', 1)[0]);
  if (isPastMaxAge(signedInAt, maxHours)) return null;
  return { serverUrl: credentials.serverUrl, username: credentials.username, authHeader: sessionAuthHeader(credentials) };
}
