import { cookies } from 'next/headers';
import { NextRequest } from 'next/server';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';

export interface StalwartCredentials {
  /** URL of the JMAP server (used for JMAP + management method calls) */
  serverUrl: string;
  authHeader: string;
  username: string;
  hasSessionCookie: boolean;
  slot: number;
}

function parseSlot(raw: string | null): number | null {
  if (raw === null) return null;
  const slot = parseInt(raw, 10);
  return Number.isNaN(slot) || slot < 0 || slot > 4 ? null : slot;
}

function getCandidateSlots(request: NextRequest): number[] {
  const requestedSlot = parseSlot(request.headers.get('X-JMAP-Cookie-Slot'))
    ?? parseSlot(request.nextUrl.searchParams.get('slot'));

  return requestedSlot === null ? [0, 1, 2, 3, 4] : [requestedSlot];
}

export async function getStalwartCredentials(request: NextRequest): Promise<StalwartCredentials | null> {
  const cookieStore = await cookies();

  for (const slot of getCandidateSlots(request)) {
    const context = readStalwartAuthContextFromStore(cookieStore, slot);
    if (!context) continue;

    return {
      serverUrl: context.serverUrl.replace(/\/+$/, ''),
      authHeader: context.authHeader,
      username: context.username,
      hasSessionCookie: !!cookieStore.get(sessionCookieName(slot))?.value,
      slot,
    };
  }

  return null;
}
