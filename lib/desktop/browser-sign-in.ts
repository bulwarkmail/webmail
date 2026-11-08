/**
 * "Sign in with your browser" in the desktop app, so a password manager, passkeys and an
 * organisation's sign-in all work where they live.
 *
 * Standalone: RFC 8252. The mail server's own authorize page in the system browser, with
 * the redirect going to a listener in the Electron main process, and this page redeeming
 * the code with the PKCE verifier it kept. A server with no OAuth at all gets a small page
 * main serves on a stable loopback port, and what's posted there comes down the app's
 * normal login path here.
 *
 * Instance: the instance's real login page at its real origin, so saved passwords match.
 * It parks the sign-in on the instance and sends a one-time code to the same kind of
 * listener (lib/auth/mobile-handoff.ts). The page redeems it with the verifier.
 *
 * The calls are taken once per document, in the first render (claimBrowserSignIn, from
 * WindowControlsHost): a same-origin frame can reach the bridge, and main can't tell.
 *
 * Google and Entra can't work in standalone. Their clients are registered by whoever owns
 * them, and there nobody does. Those need an instance.
 */

import { apiFetch } from '@/lib/browser-navigation';
import { IS_LITE } from '@/lib/lite';
import { generateCodeChallenge, generateCodeVerifier } from '@/lib/oauth/pkce';
import { getDesktopBridge } from './bridge';
import { desktopPolicyValue } from './policy';
import type { DesktopBrowserSignInControls, DesktopPasswordSignInAnswer, DesktopPasswordSignInAttempt } from './types';

export const DESKTOP_CLIENT_ID_KEY = 'oauth_client_id';

export type DesktopBrowserSignInOutcome =
  | { kind: 'signed-in' }
  /** Instance mode: what to redeem. */
  | { kind: 'code'; code: string; verifier: string }
  | { kind: 'declined' }
  | { kind: 'invalid' }
  | { kind: 'policy' }
  | { kind: 'cancelled' }
  /** The user said no in the browser. */
  | { kind: 'denied' }
  | { kind: 'timeout' }
  | { kind: 'no_browser' }
  | { kind: 'failed'; error: string };

interface DesktopOAuthAnswer {
  authorization_endpoint: string;
  client_id: string;
  scope: string;
  issuer?: string;
  use_scheme?: boolean;
}

let controls: DesktopBrowserSignInControls | null = null;
let claimedFrom: unknown;
let currentFlow: string | null = null;

/** Before any frame exists. Whoever comes after this gets nothing from the preload. */
export function claimBrowserSignIn(): DesktopBrowserSignInControls | null {
  const bridge = getDesktopBridge();
  if (claimedFrom !== bridge) {
    claimedFrom = bridge;
    controls = bridge?.auth?.claim?.() ?? null;
  }
  return controls;
}

/** Whether this page offers it. In a browser there's no bridge, and Lite has no server to park on. */
export function browserSignInAvailable(): boolean {
  return !IS_LITE && !!claimBrowserSignIn() && desktopPolicyValue('BrowserSignIn') === true;
}

/**
 * A plugin's OAuth sign-in in a window of the desktop app (instance mode), so the callback
 * page reaches this page's storage. False where the shell can't (a browser, standalone, an
 * older shell): the caller opens it as a link then.
 */
export async function openPluginSignInInApp(url: string): Promise<boolean> {
  const open = claimBrowserSignIn()?.pluginSignIn;
  if (typeof open !== 'function') return false;
  try {
    return (await open(url)) === true;
  } catch {
    return false;
  }
}

/** The Cancel button, and leaving the page. */
export function cancelBrowserSignIn(): void {
  if (currentFlow) controls?.cancel(currentFlow);
  currentFlow = null;
}

function failure(error: string): DesktopBrowserSignInOutcome {
  if (error === 'cancelled') return { kind: 'cancelled' };
  if (error === 'denied') return { kind: 'denied' };
  if (error === 'timeout') return { kind: 'timeout' };
  if (error === 'no_browser') return { kind: 'no_browser' };
  if (error === 'policy') return { kind: 'policy' };
  if (error === 'declined') return { kind: 'declined' };
  if (error === 'invalid') return { kind: 'invalid' };
  return { kind: 'failed', error };
}

/** Instance mode. The caller redeems the code (loginWithDesktopHandoff in the auth store). */
export async function runInstanceBrowserSignIn(options: { base: string; locale: string; fresh: boolean; loginHint?: string }): Promise<DesktopBrowserSignInOutcome> {
  const auth = claimBrowserSignIn();
  if (!auth) return { kind: 'failed', error: 'unavailable' };
  const begun = await auth.begin({ kind: 'instance' });
  if (!begun.ok) return failure(begun.error);
  currentFlow = begun.flowId;
  try {
    const verifier = generateCodeVerifier();
    const url = new URL(`${options.base}/${options.locale}/login`);
    url.searchParams.set('mobile_redirect_uri', begun.redirectUri);
    url.searchParams.set('mobile_state', begun.state);
    url.searchParams.set('mobile_code_challenge', await generateCodeChallenge(verifier));
    if (options.fresh) url.searchParams.set('fresh_login', '1');
    // The instance's page starts with the address typed in the app.
    if (options.loginHint) url.searchParams.set('login_hint', options.loginHint);
    const result = await auth.complete(begun.flowId, url.toString());
    if (!result.ok) return failure(result.error);
    return { kind: 'code', code: result.code, verifier };
  } catch (error) {
    auth.cancel(begun.flowId);
    return { kind: 'failed', error: error instanceof Error ? error.name : 'error' };
  } finally {
    currentFlow = null;
  }
}

