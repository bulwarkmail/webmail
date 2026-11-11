import { STALWART_SCOPE_FULL } from '@/lib/oauth/scopes';

/** The answer of a successful POST /api/admin/oauth/setup, as far as the page reads it. */
export interface OAuthSetupResult {
  action?: string;
  issuerUrl?: string;
  origin?: string;
  redirectUriCount?: number;
  mobileClient?: string;
  mobileClientId?: string;
  mobileRedirectUri?: string;
  stalwartScopes?: unknown;
}

/** What the admin page says after "Set up with Stalwart" worked. */
export function oauthSetupSuccessMessage(data: OAuthSetupResult): string {
  const mobile = data.mobileClient === 'created' || data.mobileClient === 'updated'
    ? ` Bulwark Mobile client ${data.mobileClient} (${data.mobileClientId}, ${data.mobileRedirectUri}).`
    : data.mobileClient === 'failed'
      ? ` Stalwart refused the Bulwark Mobile client (${data.mobileClientId}); the app registers its own instead, without access to account settings.`
      : '';
  const scopes: string[] = Array.isArray(data.stalwartScopes) ? data.stalwartScopes : [];
  const limited = scopes.length > 0 && !scopes.includes(STALWART_SCOPE_FULL)
    ? ' Only a Stalwart superuser can allow full access, so the client got security and settings access; the admin panel stays out of reach through SSO.'
    : '';
  // Sessions from before hold tokens of the old client set-up (another
  // client, secret or scopes). Stalwart refuses to renew them with
  // invalid_grant, which otherwise looks like something broke (#1611).
  const signInAgain = ' Everyone who is signed in has to sign in again.';
  return `OAuth client ${data.action} on Stalwart (${data.issuerUrl}). ${data.redirectUriCount} redirect URI(s) registered for ${data.origin}.${mobile}${limited}${signInAgain}`;
}
