import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { verifySetupToken } from './token';
import { isStoreUnavailableError } from '@/lib/shared-store';
import { secureCookieFlag } from '@/lib/security/request-protocol';

export const SETUP_COOKIE = 'bulwark_setup_token';
const COOKIE_MAX_AGE = 60 * 60; // 1 hour, matches token TTL

/**
 * The wizard "session" is just the setup token itself, set as an HttpOnly
 * cookie after the operator pastes it into step 1. Subsequent step calls
 * re-verify the cookie value against the .setup-token file. When the wizard
 * finishes, the token file is deleted and any cookies become useless.
 *
 * No JWT, no separate signing key, no rotating session id. The lifecycle of
 * the wizard maps 1:1 to the lifecycle of the token file.
 */

export async function authenticateWizardRequest(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(SETUP_COOKIE)?.value;
  if (!token) return false;
  return verifySetupToken(token);
}

/** 503 for a setup request while the shared store, which holds the token, can't be reached (#1066). */
export function setupStoreUnavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Setup is temporarily unavailable: the shared store can\'t be reached. Try again in a moment.' },
    { status: 503, headers: { 'Retry-After': '10' } },
  );
}

/**
 * The answer for a wizard request without a valid wizard session (401), or
 * while the token can't be checked (503); null when it may go on.
 */
export async function wizardSessionRefusal(): Promise<NextResponse | null> {
  try {
    if (await authenticateWizardRequest()) return null;
  } catch (error) {
    if (isStoreUnavailableError(error)) return setupStoreUnavailableResponse();
    throw error;
  }
  return NextResponse.json({ error: 'Wizard session required' }, { status: 401 });
}

export function buildSessionCookieAttributes(request?: NextRequest) {
  // Match Secure to the actual request protocol. Browsers drop Secure cookies
  // on plain HTTP, so unconditionally setting Secure in production breaks
  // setup over HTTP - the operator gets "Wizard session required" on every
  // step. The wizard surfaces a cleartext-credentials warning in the UI when
  // HTTPS isn't in use. COOKIE_SECURE wins, as for the admin cookie.
  return {
    name: SETUP_COOKIE,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: secureCookieFlag(request),
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  };
}