/** The page main serves: each post goes through the app's own login, until one works. */
async function runPasswordPage(
  auth: DesktopBrowserSignInControls,
  flowId: string,
  tryPassword: (attempt: Extract<DesktopPasswordSignInAttempt, { ok: true }>) => Promise<DesktopPasswordSignInAnswer>,
): Promise<DesktopBrowserSignInOutcome> {
  const started = await auth.beginPassword(flowId);
  if (!started.ok) return failure(started.error);
  for (;;) {
    const attempt = await auth.nextPassword(flowId);
    if (!attempt.ok) return attempt.error === 'done' ? { kind: 'signed-in' } : failure(attempt.error);
    const answer = await tryPassword(attempt);
    auth.answerPassword(flowId, answer);
    if (answer.ok) {
      const ended = await auth.outcome(flowId);
      return ended.ok ? { kind: 'signed-in' } : failure(ended.error);
    }
  }
}

/** Standalone. Only referenced from behind the desktop build's flag, so no other bundle holds the route. */
export async function runDesktopBrowserSignIn(options: {
  serverUrl: string;
  slot: number;
  remember: boolean;
  addAccount: boolean;
  fresh: boolean;
  /** The address typed in the app, for the server's page (OIDC login_hint). */
  loginHint?: string;
  /** Redeems the code: loginWithOAuth in the auth store. */
  redeem: (serverUrl: string, code: string, verifier: string, redirectUri: string) => Promise<boolean>;
  tryPassword: (attempt: Extract<DesktopPasswordSignInAttempt, { ok: true }>) => Promise<DesktopPasswordSignInAnswer>;
}): Promise<DesktopBrowserSignInOutcome> {
  const auth = claimBrowserSignIn();
  if (!auth) return { kind: 'failed', error: 'unavailable' };
  const { serverUrl, slot, remember, addAccount, fresh, loginHint, redeem, tryPassword } = options;

  const begun = await auth.begin({ kind: 'oauth', serverUrl });
  if (!begun.ok) return failure(begun.error);
  const { flowId } = begun;
  currentFlow = flowId;
  try {
    const res = await apiFetch('/api/auth/desktop-oauth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl, redirectUri: begun.redirectUri }),
    });
    if (res.status === 404) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (body?.error === 'no_oauth') return await runPasswordPage(auth, flowId, tryPassword);
    }
    if (!res.ok) {
      auth.cancel(flowId);
      return { kind: 'failed', error: 'discovery' };
    }
    const answer = (await res.json()) as DesktopOAuthAnswer;
    let redirectUri = begun.redirectUri;
    if (answer.use_scheme) {
      const scheme = await auth.useScheme(flowId);
      if (!scheme) {
        auth.cancel(flowId);
        return { kind: 'failed', error: 'scheme' };
      }
      redirectUri = scheme;
    }

    const verifier = generateCodeVerifier();
    const authorizeUrl = new URL(answer.authorization_endpoint);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', answer.client_id);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', answer.scope);
    authorizeUrl.searchParams.set('state', begun.state);
    authorizeUrl.searchParams.set('code_challenge', await generateCodeChallenge(verifier));
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    // The server's page starts with the address already typed in the app.
    if (loginHint) authorizeUrl.searchParams.set('login_hint', loginHint);
    if (addAccount) authorizeUrl.searchParams.set('prompt', 'select_account');
    if (fresh) authorizeUrl.searchParams.set('prompt', 'login');

    const result = await auth.complete(flowId, authorizeUrl.toString());
    if (!result.ok) return failure(result.error);
    // RFC 9207: the answer names who issued it. Main has already checked the state.
    if (result.iss && answer.issuer && result.iss !== answer.issuer) return { kind: 'failed', error: 'issuer_mismatch' };

    // What the auth store's exchange reads. The code never goes near an address bar.
    sessionStorage.setItem('oauth_remember', String(remember));
    sessionStorage.setItem('oauth_cookie_slot', String(slot));
    sessionStorage.setItem(DESKTOP_CLIENT_ID_KEY, answer.client_id);
    try {
      return (await redeem(serverUrl, result.code, verifier, redirectUri)) ? { kind: 'signed-in' } : { kind: 'failed', error: 'exchange' };
    } finally {
      sessionStorage.removeItem(DESKTOP_CLIENT_ID_KEY);
    }
  } catch (error) {
    auth.cancel(flowId);
    return { kind: 'failed', error: error instanceof Error ? error.name : 'error' };
  } finally {
    currentFlow = null;
  }
}
