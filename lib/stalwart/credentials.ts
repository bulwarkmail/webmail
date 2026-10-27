import { cookies } from 'next/headers';
import { NextRequest } from 'next/server';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';
import { isTrustedJmapServerUrl } from '@/lib/stalwart/server-fetch';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';

export interface StalwartCredentials {
  /** URL of the JMAP server (used for JMAP + management method calls) */
  serverUrl: string;
  authHeader: string;
  username: string;
  /**
   * The account the sign-in resolved to. Differs from `username` when a token
   * sign-in claimed a bare name; key per-user data on this one.
   */
  accountName: string;
  hasSessionCookie: boolean;
  slot: number;
  /**
   * Whether `serverUrl` matches an admin-configured server. A `false` here
   * means the user picked the URL themselves (`allowCustomJmapEndpoint`), so
   * server-side requests to it must use the rebinding-safe fetch - see
   * `fetchJmapServer` in `@/lib/stalwart/server-fetch`.
   */
  trusted: boolean;
}

function parseSlot(raw: string | null): number | null {
  if (raw === null) return null;
  const slot = parseInt(raw, 10);
  return Number.isNaN(slot) || slot < 0 || slot >= MAX_ACCOUNT_SLOTS ? null : slot;
}

const ALL_SLOTS = Array.from({ length: MAX_ACCOUNT_SLOTS }, (_, i) => i);

function getCandidateSlots(request: NextRequest): number[] {
  const requestedSlot = parseSlot(request.headers.get('X-JMAP-Cookie-Slot'))
    ?? parseSlot(request.nextUrl.searchParams.get('slot'));

  return requestedSlot === null ? ALL_SLOTS : [requestedSlot];
}

export async function getStalwartCredentials(request: NextRequest): Promise<StalwartCredentials | null> {
  const cookieStore = await cookies();

  for (const slot of getCandidateSlots(request)) {
    const context = readStalwartAuthContextFromStore(cookieStore, slot);
    if (!context) continue;

    const serverUrl = context.serverUrl.replace(/\/+$/, '');
    return {
      serverUrl,
      authHeader: context.authHeader,
      username: context.username,
      accountName: context.accountName ?? context.username,
      hasSessionCookie: !!cookieStore.get(sessionCookieName(slot))?.value,
      slot,
      trusted: await isTrustedJmapServerUrl(serverUrl),
    };
  }

  return null;
}
