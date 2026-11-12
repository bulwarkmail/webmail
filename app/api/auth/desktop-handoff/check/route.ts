import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { loggableError } from '@/lib/oauth/answer-summary';
import { resolveDesktopHandoffServer } from '@/lib/auth/desktop-handoff-server';
import { loginClientAddress } from '@/lib/auth/client-address';
import { isStoreUnavailable, storeUnavailableResponse } from '@/lib/auth/store-unavailable';
import { LOGIN_BUDGET_RETRY_AFTER_SECONDS, reserveLoginAttempt } from '@/lib/auth/verify-budget';
import { JmapAuthVerificationError, verifyJmapAuth } from '@/lib/auth/verify-jmap-auth';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';

// The desktop app's sign-in, in the browser, before the question: is this password right?
// So a password manager never saves a wrong one, and the user isn't asked about a sign-in
// that can't work. Nothing is kept: the page holds the password until the user says yes.

const NO_STORE = { 'Cache-Control': 'no-store' };

function answer(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const body = await request.json().catch(() => null);
    const { server_url: serverUrl, username, password } = body ?? {};
    if (
      typeof serverUrl !== 'string' || !serverUrl || serverUrl.length > 2048
      || typeof username !== 'string' || !username || username.length > 512
      || typeof password !== 'string' || !password || password.length > 4096
    ) {
      return answer('invalid_request', 400);
    }
    const server = await resolveDesktopHandoffServer(serverUrl, body?.server_id);
    if ('refusal' in server) return answer(server.refusal.error, server.refusal.status);

    const clientIp = loginClientAddress(request, server.upstream);
    const refund = await reserveLoginAttempt(clientIp);
    if (!refund) {
      return NextResponse.json(
        { error: 'too_many_attempts' },
        { status: 429, headers: { ...NO_STORE, 'Retry-After': String(LOGIN_BUDGET_RETRY_AFTER_SECONDS) } },
      );
    }
    try {
      await verifyJmapAuth(server.upstream, `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`, { trusted: server.trusted, clientIp });
      await refund();
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    } catch (error) {
      const status = error instanceof JmapAuthVerificationError ? error.upstreamStatus : undefined;
      if (status === 401) return answer('invalid_credentials', 401);
      await refund();
      // Stalwart: the right password on an account with a second factor.
      if (status === 402) return answer('totp_required', 401);
      return answer('login_failed', 502);
    }
  } catch (error) {
    if (isStoreUnavailable(error)) return storeUnavailableResponse(NO_STORE);
    logger.error('Desktop hand-off check error', { error: loggableError(error) });
    return answer('Internal server error', 500);
  }
}
