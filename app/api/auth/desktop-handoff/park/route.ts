import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { loggableError } from '@/lib/oauth/answer-summary';
import { configManager } from '@/lib/admin/config-manager';
import { getPasswordLoginScope } from '@/lib/oauth/tokens';
import { loginClientAddress } from '@/lib/auth/client-address';
import { resolveDesktopHandoffServer } from '@/lib/auth/desktop-handoff-server';
import { isHandoffCodeChallenge, reserveDesktopHandoffPark, stashHandoff } from '@/lib/auth/handoff-store';
import { stalwartPasswordLogin } from '@/lib/auth/stalwart-password-login';
import { isStoreUnavailable, storeUnavailableResponse } from '@/lib/auth/store-unavailable';
import { LOGIN_BUDGET_RETRY_AFTER_SECONDS, reserveLoginAttempt } from '@/lib/auth/verify-budget';
import { JmapAuthVerificationError, verifyJmapAuth } from '@/lib/auth/verify-jmap-auth';
import { DEFAULT_CLIENT_ID } from '@/lib/oauth/token-exchange';
import { readFileEnv } from '@/lib/read-file-env';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';

// The desktop app's "Sign in with your browser", on the browser's side, after the user
// said yes. /check tested the password; until now it has only been in the page. It goes
// no further than it has to: Stalwart's login turns it into tokens, and those are what's
// parked. A password is parked only for a server with no such login, for 60 seconds, for
// whoever holds the verifier. Nothing here writes a cookie, so this browser gets no session.
//
// A two-factor code works once, so it's only spent here, after the yes. Tokens minted here
// are never dropped for budget reasons: the budget is reserved first, and a success gives
// it back, so an office behind one address can sign in as often as it likes.

const NO_STORE = { 'Cache-Control': 'no-store' };

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function answer(error: string, status: number, headers: Record<string, string> = NO_STORE) {
  return NextResponse.json({ error }, { status, headers });
}

const tooMany = () => answer('too_many_attempts', 429, { ...NO_STORE, 'Retry-After': String(LOGIN_BUDGET_RETRY_AFTER_SECONDS) });

export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const body = await request.json().catch(() => null);
    const challenge = body?.code_challenge;
    const state = typeof body?.state === 'string' ? body.state : '';
    const totp = typeof body?.totp === 'string' && body.totp ? body.totp : undefined;
    if (
      !isHandoffCodeChallenge(challenge)
      || !state
      || state.length > 512
      || !bounded(body?.server_url, 2048)
      || !bounded(body?.username, 512)
      || !bounded(body?.password, 4096)
      || (totp !== undefined && totp.length > 16)
    ) {
      return answer('invalid_request', 400);
    }

    const server = await resolveDesktopHandoffServer(body.server_url, body.server_id);
    if ('refusal' in server) return answer(server.refusal.error, server.refusal.status);
    const { entry, resolved, upstream, trusted, custom } = server;

    const clientIp = loginClientAddress(request, upstream);
    // Before anything goes upstream, so a code is never spent on a sign-in that can't finish.
    const refundPark = await reserveDesktopHandoffPark(clientIp);
    if (!refundPark) return tooMany();
    const refundLogin = await reserveLoginAttempt(clientIp);
    if (!refundLogin) return tooMany();

    const configuredClientId =
      entry?.oauth?.clientId || configManager.get<string>('oauthClientId', '') || process.env.OAUTH_CLIENT_ID;
    const clientSecret =
      entry?.oauth?.clientSecret
      || configManager.get<string>('oauthClientSecret', '')
      || process.env.OAUTH_CLIENT_SECRET
      || readFileEnv(process.env.OAUTH_CLIENT_SECRET_FILE)
      || '';
    const redirectUri = typeof body?.redirect_uri === 'string' && /^https?:\/\//.test(body.redirect_uri) ? body.redirect_uri : upstream;
    const login = await stalwartPasswordLogin({
      serverUrl: upstream,
      username: body.username,
      password: body.password,
      totp,
      clientId: configuredClientId || DEFAULT_CLIENT_ID,
      clientSecret,
      redirectUri,
      trusted,
      clientIp,
      registerUnknownClient: !configuredClientId,
      scope: configuredClientId ? getPasswordLoginScope() : undefined,
    });

    let parked: Parameters<typeof stashHandoff>[0];
    if (login.ok) {
      parked = {
        flow: 'desktop-tokens',
        server_url: resolved,
        server_id: entry?.id ?? null,
        custom,
        password_login: true,
        username: body.username,
        access_token: login.tokens.access_token,
        refresh_token: login.tokens.refresh_token,
        expires_in: login.tokens.expires_in ?? 3600,
        signed_in_at: Date.now(),
      };
      await refundLogin();
    } else if (login.error === 'invalid_credentials') {
      return answer('invalid_credentials', 401);
    } else if (login.error === 'totp_required') {
      await refundLogin();
      return answer('totp_required', 401);
    } else if (totp) {
      await refundLogin();
      return answer('login_failed', 502);
    } else {
      // The last resort: a server with no token login, or one that won't give this client any.
      try {
        await verifyJmapAuth(upstream, `Basic ${Buffer.from(`${body.username}:${body.password}`).toString('base64')}`, { trusted, clientIp });
        await refundLogin();
      } catch (error) {
        const status = error instanceof JmapAuthVerificationError ? error.upstreamStatus : undefined;
        if (status === 401) return answer('invalid_credentials', 401);
        await refundLogin();
        return status === 402 ? answer('totp_required', 401) : answer('login_failed', 502);
      }
      parked = { flow: 'desktop-password', server_url: resolved, server_id: entry?.id ?? null, custom, username: body.username, password: body.password };
    }

    const code = await stashHandoff(parked, { challenge, state });
    await refundPark();
    logger.info('Desktop hand-off parked', { flow: parked.flow });
    return NextResponse.json({ code }, { headers: NO_STORE });
  } catch (error) {
    if (isStoreUnavailable(error)) return storeUnavailableResponse(NO_STORE);
    logger.error('Desktop hand-off park error', { error: loggableError(error) });
    return answer('Internal server error', 500);
  }
}
