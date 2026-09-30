import { logger } from '@/lib/logger';
import { stalwartPasswordLogin, type StalwartPasswordLoginResult } from '@/lib/auth/stalwart-password-login';
import { registerGrantDisposer, type PairingGrant } from '@/lib/auth/pairing-store';
import { DEFAULT_CLIENT_ID, getClientSecret, getRequiredConfig } from '@/lib/oauth/token-exchange';
import { JmapAuthVerificationError, verifyJmapIdentity } from '@/lib/auth/verify-jmap-auth';
import { fetchJmapSession } from '@/lib/stalwart/jmap-api';
import { createAppPassword, deleteAppPassword } from '@/lib/impersonation/app-password';

// The password step-up for "Link mobile app": the desktop user types their
// current password (and TOTP code), and the server uses it once to mint the
// phone's own sign-in. The password is never stored, logged or returned -
// except in the last fallback, for servers that offer nothing better.
//
// In order of preference:
//   1. An OAuth grant from Stalwart's structured login (/api/auth, which also
//      takes the TOTP code), for the client the app itself uses natively, so
//      the phone renews it directly. If the server insists on a registered
//      client, the webmail's own client (as the password+TOTP login uses).
//   2. No structured login, but a Stalwart account: an app password the user
//      can see and delete ("Bulwark mobile (paired <date>)").
//   3. Neither (not Stalwart): the verified account password, which is what
//      the login page's mobile handoff has always passed to the app.

/**
 * An app password minted for a phone that never redeemed its code would stay
 * valid (no expiry, full permissions, no TOTP) and use up one of the
 * account's few app-password slots. Delete it, with its own credential,
 * when its grant dies unredeemed.
 */
