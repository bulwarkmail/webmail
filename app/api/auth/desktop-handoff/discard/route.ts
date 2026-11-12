import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { loggableError } from '@/lib/oauth/answer-summary';
import { revokeParkedTokens } from '@/lib/auth/desktop-handoff-revoke';
import { discardDesktopHandoff, isHandoffCode } from '@/lib/auth/handoff-store';
import { isStoreUnavailable, storeUnavailableResponse } from '@/lib/auth/store-unavailable';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';

// "Not now" on an SSO sign-in the desktop app asked for, or its tab closed. sso/complete
// has to park the tokens before the question can be shown, so this is what ends them: gone
// from the store, and revoked where the provider can. Only the page holding the code knows it.

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const body = await request.json().catch(() => null);
    if (!isHandoffCode(body?.code)) return NextResponse.json({ error: 'invalid_code' }, { status: 400, headers: NO_STORE });
    const parked = await discardDesktopHandoff(body.code);
    if (parked) {
      await revokeParkedTokens(parked);
      logger.info('Desktop hand-off discarded', { flow: parked.flow });
    }
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (isStoreUnavailable(error)) return storeUnavailableResponse(NO_STORE);
    logger.error('Desktop hand-off discard error', { error: loggableError(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE });
  }
}
