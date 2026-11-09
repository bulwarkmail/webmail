import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { isHandoffCodeChallenge, reserveHandoffCreate, stashHandoff } from '@/lib/auth/handoff-store';
import { loginClientAddress } from '@/lib/auth/client-address';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { isStoreUnavailable, storeUnavailableResponse } from '@/lib/auth/store-unavailable';

// Password sign-in hand-off to the mobile app, browser side. The login page
// was opened by the app with a `mobile_code_challenge`; after the user signed
// in and confirmed, it parks the sign-in here and opens the app's callback
// link with the returned code instead of the password
// (lib/auth/handoff-store.ts, bulwarkmail.org/docs/development/mobile-handoff).
//
// The page already checked the password against the mail server when it
// signed in, and the old hand-off put whatever the page held into the link
// unchecked too, so nothing is verified again here (a second login would
// spend the account's failed-login allowance and a TOTP code twice). What
// is parked only ever goes to whoever holds the verifier for the challenge.
//
// The SSO hand-off parks its tokens in /api/auth/sso/complete itself; they
// never reach the browser.

const NO_STORE = { 'Cache-Control': 'no-store' };

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const body = await request.json().catch(() => null);
    const challenge = body?.code_challenge;
    const state = typeof body?.state === 'string' ? body.state : '';
    if (
      !isHandoffCodeChallenge(challenge)
      || state.length > 512
      || !boundedString(body?.server_url, 2048)
      || !boundedString(body?.username, 512)
      || !boundedString(body?.password, 4096)
    ) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers: NO_STORE });
    }

    if (!(await reserveHandoffCreate(loginClientAddress(request)))) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: NO_STORE });
    }

    const code = await stashHandoff(
      { flow: 'password', server_url: body.server_url, username: body.username, password: body.password },
      { challenge, state },
    );
    logger.info('Mobile hand-off parked', { flow: 'password' });
    return NextResponse.json({ code }, { headers: NO_STORE });
  } catch (error) {
    if (isStoreUnavailable(error)) return storeUnavailableResponse(NO_STORE);
    logger.error('Mobile hand-off create error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE });
  }
}