export function disposeUnusedGrant(grant: PairingGrant): void {
  if (grant.flow !== 'password' || grant.credential !== 'app-password' || !grant.appPasswordId) return;
  void deleteAppPassword({
    serverUrl: grant.serverUrl,
    authHeader: `Basic ${Buffer.from(`${grant.username}:${grant.password}`).toString('base64')}`,
    id: grant.appPasswordId,
    trusted: grant.trusted ?? true,
  }).catch((error) => {
    logger.warn('Pair: unused app password was not deleted', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  });
}
registerGrantDisposer(disposeUnusedGrant);

/** The client id and redirect the app uses for its own sign-in (src/lib/totp-login.ts). */
export const MOBILE_CLIENT_ID = DEFAULT_CLIENT_ID;
export const MOBILE_REDIRECT_URI = 'bulwarkmobile://auth/callback';

export type PasswordGrantError =
  | 'invalid_credentials'
  | 'totp_required'
  | 'server_unreachable'
  | 'pairing_unavailable';

export type PasswordGrantResult = { ok: true; grant: PairingGrant } | { ok: false; error: PasswordGrantError };

export interface PasswordGrantOptions {
  /** JMAP server of the signed-in account (from its verified session context). */
  serverUrl: string;
  /** Whether that server is admin-configured (else: rebinding-safe fetch). */
  trusted: boolean;
  /** Its server entry, for per-server OAuth client settings. */
  serverId: string | null;
  /** The account's login name. */
  username: string;
  password: string;
  totp?: string;
  /** The desktop's OAuth callback URL, for the webmail-client attempt. */
  webmailRedirectUri?: string;
  now?: Date;
}

function configuredClient(serverId: string | null): { clientId: string; clientSecret: string } {
  let clientId = DEFAULT_CLIENT_ID;
  try {
    clientId = getRequiredConfig(serverId, { fallbackClientId: DEFAULT_CLIENT_ID }).clientId;
  } catch {
    // No server configured (custom endpoints only): the default client.
  }
  return { clientId, clientSecret: getClientSecret(serverId) };
}

function oauthGrant(
  opts: PasswordGrantOptions,
  result: Extract<StalwartPasswordLoginResult, { ok: true }>,
  clientId: string,
  confidential: boolean,
): PairingGrant {
  return {
    flow: 'oauth',
    serverUrl: opts.serverUrl,
    serverId: opts.serverId,
    accessToken: result.tokens.access_token,
    ...(result.tokens.refresh_token ? { refreshToken: result.tokens.refresh_token } : {}),
    expiresIn: result.tokens.expires_in ?? 3600,
    issuedAt: (opts.now ?? new Date()).getTime(),
    tokenEndpoint: result.tokenEndpoint,
    clientId,
    confidential,
    trusted: opts.trusted,
  };
}

/** A credential verdict ends the attempt; anything else may try the next way. */
function verdict(result: StalwartPasswordLoginResult): PasswordGrantResult | null {
  if (result.ok) return null;
  switch (result.error) {
    case 'invalid_credentials':
    case 'totp_required':
      return { ok: false, error: result.error };
    case 'login_unreachable':
    case 'invalid_server_url':
      return { ok: false, error: 'server_unreachable' };
    default:
      return null;
  }
}

function pairedDescription(now: Date): string {
  return `Bulwark mobile (paired ${now.toISOString().slice(0, 10)})`;
}

export async function mintGrantWithPassword(opts: PasswordGrantOptions): Promise<PasswordGrantResult> {
  const now = opts.now ?? new Date();
  const configured = configuredClient(opts.serverId);
  // The secret belongs to the admin's server; a user-chosen one never sees it.
  if (!opts.trusted) configured.clientSecret = '';

  // 1a. The app's own client. It is public unless the admin registered it
  // with a secret for the webmail too - then the secret is ours to send, and
  // the phone must renew through the webmail.
  const mobileSecret = configured.clientId === MOBILE_CLIENT_ID ? configured.clientSecret : '';
  const first = await stalwartPasswordLogin({
    serverUrl: opts.serverUrl,
    username: opts.username,
    password: opts.password,
    totp: opts.totp,
    clientId: MOBILE_CLIENT_ID,
    clientSecret: mobileSecret,
    redirectUri: MOBILE_REDIRECT_URI,
    trusted: opts.trusted,
  });
  if (first.ok) return { ok: true, grant: oauthGrant(opts, first, MOBILE_CLIENT_ID, mobileSecret !== '') };
  const firstVerdict = verdict(first);
  if (firstVerdict) return firstVerdict;
  const hasStructuredLogin = first.error !== 'login_endpoint_missing';

  // 1b. The server wants a registered client or redirect: the webmail's own,
  // exactly as its password+TOTP login is set up.
  if (hasStructuredLogin && opts.webmailRedirectUri
    && (configured.clientId !== MOBILE_CLIENT_ID || opts.webmailRedirectUri !== MOBILE_REDIRECT_URI)) {
    const second = await stalwartPasswordLogin({
      serverUrl: opts.serverUrl,
      username: opts.username,
      password: opts.password,
      totp: opts.totp,
      clientId: configured.clientId,
      clientSecret: configured.clientSecret,
      redirectUri: opts.webmailRedirectUri,
      trusted: opts.trusted,
    });
    if (second.ok) {
      return { ok: true, grant: oauthGrant(opts, second, configured.clientId, configured.clientSecret !== '') };
    }
    const secondVerdict = verdict(second);
    if (secondVerdict) return secondVerdict;
    logger.warn('Pair step-up: structured login refused both clients', { first: first.error, second: second.error });
  }

  // 2./3. Basic auth. A TOTP account cannot use it on Stalwart 0.16 (it
  // answers 402 when the password is right), so with a code there is nothing
  // left to try.
  const authHeader = `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString('base64')}`;
  try {
    await verifyJmapIdentity(opts.serverUrl, authHeader, opts.username, { trusted: opts.trusted });
  } catch (error) {
    if (error instanceof JmapAuthVerificationError && error.status === 401) {
      return { ok: false, error: 'invalid_credentials' };
    }
    // Stalwart answers Basic auth for a TOTP account with 402 when the
    // password is right.
    if (error instanceof JmapAuthVerificationError && error.upstreamStatus === 402) {
      return { ok: false, error: opts.totp ? 'pairing_unavailable' : 'totp_required' };
    }
    logger.warn('Pair step-up: credential check failed', {
      status: error instanceof JmapAuthVerificationError ? error.status : undefined,
    });
    return { ok: false, error: 'server_unreachable' };
  }

  const session = await fetchJmapSession(opts.serverUrl, authHeader, { trusted: opts.trusted }).catch(() => null);
  if (!session) {
    // Without the session there is no telling a Stalwart account (which must
    // get an app password) from another server: never guess towards handing
    // over the real password.
    logger.warn('Pair step-up: could not read the JMAP session after the credential check');
    return { ok: false, error: 'pairing_unavailable' };
  }
  const isStalwart = Object.values(
    (session as { accounts?: Record<string, { accountCapabilities?: Record<string, unknown> }> }).accounts ?? {},
  ).some((account) => !!account?.accountCapabilities?.['urn:stalwart:jmap']);

  if (isStalwart) {
    try {
      const appPassword = await createAppPassword({
        serverUrl: opts.serverUrl,
        authHeader,
        description: pairedDescription(now),
        trusted: opts.trusted,
      });
      return {
        ok: true,
        grant: {
          flow: 'password',
          serverUrl: opts.serverUrl,
          username: opts.username,
          password: appPassword.secret,
          credential: 'app-password',
          appPasswordId: appPassword.id,
          trusted: opts.trusted,
        },
      };
    } catch (error) {
      // An account that may not create app passwords (permissions, quota)
      // gets no phone credential at all rather than its real password: on a
      // Stalwart server that is a policy, not a missing feature.
      logger.warn('Pair step-up: app password was not created', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return { ok: false, error: 'pairing_unavailable' };
    }
  }

  return {
    ok: true,
    grant: {
      flow: 'password',
      serverUrl: opts.serverUrl,
      username: opts.username,
      password: opts.password,
      credential: 'account-password',
    },
  };
}
