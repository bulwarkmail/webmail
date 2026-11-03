/**
 * Sign-in through the system browser in the desktop build, for any Stalwart.
 *
 * A window on app.bulwark.localhost can't be a redirect target: Stalwart 1.0
 * refuses it for a public client, and identity providers won't embed. So the
 * Electron main process listens on http://127.0.0.1:<port> for one redirect and
 * hands the code back. The rest is the regular PKCE flow: the same
 * sessionStorage keys, then the callback page, which reads the stored redirect
 * URI because it can't be rebuilt from this page's origin.
 *
 * Google and Entra can't work here. Their clients are registered by whoever
 * owns them, and in standalone mode nobody does. Those need an instance.
 */

import { apiFetch } from '@/lib/browser-navigation';
import { generateCodeChallenge, generateCodeVerifier, generateState } from '@/lib/oauth/pkce';
import { getDesktopBridge } from './bridge';

export const DESKTOP_REDIRECT_URI_KEY = 'oauth_redirect_uri';
export const DESKTOP_CLIENT_ID_KEY = 'oauth_client_id';

export type DesktopBrowserSignInOutcome =
  | { kind: 'callback'; callbackUrl: string }
  | { kind: 'unavailable' }
  | { kind: 'declined' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string };

interface DesktopOAuthAnswer {
  authorization_endpoint: string;
  client_id: string;
  scope: string;
}

export function browserSignInAvailable(): boolean {
  return !!getDesktopBridge()?.auth;
}

export async function runDesktopBrowserSignIn(options: {
  serverUrl: string;
  callbackPath: string;
  slot: number;
  remember: boolean;
  addAccount: boolean;
}): Promise<DesktopBrowserSignInOutcome> {
  const bridge = getDesktopBridge();
  if (!bridge?.auth) return { kind: 'unavailable' };
  const { serverUrl, callbackPath, slot, remember, addAccount } = options;

  const prepared = await bridge.servers?.prepare(serverUrl);
  if (prepared && !prepared.ok) return { kind: 'declined' };

  const { flowId, redirectUri } = await bridge.auth.beginBrowserSignIn();
  try {
    const res = await apiFetch('/api/auth/desktop-oauth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl, redirectUri }),
    });
    if (!res.ok) {
      bridge.auth.cancelBrowserSignIn(flowId);
      return { kind: 'unavailable' };
    }
    const answer = (await res.json()) as DesktopOAuthAnswer;

    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    const state = generateState();

    const authorizeUrl = new URL(answer.authorization_endpoint);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', answer.client_id);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', answer.scope);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    if (addAccount) authorizeUrl.searchParams.set('prompt', 'select_account');

    const result = await bridge.auth.completeBrowserSignIn(flowId, authorizeUrl.toString());
    if (!result.ok) {
      return result.error === 'cancelled' ? { kind: 'cancelled' } : { kind: 'failed', error: result.error };
    }
    if (result.state !== state) return { kind: 'failed', error: 'state_mismatch' };

    // What the callback page expects from a same-window flow, plus the two
    // values only this flow has.
    sessionStorage.setItem('oauth_code_verifier', verifier);
    sessionStorage.setItem('oauth_state', state);
    sessionStorage.setItem('oauth_server_url', serverUrl);
    sessionStorage.removeItem('oauth_server_id');
    sessionStorage.setItem('oauth_remember', String(remember));
    sessionStorage.setItem('oauth_cookie_slot', String(slot));
    sessionStorage.setItem(DESKTOP_REDIRECT_URI_KEY, redirectUri);
    sessionStorage.setItem(DESKTOP_CLIENT_ID_KEY, answer.client_id);
    if (addAccount) sessionStorage.setItem('oauth_add_account_mode', 'true');

    const query = new URLSearchParams({ code: result.code, state: result.state });
    return { kind: 'callback', callbackUrl: `${callbackPath}?${query}` };
  } catch (error) {
    bridge.auth.cancelBrowserSignIn(flowId);
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
