import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import {
  isHandoffCode,
  isHandoffCodeVerifier,
  redeemHandoff,
  reserveHandoffRedeem,
} from '@/lib/auth/handoff-store';
import type { BudgetRefund } from '@/lib/auth/verify-budget';
import { loginClientAddress } from '@/lib/auth/client-address';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { isStoreUnavailable, storeUnavailableResponse } from '@/lib/auth/store-unavailable';

// The mobile app's side of the browser sign-in hand-off. It POSTs the code
// from its callback link with the PKCE verifier behind the challenge it sent
// to the login page, and gets the sign-in the browser parked for it: the
// same fields older builds read from the link's fragment
// (lib/auth/handoff-store.ts, bulwarkmail.org/docs/development/mobile-handoff).
//
// The code and verifier are the only credentials, so this route is
// unauthenticated (the app has no webmail cookies). Every failure is a 400
// and spends the code: invalid_code (never issued or already used),
// expired_code, invalid_verifier; invalid_request for a malformed body.

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  let refund: BudgetRefund | null = null;
  try {
    refund = await reserveHandoffRedeem(loginClientAddress(request));
    if (!refund) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: NO_STORE });
    }

    const body = await request.json().catch(() => null);
    const code = body?.code;
    const verifier = body?.code_verifier;
    if (!isHandoffCode(code)) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers: NO_STORE });
    }
    if (!isHandoffCodeVerifier(verifier)) {
      // Still spend the code: a malformed verifier is a wrong one.
      await redeemHandoff(code, '');
      return NextResponse.json({ error: 'invalid_verifier' }, { status: 400, headers: NO_STORE });
    }

    const result = await redeemHandoff(code, verifier);
    if (!result.ok) {
      const error = result.reason === 'verifier_mismatch' ? 'invalid_verifier' : `${result.reason}_code`;
      logger.warn('Mobile hand-off redeem refused', { reason: result.reason });
      return NextResponse.json({ error }, { status: 400, headers: NO_STORE });
    }

    await refund();
    logger.info('Mobile hand-off redeemed', { flow: result.bundle.flow });
    return NextResponse.json({ ...result.bundle, state: result.state }, { headers: NO_STORE });
  } catch (error) {
    if (isStoreUnavailable(error)) {
      // Nothing was redeemed: the attempt doesn't count.
      if (refund) await refund();
      return storeUnavailableResponse(NO_STORE);
    }
    logger.error('Mobile hand-off redeem error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE });
  }
}
