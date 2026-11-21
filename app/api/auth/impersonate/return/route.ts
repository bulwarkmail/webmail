import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { SESSION_COOKIE_MAX_AGE, sessionCookieName } from '@/lib/auth/session-cookie';
import { getCookieOptions, getSignInCookieOptions } from '@/lib/oauth/cookie-config';
import { clearStalwartAuthContextInStore } from '@/lib/stalwart/auth-context';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { isStoreUnavailable, storeUnavailableResponse } from '@/lib/auth/store-unavailable';
import { clearPairReauthInStore } from '@/lib/auth/pair-reauth';
import { revokeWopiTokens } from '@/lib/wopi/revocation';
import { readImpersonationConfig } from '@/lib/impersonation/master-config';
import { IMPERSONATION_MARKER_COOKIE } from '@/lib/impersonation/marker-cookie';
import { revokeImpersonationGrant } from '@/lib/impersonation/revoke-grant';
import {
  IMPERSONATION_RESTORE_COOKIE,
  MAX_RESTORE_REGISTRY_BYTES,
  activeImpersonationGrant,
  attachRestoreRegistry,
  peekRestore,
  takeRestore,
} from '@/lib/impersonation/restore';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };

/**
 * "Return to my account" after an impersonation handoff (#1538). The
 * session to return to is parked by GET /api/auth/impersonate; see
 * lib/impersonation/restore.ts for how it is held and bound.
 *
 * GET: whether this browser can return, for the banner's button.
 * PUT: the page attaches the account list it had before the handoff, once.
 * POST: end the impersonation like signing out does, put the parked session
 * back and hand the account list back to the page.
 *
 * 404 when impersonation is not configured, like the handoff route.
 */
function notConfigured(): NextResponse | null {
  return readImpersonationConfig() ? null : new NextResponse('Not found', { status: 404 });
}

export async function GET() {
  const missing = notConfigured();
  if (missing) return missing;
  try {
    const record = await peekRestore(await cookies());
    return NextResponse.json({ available: !!record }, { headers: NO_STORE });
  } catch (error) {
    if (isStoreUnavailable(error)) return NextResponse.json({ available: false }, { headers: NO_STORE });
    throw error;
  }
}

/** The account list as the page persisted it: an object with an `accounts` array. */
function isRegistry(value: unknown): value is { accounts: unknown[] } {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray((value as { accounts?: unknown }).accounts);
}

export async function PUT(request: NextRequest) {
  const missing = notConfigured();
  if (missing) return missing;
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  if (Number(request.headers.get('content-length') ?? 0) > MAX_RESTORE_REGISTRY_BYTES) {
    return NextResponse.json({ error: 'Too large' }, { status: 413 });
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_RESTORE_REGISTRY_BYTES) {
    return NextResponse.json({ error: 'Too large' }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  if (!isRegistry(body)) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  try {
    const outcome = await attachRestoreRegistry(await cookies(), body);
    if (outcome === 'attached') return NextResponse.json({ ok: true });
    return NextResponse.json({ error: outcome === 'taken' ? 'Already attached' : 'No restore' }, { status: outcome === 'taken' ? 409 : 404 });
  } catch (error) {
    if (isStoreUnavailable(error)) return storeUnavailableResponse();
    throw error;
  }
}

export async function POST(request: NextRequest) {
  const missing = notConfigured();
  if (missing) return missing;
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;

  const cookieStore = await cookies();
  const grant = activeImpersonationGrant(cookieStore);
  let record;
  try {
    record = await takeRestore(cookieStore);
  } catch (error) {
    if (isStoreUnavailable(error)) return storeUnavailableResponse();
    throw error;
  }
  // Spent either way: a handle that did not open is no use any more.
  cookieStore.delete(IMPERSONATION_RESTORE_COOKIE);
  if (!record || !grant) {
    return NextResponse.json({ error: 'Nothing to return to' }, { status: 410, headers: NO_STORE });
  }

  // End the target session the way signing out of slot 0 does.
  await revokeWopiTokens(cookieStore, 0);
  cookieStore.delete(sessionCookieName(0));
  clearStalwartAuthContextInStore(cookieStore, 0);
  await revokeImpersonationGrant(cookieStore);
  await clearPairReauthInStore(cookieStore, 0);
  cookieStore.delete(IMPERSONATION_MARKER_COOKIE);

  // The parked cookie is the one POST /api/auth/session wrote, sealed as it
  // was: it goes back with the lifetime that sign-in asked for (30 days, or
  // until the browser closes), and the session's own sign-in time still
  // counts for the maximum session length.
  if (record.session) {
    cookieStore.set(
      sessionCookieName(0),
      record.session,
      record.remembered === true ? { ...getCookieOptions(), maxAge: SESSION_COOKIE_MAX_AGE } : getSignInCookieOptions(false),
    );
  }

  logger.info('Impersonation ended by returning to the own account', {
    event: 'impersonation_returned',
    mailbox: grant.mailbox,
    credential_id: grant.credentialId,
  });

  return NextResponse.json({ ok: true, registry: record.registry ?? null }, { headers: NO_STORE });
}
