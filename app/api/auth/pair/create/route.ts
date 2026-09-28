import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { createPairingCode, isGrantAvailable, stashGrant } from '@/lib/auth/pairing-store';
import { pairingOwner, readPairReauthFromStore, setPairReauthInStore } from '@/lib/auth/pair-reauth';
import { mintGrantWithPassword } from '@/lib/auth/pair-grant';
import { appAcceptsServerUrl } from '@/lib/auth/pair-bundle';
import { beginPairStepUp, pairAttemptKey, settlePairStepUp } from '@/lib/auth/pair-attempts';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';
import { isTrustedJmapServerUrl } from '@/lib/stalwart/server-fetch';
import { configManager } from '@/lib/admin/config-manager';
import { findServerByUrl, parseJmapServers } from '@/lib/admin/jmap-servers';
import { IMPERSONATION_GRANT_COOKIE, openImpersonationGrant } from '@/lib/impersonation/grant-cookie';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';

// Desktop side of "Link mobile app". Returns a one-time pairing code for the
// QR; the phone redeems it at /api/auth/pair/redeem.
//
// Linking provisions a new long-lived login on another device, so it needs a
// step-up first, and the step-up itself produces what the phone receives:
// - with `password` (and `totp`): the current password is checked against
//   the mail server and used once to mint the phone's own sign-in (see
//   lib/auth/pair-grant.ts);
// - after a fresh IdP login (/api/auth/sso/start purpose=reauth, completed by
//   /api/auth/reauth/sso/complete): that login's own tokens.
// Either way the phone never shares the desktop's session, so signing out
// here does not sign the phone out. Within the step-up window a new code can
// be shown without asking again, until one of them is redeemed.
//
// The account is the slot's verified session context: its server URL and user
// never come from the request body.

function parseSlot(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < MAX_ACCOUNT_SLOTS ? raw : 0;
}

/**
 * The webmail's public base (origin + mount path) the desktop shows in the
 * QR. Only accepted for the origin this request came from; the phone sends
 * its refresh requests there when it needs the token proxy.
 */
function resolveWebmailBase(raw: unknown, request: NextRequest): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const origin = request.headers.get('origin');
  if (origin) {
    if (url.origin !== origin) return null;
  } else {
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
    if (!host || url.host !== host) return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The desktop's OAuth callback, for servers that insist on a registered redirect. */
function resolveRedirectUri(raw: unknown, webmailBase: string): string | undefined {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return undefined;
  try {
    const url = new URL(raw);
    if (url.origin !== new URL(webmailBase).origin || url.search || url.hash) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

const STEP_UP_ERRORS = {
  invalid_credentials: 401,
  totp_required: 401,
  server_unreachable: 502,
  pairing_unavailable: 502,
} as const;

export async function POST(request: NextRequest) {
  // CSRF gate (GHSA-qvr9-m8cq-7wvg): cookies written here are SameSite=Lax,
  // so a cross-site top-level POST would otherwise reach this handler.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    // The step-up proof, the session context and the phone's sealed refresh
    // token are all encrypted under SESSION_SECRET.
    if (!hasSessionSecret()) {
      return NextResponse.json({ error: 'session_secret_required' }, { status: 500 });
    }

    const body = await request.json().catch(() => ({}));
    const slot = parseSlot(body?.slot);
    const webmailBase = resolveWebmailBase(body?.webmail_base, request);
    if (!webmailBase) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }

    const cookieStore = await cookies();

    // A support session opens the mailbox with a short-lived app password; it
    // must not be able to hand out a lasting login for it.
    if (slot === 0 && openImpersonationGrant(cookieStore.get(IMPERSONATION_GRANT_COOKIE)?.value)) {
      return NextResponse.json({ error: 'impersonation' }, { status: 403 });
    }

    const context = readStalwartAuthContextFromStore(cookieStore, slot);
    if (!context) {
      return NextResponse.json({ error: 'not_signed_in' }, { status: 401 });
    }
    const owner = pairingOwner(slot, context.username);

    // The app refuses a mail server over plain http. Say so here, before a
    // password attempt is spent and before the desktop would report a phone
    // that could never connect as signed in.
    if (!appAcceptsServerUrl(context.serverUrl)) {
      return NextResponse.json({ error: 'insecure_server' }, { status: 400 });
    }

    let grantId: string;
    const password = typeof body?.password === 'string' ? body.password : '';
    if (password) {
      const serverUrl = context.serverUrl.replace(/\/+$/, '');
      // The login name the credential belongs to, when the session context
      // was written under an identity address.
      const accountName = context.accountName ?? context.username;
      const attemptKey = pairAttemptKey(serverUrl, accountName);
      if (!beginPairStepUp(attemptKey)) {
        return NextResponse.json({ error: 'too_many_attempts' }, { status: 429 });
      }
      const totp = typeof body?.totp === 'string' && body.totp.trim() ? body.totp.trim() : undefined;
      await configManager.ensureLoaded();
      const serverId = findServerByUrl(parseJmapServers(configManager.get<unknown>('jmapServers', [])), serverUrl)?.id ?? null;

      const result = await mintGrantWithPassword({
        serverUrl,
        trusted: await isTrustedJmapServerUrl(serverUrl),
        serverId,
        username: accountName,
        password,
        totp,
        webmailRedirectUri: resolveRedirectUri(body?.redirect_uri, webmailBase),
      });
      if (!result.ok) {
        const wrong = result.error === 'invalid_credentials' || (result.error === 'totp_required' && !!totp);
        settlePairStepUp(attemptKey, wrong ? 'wrong_credential' : 'other');
        return NextResponse.json({ error: result.error }, { status: STEP_UP_ERRORS[result.error] });
      }
      settlePairStepUp(attemptKey, 'success');
      grantId = stashGrant(result.grant, owner);
      setPairReauthInStore(cookieStore, { grantId, owner });
      logger.info('Pair step-up succeeded', { flow: result.grant.flow, method: 'password' });
    } else {
      const proof = readPairReauthFromStore(cookieStore);
      if (!proof || proof.owner !== owner || !isGrantAvailable(proof.grantId, owner)) {
        return NextResponse.json({ error: 'reauth_required' }, { status: 401 });
      }
      grantId = proof.grantId;
    }

    const pairing = createPairingCode(grantId, owner, webmailBase);
    if (!pairing) {
      return NextResponse.json({ error: 'reauth_required' }, { status: 401 });
    }

    return NextResponse.json(
      { pairing_code: pairing.code, status_id: pairing.statusId, expires_in: pairing.expiresIn },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    logger.error('Pair create error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
