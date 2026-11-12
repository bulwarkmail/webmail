import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { decryptSession } from '@/lib/auth/crypto';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { verifyCurrentAdminSession } from '@/lib/admin/session';
import { ADMIN_SESSION_COOKIE } from '@/lib/admin/types';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { readCurrentStalwartAuthContext, rememberedSessionPastMaxAge } from '@/lib/stalwart/auth-context';

/**
 * Whether a request may see details that fingerprint this instance: exact
 * versions, pending security advisories, installed plugins and the hosts
 * they talk to, push relays, sidebar app URLs, memory figures.
 *
 * Yes for anyone signed in here - a mailbox session (the per-slot auth
 * context, or the remembered session cookie before the context is restored
 * on a new browser session) or the admin dashboard, while within the
 * maximum session length. Without a session secret no session can be told
 * apart server-side, so those deployments keep answering everyone as before.
 */
export async function canSeeInstanceDetails(request: NextRequest): Promise<boolean> {
  if (!hasSessionSecret()) return true;
  if (await getStalwartCredentials(request)) return true;

  const jar = await cookies();
  for (let slot = 0; slot < MAX_ACCOUNT_SLOTS; slot++) {
    const session = jar.get(sessionCookieName(slot))?.value;
    const remembered = session ? decryptSession(session) : null;
    if (remembered && !(await rememberedSessionPastMaxAge(remembered))) return true;
  }
  const admin = jar.get(ADMIN_SESSION_COOKIE)?.value;
  return !!admin && (await verifyCurrentAdminSession(admin)) !== null;
}

/**
 * Who the request is signed in as, for answers that depend on the user:
 * `admin` for the admin dashboard, otherwise the addresses of every mailbox
 * session in the browser (each slot's auth context and remembered cookie)
 * that is within the maximum session length. Null when the server can't
 * tell, because there is no session secret.
 */
export async function signedInIdentity(): Promise<{ admin: true } | { admin: false; addresses: string[] } | null> {
  if (!hasSessionSecret()) return null;
  const jar = await cookies();
  const admin = jar.get(ADMIN_SESSION_COOKIE)?.value;
  if (admin && (await verifyCurrentAdminSession(admin)) !== null) return { admin: true };

  const addresses = new Set<string>();
  for (let slot = 0; slot < MAX_ACCOUNT_SLOTS; slot++) {
    const context = await readCurrentStalwartAuthContext(jar, slot);
    if (context) {
      addresses.add(context.username);
      if (context.accountName) addresses.add(context.accountName);
    }
    const session = jar.get(sessionCookieName(slot))?.value;
    const remembered = session ? decryptSession(session) : null;
    if (remembered && !(await rememberedSessionPastMaxAge(remembered))) addresses.add(remembered.username);
  }
  return { admin: false, addresses: [...addresses].map((a) => a.trim().toLowerCase()).filter(Boolean) };
}
