import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { encryptPayload } from '@/lib/auth/crypto';
import { generateCodeVerifierServer, generateCodeChallengeServer, generateStateServer } from '@/lib/oauth/pkce-server';
import { getRequiredConfig } from '@/lib/oauth/token-exchange';
import { discoverOAuth } from '@/lib/oauth/discovery';
import { OAUTH_SCOPES } from '@/lib/oauth/tokens';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { readFileEnv } from '@/lib/read-file-env';

const SSO_PENDING_COOKIE = 'sso_pending';
const SSO_PENDING_MAX_AGE = 300; // 5 minutes

export async function POST(request: NextRequest) {
  try {
    if (!process.env.SESSION_SECRET && !readFileEnv(process.env.SESSION_SECRET_FILE)) {
      return NextResponse.json({ error: 'SESSION_SECRET is required for SSO' }, { status: 500 });
    }

    const { redirect_uri, locale } = await request.json();

    if (!redirect_uri || typeof redirect_uri !== 'string') {
      return NextResponse.json({ error: 'Missing redirect_uri' }, { status: 400 });
    }

    // Validate redirect_uri origin matches the request origin to prevent open redirects
    const requestOrigin = request.headers.get('origin') || request.nextUrl.origin;
    try {
      const redirectOrigin = new URL(redirect_uri).origin;
      if (redirectOrigin !== requestOrigin) {
        logger.warn('SSO start: redirect_uri origin mismatch', { redirectOrigin, requestOrigin });
        return NextResponse.json({ error: 'Invalid redirect_uri' }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: 'Invalid redirect_uri' }, { status: 400 });
    }

    const { clientId, discoveryUrl } = getRequiredConfig();
    const metadata = await discoverOAuth(discoveryUrl);

    if (!metadata?.authorization_endpoint) {
      return NextResponse.json({ error: 'OAuth discovery failed' }, { status: 502 });
    }

    // Generate PKCE + state server-side
    const codeVerifier = generateCodeVerifierServer();
    const codeChallenge = generateCodeChallengeServer(codeVerifier);
    const state = generateStateServer();

    // Encrypt and store in httpOnly cookie
    const pendingData = {
      state,
      code_verifier: codeVerifier,
      redirect_uri,
      created_at: Date.now(),
    };

    const encrypted = encryptPayload(pendingData);
    const cookieStore = await cookies();
    const baseCookieOpts = getCookieOptions();
    cookieStore.set(SSO_PENDING_COOKIE, encrypted, {
      ...baseCookieOpts,
      maxAge: SSO_PENDING_MAX_AGE,
    });

    // Build authorize URL
    const authUrl = new URL(metadata.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirect_uri);
    authUrl.searchParams.set('scope', OAUTH_SCOPES);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    if (locale) {
      authUrl.searchParams.set('ui_locales', locale);
    }

    return NextResponse.json({
      authorize_url: authUrl.toString(),
      state,
    });
  } catch (error) {
    logger.error('SSO start error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
