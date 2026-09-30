import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { redeemPairingCode } from '@/lib/auth/pairing-store';
import { PAIR_TOKEN_PROXY_PATH, buildRedeemBundle } from '@/lib/auth/pair-bundle';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';

// Phone side of "Link mobile app". The app POSTs the code it scanned and gets
// the sign-in the desktop's step-up minted for it (see /api/auth/pair/create):
// an OAuth bundle, or for servers without OAuth login a username + (app)
// password. The code is the only credential required - it carries 256 bits,
// works once and expires within two minutes - so this route is intentionally
// unauthenticated (the scanning device has no webmail cookies).
//
// Failures say what happened, so the app can tell the user what to do:
// 400 invalid_code (never issued), 410 expired_code, 410 used_code.

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: NextRequest) {
  // CSRF gate (GHSA-qvr9-m8cq-7wvg): cookies written here are SameSite=Lax,
  // so a cross-site top-level POST would otherwise reach this handler.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const body = await request.json().catch(() => ({}));
    const pairingCode = body?.pairing_code;
    if (typeof pairingCode !== 'string' || !/^[0-9a-f]{64}$/.test(pairingCode)) {
      return NextResponse.json({ error: 'invalid_code' }, { status: 400, headers: NO_STORE });
    }

    const result = redeemPairingCode(pairingCode);
    if (!result.ok) {
      const status = result.reason === 'invalid' ? 400 : 410;
      return NextResponse.json({ error: `${result.reason}_code` }, { status, headers: NO_STORE });
    }

    const bundle = buildRedeemBundle(result.grant, result.webmailBase);
    logger.info('Pair code redeemed', {
      flow: bundle.flow,
      proxied: bundle.flow === 'oauth' && bundle.token_endpoint.endsWith(PAIR_TOKEN_PROXY_PATH),
    });
    return NextResponse.json(bundle, { headers: NO_STORE });
  } catch (error) {
    logger.error('Pair redeem error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE });
  }
}
