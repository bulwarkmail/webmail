import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { decryptSession } from '@/lib/auth/crypto';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { verifyAdminSession } from '@/lib/admin/session';
import { ADMIN_SESSION_COOKIE } from '@/lib/admin/types';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';

/**
 * Whether a request may see details that fingerprint this instance: exact
 * versions, pending security advisories, installed plugins and the hosts
 * they talk to, push relays, sidebar app URLs, memory figures.
 *
 * Yes for anyone signed in here - a mailbox session (the per-slot auth
 * context, or the remembered session cookie before the context is restored
 * on a new browser session) or the admin dashboard. Without a session
 * secret no session can be told apart server-side, so those deployments
 * keep answering everyone as before.
 */
export async function canSeeInstanceDetails(request: NextRequest): Promise<boolean> {
  if (!hasSessionSecret()) return true;
  if (await getStalwartCredentials(request)) return true;

  const jar = await cookies();
  for (let slot = 0; slot < MAX_ACCOUNT_SLOTS; slot++) {
    const session = jar.get(sessionCookieName(slot))?.value;
    if (session && decryptSession(session)) return true;
  }
  const admin = jar.get(ADMIN_SESSION_COOKIE)?.value;
  return !!admin && verifyAdminSession(admin) !== null;
}
