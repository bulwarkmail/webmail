import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { encryptSession } from '@/lib/auth/crypto';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { normalizeJmapServerUrl } from '@/lib/auth/verify-jmap-auth';
import { setStalwartAuthContextInStore } from '@/lib/stalwart/auth-context';
import { recordLogin } from '@/lib/telemetry/login-tracker';
import { ImpersonationJwtError, verifyImpersonationJwt } from '@/lib/impersonation/jwt';
import { consumeImpersonationJti } from '@/lib/impersonation/replay-store';
import {
  readImpersonationConfig,
  resolveImpersonationServerUrl,
} from '@/lib/impersonation/master-config';
import { mintImpersonationCredential } from '@/lib/impersonation/app-password';
import { IMPERSONATION_GRANT_COOKIE, sealImpersonationGrant } from '@/lib/impersonation/grant-cookie';

export const runtime = 'nodejs';

const IMPERSONATION_SLOT = 0;

/**
 * Impersonation cookies deliberately omit Max-Age so the browser treats
 * them as session cookies - the impersonated session ends when the user
 * closes the browser, not 30 days later. Impersonation is a temporary
 * support handoff; a normal password login is the only thing that should
 * survive a browser restart.
 */
function impersonationCookieOptions() {
  const { maxAge: _maxAge, ...rest } = getCookieOptions();
  return rest;
}

/**
 * GET /api/auth/impersonate?token=<jwt>
 *
 * Master-user impersonation via signed JWT. The token carries the target
 * mailbox; Bulwark verifies the signature, resolves the configured Stalwart
 * master credentials from env, then mints the same session cookies the
 * password-login path produces. The browser is redirected to "/?impersonated=1" (see
 * ImpersonationReconciler, GH #646) and the SPA hydrates as if the user had
 * just logged in to the target mailbox.
 *
 * The master credential is used here, server-side, only to create an
 * expiring app password on the target mailbox. The session cookies carry
 * that app password: the browser reads its session back through
 * PUT /api/auth/session, and the master password would open every mailbox.
 *
 * Returns 404 when the feature is not configured so an unconfigured
 * deployment does not advertise the endpoint.
 */
export async function GET(request: NextRequest) {
  const config = readImpersonationConfig();
  if (!config) {
    // Not configured - behave exactly like an unknown route.
    return new NextResponse('Not found', { status: 404 });
  }

  const token = request.nextUrl.searchParams.get('token');
  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 });
  }

  let claims;
  try {
    claims = verifyImpersonationJwt(token, config.jwtSecret, {
      expectedIssuer: config.expectedIssuer,
    });
  } catch (err) {
    if (err instanceof ImpersonationJwtError) {
      logger.warn('Impersonation JWT rejected', { code: err.code });
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error('Impersonation JWT error', {
      error: err instanceof Error ? err.message : 'Unknown',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  if (!(await consumeImpersonationJti(claims.jti, claims.exp))) {
    logger.warn('Impersonation JWT replay rejected', { jti: claims.jti });
    return NextResponse.json({ error: 'Token already used' }, { status: 401 });
  }

  const serverUrl = await resolveImpersonationServerUrl();
  if (!serverUrl) {
    logger.error('Impersonation requested but jmapServerUrl is not configured');
    return NextResponse.json({ error: 'JMAP server not configured' }, { status: 500 });
  }

  let normalizedServerUrl: string;
  try {
    normalizedServerUrl = normalizeJmapServerUrl(serverUrl);
  } catch {
    return NextResponse.json({ error: 'Invalid JMAP server URL' }, { status: 500 });
  }

  // Stalwart master-user login ("<target>%<master>", master password) opens
  // the target mailbox; use it once to mint the target's own app password.
  //   https://stalw.art/docs/auth/authorization/administrator/
  let credential;
  try {
    credential = await mintImpersonationCredential({
      serverUrl: normalizedServerUrl,
      mailbox: claims.mailbox,
      masterUser: config.masterUser,
      masterPassword: config.masterPassword,
      description: `Support session ${claims.jti}`.slice(0, 100),
    });
  } catch (err) {
    logger.error('Impersonation credential could not be created', {
      jti: claims.jti,
      mailbox: claims.mailbox,
      error: err instanceof Error ? err.message : 'Unknown',
    });
    return NextResponse.json({ error: 'Could not open the mailbox' }, { status: 502 });
  }

  const cookieStore = await cookies();
  const sessionToken = encryptSession(normalizedServerUrl, claims.mailbox, credential.secret);
  cookieStore.set(sessionCookieName(IMPERSONATION_SLOT), sessionToken, impersonationCookieOptions());
  setStalwartAuthContextInStore(cookieStore, IMPERSONATION_SLOT, {
    serverUrl: normalizedServerUrl,
    username: claims.mailbox,
    authHeader: `Basic ${Buffer.from(`${claims.mailbox}:${credential.secret}`).toString('base64')}`,
  });
  cookieStore.set(
    IMPERSONATION_GRANT_COOKIE,
    sealImpersonationGrant({
      serverUrl: normalizedServerUrl,
      mailbox: claims.mailbox,
      credentialId: credential.id,
    }),
    impersonationCookieOptions(),
  );

  // Structured audit log - operators rely on this for security review.
  logger.info('Impersonation session granted', {
    event: 'impersonation_granted',
    jti: claims.jti,
    mailbox: claims.mailbox,
    tenant_id: claims.tenant_id,
    actor_user_id: claims.actor_user_id,
    iss: claims.iss,
    expires_at: credential.expiresAt,
    ip:
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      null,
    referer: request.headers.get('referer'),
    user_agent: request.headers.get('user-agent'),
  });

  void recordLogin(claims.mailbox, normalizedServerUrl);

  // Use a relative Location header so the browser resolves it against the
  // public request URL. NextResponse.redirect(new URL('/', request.url))
  // would absolutise to the container's internal bind (http://0.0.0.0:3000)
  // when running behind a reverse proxy that doesn't set X-Forwarded-Host.
  return new NextResponse(null, {
    status: 303,
    headers: { Location: '/?impersonated=1' },
  });
}
