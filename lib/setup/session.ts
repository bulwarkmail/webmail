import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { verifySetupToken } from './token';
import { isHttpsRequest } from '@/lib/security/request-protocol';

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

export function buildSessionCookieAttributes(request?: NextRequest) {
  // Match Secure to the actual request protocol. Browsers drop Secure cookies
  // on plain HTTP, so unconditionally setting Secure in production breaks
  // setup over HTTP - the operator gets "Wizard session required" on every
  // step. The wizard surfaces a cleartext-credentials warning in the UI when
  // HTTPS isn't in use.
  return {
    name: SETUP_COOKIE,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: request ? isHttpsRequest(request) : process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  };
}
