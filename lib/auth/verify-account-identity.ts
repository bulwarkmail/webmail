import { cookies } from 'next/headers';
import { decryptSession } from '@/lib/auth/crypto';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';

/** Strip trailing slashes so differently-formatted URLs still match. */
export function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Verify identity against session cookies across all account slots.
 * With multi-account, the requesting account may be on any slot.
 * Checks both basic-auth session cookies and stalwart auth context cookies
 * (used by OAuth/SSO and TOTP-upgraded sessions).
 * Returns true only if a matching cookie is found.
 */
export async function verifyAccountIdentity(
  username: string,
  serverUrl: string,
): Promise<boolean> {
  const cookieStore = await cookies();
  const normalizedServerUrl = normalizeServerUrl(serverUrl);

  for (let slot = 0; slot < MAX_ACCOUNT_SLOTS; slot++) {
    const token = cookieStore.get(sessionCookieName(slot))?.value;
    if (token) {
      const session = decryptSession(token);
      if (
        session &&
        session.username === username &&
        normalizeServerUrl(session.serverUrl) === normalizedServerUrl
      ) {
        return true;
      }
    }

    const ctx = readStalwartAuthContextFromStore(cookieStore, slot);
    if (
      ctx &&
      ctx.username === username &&
      normalizeServerUrl(ctx.serverUrl) === normalizedServerUrl
    ) {
      return true;
    }
  }

  return false;
}
