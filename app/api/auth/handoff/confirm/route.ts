import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { confirmHandoff, isHandoffCode } from '@/lib/auth/handoff-store';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { isStoreUnavailable, storeUnavailableResponse } from '@/lib/auth/store-unavailable';

// The SSO callback page calls this when the user confirms the hand-off to the
// mobile app, right before it opens the app's link. /api/auth/sso/complete
// parked the tokens before the confirmation was on screen; the code becomes
// redeemable from here, for 60 seconds (lib/auth/handoff-store.ts). Nothing
// secret comes back, and confirming a code only lets the holder of its
// verifier redeem it.

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const body = await request.json().catch(() => null);
    const code = body?.code;
    if (!isHandoffCode(code) || !(await confirmHandoff(code))) {
      return NextResponse.json({ error: 'invalid_code' }, { status: 400, headers: NO_STORE });
    }
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (isStoreUnavailable(error)) return storeUnavailableResponse(NO_STORE);
    logger.error('Mobile hand-off confirm error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE });
  }
}
