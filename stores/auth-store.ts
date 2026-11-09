import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { JMAPClient, RateLimitError, RequestTimeoutError } from '@/lib/jmap/client';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useIdentityStore } from './identity-store';
import { setClientLookup } from './client-registry';
import { useContactStore } from './contact-store';
import { useVacationStore } from './vacation-store';
import { subscriptionOwner, useCalendarStore } from './calendar-store';
import { useFilterStore } from './filter-store';
import { useSettingsStore } from './settings-store';
import { useAccountStore, type AccountEntry, type AccountRemovalReason } from './account-store';
import { fetchPrincipalDisplayName } from '@/lib/stalwart/principal';
import { fetchConfig, getCachedConfig } from '@/hooks/use-config';
import { debug } from '@/lib/debug';
import { setServerAuthIssue } from '@/lib/server-auth-status';
import { generateAccountId, MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { replaceWindowLocation, getPathPrefix, getLocaleFromPath, apiFetch } from '@/lib/browser-navigation';
import { IS_DESKTOP_BUILD } from '@/lib/desktop/flag';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { clearDesktopCertificateChoices, clearDesktopCrashFiles, clearKeystoreGrants, noteDesktopCertificateAccount } from '@/lib/desktop/keystore-grants';
import { onConnectionsReset } from '@/lib/desktop/connections-reset';
import { DESKTOP_CLIENT_ID_KEY } from '@/lib/desktop/browser-sign-in';
import { isEmbedded, notifyParent } from '@/lib/iframe-bridge';
import { snapshotAccount, restoreAccount, clearAllStores, evictAccount, evictAll, forgetAccountRows } from '@/lib/account-state-manager';
import { getDesktopPolicy, onDesktopPolicyChange } from '@/lib/desktop/policy';
import { accountRefusedByDesktopPolicy, planForRefusedAccounts } from '@/lib/desktop/refused-accounts';
import { clearAllPluginStorage, clearPluginStorageForAccount } from '@/lib/plugin-sandbox/storage-scope';
import { clearPendingCookies, freshLoginDone } from '@/lib/app-lock/sign-out';
import { isAppLockedNow, isAppLockOn } from '@/lib/app-lock/state';
import { broadcastSignOut, onSignedOutElsewhere, passSignOutGates, purgeSignedOutData, runBeforeSignOut, type SignOutCleanupOptions } from '@/lib/sign-out-cleanup';
import { forgetPrincipals } from '@/lib/delegation/known-principals';
import { useSearchHistoryStore } from './search-history-store';
import { useCalendarNotificationStore } from './calendar-notification-store';
import { usePolicyStore } from './policy-store';
import { policySubjectForClient } from '@/lib/admin/policy-subject';
import { clearSessionEnd, rememberSessionEnd } from '@/lib/session-policy/sign-out-reason';
import { SESSION_TOO_OLD } from '@/lib/session-policy/constants';
import type { Identity } from '@/lib/jmap/types';
import { authHooks } from '@/lib/plugin-hooks';
import { IS_LITE, IS_LITE_STALWART } from '@/lib/lite';
import { withTokenLock } from '@/lib/auth/token-lock';
import { requestWindowSession, type SharedAccountSession } from '@/lib/popout/channel';
import { closePopoutWindow, isPopoutWindow, mainWindowStorage } from '@/lib/popout/window-role';
import { noteCredentialsRejected, type ForcedSignOutKind } from '@/lib/offline/credentials-rejected';
import { CREDENTIALS_REFUSED_CONFIRM_MS, markLoginRefused, wipeWorkWaiting } from '@/lib/devices/wipe-state';
import { checkStoreOwner, clearEvicted, dropEvictedOwner, markEvicted, readEvicted, useOfflineStore } from '@/lib/offline/state';
import { toAsciiEmail } from '@/lib/idn';
import { flushComposers } from '@/lib/compose-flush-registry';
import { sortIdentities } from '@/lib/identity-order';
import {
  LiteLoginError,
  getLiteClientId,
  liteExchangeAuthorizationCode,
  liteRefreshTokens,
  liteTokenLogin,
  nameLiteRefreshToken,
  readLiteAccessToken,
  readLiteBasicSession,
  replaceLiteRefreshToken,
  retireLiteRefreshToken,
  retireLiteSlot,
  revokeAllLiteSessions,
  revokeLiteSlot,
  saveLiteAccessToken,
  saveLiteBasicSession,
} from '@/lib/auth/lite-tokens';
import { clearLiteOAuthFlow, readLiteOAuthFlow } from '@/lib/auth/lite-oauth';

/** config.json `oauthRevokeOnSignOut`: whether Lite revokes refresh tokens it lets go of. */
const liteRevokesTokens = () => getCachedConfig()?.oauthRevokeOnSignOut !== false;

/** Logins restored at once after the one on screen: enough to overlap round trips, few enough not to crowd the server. */
const RESTORE_CONCURRENCY = 4;

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  isRateLimited: boolean;
  rateLimitUntil: number | null;
  serverUrl: string | null;
  username: string | null;
  client: IJMAPClient | null;
  identities: Identity[];
  primaryIdentity: Identity | null;
  authMode: 'basic' | 'oauth' | 'token';
  rememberMe: boolean;
  accessToken: string | null;
  tokenExpiresAt: number | null;
  connectionLost: boolean;
  activeAccountId: string | null;
  isDemoMode: boolean;
  /**
   * Bumped when background account restoration finishes connecting clients
   * after the UI already unblocked, so effects that bind per-client handlers
   * (push notifications) re-run over the now-complete client set.
   */
  connectedAccountsRevision: number;
  /**
   * True while the logins other than the one on screen are still being
   * restored after a load, so views that span every login (the unified
   * mailbox) can say they are not complete yet.
   */
  restoringAccounts: boolean;

  login: (serverUrl: string, username: string, password: string, totp?: string, rememberMe?: boolean, accountId?: string) => Promise<boolean>;
  /**
   * Sign in with an access token instead of a password (Bearer auth), for
   * servers that hand out API tokens, such as Fastmail. The token names no
   * account: the JMAP session says whose it is. It is never renewed; once
   * the server stops accepting it, the user signs in again.
   */
  loginWithToken: (serverUrl: string, token: string, rememberMe?: boolean, accountId?: string) => Promise<boolean>;
  loginWithOAuth: (serverUrl: string, code: string, codeVerifier: string, redirectUri: string, serverId?: string) => Promise<boolean>;
  loginWithServerSso: (code: string, state: string) => Promise<boolean>;
  /**
   * The desktop app on an instance: the one-time code from its browser sign-in, with the
   * verifier it kept. `blocked` is the device's own list of servers saying no.
   */
  loginWithDesktopHandoff: (code: string, verifier: string, options: { remember: boolean; rememberPassword: boolean; allowedServers: string[] | null; customServersAllowed: boolean }) => Promise<'ok' | 'blocked' | 'failed'>;
  loginDemo: () => Promise<boolean>;
  /**
   * Obtain a usable access token for `accountId`, or the active account.
   *
   * Renews against the IdP by default. `allowCached` lets a session restore
   * reuse the token the server still holds for this slot - IdPs that gate
   * refresh tokens behind an `nbf` claim reject an early renewal outright.
   */
  refreshAccessToken: (options?: { allowCached?: boolean; accountId?: string }) => Promise<string | null>;
  /**
   * Sign out of the active account. Switches to the next signed-in account
   * when there is one; otherwise ends the identity provider's session too
   * (see {@link LogoutOptions}) and leaves the app.
   */
  logout: (options?: LogoutOptions) => Promise<void>;
  /**
   * Sign out of every account. Ends at most one identity provider session:
   * see {@link pickEndSessionSlot}; none with `endProviderSession: false`
   * (the organisation's session limits, which sign out without asking).
   */
  logoutAll: (options?: LogoutOptions) => Promise<void>;
  removeAccount: (accountId: string, reason?: AccountRemovalReason) => void;
  switchAccount: (accountId: string) => Promise<void>;
  checkAuth: () => Promise<void>;
  /**
   * Start-up of a pop-out window, in place of checkAuth: takes the session
   * from a main window, or from the remembered cookies when none is open.
   * Never evicts an account and starts no token timers.
   */
  startSharedSession: (options?: { accountId?: string }) => Promise<'ready' | 'no-session'>;
  clearError: () => void;
  syncIdentities: () => void;
  /**
   * Keep a Basic-auth session working after the user changed the password:
   * the client, the server-side management context and the remembered
   * session still hold the old one, which the server now refuses.
   */
  updateBasicPassword: (newPassword: string) => Promise<void>;
  /**
   * Sign in, in the background, to a Basic account restored from the account
   * list backup with its password. The active account stays as it is.
   * Resolves false when the server refuses the password or cannot be reached.
   */
  signInRestoredAccount: (accountId: string, password: string, rememberMe: boolean) => Promise<boolean>;
  refreshIdentities: () => Promise<void>;
  getClientForAccount: (accountId: string) => JMAPClient | undefined;
  getAllConnectedClients: () => Map<string, JMAPClient>;
  /**
   * After a start without the server (offline mode, #523): sign the
   * accounts that run from this device in for real, now that the server
   * answers. True when every one of them got a real client.
   */
  reconnectOfflineClients: () => Promise<boolean>;
}

export interface LogoutOptions {
  /**
   * Also end the identity provider's session when the account signed in
   * through it (#905). Default true. False when the session ended on its own
   * (rejected or unrenewable token): the user did not ask to leave the
   * provider, and signing in again should stay a single click.
   */
  endProviderSession?: boolean;
  /**
   * The app, not the user, ends this login, and nothing says the login itself
   * is over (an outage, an unknown refusal): local mail and the outbox stay,
   * hidden, for the next sign-in or 30 days.
   */
  keepLocalData?: boolean;
  /** It's the organisation's idle or session limit that ended it: with `keepLocalData`, what lib/offline/device-wipe.ts is told. */
  sessionLimit?: boolean;
}

const ERROR_PATTERNS: Array<{ key: string; matches: string[] }> = [
  { key: 'cors_blocked', matches: ['CORS_ERROR'] },
  { key: 'totp_required', matches: ['TOTP_REQUIRED'] },
  { key: 'token_exchange_failed', matches: ['TOKEN_EXCHANGE_FAILED'] },
  { key: 'invalid_credentials', matches: ['Invalid username or password', '401', 'Unauthorized'] },
  { key: 'connection_failed', matches: ['network', 'Failed to fetch', 'NetworkError', 'ECONNREFUSED', 'Load failed', 'cancelled'] },
  { key: 'server_error', matches: ['500', '502', '503', '504', 'Internal Server Error', 'Service Unavailable'] },
];

function classifyLoginError(error: unknown): string {
  if (!(error instanceof Error)) return 'generic';
  const msg = error.message;
  for (const { key, matches } of ERROR_PATTERNS) {
    if (matches.some((pattern) => msg.includes(pattern))) return key;
  }
  return 'generic';
}

function isRateLimitError(error: unknown): error is RateLimitError {
  return error instanceof RateLimitError;
}

/**
 * Ask our own backend to try the credentials before the browser does (#969):
 * a password, or the access token of a token login. A wrong password answered
 * straight from the JMAP server arrives as
 * 401 + `WWW-Authenticate: Basic`, which makes the browser open its native
 * login dialog on top of our form when the JMAP server shares our origin
 * (reverse-proxied under the same host). Rejecting wrong credentials via a
 * JSON reply from our origin sidesteps that. Only a definitive
 * `unauthorized` short-circuits; anything else (route missing, backend can't
 * reach the JMAP server, TOTP challenge, ...) falls through to the regular
 * browser-side connect so no deployment loses the ability to log in.
 */
async function precheckCredentials(
  serverUrl: string,
  credentials: { username: string; password: string } | { token: string },
): Promise<boolean> {
  // App-relative servers (the dev mock) never send a Basic challenge, and the
  // static Lite build has no backend to ask.
  if (IS_LITE || serverUrl.startsWith('/')) return false;
  try {
    const res = await apiFetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl, ...credentials }),
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return body?.result === 'unauthorized';
  } catch {
    return false;
  }
}

// An auth/session endpoint answered with a server-side error (5xx) - an
// outage, not a rejection of our credentials.
class TransientAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(`${message}: ${status}`);
  }
}

// True when a restore/refresh attempt failed because the server could not be
// reached (network error) or answered 5xx (restart, maintenance, proxy
// hiccup). Such failures must keep the account and its cookies - "stay signed
// in" has to survive downtime and offline spells. Only a definitive rejection
// (401/400) may evict. Mirrors the rate-limit carve-out (#104).
function isTransientAuthError(error: unknown): boolean {
  if (error instanceof TransientAuthError) return true;
  // fetch() rejects with TypeError when the network is unreachable.
  if (error instanceof TypeError) return true;
  // A request that timed out, or a fetch that failed while the no-cors probe
  // got through (connect() reports that as CORS_ERROR, which is also what a
  // load balancer switching origins produces), is an outage too. (#1167)
  if (error instanceof RequestTimeoutError) return true;
  if (error instanceof Error && error.message === 'CORS_ERROR') return true;
  // JMAPClient.connect()/refreshSession() embed the HTTP status in the
  // message - a 5xx there is the server being down, not an auth failure.
  if (error instanceof Error) {
    const m = error.message.match(/(?:Failed to get session|Session refresh failed): (\d{3})/);
    if (m) return m[1].startsWith('5');
  }
  return false;
}

function getClientRateLimitState(client: IJMAPClient | null): Pick<AuthState, 'isRateLimited' | 'rateLimitUntil'> {
  if (!client) {
    return { isRateLimited: false, rateLimitUntil: null };
  }

  const remainingMs = client.getRateLimitRemainingMs();
  if (remainingMs <= 0) {
    return { isRateLimited: false, rateLimitUntil: null };
  }

  return {
    isRateLimited: true,
    rateLimitUntil: Date.now() + remainingMs,
  };
}

/**
 * Refresh the account registry's cached `displayName` from the server (#900).
 *
 * The name is captured once by `addAccount` (a no-op for an existing entry),
 * so without this an account keeps whatever name it had at first login
 * forever. The primary identity's name wins: it is what recipients see and
 * what Settings > Account edits. The Stalwart principal name is only the
 * fallback for an account without one.
 *
 * Best-effort and never throws: a failed lookup keeps the cached name.
 */
export async function syncAccountDisplayName(
  accountId: string,
  client: IJMAPClient,
  fallbackName?: string | null,
): Promise<void> {
  const account = useAccountStore.getState().getAccountById(accountId);
  if (!account) return;

  // The name people see on sent mail is the sending identity's, and that is
  // the one name Settings lets them change (settings-p2-2). Stalwart's
  // principal description ("Full name") is often an admin's note, so it only
  // names an account that has no identity name. A caller that doesn't know
  // the identities keeps the name the account already has.
  let name = fallbackName?.trim() || '';
  if (!name) {
    if (fallbackName === undefined && account.displayName) return;
    name = (await fetchPrincipalDisplayName(client, account.cookieSlot)) || '';
  }
  if (!name) return;

  // Re-read: the entry may have changed (or been removed) during the request.
  const current = useAccountStore.getState().getAccountById(accountId);
  if (!current || current.displayName === name) return;

  const updates: Partial<AccountEntry> = { displayName: name };
  // `label` is seeded from the same value and never edited separately, so
  // keep it in step unless it has diverged for some other reason.
  if (!current.label || current.label === current.displayName) {
    updates.label = name;
  }
  useAccountStore.getState().updateAccount(accountId, updates);
}

/*
 * Sign-out ordering (#905).
 *
 * A token renewal or Stalwart context sync still in flight when the user signs
 * out would write its cookies back after sign-out cleared them, reviving the
 * session. Such requests are tracked per slot. Sign-out marks the slot closing
 * (no new ones start), lets the pending ones settle - aborting any that take
 * too long, which drops their response and its cookies - and only then clears
 * the slot's credentials. That cleanup is awaited with a timeout, so its
 * result (the provider's logout URL) is known before the page navigates, and
 * failures are reported instead of dropped.
 */

/** How long sign-out waits for a token renewal already in flight. */
const SESSION_WRITE_SETTLE_TIMEOUT_MS = 3000;
/** How long sign-out waits for the server to revoke and clear a slot's credentials. */
const CREDENTIAL_CLEANUP_TIMEOUT_MS = 8000;

interface SessionWrite {
  slot: number;
  settled: Promise<unknown>;
  abort: () => void;
}

const sessionWrites = new Set<SessionWrite>();
// Slots being signed out: nothing may write their session cookies anymore.
const closingSlots = new Set<number>();

/** Run a request that may write `slot`'s session cookies, so sign-out can wait for it. */
function trackSessionWrite<T>(slot: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const request = run(controller.signal);
  const entry: SessionWrite = { slot, settled: request.catch(() => {}), abort: () => controller.abort() };
  sessionWrites.add(entry);
  void entry.settled.then(() => sessionWrites.delete(entry));
  return request;
}

/** It holds the token lock, for every window: a request that never answers can't be left to hold it. */
const TOKEN_RENEWAL_TIMEOUT_MS = 30_000;

function renewalSignal(outer: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (outer.aborted) stop();
  else outer.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, TOKEN_RENEWAL_TIMEOUT_MS);
  const stopWatching = onConnectionsReset(stop);
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      outer.removeEventListener('abort', stop);
      stopWatching?.();
    },
  };
}

const TIMED_OUT = Symbol('timed out');
// A sign-out may stop waiting, but a new sign-in must wait for its actual DELETEs.
const credentialCleanups = new Map<number, Promise<string | null>>();

async function waitForCredentialCleanup(slot: number): Promise<void> {
  while (credentialCleanups.has(slot)) await credentialCleanups.get(slot);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Wait for the session writes of closing `slots` to finish, aborting stragglers. */
async function settleSessionWrites(slots: ReadonlySet<number>): Promise<void> {
  const pending = [...sessionWrites].filter((write) => slots.has(write.slot));
  if (pending.length === 0) return;
  const result = await withTimeout(Promise.all(pending.map((write) => write.settled)), SESSION_WRITE_SETTLE_TIMEOUT_MS);
  if (result === TIMED_OUT) {
    debug.warn('auth', 'A token renewal was still running at sign-out; cancelling it');
    for (const write of pending) write.abort();
  }
}

async function syncStalwartAuthContext(
  serverUrl: string,
  username: string,
  authHeader: string,
  slot: number,
): Promise<void> {
  // The passthrough context lives on the server; Lite has none. A slot being
  // signed out must not get its context back.
  if (IS_LITE || closingSlots.has(slot)) return;
  try {
    const response = await trackSessionWrite(slot, (signal) => apiFetch('/api/auth/stalwart-context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl, username, authHeader, slot }),
      signal,
    }));

    const data = await response.json().catch(() => ({})) as { error?: string; hint?: string; warning?: string };
    if (!response.ok) {
      // Not debug-gated: without the context every server-side helper
      // answers 401, and this is the only place the browser learns why (#1073).
      const reason = data.hint || data.error || `HTTP ${response.status}`;
      setServerAuthIssue(reason);
      console.warn(`[auth] The server could not store the sign-in context (${response.status}): ${reason}`);
    } else {
      setServerAuthIssue(data.warning ?? null);
      if (data.warning) console.warn(`[auth] ${data.warning}`);
    }
  } catch (error) {
    debug.warn('auth', 'Failed to sync Stalwart auth context:', error);
  }
}

/*
 * Per-slot credential endpoints.
 *
 * The regular build keeps refresh tokens and remembered passwords in encrypted
 * per-slot cookies behind /api/auth/*. The static Lite build has no server and
 * keeps them in web storage instead (lib/auth/lite-tokens.ts). The Lite
 * variants below answer with the same Response shapes the routes do, so every
 * caller's status handling (401 = rejected, 5xx/network = outage) is shared.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function liteErrorStatus(err: LiteLoginError): number {
  switch (err.code) {
    case 'endpoint_missing':
      return 404;
    case 'totp_required':
    case 'invalid_credentials':
    case 'refresh_rejected':
      return 401;
    default:
      return err.status && err.status >= 500 ? err.status : 502;
  }
}

/** POST /api/auth/totp-token-exchange - password (+ optional TOTP) to bearer tokens for `slot`. */
async function exchangePasswordForTokens(params: {
  serverUrl: string;
  username: string;
  password: string;
  totp?: string;
  slot: number;
  redirectUri: string;
  rememberMe: boolean;
}): Promise<Response> {
  const { serverUrl, username, password, totp, slot, redirectUri, rememberMe } = params;
  if (!IS_LITE) {
    return apiFetch('/api/auth/totp-token-exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // server_id isn't passed - the route looks up the server entry by
      // serverUrl, so per-server OAuth still applies for password+TOTP.
      body: JSON.stringify({ serverUrl, username, password, totp, slot, redirectUri, rememberMe }),
    }).then((res) => noteSessionAnswer(res, slot));
  }
  try {
    const tokens = await liteTokenLogin({ serverUrl, username, password, totp, redirectUri });
    // "Remember me" keeps the refresh token across browser restarts
    // (localStorage); otherwise it lives with the tab (sessionStorage).
    // Signing in again to an account replaces its slot's token: that one is revoked (#1571).
    if (tokens.refreshToken) {
      void replaceLiteRefreshToken(slot, { serverUrl, username, refreshToken: tokens.refreshToken, clientId: tokens.clientId ?? getLiteClientId() }, rememberMe, liteRevokesTokens());
    } else {
      void retireLiteRefreshToken(slot, liteRevokesTokens());
    }
    saveLiteAccessToken(slot, tokens.accessToken, tokens.expiresIn, rememberMe);
    return jsonResponse({ access_token: tokens.accessToken, expires_in: tokens.expiresIn, has_refresh_token: !!tokens.refreshToken });
  } catch (err) {
    if (err instanceof LiteLoginError) return jsonResponse({ error: err.code }, liteErrorStatus(err));
    throw err;
  }
}

/** POST /api/auth/token?slot=N - redeem an OAuth authorization code for `slot`. */
async function exchangeOAuthCode(params: {
  serverUrl: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  slot: number;
  serverId?: string;
  remember: boolean;
}): Promise<Response> {
  const { serverUrl, code, codeVerifier, redirectUri, slot, serverId, remember } = params;
  if (!IS_LITE) {
    return apiFetch(`/api/auth/token?slot=${slot}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        slot,
        ...(serverId ? { server_id: serverId } : {}),
        remember,
        // The desktop app signs in to a server only it knows about.
        ...(IS_DESKTOP_BUILD ? { custom_server_url: serverUrl, client_id: sessionStorage.getItem(DESKTOP_CLIENT_ID_KEY) } : {}),
      }),
    }).then((res) => noteSessionAnswer(res, slot));
  }
  // The login page parked where and as whom to redeem the code
  // (lib/auth/lite-oauth.ts); without it this is not a flow we started. A
  // code is good for one attempt, so the flow goes either way.
  const flow = readLiteOAuthFlow();
  clearLiteOAuthFlow();
  if (!flow) return jsonResponse({ error: 'missing_flow' }, 400);
  try {
    const tokens = await liteExchangeAuthorizationCode({
      tokenEndpoint: flow.tokenEndpoint,
      code,
      codeVerifier,
      redirectUri: flow.redirectUri,
      clientId: flow.clientId,
    });
    // The username is filled in once the session names the account
    // (nameLiteRefreshToken in loginWithOAuth).
    if (tokens.refreshToken) {
      void replaceLiteRefreshToken(slot, {
        serverUrl,
        username: '',
        refreshToken: tokens.refreshToken,
        clientId: flow.clientId,
        tokenEndpoint: flow.tokenEndpoint,
        revocationEndpoint: flow.revocationEndpoint,
      }, flow.persistent, liteRevokesTokens());
    } else {
      void retireLiteRefreshToken(slot, liteRevokesTokens());
    }
    saveLiteAccessToken(slot, tokens.accessToken, tokens.expiresIn, flow.persistent);
    return jsonResponse({ access_token: tokens.accessToken, expires_in: tokens.expiresIn });
  } catch (err) {
    if (err instanceof LiteLoginError) return jsonResponse({ error: err.code }, liteErrorStatus(err));
    throw err;
  }
}

/**
 * Credentials a remembered session signs back in with: the password (Basic
 * auth), or the access token of a token login (Bearer auth).
 */
type RememberedSession = (
  | { serverUrl: string; username: string; password: string; token?: undefined }
  | { serverUrl: string; username: string; token: string; password?: undefined }
) & {
  /** The session an impersonation handoff opened (set by the server). */
  impersonated?: boolean;
};

/** A client for remembered credentials. */
function clientForSession(session: RememberedSession): JMAPClient {
  return session.token !== undefined
    ? JMAPClient.withBearer(session.serverUrl, session.token, session.username)
    : new JMAPClient(session.serverUrl, session.username, session.password);
}

/**
 * Whether a sign-in made with "Remember me" unticked lasts until the browser
 * closes (BROWSER_SESSION_SIGN_IN; the server turns it on only with a
 * SESSION_SECRET). Its cookies then have no expiry, and a reload or a new tab
 * restores it from them. Lite keeps such a sign-in with the tab instead.
 * For a sign-in, which happens on a page that has the config already.
 */
function keepsUntickedSignInNow(): boolean {
  return !IS_LITE && getCachedConfig()?.browserSessionSignIn === true;
}

/** {@link keepsUntickedSignInNow} at start-up, when the config may still be on its way. */
async function keepsUntickedSignIn(): Promise<boolean> {
  if (IS_LITE) return false;
  if (getCachedConfig()) return keepsUntickedSignInNow();
  try {
    return (await fetchConfig()).browserSessionSignIn === true;
  } catch {
    return false;
  }
}

/**
 * A restore the server refused because the slot has no cookie at all. For a
 * sign-in kept until the browser closes, that means the browser was closed:
 * the sign-in ended as the user chose, not because anything went wrong.
 */
async function slotCookieGone(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  try {
    const { error } = await res.clone().json() as { error?: unknown };
    return error === 'No session' || error === 'No refresh token';
  } catch {
    return false;
  }
}

/**
 * POST /api/auth/session?slot=N - keep a password or access token for `slot`:
 * for 30 days when `remember`, until the browser closes otherwise.
 */
async function persistSession(slot: number, session: RememberedSession, remember = true): Promise<void> {
  if (IS_LITE) {
    // Only reached for a password when the server has no token login: keep
    // the credentials with this tab so a reload does not sign the user out.
    saveLiteBasicSession(slot, session);
    return;
  }
  // A slot being signed out must not get its cookie back; sign-out waits for
  // a write still running (login doesn't wait for it, see there).
  if (closingSlots.has(slot)) return;
  try {
    const res = await trackSessionWrite(slot, (signal) => apiFetch(`/api/auth/session?slot=${slot}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...session, slot, ...(remember ? {} : { remember: false }) }),
      signal,
    })).then((answer) => noteSessionAnswer(answer, slot));
    if (!res.ok) debug.error('Failed to store session: server returned', res.status);
  } catch (err) {
    debug.error('Failed to store session:', err);
  }
}

/**
 * When the server says each cookie slot signed in, from the sign-in and
 * restore answers. The organisation's maximum session length counts from
 * the server's time in the browser too, so the server never refuses a
 * session before the browser warned (lib/auth/session-age.ts).
 */
const serverSignedInAt = new Map<number, number>();

/**
 * The server's sign-in time for a sign-in to `slot` that just happened, or
 * the browser's clock. An older answer belongs to an earlier sign-in.
 */
export function signedInAtForSlot(slot: number | undefined): number {
  const now = Date.now();
  const server = slot !== undefined ? serverSignedInAt.get(slot) : undefined;
  return server !== undefined && Math.abs(now - server) < 10 * 60 * 1000 ? server : now;
}

/**
 * Reads what a sign-in, restore or renewal answer says about the session:
 * the server's sign-in time, or that it refused the session because it
 * reached the organisation's maximum length. The login page says so only
 * when no other account stays signed in here; a later successful restore
 * takes the reason back.
 */
async function noteSessionAnswer(res: Response, slot: number | undefined): Promise<Response> {
  if (typeof res.clone !== 'function' || (!res.ok && res.status !== 401)) return res;
  try {
    const data = await res.clone().json() as { error?: unknown; maxHours?: unknown; signedInAt?: unknown; signed_in_at?: unknown };
    if (res.ok) {
      clearSessionEnd();
      const at = typeof data?.signedInAt === 'number' ? data.signedInAt : data?.signed_in_at;
      if (typeof at === 'number' && Number.isFinite(at) && slot !== undefined) {
        serverSignedInAt.set(slot, at);
        const account = useAccountStore.getState().accounts.find((a) => a.cookieSlot === slot);
        if (account && account.signedInAt !== at) useAccountStore.getState().updateAccount(account.id, { signedInAt: at });
      }
    } else if (data?.error === SESSION_TOO_OLD && typeof data.maxHours === 'number') {
      const othersSignedIn = useAccountStore.getState().accounts.some((a) => a.cookieSlot !== slot && a.isConnected);
      if (!othersSignedIn) rememberSessionEnd({ kind: 'max', hours: data.maxHours });
    }
  } catch {
    /* not JSON */
  }
  return res;
}

/**
 * PUT /api/auth/token?slot=N - renew (or, unless `force`, reuse) the slot's
 * access token. `remember: false` keeps a rotated refresh token in a cookie
 * that ends with the browser session.
 */
function fetchSlotAccessToken(slot: number, opts: { force?: boolean; remember?: boolean } = {}): Promise<Response> {
  // Renewing would write the tokens of a slot being signed out back.
  if (closingSlots.has(slot)) return Promise.resolve(jsonResponse({ error: 'signed_out' }, 401));
  // Tracked from before the wait, so a sign-out can call off a renewal still
  // queued on the lock.
  return trackSessionWrite(slot, (signal) => withTokenLock(slot, async ({ contended }) => {
    // The slot may have started closing during the wait.
    if (closingSlots.has(slot)) return jsonResponse({ error: 'signed_out' }, 401);
    // One at a time across windows: each must send the refresh token the last
    // answer wrote (lib/auth/token-lock.ts). After waiting for another window,
    // what it renewed is what this one wanted: forcing a second renewal this
    // soon can be refused (Rauthy `nbf`, #552).
    const force = opts.force && !contended;
    if (!IS_LITE) {
      const query = `${force ? '&force=true' : ''}${opts.remember === false ? '&remember=false' : ''}`;
      const renewal = renewalSignal(signal);
      return apiFetch(`/api/auth/token?slot=${slot}${query}`, { method: 'PUT', signal: renewal.signal })
        .then((res) => noteSessionAnswer(res, slot))
        .finally(renewal.done);
    }
    // Like the route's cookie cache: a restore resumes with the token it had,
    // since a renewal before the refresh token's `nbf` is refused (#552).
    if (!force) {
      const cached = readLiteAccessToken(slot);
      if (cached) return jsonResponse({ access_token: cached.accessToken, expires_in: cached.expiresIn });
    }
    try {
      const tokens = await liteRefreshTokens(slot);
      return jsonResponse({ access_token: tokens.accessToken, expires_in: tokens.expiresIn });
    } catch (err) {
      if (err instanceof LiteLoginError) return jsonResponse({ error: err.code }, liteErrorStatus(err));
      throw err; // network failure - callers treat it as an outage, not a rejection
    }
  }, { signal }));
}

/** PUT /api/auth/session[?slot=N] - the slot's remembered password or access token. */
async function fetchSlotSession(slot?: number): Promise<Response> {
  if (!IS_LITE) {
    return apiFetch(slot === undefined ? '/api/auth/session' : `/api/auth/session?slot=${slot}`, { method: 'PUT' })
      .then((res) => noteSessionAnswer(res, slot ?? 0));
  }
  const stored = readLiteBasicSession(slot ?? 0);
  return stored ? jsonResponse(stored) : jsonResponse({ error: 'no_session' }, 401);
}

/**
 * DELETE one of the credential endpoints. Resolves to the JSON body, or null
 * when the server could not clear it - reported, since those credentials may
 * then still resume the session. keepalive lets a request that outlives the
 * cleanup timeout finish after the page has navigated away.
 */
async function deleteCredentials(path: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await apiFetch(path, { method: 'DELETE', keepalive: true });
    if (!res.ok) {
      console.warn(`[auth] Sign-out could not clear ${path}: HTTP ${res.status}`);
      return null;
    }
    return await res.json().catch(() => ({}));
  } catch (err) {
    console.warn(`[auth] Sign-out could not reach ${path}:`, err);
    return null;
  }
}

/** The provider logout URL from a token DELETE answer, when it is one a browser may be sent to. */
function readEndSessionUrl(body: Record<string, unknown> | null): string | null {
  const url = body?.end_session_url;
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Clear credentials for the closing `slots` once their in-flight session
 * writes have settled, then reopen the slots. `requests` issues the DELETEs
 * and picks the provider logout URL out of the answers.
 */
async function clearClosingSlots(
  slots: ReadonlySet<number>,
  requests: () => Promise<string | null>,
): Promise<string | null> {
  const previous = [...new Set([...slots].map((slot) => credentialCleanups.get(slot)).filter((work) => work !== undefined))];
  const settled = settleSessionWrites(slots);
  const currentCleanup = settled.then(requests);
  const cleanup = Promise.all([...previous, currentCleanup]).then((answers) => answers[answers.length - 1]);
  for (const slot of slots) credentialCleanups.set(slot, cleanup);
  void cleanup.finally(() => {
    for (const slot of slots) if (credentialCleanups.get(slot) === cleanup) credentialCleanups.delete(slot);
  }).catch(() => {});
  try {
    await settled;
    const result = await withTimeout(currentCleanup, CREDENTIAL_CLEANUP_TIMEOUT_MS);
    if (result === TIMED_OUT) {
      console.warn('[auth] Sign-out cleanup is taking long; finishing it in the background');
      return null;
    }
    return result;
  } finally {
    for (const slot of slots) closingSlots.delete(slot);
  }
}

/**
 * Revoke and clear a slot's credentials: the remembered session and, with
 * `includeToken`, the refresh token. With `endSession`, resolves to the URL
 * that ends the identity provider's session, when there is one.
 */
function clearSlotCredentials(slot: number, includeToken: boolean, endSession = false): Promise<string | null> {
  closingSlots.add(slot);
  return clearClosingSlots(new Set([slot]), async () => {
    if (IS_LITE) {
      await revokeLiteSlot(slot, getCachedConfig()?.oauthRevokeOnSignOut !== false);
      return null;
    }
    const [, token] = await Promise.all([
      deleteCredentials(`/api/auth/session?slot=${slot}`),
      includeToken ? deleteCredentials(`/api/auth/token?slot=${slot}${endSession ? '&end_session=true' : ''}`) : null,
    ]);
    return readEndSessionUrl(token);
  });
}

/**
 * Revoke and clear every slot's credentials. With `endSessionSlot`, resolves
 * to the URL that ends that slot's identity provider session, when there is one.
 */
function clearAllCredentials(endSessionSlot: number | null): Promise<string | null> {
  const slots = new Set(Array.from({ length: MAX_ACCOUNT_SLOTS }, (_, i) => i));
  for (const slot of slots) closingSlots.add(slot);
  return clearClosingSlots(slots, async () => {
    if (IS_LITE) {
      await revokeAllLiteSessions(getCachedConfig()?.oauthRevokeOnSignOut !== false);
      return null;
    }
    const endSession = endSessionSlot === null ? '' : `&end_session_slot=${endSessionSlot}`;
    const [, token] = await Promise.all([
      deleteCredentials('/api/auth/session?all=true'),
      deleteCredentials(`/api/auth/token?all=true${endSession}`),
    ]);
    return readEndSessionUrl(token);
  });
}

/**
 * Whether signing `account` out should also end its identity provider
 * session: only for a sign-in through the provider's own login (OAuth code or
 * SSO flow - a password login leaves no provider session to end), only when
 * the page can navigate the whole window (an embedding portal owns SSO and is
 * told through the iframe bridge instead), and not in Lite, which has no
 * server to build the logout request.
 */
function shouldEndProviderSession(account: AccountEntry | null | undefined): boolean {
  return !!account?.providerSession && !IS_LITE && !isEmbedded();
}

/**
 * The account whose provider session "Sign out of all accounts" ends. A page
 * can make one top-level navigation, so one provider can be visited: the
 * active account's, when it signed in through one, else the first such account
 * in the list. Accounts on that same provider share its browser session and
 * are signed out of it together. Accounts on other providers are signed out of
 * Bulwark and their tokens revoked, but those providers' sessions stay open.
 */
export function pickEndSessionSlot(accounts: AccountEntry[], activeAccountId: string | null): number | null {
  const eligible = accounts.filter((account) => shouldEndProviderSession(account));
  const target = eligible.find((account) => account.id === activeAccountId) ?? eligible[0];
  return target ? target.cookieSlot : null;
}

/** Accounts the server refused during a connect that hasn't reported back yet. */
const refusedAtConnect = new Set<string>();
/** errorMessage of an account the server refused as a whole (AccountUnavailableError). */
const ACCOUNT_REFUSED = 'account_refused';
const endingRefused = new Set<string>();

/** A client that's connected: what the server said on the way there is over. */
function holdClient(accountId: string, client: JMAPClient): void {
  clients.set(accountId, client);
  refusedAtConnect.delete(accountId);
}

/**
 * This login ended with nobody asking: the server refused it, or the organisation's
 * idle or session limit ran out. The data hides from here on. It waits for the next
 * sign-in, or goes after 30 days, or now if the organisation asks for that
 * (lib/devices/wipe-state.ts, lib/offline/device-wipe.ts). The usual cause is a
 * password changed on another device: nothing goes by itself, unsent mail included.
 * `certain`: not one bad answer at a connect.
 */
function noteRefusedLogin(accountId: string, certain: boolean, kind: ForcedSignOutKind = 'refused'): void {
  if (useOfflineStore.getState().enabled.includes(accountId)) {
    const { accounts } = useAccountStore.getState();
    const account = accounts.find((entry) => entry.id === accountId);
    markLoginRefused(accountId, {
      certain,
      kind,
      seenBy: accounts.filter((entry) => entry.id !== accountId).map((entry) => entry.id),
      label: account?.email || account?.username,
      username: account?.username,
    });
    markEvicted(accountId);
  }
  noteCredentialsRejected(accountId, certain, kind);
}

/**
 * The server kept refusing this login, after a fresh try each time: it signs out
 * at once. It has no parsed refusal like `invalid_grant` to go by, and this is the
 * only word a password login ever gets.
 */
async function endRefusedLogin(accountId: string, get: () => AuthState): Promise<void> {
  const account = useAccountStore.getState().getAccountById(accountId);
  if (!account || endingRefused.has(accountId)) return;
  endingRefused.add(accountId);
  try {
    if (get().activeAccountId !== accountId) {
      noteRefusedLogin(accountId, true);
      get().removeAccount(accountId, 'evicted');
      return;
    }
    await saveDraftsBeforeExpiry(account.cookieSlot ?? 0);
    noteRefusedLogin(accountId, true);
    notifyParent('sso:session-expired');
    markSessionExpired();
    await get().logout({ endProviderSession: false, keepLocalData: true });
  } finally {
    endingRefused.delete(accountId);
  }
}

function bindClientStatusHandlers(
  client: IJMAPClient,
  set: (state: Partial<AuthState>) => void,
  get: () => AuthState,
  accountId?: string,
): void {
  client.onCredentialsRefused?.((refusedForMs) => {
    // A pop-out is on another window's session. Lite keeps no data to wait.
    if (!accountId || IS_LITE || isPopoutWindow()) return;
    // Still connecting: the restore that started this decides, when it fails.
    if (clients.get(accountId) !== client) {
      refusedAtConnect.add(accountId);
      return;
    }
    if (refusedForMs >= CREDENTIALS_REFUSED_CONFIRM_MS) void endRefusedLogin(accountId, get);
  });

  // Refused as a whole, e.g. deleted on the server (#1539): the client has stopped,
  // and the account list shows it in trouble. Switching to it asks for a sign-in.
  client.onAccessRefused?.(() => {
    if (!accountId) return;
    useAccountStore.getState().updateAccount(accountId, { isConnected: false, hasError: true, errorMessage: ACCOUNT_REFUSED });
  });

  client.onConnectionChange((connected) => {
    if (!accountId || get().activeAccountId === accountId) {
      set({ connectionLost: !connected });
    }
    if (accountId) {
      useAccountStore.getState().updateAccount(accountId, { isConnected: connected });
    }
  });

  client.onRateLimit((rateLimited, retryAfterMs) => {
    const isActiveAccount = !accountId || get().activeAccountId === accountId;
    const nextRateLimitUntil = rateLimited ? Date.now() + retryAfterMs : null;

    if (isActiveAccount) {
      set({
        isRateLimited: rateLimited,
        rateLimitUntil: nextRateLimitUntil,
        connectionLost: false,
      });
    }

    if (accountId) {
      useAccountStore.getState().updateAccount(accountId, {
        isConnected: !rateLimited,
        hasError: rateLimited,
        errorMessage: rateLimited ? 'Temporarily rate limited by server' : undefined,
      });
    }
  });
}

function loadIdentities(rawIdentities: Identity[], username: string): { identities: Identity[]; primaryIdentity: Identity | null } {
  // The synced per-account default sender identity (#507) is keyed by
  // AccountEntry.id and re-applied by applyPreferredIdentity() once
  // loadFromServer resolves (the accountId isn't known here). At load time we
  // only honour the browser-local fallback (identity-storage) so the ordering
  // is stable before - or entirely without - settings sync.
  const preferredPrimaryId = useIdentityStore.getState().preferredPrimaryId;

  const identities = sortIdentities(rawIdentities, username);

  // If a local preferred primary is set, move it to the front.
  if (preferredPrimaryId) {
    const idx = identities.findIndex((id) => id.id === preferredPrimaryId);
    if (idx > 0) {
      const [preferred] = identities.splice(idx, 1);
      identities.unshift(preferred);
    }
  }

  const primaryIdentity = identities[0] ?? null;
  useIdentityStore.getState().setIdentities(identities);
  return { identities, primaryIdentity };
}

/**
 * Re-apply the per-account default sender identity once synced settings are
 * available (issue #507). The choice is stored server-side in the settings
 * store (`preferredIdentityIds`, keyed by AccountEntry.id), so it can only be
 * applied after `loadFromServer` resolves. It reorders the account's identities
 * so the preferred one is primary - the composer defaults its `From` to
 * identities[0]. No-op when nothing is configured for the account.
 *
 * Also performs the one-time migration of the pre-#507 browser-local default
 * (identity-storage) into the synced per-account map, keyed by accountId.
 *
 * @param accountId The account to apply for; defaults to the active account.
 */
/**
 * Load the account's synced settings and turn syncing back on for it. Every
 * path that makes an account active after sync was switched off for the
 * previous one must run this, or later edits are never saved to the server.
 */
function resumeSettingsSync(account: Pick<AccountEntry, 'id' | 'username' | 'serverUrl'>): void {
  fetchConfig().then(config => {
    if (!config.settingsSyncEnabled) return;
    useSettingsStore.getState().loadFromServer(account.username, account.serverUrl).finally(() => {
      useSettingsStore.getState().enableSync(account.username, account.serverUrl);
      applyPreferredIdentity(account.id);
    });
  }).catch(() => {});
}

export function applyPreferredIdentity(accountId?: string | null): void {
  const targetId = accountId ?? useAccountStore.getState().activeAccountId;
  if (!targetId) return;

  const idStore = useIdentityStore.getState();
  // Only touch the live identity store when it currently holds this account's
  // identities (true for the active account). Switching snapshots/restores the
  // ordering per account, so a background account's order is restored later.
  // The local fallback below also belongs to the active account, so gate first.
  if (useAccountStore.getState().activeAccountId !== targetId) return;

  let preferred = useSettingsStore.getState().preferredIdentityIds[targetId] ?? null;

  // One-time migration: before #507 the default lived only in the browser-local
  // identity-storage (never synced). If the synced map has no entry for this
  // account yet, adopt that local value and persist it (keyed by accountId) so
  // it follows the user across devices.
  if (!preferred) {
    const legacy = idStore.preferredPrimaryId;
    if (legacy) {
      preferred = legacy;
      const current = useSettingsStore.getState().preferredIdentityIds;
      useSettingsStore.getState().updateSetting('preferredIdentityIds', { ...current, [targetId]: legacy }, { internal: true });
    }
  }
  if (!preferred) return;

  idStore.setPreferredPrimary(preferred);
  const ids = [...idStore.identities];
  const idx = ids.findIndex((i) => i.id === preferred);
  if (idx > 0) {
    const [p] = ids.splice(idx, 1);
    ids.unshift(p);
    idStore.setIdentities(ids);
  }
  useAuthStore.setState({ identities: ids, primaryIdentity: ids[0] ?? null });
}

function getLocaleLoginPath(): string {
  if (typeof window === 'undefined') return '/en/login';

  const prefix = getPathPrefix();
  const locale = getLocaleFromPath();
  return `${prefix}/${locale}/login`;
}

/**
 * Set once sign-out has sent the browser to the identity provider's logout.
 * The pages' auth guards answer the signed-out state by heading for the login
 * page, and that later navigation would cancel the one to the provider.
 */
let leavingForProviderLogout = false;

/**
 * Remembers where the user was so login can send them back. Stores the query
 * and hash too, not just the path - a deep link's disambiguators (#733) live
 * there, and dropping them silently lands the user on the wrong thing.
 */
export function saveRedirectAfterLogin(): void {
  if (typeof window === 'undefined' || leavingForProviderLogout) return;

  try {
    const loginPath = getLocaleLoginPath();
    const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;

    // The app's home is where a login lands anyway. Saving it only made the
    // login page navigate a second time, through the locale-aware router,
    // which prefixes the locale again (/en/en) and races the first.
    const home = `${getPathPrefix()}/${getLocaleFromPath()}`;
    if (currentPath === home || currentPath === `${home}/`) {
      sessionStorage.removeItem('redirect_after_login');
      return;
    }

    if (currentPath !== loginPath) {
      sessionStorage.setItem('redirect_after_login', currentPath);
    }
  } catch {
    /* noop */
  }
}

/**
 * Whether the login page can be reached without reloading the app. Before a
 * session was usable on this page load there is no mail state to throw away,
 * so a client-side navigation does and the app isn't downloaded and started
 * a second time; after one, the reload is what clears it.
 *
 * Not in Lite: its static router lands on `/login/` with a trailing slash,
 * which the login path checks here (`/login`) don't recognise.
 */
export function canEnterLoginInPlace(): boolean {
  return !IS_LITE && !signedInSincePageLoad && !leavingForProviderLogout;
}

export function redirectToLogin(): void {
  if (typeof window === 'undefined' || leavingForProviderLogout) return;
  navigateToLogin();
}

function navigateToLogin(): void {
  if (typeof window === 'undefined') return;
  // Signing in happens in the main window; a pop-out just goes away.
  if (isPopoutWindow()) {
    closePopoutWindow();
    return;
  }

  const loginPath = getLocaleLoginPath();
  if (window.location.pathname === loginPath) return;
  replaceWindowLocation(loginPath);
}

/** How long an expired session waits for the open composers to save. */
const EXPIRY_DRAFT_FLUSH_MS = 3000;
/** Set when an expired session couldn't save every open message; the login page says so. */
export const SESSION_EXPIRED_DRAFTS_UNSAVED_KEY = 'session_expired_drafts_unsaved';

/**
 * The server refused to renew the session. The access token in hand usually
 * still works for a while (renewal runs before it expires), so the open
 * composers save their drafts with it before the sign-out throws their
 * state away, as the organisation's idle timeout does (WCAG 2.2.5). The
 * slot counts as closing meanwhile: a save that needs a new token gets none
 * at once instead of waiting on this refresh. Bounded, so a hung save never
 * keeps an expired session open.
 */
async function saveDraftsBeforeExpiry(slot: number): Promise<void> {
  closingSlots.add(slot);
  try {
    const result = await flushComposers(EXPIRY_DRAFT_FLUSH_MS);
    if (result.failed > 0 || result.timedOut) {
      try {
        sessionStorage.setItem(SESSION_EXPIRED_DRAFTS_UNSAVED_KEY, 'true');
      } catch {
        /* noop */
      }
    }
  } catch {
    /* the sign-out goes on */
  }
}

function markSessionExpired(): void {
  try {
    sessionStorage.setItem('session_expired', 'true');
  } catch {
    /* noop */
  }

  saveRedirectAfterLogin();
}

const SIGNED_OUT_KEY = 'signed_out';

/**
 * True once after the user signed out on purpose. The login page then skips
 * automatic SSO: it would sign the user straight back in whenever the
 * provider's session outlived the sign-out (#905).
 */
export function consumeSignedOut(): boolean {
  try {
    const signedOut = sessionStorage.getItem(SIGNED_OUT_KEY) === 'true';
    sessionStorage.removeItem(SIGNED_OUT_KEY);
    return signedOut;
  } catch {
    return false;
  }
}

/**
 * Leave the app after a full sign-out: through the identity provider's logout
 * when there is one to end, otherwise straight to the login page.
 */
function finishSignOut(endSessionUrl: string | null, userInitiated: boolean): void {
  if (userInitiated) {
    try {
      sessionStorage.setItem(SIGNED_OUT_KEY, 'true');
    } catch {
      /* noop */
    }
  }
  if (endSessionUrl) {
    // The desktop build signs in through the system browser, so the provider's
    // session lives there. The window itself goes straight to the login page.
    const desktopShell = IS_DESKTOP_BUILD ? getDesktopBridge()?.shell : undefined;
    if (desktopShell) {
      desktopShell.openExternal(endSessionUrl);
      navigateToLogin();
      return;
    }
    leavingForProviderLogout = true;
    replaceWindowLocation(endSessionUrl);
    return;
  }
  navigateToLogin();
}

function initializeFeatureStores(client: IJMAPClient): void {
  if (client.supportsContacts()) {
    const contactStore = useContactStore.getState();
    contactStore.setSupportsSync(true);
    contactStore.fetchAddressBooks(client).catch((err) => debug.error('Failed to fetch address books:', err));
    contactStore.fetchContacts(client).catch((err) => debug.error('Failed to fetch contacts:', err));
  } else {
    useContactStore.getState().setSupportsSync(false);
  }

  // Directory (RFC 9670 principals) is independent of contacts support and only
  // works when the server allows directory queries; populates recipient
  // autocomplete with other users on the server.
  if (client.supportsPrincipals()) {
    useContactStore.getState().fetchDirectory(client).catch((err) => debug.error('Failed to fetch directory:', err));
  }

  const vacationStore = useVacationStore.getState();
  if (client.supportsVacationResponse()) {
    vacationStore.setSupported(true);
    vacationStore.fetchVacationResponse(client).catch((err) => debug.error('Failed to fetch vacation response:', err));
  } else {
    vacationStore.setSupported(false);
  }

  if (client.supportsCalendars()) {
    const calendarStore = useCalendarStore.getState();
    calendarStore.setSupported(true);
    calendarStore.fetchCalendars(client).catch((err) => debug.error('Failed to fetch calendars:', err));
  }

  if (client.supportsSieve()) {
    const filterStore = useFilterStore.getState();
    filterStore.setSupported(true);
    filterStore.fetchFilters(client).catch((err) => debug.error('Failed to fetch filters:', err));
  }
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshPromise: Promise<string | null> | null = null;

// Multi-account state: per-account JMAP clients and refresh timers
const clients = new Map<string, JMAPClient>();

/** Server URL recorded on the demo accounts; nothing is ever sent to it. */
const DEMO_SERVER_URL = 'https://demo.example.com';

/**
 * Account switches can overlap (click B, then C before B lands). Each switch
 * takes a generation and gives up at its next await once a newer one has
 * started, so only the last click is applied.
 */
let switchGeneration = 0;
/**
 * True while a switch has cleared the stores and not yet filled them with
 * the target account. A switch starting then must not snapshot the empty
 * stores over the outgoing account's cached state.
 */
let storesClearedForSwitch = false;

/**
 * Snapshot the account whose data is on screen right now and clear the
 * stores. Reads the active account when it runs, not when the switch began:
 * an overlapping switch may have changed it in between, and a snapshot under
 * the wrong key would later restore one account's identities (and so its
 * From address) into another.
 */
function snapshotAndClearForSwitch(activeAccountId: string | null): void {
  if (!storesClearedForSwitch && activeAccountId) {
    snapshotAccount(activeAccountId);
  }
  clearAllStores();
  storesClearedForSwitch = true;
}
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const refreshPromises = new Map<string, Promise<string | null>>();

/** Told when a pop-out's session can't be renewed any more and no main window is left to do it. */
export const SHARED_SESSION_ENDED_EVENT = 'bulwark:shared-session-ended';

function bearerToken(header: string): string | null {
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}

/**
 * A new token for a pop-out, whose credential the server just refused. It asks
 * the main window first: that one owns the renewal, and usually already has
 * the next token. Only with no main window left does the pop-out renew, under
 * the same lock (fetchSlotAccessToken), and it never signs anyone out.
 */
async function renewSharedToken(accountId: string): Promise<string | null> {
  const client = clients.get(accountId);
  const account = useAccountStore.getState().getAccountById(accountId);
  if (!client || !account) return null;
  const rejected = client.getAuthHeader();
  try {
    const answer = await requestWindowSession({ accountId, rejectedAuthHeader: rejected });
    const shared = answer?.sessions.find((session) => session.accountId === accountId);
    if (shared) return shared.authHeader === rejected ? null : bearerToken(shared.authHeader);

    let res = await fetchSlotAccessToken(account.cookieSlot, { remember: account.rememberMe });
    if (res.ok) {
      let { access_token } = await res.json();
      // The cached token is the one the server refused.
      if (`Bearer ${access_token}` === rejected) {
        res = await fetchSlotAccessToken(account.cookieSlot, { force: true, remember: account.rememberMe });
        if (res.ok) ({ access_token } = await res.json());
      }
      if (res.ok) {
        await syncStalwartAuthContext(account.serverUrl, account.username, `Bearer ${access_token}`, account.cookieSlot);
        return access_token;
      }
    }
    if (res.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event(SHARED_SESSION_ENDED_EVENT));
    return null;
  } catch (error) {
    debug.error('Token renewal in a pop-out failed:', error);
    return null;
  }
}

// Retry backoff for transiently failed token refreshes (#588). The values
// are pseudo-expiries for scheduleRefresh - its "expiry - 60s" math turns
// them into delays of 30s, 1m, 2m and 5m (capped). Consecutive failures
// climb the ladder; any success resets it.
const TOKEN_REFRESH_RETRY_LADDER_SECONDS = [90, 120, 180, 360] as const;
const refreshFailureCounts = new Map<string, number>();

function nextRefreshRetrySeconds(accountId?: string): number {
  const key = accountId ?? '__global__';
  const failures = refreshFailureCounts.get(key) ?? 0;
  refreshFailureCounts.set(key, failures + 1);
  return TOKEN_REFRESH_RETRY_LADDER_SECONDS[
    Math.min(failures, TOKEN_REFRESH_RETRY_LADDER_SECONDS.length - 1)
  ];
}

function resetRefreshBackoff(accountId?: string): void {
  refreshFailureCounts.delete(accountId ?? '__global__');
  permanentRefreshFailureCounts.delete(accountId ?? '__global__');
}

// /api/auth/token answers 503 for an upstream outage (retry forever - the IdP
// may come back) but 500/502 for a Bulwark-side failure (misconfiguration,
// broken token response). The latter does not heal by waiting, so after this
// many consecutive answers the account is evicted and the user asked to sign
// in again instead of retrying silently forever. (#972)
const MAX_PERMANENT_REFRESH_FAILURES = 5;
const permanentRefreshFailureCounts = new Map<string, number>();

function isPermanentRefreshFailure(status: number): boolean {
  return status === 500 || status === 502;
}

/** Records a 500/502 refresh answer; true once the consecutive cap is reached. */
function recordPermanentRefreshFailure(status: number, accountId?: string): boolean {
  if (!isPermanentRefreshFailure(status)) return false;
  const key = accountId ?? '__global__';
  const failures = (permanentRefreshFailureCounts.get(key) ?? 0) + 1;
  permanentRefreshFailureCounts.set(key, failures);
  if (failures < MAX_PERMANENT_REFRESH_FAILURES) return false;
  permanentRefreshFailureCounts.delete(key);
  return true;
}

/**
 * What a refused renewal says about the login: the server refused it
 * (invalid_grant), or the organisation's session limit was reached, which says
 * nothing about the password. Both sign out and hide the data (noteRefusedLogin).
 * Anything else keeps it the same way with no word to anyone, including a body
 * we can't read.
 */
async function forcedSignOutOf(res: Response): Promise<ForcedSignOutKind | null> {
  try {
    const { error } = await res.clone().json() as { error?: unknown };
    if (error === 'invalid_grant') return 'refused';
    return error === SESSION_TOO_OLD ? 'session' : null;
  } catch {
    return null;
  }
}

function notifySignInAgain(): void {
  void import('@/stores/toast-store').then(({ toast }) => {
    toast.error('Your session could not be renewed', 'Sign in again to continue.');
  }).catch(() => {});
}

// Only re-arm a failed refresh while someone is still signed in to that
// account. A sign-out during the outage - or while the request was in
// flight - must end the retry loop instead of keeping it alive with
// doomed requests (#588).
function shouldRetryRefresh(slot: number, accountId?: string): boolean {
  if (closingSlots.has(slot)) return false;
  if (accountId) return !!useAccountStore.getState().getAccountById(accountId);
  return useAuthStore.getState().isAuthenticated;
}

function scheduleRefresh(expiresIn: number, refreshFn: () => Promise<string | null>, accountId?: string): void {
  if (accountId) {
    const existing = refreshTimers.get(accountId);
    if (existing) clearTimeout(existing);
    const refreshAt = Math.max((expiresIn - 60) * 1000, 10_000);
    refreshTimers.set(accountId, setTimeout(() => {
      refreshFn().catch((err) => {
        debug.error(`Scheduled token refresh failed for ${accountId}:`, err);
      });
    }, refreshAt));
  } else {
    if (refreshTimer) clearTimeout(refreshTimer);
    const refreshAt = Math.max((expiresIn - 60) * 1000, 10_000);
    refreshTimer = setTimeout(() => {
      refreshFn().catch((err) => {
        debug.error('Scheduled token refresh failed:', err);
      });
    }, refreshAt);
  }
}

/**
 * Derive the accountId a *connected* client actually belongs to, using the
 * same canonicalisation as login (primary-identity email for OAuth, else the
 * JMAP session username). Lets a caller detect a slot->token mapping that
 * resolves to the wrong account before it surfaces as the wrong mailbox.
 * Returns null when it can't determine the identity (treated as "don't block").
 */
export function buildServerIdentifiers(
  sessionUsername: string | undefined,
  primaryEmail: string | undefined,
  serverUrl: string,
): string[] {
  const ids = new Set<string>();
  if (sessionUsername) ids.add(generateAccountId(sessionUsername, serverUrl));
  if (primaryEmail) ids.add(generateAccountId(primaryEmail, serverUrl));
  return [...ids];
}

export async function connectedAccountCandidates(client: JMAPClient, serverUrl: string): Promise<string[]> {
  // accountId is generated differently per auth mode: OAuth/SSO registers from
  // the primary-identity EMAIL, basic auth from the typed login username. A
  // single derivation can't match both, so collect every server-confirmed
  // identifier the connected session exposes — the JMAP Session.username
  // (authenticated login) and the primary sending-identity email — and let the
  // caller accept the session if the target accountId matches ANY of them.
  // Deliberately excludes client.getUsername(), which echoes the constructor
  // username (always the target) and would defeat the desync check. An empty
  // result means nothing could be confirmed → the caller should NOT force a
  // re-auth.
  let sessionUser: string | undefined;
  try {
    sessionUser = client.getSessionUsername();
  } catch { /* session unavailable */ }
  let primaryEmail: string | undefined;
  try {
    // Pure resolution (no setIdentities side effect): this guard runs while the
    // previous account may still be on screen during a seamless switch, so it
    // must not mutate the live identity store.
    const sorted = sortIdentities(await client.getIdentities(), client.getUsername());
    primaryEmail = sorted[0]?.email;
  } catch { /* identities unavailable */ }
  return buildServerIdentifiers(sessionUser, primaryEmail, serverUrl);
}

/**
 * Decide whether a freshly connected session may be bound to `accountId`.
 *
 * `connectedCandidates` are the server-confirmed identifiers of the session we
 * just connected ({@link connectedAccountCandidates}). We accept when they
 * overlap either the stored `accountId` (full-email / OAuth logins, where the
 * id already IS the canonical address) or `storedIdentifiers` — the identifiers
 * captured when THIS account last logged in, which cover a short login username
 * the server canonicalizes to a full address.
 *
 *  - 'accept' — bind the session (matched, or nothing confirmable to check).
 *  - 'trust'  — legacy account with no baseline yet: accept and backfill (TOFU),
 *               so short-username accounts created before this check self-heal
 *               instead of bouncing forever.
 *  - 'reject' — server identity contradicts a known baseline: a real desync;
 *               force a clean re-auth.
 */
export function classifySessionMatch(
  connectedCandidates: string[],
  accountId: string,
  storedIdentifiers: string[] | undefined,
): 'accept' | 'trust' | 'reject' {
  if (connectedCandidates.length === 0) return 'accept';
  const accepted = new Set<string>([accountId, ...(storedIdentifiers ?? [])]);
  if (connectedCandidates.some((c) => accepted.has(c))) return 'accept';
  if (storedIdentifiers === undefined) return 'trust';
  return 'reject';
}

const signInGenerations = new Map<string, number>();
const targetGenerations = new WeakMap<AccountEntry, number>();
useAccountStore.subscribe((state, previous) => {
  for (const account of previous.accounts) {
    if (!state.accounts.some((current) => current.id === account.id)) {
      signInGenerations.set(account.id, (signInGenerations.get(account.id) ?? 0) + 1);
    }
  }
});

function signInTarget(serverUrl: string, accountId?: string | null): AccountEntry | undefined {
  if (!accountId) return undefined;
  const account = useAccountStore.getState().getAccountById(accountId);
  if (!account?.awaitingSignIn || account.serverUrl !== serverUrl) throw new Error('Invalid username or password');
  targetGenerations.set(account, signInGenerations.get(account.id) ?? 0);
  return account;
}

/** A targeted sign-in must not revive a removed entry or reveal another login's mail. */
async function verifySignInTarget(client: JMAPClient, target: AccountEntry | undefined): Promise<void> {
  if (!target) return;
  const candidates = await connectedAccountCandidates(client, target.serverUrl);
  const accepted = new Set([target.id, ...(target.serverIdentifiers ?? []), generateAccountId(target.email, target.serverUrl)]);
  const current = useAccountStore.getState().getAccountById(target.id);
  if (!current?.awaitingSignIn || current.cookieSlot !== target.cookieSlot || current.serverUrl !== target.serverUrl
    || targetGenerations.get(target) !== (signInGenerations.get(target.id) ?? 0)
    || !candidates.some((id) => accepted.has(id))) {
    client.disconnect();
    const owner = useAccountStore.getState().accounts.find((account) => account.cookieSlot === target.cookieSlot);
    if (!owner || (owner.id === target.id && owner.awaitingSignIn)) {
      await clearSlotCredentials(target.cookieSlot, true);
    }
    throw new Error('Invalid username or password');
  }
}

function verifyAdoptedSignIn(accountId: string, client: JMAPClient, target: AccountEntry | undefined): void {
  if (!useAccountStore.getState().getAccountById(accountId) || clients.get(accountId) !== client
    || (target && targetGenerations.get(target) !== (signInGenerations.get(accountId) ?? 0))) {
    client.disconnect();
    throw new Error('Invalid username or password');
  }
}

function clearRefreshTimer(accountId?: string): void {
  if (accountId) {
    const timer = refreshTimers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      refreshTimers.delete(accountId);
    }
    refreshPromises.delete(accountId);
    refreshFailureCounts.delete(accountId);
  } else {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    refreshFailureCounts.delete('__global__');
    refreshPromise = null;
  }
}

function clearAllRefreshTimers(): void {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  refreshPromise = null;
  for (const timer of refreshTimers.values()) clearTimeout(timer);
  refreshTimers.clear();
  refreshPromises.clear();
  refreshFailureCounts.clear();
}

/**
 * Synchronously clears all auth and feature store state.
 * Called during full logout (no remaining accounts).
 */
/**
 * Drop the calendar subscriptions of a login being signed out: they persist
 * across account switches, and their feed URLs are often secret.
 */
function forgetCalendarSubscriptions(client: IJMAPClient): void {
  try {
    useCalendarStore.getState().forgetICalSubscriptions(subscriptionOwner(client));
  } catch {
    // A client that cannot name its server and login owns no subscription.
  }
}

/**
 * A client for an account that couldn't be restored because the server
 * can't be reached, from the session kept with its offline data (#523);
 * null without offline mode for that account. Loaded on demand: offline
 * mode imports this store.
 */
async function startOfflineClient(accountId: string, serverUrl: string, username: string): Promise<JMAPClient | null> {
  if (IS_LITE) return null;
  try {
    const offline = await import('@/lib/offline/offline-mode');
    // Only without a network or a server: a server that refused one request
    // (an overload without CORS headers, a 5xx) gets the usual error.
    if (!(await offline.serverUnreachable(serverUrl))) return null;
    const session = await offline.offlineSessionFor(accountId);
    if (!session) return null;
    offline.markStartedOffline();
    return JMAPClient.fromOfflineSession(serverUrl, username, session);
  } catch {
    return null;
  }
}

/**
 * The account's local copy, to show right away while the real connect runs. A
 * client that answers from the device only; null without the local store for
 * that account, and the start goes the usual way.
 */
async function startLocalCopyClient(accountId: string, serverUrl: string, username: string): Promise<JMAPClient | null> {
  if (IS_LITE || skipLocalCopy || !useOfflineStore.getState().enabled.includes(accountId)) return null;
  try {
    const offline = await import('@/lib/offline/offline-mode');
    // A store that has no folders yet has nothing to show: the snapshot stays up.
    const session = await offline.offlineSessionFor(accountId, { withFolders: true });
    return session ? JMAPClient.fromOfflineSession(serverUrl, username, session) : null;
  } catch {
    return null;
  }
}

// While device-only clients get replaced, restoring goes straight to the server.
let skipLocalCopy = false;

/** Clear a failed session while retaining its remembered sign-in target. */
function requireAccountSignIn(accountId: string): void {
  const accountStore = useAccountStore.getState();
  const account = accountStore.getAccountById(accountId);
  if (!account) return;
  clearRefreshTimer(accountId);
  const client = clients.get(accountId);
  if (client) forgetCalendarSubscriptions(client);
  try { client?.disconnect(); } catch { /* finish cleanup even if disconnected */ }
  clients.delete(accountId);
  evictAccount(accountId);
  forgetAccountRows(accountId, useAuthStore.getState().client);
  accountStore.requireSignIn(accountId);
  forgetPrincipals(accountId);
  clearPluginStorageForAccount(accountId);
  closingSlots.add(account.cookieSlot);
  void clearSlotCredentials(account.cookieSlot, account.authMode === 'oauth');
}

function performFullLogout(set: (state: Partial<AuthState>) => void, options: SignOutCleanupOptions = {}): void {
  useSettingsStore.getState().disableSync();
  // With settings sync on, the local settings and templates are a copy of the
  // signed-out account's server file. Left in place, the next account to sign
  // in here would show them and push them to its own file (#1185).
  useSettingsStore.getState().forgetSyncedSettings();

  set({
    isAuthenticated: false,
    isLoading: false,
    isRateLimited: false,
    rateLimitUntil: null,
    serverUrl: null,
    username: null,
    client: null,
    identities: [],
    primaryIdentity: null,
    authMode: 'basic',
    rememberMe: false,
    accessToken: null,
    tokenExpiresAt: null,
    connectionLost: false,
    error: null,
    activeAccountId: null,
    isDemoMode: false,
  });

  clearAllStores();
  // Calendar subscriptions outlive account switches, but their feed URLs are
  // often secret: nobody is signed in any more, so none may stay behind.
  useCalendarStore.getState().clearICalSubscriptions();
  useSearchHistoryStore.getState().clearRecentSearches();
  useCalendarNotificationStore.getState().clearAll();
  clearAllPluginStorage();

  // Remove persisted state AFTER the final set() so the persist middleware
  // doesn't re-write stale values.
  try { localStorage.removeItem('auth-storage'); } catch { /* noop */ }
  useAccountStore.setState({ activeAccountId: null });
  if (useAccountStore.getState().accounts.length === 0) {
    try { localStorage.removeItem('account-registry'); } catch { /* noop */ }
  }
  // A dropped account's data outlives anyone else's sign-out. The account that
  // signed out takes its own along when it leaves the registry.
  purgeSignedOutData({ keepLocalStore: options.keepLocalStore || Object.keys(readEvicted()).length > 0 });
  // Other tabs still hold the accounts' mail in memory.
  broadcastSignOut();
}

/**
 * How long sign-out waits for plugins to tidy up. Plugins observe sign-out;
 * they cannot stop it or hold it up, or a plugin could keep the user signed
 * in on a shared computer.
 */
export const LOGOUT_HOOK_BUDGET_MS = 2000;

function notifySignedIn(state: { activeAccountId: string | null; username: string | null }): void {
  if (!state.activeAccountId) return;
  // The organisation's maximum session length counts from a sign-in, never
  // from a restore, and from the server's time when it said.
  const slot = useAccountStore.getState().getAccountById(state.activeAccountId)?.cookieSlot;
  useAccountStore.getState().updateAccount(state.activeAccountId, { signedInAt: signedInAtForSlot(slot) });
  void authHooks.onLogin.emit({ accountId: state.activeAccountId, username: state.username ?? '' });
}

/**
 * A provider's tokens are in, with the refresh token already in the slot's cookie: the
 * rest of a sign-in. Server-side SSO, and the desktop app's sign-in on an instance.
 */
async function adoptProviderSession(
  set: (state: Partial<AuthState>) => void,
  get: () => AuthState,
  session: {
    serverUrl: string;
    accessToken: string;
    expiresIn: number;
    remember: boolean | undefined;
    slot: number;
    /**
     * Tokens from a typed password, not a provider's page: the account the user knows, under
     * the name they typed. It has the same id as any other password sign-in with that name, so
     * what its last sign-out kept comes back, and its password settings stay (#1432).
     */
    typedUsername?: string;
  },
): Promise<void> {
  const { serverUrl: ssoServerUrl, accessToken: access_token, expiresIn: expires_in, remember, slot } = session;
  const typed = session.typedUsername ? toAsciiEmail(session.typedUsername) : '';
  const accountStore = useAccountStore.getState();
  let boundAccountId: string | undefined;
  const target = signInTarget(ssoServerUrl, sessionStorage.getItem('oauth_reauthenticate_account'));
  await waitForCredentialCleanup(slot);
  const client = JMAPClient.withBearer(ssoServerUrl, access_token, typed, () => get().refreshAccessToken({ accountId: boundAccountId }));
  await client.connect();

  const jmapUsername = client.getUsername();
  await verifySignInTarget(client, target);
  const { identities, primaryIdentity } = loadIdentities(await client.getIdentities(), typed || jmapUsername);
  // For SSO/OIDC, the JMAP session account name may be the
  // preferred_username claim rather than the real email address.
  // Prefer the email from the primary identity when available.
  const username = target?.username || typed || primaryIdentity?.email || jmapUsername;
  initializeFeatureStores(client);

  const accountId = generateAccountId(username, ssoServerUrl);
  boundAccountId = accountId;

  const prevAccountId = get().activeAccountId;
  if (prevAccountId && prevAccountId !== accountId) {
    snapshotAccount(prevAccountId);
    clearAllStores();
  }

  await checkStoreOwner(accountId, client.getAccountId(), ssoServerUrl);
  await verifySignInTarget(client, target);
  holdClient(accountId, client);
  bindClientStatusHandlers(client, set, get, accountId);

  accountStore.addAccount({
    label: primaryIdentity?.name || username,
    serverUrl: ssoServerUrl,
    username,
    authMode: 'oauth',
    rememberMe: remember !== false,
    displayName: primaryIdentity?.name || username,
    email: primaryIdentity?.email || username,
    lastLoginAt: Date.now(),
    isConnected: true,
    hasError: false,
    isDefault: accountStore.accounts.length === 0,
  });
  // The refresh-token cookie was written to `slot` by /api/auth/sso/complete.
  // Force the stored cookieSlot to match - see loginWithOAuth above for the
  // re-add and concurrent-tab cases this guards against.
  accountStore.updateAccount(accountId, { cookieSlot: slot, providerSession: !typed });
  if (typed) {
    const serverIdentifiers = buildServerIdentifiers(client.getSessionUsername(), primaryIdentity?.email, ssoServerUrl);
    if (serverIdentifiers.length > 0) accountStore.updateAccount(accountId, { serverIdentifiers });
  }
  accountStore.setActiveAccount(accountId);

  await syncStalwartAuthContext(ssoServerUrl, username, client.getAuthHeader(), slot);
  verifyAdoptedSignIn(accountId, client, target);
  void syncAccountDisplayName(accountId, client, primaryIdentity?.name);

  set({
    isAuthenticated: true,
    isLoading: false,
    serverUrl: ssoServerUrl,
    username,
    client,
    ...getClientRateLimitState(client),
    identities,
    primaryIdentity,
    authMode: 'oauth',
    accessToken: access_token,
    tokenExpiresAt: Date.now() + expires_in * 1000,
    connectionLost: false,
    error: null,
    activeAccountId: accountId,
  });

  import('@/stores/email-store').then(({ useEmailStore }) => {
    useEmailStore.getState().prefetchInitialData(client).catch((err) => {
      debug.error('Initial data prefetch failed:', err);
    });
  }).catch(() => {});

  scheduleRefresh(expires_in, () => get().refreshAccessToken({ accountId }), accountId);

  notifyParent('sso:auth-success', { username });

  fetchConfig().then(cfg => {
    if (!cfg.settingsSyncEnabled) return;
    useSettingsStore.getState().loadFromServer(username, ssoServerUrl).finally(() => {
      useSettingsStore.getState().enableSync(username, ssoServerUrl);
      applyPreferredIdentity(accountId);
    });
  }).catch(() => {});

  notifySignedIn(get());
}

/** Within the sign-out's budget: an unreachable server doesn't hold it up. */
function endPushForSignOut(signingOut: Iterable<IJMAPClient>): Promise<void> {
  return Promise.race([
    (async () => {
      const { endWebPushForSignOut } = await import('@/lib/web-push');
      for (const client of signingOut) await endWebPushForSignOut(client);
    })().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, LOGOUT_HOOK_BUDGET_MS)),
  ]);
}

function beforeLogoutHooks(accountId: string, options: SignOutCleanupOptions = {}): Promise<void> {
  return Promise.race([
    Promise.all([authHooks.onBeforeLogout.emit({ accountId }), runBeforeSignOut(accountId, options)]).then(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, LOGOUT_HOOK_BUDGET_MS)),
  ]);
}

/** Test helper: the store's own clients come from signing in. */
export function setClientForTests(accountId: string, client: JMAPClient): void {
  clients.set(accountId, client);
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      isAuthenticated: false,
      isLoading: false,
      error: null,
      isRateLimited: false,
      rateLimitUntil: null,
      serverUrl: null,
      username: null,
      client: null,
      identities: [],
      primaryIdentity: null,
      authMode: 'basic',
      rememberMe: false,
      accessToken: null,
      tokenExpiresAt: null,
      connectionLost: false,
      activeAccountId: null,
      isDemoMode: false,
      connectedAccountsRevision: 0,
      restoringAccounts: false,

      login: async (serverUrl, typedUsername, password, totp, rememberMe, targetId) => {
        set({ isLoading: true, error: null, isRateLimited: false, rateLimitUntil: null });
        // The email store, at hand by the time the first mail requests go out
        // (below), so they're asked for in the same task as the rest.
        let emailStore: typeof import('@/stores/email-store') | null = null;
        const emailStoreLoad = import('@/stores/email-store').then((m) => (emailStore = m));
        emailStoreLoad.catch(() => {});

        // Sign in with the ASCII (punycode) form of an IDN domain, the form
        // Stalwart stores and reports back in the session and identities, so
        // `user@bücher.de` and `user@xn--bcher-kva.de` are one account (#1100).
        const username = toAsciiEmail(typedUsername);

        try {
          // Resolve account/slot info up front so the TOTP exchange can target
          // the right per-account refresh-token cookie slot.
          const accountStore = useAccountStore.getState();
          const target = signInTarget(serverUrl, targetId);
          const accountId = generateAccountId(username, serverUrl);
          if (target && accountId !== target.id) throw new Error('Invalid username or password');
          const cookieSlot = accountStore.hasAccount(username, serverUrl)
            ? (accountStore.getAccountById(accountId)?.cookieSlot ?? accountStore.getNextCookieSlot())
            : accountStore.getNextCookieSlot();
          await waitForCredentialCleanup(cookieSlot);

          let client: JMAPClient;
          let upgradedToOAuth = false;
          // Lite keeps a Basic password for the tab only when the server has
          // no token login to use instead; a token login that failed for
          // another reason must not leave the password in web storage.
          let tokenLoginUnavailable = false;
          let oauthAccessToken: string | null = null;
          let oauthExpiresIn = 0;

          // Lite has no session cookie to remember a password in, so every
          // password login goes through Stalwart's token flow and only a
          // refresh token is kept: localStorage with "remember me", the tab's
          // sessionStorage without it (lib/auth/lite-tokens.ts). Servers
          // without the endpoint fall back to Basic auth below.
          const useTokenLogin = !!totp || IS_LITE;
          if (useTokenLogin) {
            // Stalwart 0.16+ dropped the `password$totp` basic-auth convention;
            // the MFA code must be exchanged for tokens via the structured login
            // endpoint (handled server-side). Token auth also survives TOTP
            // rotation, unlike basic auth which embeds the ~30s code per request.
            let bearerToken: string | null = null;
            try {
              // The callback URL the OAuth client already registers; the route
              // needs an identical redirect URI for the login + token-exchange
              // steps (and registered when require_client_registration is on).
              // Lite on Stalwart uses the mount root instead: one locale-free
              // URI per Application for the admin to register.
              const redirectUri = typeof window === 'undefined'
                ? ''
                : IS_LITE_STALWART
                  ? `${window.location.origin}${getPathPrefix()}/`
                  : `${window.location.origin}${getPathPrefix()}/${getLocaleFromPath()}/auth/callback`;
              const tokenRes = await exchangePasswordForTokens({
                serverUrl, username, password, totp, slot: cookieSlot, redirectUri, rememberMe: !!rememberMe,
              });
              if (tokenRes.ok) {
                const { access_token, expires_in, has_refresh_token } = await tokenRes.json();
                bearerToken = access_token;
                oauthExpiresIn = expires_in;
                debug.log('auth', 'TOTP login exchanged for token-based auth (has_refresh_token=' + has_refresh_token + ')');
              } else {
                if (tokenRes.status === 404) tokenLoginUnavailable = true;
                const errorBody = await tokenRes.json().catch(() => ({ error: 'unknown' }));
                // A correct password with a missing/invalid MFA token surfaces as
                // a TOTP prompt rather than a generic failure.
                if (errorBody?.error === 'totp_required') {
                  throw new Error('TOTP_REQUIRED');
                }
                // The server took the password and code but would not issue
                // tokens (in Lite: an OAuth client with a secret, which a
                // browser cannot send). A server with the structured login
                // endpoint is 0.16+ and refuses `password$totp` over Basic,
                // so the legacy fallback would only pop the browser's
                // Basic-auth dialog and then report a wrong code.
                if (totp && errorBody?.error === 'token_exchange_failed') {
                  throw new Error('TOKEN_EXCHANGE_FAILED');
                }
                debug.warn('auth', 'TOTP login exchange failed, trying legacy basic auth:', tokenRes.status, errorBody);
              }
            } catch (err) {
              if (err instanceof Error && (err.message === 'TOTP_REQUIRED' || err.message === 'TOKEN_EXCHANGE_FAILED')) throw err;
              // Unreachable (a server without /api/auth rarely answers CORS).
              tokenLoginUnavailable = true;
              debug.warn('auth', 'TOTP login exchange error, trying legacy basic auth:', err);
            }

            if (bearerToken) {
              client = JMAPClient.withBearer(serverUrl, bearerToken, username, () => get().refreshAccessToken({ accountId }));
              await client.connect();
              oauthAccessToken = bearerToken;
              upgradedToOAuth = true;
            } else if (totp) {
              // Legacy fallback for pre-0.16 Stalwart, which accepts the TOTP
              // appended to the password over basic auth.
              if (await precheckCredentials(serverUrl, { username, password: `${password}$${totp}` })) {
                throw new Error('Invalid username or password');
              }
              client = new JMAPClient(serverUrl, username, `${password}$${totp}`);
              await client.connect();
              const { useTotpReauthStore } = await import('@/stores/totp-reauth-store');
              client.enableTotpReauth(password, () => useTotpReauthStore.getState().requestTotp());
              debug.log('auth', 'TOTP re-auth enabled (legacy basic-auth path)');
            } else {
              // Lite on a server without token login (or one that blocks the
              // browser's /api/auth call): plain Basic auth; the session is
              // then kept with the tab only, see persistSession.
              client = new JMAPClient(serverUrl, username, password);
              await client.connect();
            }
          } else {
            if (await precheckCredentials(serverUrl, { username, password })) {
              throw new Error('Invalid username or password');
            }
            client = new JMAPClient(serverUrl, username, password);
            await client.connect();
          }

          await verifySignInTarget(client, target);

          // Snapshot/clear before kicking off any feature-store fetches so they
          // don't write into stores we're about to wipe.
          const prevAccountId = get().activeAccountId;
          if (prevAccountId && prevAccountId !== accountId) {
            snapshotAccount(prevAccountId);
            clearAllStores();
          }

          // Identities can fly in parallel with everything below.
          const identitiesPromise = client.getIdentities();

          const effectiveAuthMode = upgradedToOAuth ? 'oauth' : 'basic';

          // Run the remaining independent requests in parallel. The session
          // write and stalwart-context write are best-effort persistence; the
          // outer login still succeeds even if they log a warning. Errors are
          // caught locally so Promise.all doesn't reject on either. Only the
          // context is waited for: the server-side helpers the mail view
          // calls next need it, while the remembered session only matters
          // for the next visit (and sign-out waits for its write).
          // In Lite a Basic session is kept for the tab (sessionStorage) on a
          // server without token login, so a reload does not sign the user
          // out; the regular build only writes the cookie when the user asked
          // to be remembered, or, unticked, when the admin keeps such a
          // sign-in until the browser closes.
          if ((IS_LITE ? tokenLoginUnavailable : rememberMe || keepsUntickedSignInNow()) && !upgradedToOAuth) {
            void persistSession(cookieSlot, { serverUrl, username, password }, !!rememberMe);
          }

          const [rawIdentities] = await Promise.all([
            identitiesPromise,
            syncStalwartAuthContext(serverUrl, username, client.getAuthHeader(), cookieSlot),
          ]);

          const { identities, primaryIdentity } = loadIdentities(rawIdentities, username);

          await checkStoreOwner(accountId, client.getAccountId(), serverUrl);
          await verifySignInTarget(client, target);
          // Store client in multi-account map
          holdClient(accountId, client);
          bindClientStatusHandlers(client, set, get, accountId);

          // Mailboxes, quota and the folder's first page first: the first
          // rows wait for them, and nothing else here does. Asked for before
          // the other stores' first requests and before the sign-in flips the
          // app to signed in (below, in this same task, so the auth and
          // account stores never disagree). The email store comes by dynamic
          // import (no static circular dep), loaded since login() started.
          const prefetch = (m: typeof import('@/stores/email-store')) => m.useEmailStore.getState().prefetchInitialData(client).catch((err) => {
            debug.error('Initial data prefetch failed:', err);
          });
          if (emailStore) void prefetch(emailStore);
          else emailStoreLoad.then(prefetch).catch(() => {});
          initializeFeatureStores(client);

          accountStore.addAccount({
            label: primaryIdentity?.name || username,
            serverUrl,
            username,
            authMode: effectiveAuthMode,
            rememberMe: !!rememberMe,
            displayName: primaryIdentity?.name || username,
            email: primaryIdentity?.email || username,
            lastLoginAt: Date.now(),
            isConnected: true,
            hasError: false,
            isDefault: accountStore.accounts.length === 0,
          });
          accountStore.setActiveAccount(accountId);
          void syncAccountDisplayName(accountId, client, primaryIdentity?.name);

          // Update account entry in case it already existed (addAccount is a no-op for existing accounts)
          accountStore.updateAccount(accountId, {
            authMode: effectiveAuthMode,
            rememberMe: !!rememberMe,
            providerSession: false,
            isConnected: true,
            hasError: false,
            errorMessage: undefined,
            lastLoginAt: Date.now(),
          });

          // Capture the server-confirmed identity now so a later account switch
          // recognizes this session even when `username` is a short login name
          // the server canonicalizes to a different address (see the switch guard).
          const serverIdentifiers = buildServerIdentifiers(client.getSessionUsername(), primaryIdentity?.email, serverUrl);
          if (serverIdentifiers.length > 0) {
            accountStore.updateAccount(accountId, { serverIdentifiers });
          }

          set({
            isAuthenticated: true,
            isLoading: false,
            serverUrl,
            username,
            client,
            ...getClientRateLimitState(client),
            identities,
            primaryIdentity,
            authMode: effectiveAuthMode,
            rememberMe: !!rememberMe,
            accessToken: oauthAccessToken,
            tokenExpiresAt: oauthAccessToken ? Date.now() + oauthExpiresIn * 1000 : null,
            connectionLost: false,
            error: null,
            activeAccountId: accountId,
          });

          // Schedule token refresh for TOTP-upgraded sessions
          if (upgradedToOAuth && oauthExpiresIn > 0) {
            scheduleRefresh(oauthExpiresIn, () => get().refreshAccessToken({ accountId }), accountId);
          }

          // Sync settings from server (only if enabled)
          fetchConfig().then(config => {
            if (!config.settingsSyncEnabled) return;
            useSettingsStore.getState().loadFromServer(username, serverUrl).finally(() => {
              useSettingsStore.getState().enableSync(username, serverUrl);
              applyPreferredIdentity(accountId);
            });
          }).catch(() => {});

          notifySignedIn(get());
          return true;
        } catch (error) {
          debug.error('Login error:', error);
          set({
            isLoading: false,
            error: classifyLoginError(error),
            isAuthenticated: false,
            isRateLimited: false,
            rateLimitUntil: null,
            client: null,
          });
          return false;
        }
      },

      loginWithToken: async (serverUrl, typedToken, rememberMe, targetId) => {
        set({ isLoading: true, error: null, isRateLimited: false, rateLimitUntil: null });

        // Pasted tokens often come with the scheme or surrounding whitespace.
        const token = typedToken.trim().replace(/^Bearer\s+/i, '');

        try {
          const target = signInTarget(serverUrl, targetId);
          if (!token || /\s/.test(token) || await precheckCredentials(serverUrl, { token })) {
            throw new Error('INVALID_TOKEN');
          }

          // No refresh callback: a pasted token cannot be renewed.
          const client = JMAPClient.withBearer(serverUrl, token, '');
          try {
            await client.connect();
          } catch (err) {
            if (err instanceof Error && /^Authentication failed|: 40[13]$/.test(err.message)) {
              throw new Error('INVALID_TOKEN');
            }
            throw err;
          }

          await verifySignInTarget(client, target);
          const username = target?.username || client.getSessionUsername() || client.getUsername();
          if (!username) throw new Error('The server did not name the account');

          const accountStore = useAccountStore.getState();
          const accountId = generateAccountId(username, serverUrl);
          const cookieSlot = accountStore.getAccountById(accountId)?.cookieSlot ?? accountStore.getNextCookieSlot();
          await waitForCredentialCleanup(cookieSlot);

          const prevAccountId = get().activeAccountId;
          if (prevAccountId && prevAccountId !== accountId) {
            snapshotAccount(prevAccountId);
            clearAllStores();
          }

          // Lite keeps the token with the tab either way, like its Basic
          // sessions; the regular build only when asked to remember it, or
          // until the browser closes when the admin allows that.
          const [rawIdentities] = await Promise.all([
            client.getIdentities(),
            IS_LITE || rememberMe || keepsUntickedSignInNow() ? persistSession(cookieSlot, { serverUrl, username, token }, !!rememberMe) : null,
            syncStalwartAuthContext(serverUrl, username, client.getAuthHeader(), cookieSlot),
          ]);

          const { identities, primaryIdentity } = loadIdentities(rawIdentities, username);
          initializeFeatureStores(client);

          await checkStoreOwner(accountId, client.getAccountId(), serverUrl);
          await verifySignInTarget(client, target);
          holdClient(accountId, client);
          bindClientStatusHandlers(client, set, get, accountId);

          accountStore.addAccount({
            label: primaryIdentity?.name || username,
            serverUrl,
            username,
            authMode: 'token',
            rememberMe: !!rememberMe,
            displayName: primaryIdentity?.name || username,
            email: primaryIdentity?.email || username,
            lastLoginAt: Date.now(),
            isConnected: true,
            hasError: false,
            isDefault: accountStore.accounts.length === 0,
          });
          // The session was remembered at `cookieSlot`; see loginWithOAuth.
          const serverIdentifiers = buildServerIdentifiers(client.getSessionUsername(), primaryIdentity?.email, serverUrl);
          accountStore.updateAccount(accountId, {
            cookieSlot,
            authMode: 'token',
            rememberMe: !!rememberMe,
            providerSession: false,
            ...(serverIdentifiers.length > 0 ? { serverIdentifiers } : {}),
          });
          accountStore.setActiveAccount(accountId);
          void syncAccountDisplayName(accountId, client, primaryIdentity?.name);

          set({
            isAuthenticated: true,
            isLoading: false,
            serverUrl,
            username,
            client,
            ...getClientRateLimitState(client),
            identities,
            primaryIdentity,
            authMode: 'token',
            rememberMe: !!rememberMe,
            accessToken: null,
            tokenExpiresAt: null,
            connectionLost: false,
            error: null,
            activeAccountId: accountId,
          });

          import('@/stores/email-store').then(({ useEmailStore }) => {
            useEmailStore.getState().prefetchInitialData(client).catch((err) => {
              debug.error('Initial data prefetch failed:', err);
            });
          }).catch(() => {});

          resumeSettingsSync({ id: accountId, username, serverUrl });
          notifySignedIn(get());
          return true;
        } catch (error) {
          debug.error('Token login error:', error);
          set({
            isLoading: false,
            error: error instanceof Error && error.message === 'INVALID_TOKEN' ? 'invalid_token' : classifyLoginError(error),
            isAuthenticated: false,
            isRateLimited: false,
            rateLimitUntil: null,
            client: null,
          });
          return false;
        }
      },

      loginDemo: async () => {
        set({ isLoading: true, error: null, isRateLimited: false, rateLimitUntil: null });
        try {
          // Clear all store data before re-initializing with fresh demo data
          clearAllStores();

          const { DemoJMAPClient } = await import('@/lib/demo/demo-client');
          const { seedDemoPreferences } = await import('@/lib/demo/demo-preferences');
          // Two logins: the work account (primary, with the shared Support
          // mailbox) and a personal account with mail and contacts, so the account
          // switcher and the merged inbox have more than one source.
          const client = new DemoJMAPClient('work');
          const personal = new DemoJMAPClient('personal');
          await Promise.all([client.connect(), personal.connect()]);

          const username = client.getUsername();
          const { identities, primaryIdentity } = loadIdentities(await client.getIdentities(), username);
          initializeFeatureStores(client);

          // Register the account entries so the account switcher shows
          // names and avatars, and the unified views find both clients.
          const accountStore = useAccountStore.getState();
          const displayName = primaryIdentity?.name || 'Nora Lindqvist';
          const register = (demoClient: InstanceType<typeof DemoJMAPClient>, label: string, isDefault: boolean) => {
            const email = demoClient.getUsername();
            const id = accountStore.addAccount({
              label,
              serverUrl: DEMO_SERVER_URL,
              username: email,
              authMode: 'basic',
              rememberMe: false,
              displayName,
              email,
              lastLoginAt: Date.now(),
              isConnected: true,
              hasError: false,
              isDefault,
            });
            // The registry is typed for the real client; the unified views only
            // use the IJMAPClient surface, which the demo client implements.
            holdClient(id, demoClient as unknown as JMAPClient);
            return id;
          };
          const demoAccountId = register(client, 'Meridian Labs', true);
          register(personal, 'Personal', false);
          accountStore.setActiveAccount(demoAccountId);
          seedDemoPreferences();

          set({
            isAuthenticated: true,
            isLoading: false,
            serverUrl: 'demo.example.com',
            username,
            client,
            ...getClientRateLimitState(client),
            identities,
            primaryIdentity,
            authMode: 'basic',
            rememberMe: false,
            accessToken: null,
            tokenExpiresAt: null,
            connectionLost: false,
            error: null,
            activeAccountId: demoAccountId,
            isDemoMode: true,
          });
          notifySignedIn(get());
          return true;
        } catch (error) {
          debug.error('Demo login error:', error);
          set({
            isLoading: false,
            error: 'generic',
            isAuthenticated: false,
            isRateLimited: false,
            rateLimitUntil: null,
            client: null,
          });
          return false;
        }
      },

      loginWithOAuth: async (serverUrl, code, codeVerifier, redirectUri, serverId) => {
        set({ isLoading: true, error: null, isRateLimited: false, rateLimitUntil: null });

        // Lite: the slot whose refresh token this attempt wrote, until the
        // session has named its account.
        let unnamedLiteSlot: number | null = null;

        try {
          // Determine slot for this account (use slot from sessionStorage if re-adding).
          // Note: `parseInt(getItem(...) || '0')` collapses "no value set" and
          // "value is 0" into the same case, so the fallback to getNextCookieSlot()
          // never fired for the common "+ Add Account" path - every OAuth account
          // ended up on slot 0 and overwrote earlier accounts' refresh-token cookies.
          // Distinguishing rawSlot === null from a parsed 0 fixes that. The page
          // also writes oauth_cookie_slot before redirecting to the IdP.
          const accountStore = useAccountStore.getState();
          const target = signInTarget(serverUrl, sessionStorage.getItem('oauth_reauthenticate_account'));
          const rawSlot = typeof window !== 'undefined'
            ? sessionStorage.getItem('oauth_cookie_slot')
            : null;
          const pendingSlot = rawSlot !== null ? parseInt(rawSlot, 10) : NaN;
          const slot = target?.cookieSlot ?? (!isNaN(pendingSlot) && pendingSlot >= 0 && pendingSlot < MAX_ACCOUNT_SLOTS
            ? pendingSlot
            : accountStore.getNextCookieSlot());
          // The login page parks "Remember me" here when the box is offered.
          const remember = typeof window === 'undefined' || sessionStorage.getItem('oauth_remember') !== 'false';
          await waitForCredentialCleanup(slot);

          const tokenRes = await exchangeOAuthCode({ serverUrl, code, codeVerifier, redirectUri, slot, serverId, remember });

          if (!tokenRes.ok) {
            throw new Error('token_exchange_failed');
          }
          if (IS_LITE) unnamedLiteSlot = slot;

          const { access_token, expires_in } = await tokenRes.json();

          // The account id comes from the session, so the refresh hook reads
          // it once it is known below.
          let boundAccountId: string | undefined;
          const client = JMAPClient.withBearer(serverUrl, access_token, '', () => get().refreshAccessToken({ accountId: boundAccountId }));
          await client.connect();

          const jmapUsername = client.getUsername();
          await verifySignInTarget(client, target);
          const { identities, primaryIdentity } = loadIdentities(await client.getIdentities(), jmapUsername);
          // For OAuth/OIDC, the JMAP session account name may be the
          // preferred_username claim rather than the real email address.
          // Prefer the email from the primary identity when available.
          const username = target?.username || primaryIdentity?.email || jmapUsername;
          if (IS_LITE) {
            nameLiteRefreshToken(slot, username);
            unnamedLiteSlot = null;
          }
          initializeFeatureStores(client);

          // Register in account store
          const accountId = generateAccountId(username, serverUrl);
          boundAccountId = accountId;

          // Snapshot current account if switching away and clear stores so
          // the new account starts with a clean email/contact/calendar state.
          const prevAccountId = get().activeAccountId;
          if (prevAccountId && prevAccountId !== accountId) {
            snapshotAccount(prevAccountId);
            clearAllStores();
          }

          await checkStoreOwner(accountId, client.getAccountId(), serverUrl);
          await verifySignInTarget(client, target);
          holdClient(accountId, client);
          bindClientStatusHandlers(client, set, get, accountId);

          // The slot of an account Lite already had, before it moves to `slot`.
          const priorSlot = accountStore.hasAccount(username, serverUrl)
            ? accountStore.getAccountById(accountId)?.cookieSlot
            : undefined;
          accountStore.addAccount({
            label: primaryIdentity?.name || username,
            serverUrl,
            username,
            authMode: 'oauth',
            rememberMe: remember,
            displayName: primaryIdentity?.name || username,
            email: primaryIdentity?.email || username,
            lastLoginAt: Date.now(),
            isConnected: true,
            hasError: false,
            isDefault: accountStore.accounts.length === 0,
          });
          // The refresh-token cookie was written to `slot`. Force the stored
          // cookieSlot to match: addAccount preserves the prior slot when
          // re-adding an existing account, and recomputes via getNextCookieSlot
          // for new accounts (which may disagree if another tab claimed a slot
          // mid-flow). Either way, the cookie's slot is the source of truth.
          accountStore.updateAccount(accountId, { cookieSlot: slot, providerSession: true });
          accountStore.setActiveAccount(accountId);
          // Signed in again to an account Lite already had: its old slot is
          // no one's now, so its refresh token is revoked rather than left
          // behind as one more grant on the server (#1571).
          if (IS_LITE && priorSlot !== undefined && priorSlot !== slot
            && !useAccountStore.getState().accounts.some((a) => a.cookieSlot === priorSlot)) {
            void retireLiteSlot(priorSlot, liteRevokesTokens());
          }

          await syncStalwartAuthContext(serverUrl, username, client.getAuthHeader(), slot);
          verifyAdoptedSignIn(accountId, client, target);
          void syncAccountDisplayName(accountId, client, primaryIdentity?.name);

          set({
            isAuthenticated: true,
            isLoading: false,
            serverUrl,
            username,
            client,
            ...getClientRateLimitState(client),
            identities,
            primaryIdentity,
            authMode: 'oauth',
            accessToken: access_token,
            tokenExpiresAt: Date.now() + expires_in * 1000,
            connectionLost: false,
            error: null,
            activeAccountId: accountId,
          });

          import('@/stores/email-store').then(({ useEmailStore }) => {
            useEmailStore.getState().prefetchInitialData(client).catch((err) => {
              debug.error('Initial data prefetch failed:', err);
            });
          }).catch(() => {});

          scheduleRefresh(expires_in, () => get().refreshAccessToken({ accountId }), accountId);

          notifyParent('sso:auth-success', { username });

          // Sync settings from server (only if enabled)
          fetchConfig().then(config => {
            if (!config.settingsSyncEnabled) return;
            useSettingsStore.getState().loadFromServer(username, serverUrl).finally(() => {
              useSettingsStore.getState().enableSync(username, serverUrl);
              applyPreferredIdentity(accountId);
            });
          }).catch(() => {});

          // Clean up sessionStorage
          if (typeof window !== 'undefined') {
            sessionStorage.removeItem('oauth_cookie_slot');
            sessionStorage.removeItem('oauth_remember');
          }

          notifySignedIn(get());
          return true;
        } catch (error) {
          debug.error('OAuth login error:', error);
          // The code was redeemed but the session never came up: nothing owns
          // the refresh token the exchange stored.
          if (unnamedLiteSlot !== null) void retireLiteRefreshToken(unnamedLiteSlot, liteRevokesTokens());
          const errorMsg = error instanceof Error ? error.message : 'generic';
          notifyParent('sso:auth-failure', { error: errorMsg });
          set({
            isLoading: false,
            error: errorMsg,
            isAuthenticated: false,
            isRateLimited: false,
            rateLimitUntil: null,
            client: null,
          });
          return false;
        } finally {
          sessionStorage.removeItem('oauth_reauthenticate_account');
        }
      },

      loginWithServerSso: async (code, state) => {
        set({ isLoading: true, error: null, isRateLimited: false, rateLimitUntil: null });

        try {
          // Server-side SSO: the server holds the PKCE verifier in an encrypted cookie.
          // Pass the next-free cookie slot so /api/auth/sso/complete writes the refresh
          // token to the correct per-account jmap_rt_<slot> cookie. Without this the
          // route hardcoded slot 0, which broke "+ Add Account" by overwriting the
          // first account's refresh-token cookie.
          const accountStore = useAccountStore.getState();
          const targetId = sessionStorage.getItem('oauth_reauthenticate_account');
          const target = targetId ? accountStore.getAccountById(targetId) : undefined;
          if (targetId && !target?.awaitingSignIn) throw new Error('Invalid username or password');
          const slot = target?.cookieSlot ?? accountStore.getNextCookieSlot();
          await waitForCredentialCleanup(slot);

          // SSO token exchange and config fetch are independent - fire both
          // up front and let them resolve in parallel.
          const [ssoRes, config] = await Promise.all([
            apiFetch('/api/auth/sso/complete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ code, state, slot }),
            }).then((res) => noteSessionAnswer(res, slot)),
            fetchConfig(),
          ]);

          if (!ssoRes.ok) {
            const errorData = await ssoRes.json().catch(() => ({ error: 'token_exchange_failed' }));
            throw new Error(errorData.error || 'token_exchange_failed');
          }

          // `remember` is what the login page chose when the flow started.
          const { access_token, expires_in, remember } = await ssoRes.json();

          const ssoServerUrl = config.jmapServerUrl;

          if (!ssoServerUrl) {
            throw new Error('Server URL not configured');
          }

          await adoptProviderSession(set, get, { serverUrl: ssoServerUrl, accessToken: access_token, expiresIn: expires_in, remember, slot });
          return true;
        } catch (error) {
          debug.error('Server SSO login error:', error);
          const errorMsg = error instanceof Error ? error.message : 'generic';
          notifyParent('sso:auth-failure', { error: errorMsg });
          set({
            isLoading: false,
            error: errorMsg,
            isAuthenticated: false,
            isRateLimited: false,
            rateLimitUntil: null,
            client: null,
          });
          return false;
        } finally {
          sessionStorage.removeItem('oauth_reauthenticate_account');
        }
      },

      loginWithDesktopHandoff: async (code, verifier, { remember, rememberPassword, allowedServers, customServersAllowed }) => {
        if (IS_LITE) return 'failed';
        set({ isLoading: true, error: null, isRateLimited: false, rateLimitUntil: null });
        try {
          const targetId = sessionStorage.getItem('oauth_reauthenticate_account');
          const target = targetId ? useAccountStore.getState().getAccountById(targetId) : undefined;
          if (targetId && !target?.awaitingSignIn) throw new Error('Invalid username or password');
          const slot = target?.cookieSlot ?? useAccountStore.getState().getNextCookieSlot();
          await waitForCredentialCleanup(slot);
          const res = await apiFetch('/api/auth/desktop-handoff/redeem', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, code_verifier: verifier, slot, remember, allowed_servers: allowedServers, custom_servers_allowed: customServersAllowed }),
          }).then((answer) => noteSessionAnswer(answer, slot));
          if (!res.ok) {
            const refusal = (await res.json().catch(() => null)) as { error?: string } | null;
            set({ isLoading: false, error: null });
            return refusal?.error === 'blocked_by_policy' ? 'blocked' : 'failed';
          }
          const parked = await res.json();
          if (parked.flow === 'password') {
            // A password the browser checked a moment ago, down the same path as a typed one.
            return (await get().login(parked.server_url, parked.username, parked.password, undefined, rememberPassword, ...(targetId ? [targetId] as const : []))) ? 'ok' : 'failed';
          }
          await adoptProviderSession(set, get, {
            serverUrl: parked.server_url,
            accessToken: parked.access_token,
            expiresIn: parked.expires_in,
            remember: parked.remember,
            slot,
            ...(parked.password_login ? { typedUsername: parked.username } : {}),
          });
          return 'ok';
        } catch (error) {
          debug.error('Desktop hand-off login error:', error);
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'generic',
            isAuthenticated: false,
            isRateLimited: false,
            rateLimitUntil: null,
            client: null,
          });
          return 'failed';
        } finally {
          sessionStorage.removeItem('oauth_reauthenticate_account');
        }
      },

      refreshAccessToken: async (options) => {
        // Every multi-account client and timer passes its own account: renewing
        // the active slot on a background account's behalf would hand that
        // client another account's token (#989).
        const accountId = options?.accountId ?? get().activeAccountId;
        if (accountId) {
          const inFlight = refreshPromises.get(accountId);
          if (inFlight) return inFlight;
        } else if (refreshPromise) {
          return refreshPromise;
        }

        // A pop-out is on another window's session: it asks that window first.
        if (isPopoutWindow()) {
          if (!accountId) return null;
          const renewal = renewSharedToken(accountId).finally(() => refreshPromises.delete(accountId));
          refreshPromises.set(accountId, renewal);
          return renewal;
        }

        const account = accountId ? useAccountStore.getState().getAccountById(accountId) : null;
        if (account?.awaitingSignIn) return null;
        const accountGeneration = account ? signInGenerations.get(account.id) ?? 0 : 0;
        const slot = account?.cookieSlot ?? 0;
        // The account is being signed out: a renewal now would only undo that.
        if (closingSlots.has(slot)) return null;

        const promise = (async () => {
          try {
            // Default to forcing a genuine refresh: the usual caller was told
            // the current token is unusable (rejected by JMAP, or due for
            // scheduled renewal), so the server-side cache must be skipped.
            // Session restore passes allowCached to reuse a still-valid token.
            const res = await fetchSlotAccessToken(slot, { force: !options?.allowCached, remember: account?.rememberMe });

            // Possibly a long wait for another window's renewal. A slot closing
            // or an account gone by now says nothing about any session, and a
            // refusal mustn't sign out whichever account is active by now.
            const current = account ? useAccountStore.getState().getAccountById(account.id) : null;
            if (closingSlots.has(slot) || (account && (!current || current.awaitingSignIn
              || (signInGenerations.get(account.id) ?? 0) !== accountGeneration))) return null;
            const isActive = !accountId || accountId === get().activeAccountId;

            if (!res.ok) {
              // Only a definitive 401 ends the session. Anything else (5xx
              // while the server restarts, proxy errors) is an outage - keep
              // the session and retry shortly so "stay signed in" survives
              // maintenance windows and offline spells.
              if (res.status === 401) {
                resetRefreshBackoff(accountId ?? undefined);
                const forced = await forcedSignOutOf(res);
                // Only this login's refresh token was refused.
                if (accountId && !isActive) {
                  if (forced) noteRefusedLogin(accountId, true, forced);
                  requireAccountSignIn(accountId);
                  return null;
                }
                await saveDraftsBeforeExpiry(slot);
                if (forced && accountId) noteRefusedLogin(accountId, true, forced);
                notifyParent('sso:session-expired');
                markSessionExpired();
                get().logout({ endProviderSession: false, keepLocalData: true });
                return null;
              }
              // A Bulwark-side failure (500/502) that keeps repeating will not
              // heal by waiting: stop retrying and ask for a fresh sign-in. (#972)
              if (recordPermanentRefreshFailure(res.status, accountId ?? undefined)) {
                debug.error(`Token refresh failed permanently (${res.status}) ${MAX_PERMANENT_REFRESH_FAILURES} times - signing out`);
                resetRefreshBackoff(accountId ?? undefined);
                notifySignInAgain();
                notifyParent('sso:session-expired');
                markSessionExpired();
                // removeAccount() on the active account would sign out as if the user asked to.
                if (accountId && accountId !== get().activeAccountId) requireAccountSignIn(accountId);
                else {
                  await saveDraftsBeforeExpiry(slot);
                  // An outage on our side says nothing against the mail on this device.
                  get().logout({ endProviderSession: false, keepLocalData: true });
                }
                return null;
              }
              if (shouldRetryRefresh(slot, accountId ?? undefined)) {
                const retryIn = nextRefreshRetrySeconds(accountId ?? undefined);
                debug.error(`Token refresh unavailable (${res.status}), retrying with backoff`);
                scheduleRefresh(retryIn, () => get().refreshAccessToken({ accountId: accountId ?? undefined }), accountId ?? undefined);
              }
              return null;
            }

            const { access_token, expires_in } = await res.json();

            // Signed out while the renewal was in flight: nothing to keep alive.
            if (closingSlots.has(slot)) return null;

            const owner = (accountId ? clients.get(accountId) : undefined) ?? (isActive ? get().client : null);
            owner?.updateAccessToken(access_token);

            if (account) {
              await syncStalwartAuthContext(
                account.serverUrl,
                account.username,
                `Bearer ${access_token}`,
                slot,
              );
            }

            if (isActive) {
              set({
                accessToken: access_token,
                tokenExpiresAt: Date.now() + expires_in * 1000,
              });
            }

            resetRefreshBackoff(accountId ?? undefined);
            scheduleRefresh(expires_in, () => get().refreshAccessToken({ accountId: accountId ?? undefined }), accountId ?? undefined);
            if (accountId) void authHooks.onTokenRefresh.emit({ accountId });
            return access_token;
          } catch (error) {
            // Network failure (offline, Wi-Fi switch, server unreachable) -
            // not a rejection. Keep the session and retry with backoff.
            debug.error('Token refresh failed, retrying with backoff:', error);
            if (shouldRetryRefresh(slot, accountId ?? undefined)) {
              scheduleRefresh(nextRefreshRetrySeconds(accountId ?? undefined), () => get().refreshAccessToken({ accountId: accountId ?? undefined }), accountId ?? undefined);
            }
            return null;
          } finally {
            if (accountId) refreshPromises.delete(accountId);
            else refreshPromise = null;
          }
        })();

        if (accountId) refreshPromises.set(accountId, promise);
        else refreshPromise = promise;

        return promise;
      },

       logout: async (options) => {
        const state = get();
        const wasDemoMode = state.isDemoMode;
        const wasOAuth = state.authMode === 'oauth';
        const accountId = state.activeAccountId;
        const accountStore = useAccountStore.getState();
        const account = accountId ? accountStore.getAccountById(accountId) : null;
        const slot = account?.cookieSlot ?? 0;
        // `options` can be a click event when the action is wired straight to onClick.
        const userInitiated = options?.endProviderSession !== false;
        const keepLocalData = options?.keepLocalData === true;
        const endProviderSession = userInitiated && !wasDemoMode && shouldEndProviderSession(account);

        // Signing out on purpose may be stopped by the user (unsent mail in
        // the offline outbox would be lost); an automatic one may not.
        if (userInitiated && !(await passSignOutGates(accountId ?? 'all'))) return;

        await beforeLogoutHooks(accountId ?? 'all', { keepLocalStore: keepLocalData, userInitiated });
        // A session that only ran out comes back with the next sign-in, push included.
        if (state.client && !wasDemoMode && !keepLocalData) await endPushForSignOut([state.client]);

        // From here on nothing may renew this slot's session; the cleanup
        // below reopens it once the credentials are gone.
        if (!wasDemoMode) closingSlots.add(slot);
        clearRefreshTimer(accountId ?? undefined);

        // Disconnect and null out the client BEFORE clearing stores so the
        // page doesn't fire data-loading effects with the stale client.
        const oldClient = state.client;
        set({ client: null });
        oldClient?.disconnect();
        if (oldClient && !wasDemoMode) forgetCalendarSubscriptions(oldClient);

        // Remove client from multi-account map
        if (accountId) {
          clients.delete(accountId);
          evictAccount(accountId);
          if (keepLocalData && !wasDemoMode) accountStore.requireSignIn(accountId);
          else accountStore.removeAccount(accountId);
          forgetPrincipals(accountId);
          if (!wasDemoMode) clearPluginStorageForAccount(accountId);
        }

        await useSettingsStore.getState().flushSync();
        useSettingsStore.getState().disableSync();

        clearKeystoreGrants();
        clearDesktopCertificateChoices({ account: accountId ?? undefined, last: useAccountStore.getState().accounts.length === 0 });
        clearDesktopCrashFiles();
        void authHooks.onAfterLogout.emit({
          accountId: accountId ?? 'all',
        });

        // Check if there are remaining accounts to switch to. Read the store
        // afresh: `accountStore` is the state from before removeAccount().
        // Prefer an account that is signed in here: one restored from the
        // account list backup (or otherwise not connected) has no client, and
        // picking it signs out every account left.
        const remainingAccounts = useAccountStore.getState().accounts.filter(
          (account) => account.id !== accountId && !account.awaitingSignIn && !accountRefusedByDesktopPolicy(account),
        );
        const nextAccount = wasDemoMode
          ? undefined
          : remainingAccounts.find((a) => clients.has(a.id)) ?? remainingAccounts[0];
        const droppedAccounts: AccountEntry[] = [];

        if (nextAccount) {
          // Switch to the next account - this is the one path that stays in-app
          clearAllStores();

          const nextClient = clients.get(nextAccount.id);
          if (nextClient) {
            const restored = restoreAccount(nextAccount.id);
            accountStore.setActiveAccount(nextAccount.id);

            const restoredIdentities = restored ? useIdentityStore.getState().identities : [];
            const restoredPrimary = restoredIdentities[0] ?? null;

            set({
              isAuthenticated: true,
              isLoading: false,
              serverUrl: nextAccount.serverUrl,
              username: nextAccount.username,
              client: nextClient,
              authMode: nextAccount.authMode,
              rememberMe: nextAccount.rememberMe,
              connectionLost: false,
              error: null,
              activeAccountId: nextAccount.id,
              identities: restoredIdentities,
              primaryIdentity: restoredPrimary,
            });

            if (!restored) {
              initializeFeatureStores(nextClient);
              nextClient.getIdentities().then((rawIds) => {
                const { identities, primaryIdentity } = loadIdentities(rawIds, nextAccount.username);
                set({ identities, primaryIdentity });
              }).catch((err) => debug.error('Failed to load identities after switch:', err));
            }

            // Sync was switched off for the signed-out account above; the
            // account staying signed in needs it back.
            resumeSettingsSync(nextAccount);

            // The provider session is left alone: visiting its logout page
            // would take the user away from the accounts still signed in
            // here, which may share that session. Revoking the token ends
            // Bulwark's grant.
            void clearSlotCredentials(slot, wasOAuth);
            return;
          }

          // Client not in memory. Trying to async-restore during logout caused
          // the original bug. An account signed in before this page load (the
          // one being signed out was added after an OAuth redirect or a reload
          // of the add-account page) was simply never restored here: reload,
          // and the usual restore picks it up.
          if (!nextAccount.hasError && !nextAccount.awaitingSignIn) {
            accountStore.setActiveAccount(nextAccount.id);
            set({ activeAccountId: nextAccount.id, serverUrl: nextAccount.serverUrl, username: nextAccount.username });
            await clearSlotCredentials(slot, wasOAuth);
            replaceWindowLocation(`${getPathPrefix()}/${getLocaleFromPath()}`);
            return;
          }

          // Its restore failed - sign out fully instead.
          // A full logout leaves no account behind: drop every remaining one
          // and clear its slot too. Left in place, its remembered session
          // would sign the next visitor of this browser straight back in.
          debug.error(`Cannot restore next account ${nextAccount.id}, performing full logout`);
          for (const remaining of useAccountStore.getState().accounts) {
            droppedAccounts.push(remaining);
            clearRefreshTimer(remaining.id);
            clients.get(remaining.id)?.disconnect();
            clients.delete(remaining.id);
            evictAccount(remaining.id);
            // Dropped by this sign-out, not signed out by anyone: their unsent
            // mail never passed a question, so it waits for their next sign-in.
            accountStore.requireSignIn(remaining.id);
          }
          clearDesktopCertificateChoices({ last: true });
        }

        // Full logout. The credentials are cleared before the page state:
        // once signed out, the pages' auth guards head for the login page and
        // would cut the cleanup short. Awaiting it also means the provider's
        // logout URL is known before navigating, and nothing is left to
        // resume the session when the browser comes back.
        const [endSessionUrl] = wasDemoMode ? [null] : await Promise.all([
          clearSlotCredentials(slot, wasOAuth, endProviderSession),
          ...droppedAccounts.map((dropped) => clearSlotCredentials(dropped.cookieSlot ?? 0, dropped.authMode === 'oauth')),
        ]);

        performFullLogout(set, { keepLocalStore: keepLocalData });

        notifyParent('sso:logout');

        finishSignOut(endSessionUrl, userInitiated);
      },

      // Remove a specific (typically non-active) account: tear down its client,
      // drop it from the registry, and clear its per-slot cookies. If asked to
      // remove the active account, defer to logout() which handles switching
      // away or redirecting.
      removeAccount: (accountId: string, reason = 'explicit') => {
        if (accountId === get().activeAccountId) { void get().logout(); return; }
        const accountStore = useAccountStore.getState();
        const account = accountStore.getAccountById(accountId);
        if (!account) return;
        const slot = account.cookieSlot ?? 0;
        const wasOAuth = account.authMode === 'oauth';
        const client = clients.get(accountId);
        // The slot is closing from here on: a renewal in flight cannot bring the
        // session back.
        closingSlots.add(slot);
        clearRefreshTimer(accountId);
        if (client) forgetCalendarSubscriptions(client);
        // The login's push goes first: a client that disconnected has no account
        // id and no API left to reach the server with.
        const pushEnded = client && reason === 'explicit' ? endPushForSignOut([client]) : Promise.resolve();
        void pushEnded.finally(() => {
          try { client?.disconnect(); } catch { /* noop */ }
          return clearSlotCredentials(slot, wasOAuth);
        });
        clients.delete(accountId);
        evictAccount(accountId);
        forgetAccountRows(accountId, get().client);
        accountStore.removeAccount(accountId, reason);
        clearDesktopCertificateChoices({ account: accountId });
        forgetPrincipals(accountId);
        clearPluginStorageForAccount(accountId);
      },

      logoutAll: async (options) => {
        const userInitiated = options?.endProviderSession !== false;
        if (userInitiated && !(await passSignOutGates('all'))) return;
        const keepLocalData = options?.keepLocalData === true;
        // Before anything goes, while the accounts are still there to be named.
        if (options?.sessionLimit) {
          for (const account of useAccountStore.getState().accounts) noteRefusedLogin(account.id, true, 'session');
        }
        await beforeLogoutHooks('all', { keepLocalStore: keepLocalData, userInitiated });
        if (!get().isDemoMode && !keepLocalData) {
          // Each connected login first, on a budget that one unreachable server can
          // use up. What's left, and whoever had no connection, only needs the relay.
          await endPushForSignOut(clients.values());
          await Promise.race([
            import('@/lib/web-push').then((push) => push.dropAllWebPushRegistrations()).catch(() => undefined),
            new Promise<void>((resolve) => setTimeout(resolve, LOGOUT_HOOK_BUDGET_MS)),
          ]);
        }

        const accountStore = useAccountStore.getState();
        const allAccounts = [...accountStore.accounts];
        // `options` can be a click event when the action is wired straight to onClick.
        const endProviderSession = options?.endProviderSession !== false;
        const endSessionSlot = get().isDemoMode || !endProviderSession ? null : pickEndSessionSlot(allAccounts, get().activeAccountId);

        // Starts by marking every slot closing, so nothing renews a session
        // while the clients are torn down.
        const cleanup = clearAllCredentials(endSessionSlot);

        // The settings are reset below; save the last edits first.
        await useSettingsStore.getState().flushSync();

        // Disconnect all clients
        set({ client: null });
        for (const c of clients.values()) {
          c.disconnect();
        }
        clients.clear();
        clearAllRefreshTimers();
        evictAll();

        // Credentials are cleared before the page state - see logout().
        const endSessionUrl = await cleanup;

        // Clear all accounts from registry
        for (const account of allAccounts) {
          if (keepLocalData && account.serverUrl !== DEMO_SERVER_URL) accountStore.requireSignIn(account.id);
          else accountStore.removeAccount(account.id);
        }
        performFullLogout(set, { keepLocalStore: keepLocalData });

        clearKeystoreGrants();
        clearDesktopCertificateChoices({ last: true });
        clearDesktopCrashFiles();
        void authHooks.onAfterLogout.emit({
          accountId: 'all'
        });

        notifyParent('sso:logout');

        finishSignOut(endSessionUrl, true);
      },

      switchAccount: async (accountId: string) => {
        const state = get();
        if (state.activeAccountId === accountId) return;
        const generation = ++switchGeneration;
        const superseded = () => generation !== switchGeneration;

        const accountStore = useAccountStore.getState();
        const targetAccount = accountStore.getAccountById(accountId);
        if (!targetAccount || accountRefusedByDesktopPolicy(targetAccount)) return;
        // Restored from the account list backup and never signed in here:
        // there is no session to resume, so ask for the password instead.
        if (targetAccount.awaitingSignIn && !clients.has(accountId)) {
          replaceWindowLocation(`${getLocaleLoginPath()}?mode=add-account&account=${encodeURIComponent(accountId)}`);
          return;
        }

        // A switch between two already-connected accounts is done seamlessly:
        // the current account's client and mail stay on screen while we verify
        // the target session, then the store state is swapped in one synchronous
        // batch (further below). Nulling the client / raising isLoading here
        // would trip the page's full-screen loading gate and blank the whole app
        // mid-switch, so we only do that when the target must be re-connected
        // over the network (nothing worth keeping on screen while we wait).
        let targetClient = clients.get(accountId);
        const wasConnected = !!targetClient;
        let targetRestoreRateLimited = false;
        let targetForced: ForcedSignOutKind | null = null;

        if (!targetClient) {
          // Null out the client immediately so the page doesn't fire data-loading
          // effects with the old client while stores are being cleared.
          set({ isLoading: true, client: null, isRateLimited: false, rateLimitUntil: null });

          // Snapshot current account, then clear - there's nothing to keep on
          // screen during the network round-trip.
          snapshotAndClearForSwitch(get().activeAccountId);
          await useSettingsStore.getState().flushSync();
          useSettingsStore.getState().disableSync();

          // Client not connected - try to restore
          try {
            if (targetAccount.authMode === 'oauth') {
              const res = await fetchSlotAccessToken(targetAccount.cookieSlot, { remember: targetAccount.rememberMe });
              if (!res.ok && res.status === 401) targetForced = await forcedSignOutOf(res);
              if (res.ok) {
                const { access_token, expires_in } = await res.json();
                targetClient = JMAPClient.withBearer(targetAccount.serverUrl, access_token, targetAccount.username, () => get().refreshAccessToken({ accountId }));
                bindClientStatusHandlers(targetClient, set, get, accountId);
                await targetClient.connect();
                holdClient(accountId, targetClient);
                scheduleRefresh(expires_in, () => get().refreshAccessToken({ accountId }), accountId);
                await syncStalwartAuthContext(
                  targetAccount.serverUrl,
                  targetAccount.username,
                  targetClient.getAuthHeader(),
                  targetAccount.cookieSlot,
                );
              }
            } else if (targetAccount.rememberMe || await keepsUntickedSignIn()) {
              const res = await fetchSlotSession(targetAccount.cookieSlot);
              if (!res.ok && res.status === 401) targetForced = await forcedSignOutOf(res);
              if (res.ok) {
                const session: RememberedSession = await res.json();
                targetClient = clientForSession(session);
                bindClientStatusHandlers(targetClient, set, get, accountId);
                await targetClient.connect();
                holdClient(accountId, targetClient);
                await syncStalwartAuthContext(session.serverUrl, session.username, targetClient.getAuthHeader(), targetAccount.cookieSlot);
              }
            }
          } catch (err) {
            debug.error(`Failed to restore client for ${accountId}:`, err);
            if (isRateLimitError(err)) {
              targetRestoreRateLimited = true;
            }
          }
        }

        // A newer switch owns the screen now. A client restored here stays in
        // the pool for when the account is picked again.
        if (superseded()) return;

        if (!targetClient) {
          if (targetRestoreRateLimited) {
            if (state.activeAccountId && state.activeAccountId !== accountId) {
              const prevClient = clients.get(state.activeAccountId);
              const prevAccount = accountStore.getAccountById(state.activeAccountId);
              if (prevClient && prevAccount) {
                restoreAccount(state.activeAccountId);
                storesClearedForSwitch = false;
                accountStore.setActiveAccount(state.activeAccountId);
                set({
                  isLoading: false,
                  serverUrl: prevAccount.serverUrl,
                  username: prevAccount.username,
                  client: prevClient,
                  ...getClientRateLimitState(prevClient),
                  authMode: prevAccount.authMode,
                  rememberMe: prevAccount.rememberMe,
                  connectionLost: false,
                  error: 'connection_failed',
                  activeAccountId: state.activeAccountId,
                });
                return;
              }
            }

            set({ isLoading: false, error: 'connection_failed', isRateLimited: false, rateLimitUntil: null });
            return;
          }

          // Cannot restore - remove the stale account and redirect to login
          if (targetForced) noteRefusedLogin(accountId, true, targetForced);
          else if (refusedAtConnect.has(accountId)) noteRefusedLogin(accountId, false);
          refusedAtConnect.delete(accountId);
          requireAccountSignIn(accountId);

          // Restore the previous account if still available
          if (state.activeAccountId && state.activeAccountId !== accountId) {
            const prevClient = clients.get(state.activeAccountId);
            const prevAccount = accountStore.getAccountById(state.activeAccountId);
            if (prevClient && prevAccount) {
              restoreAccount(state.activeAccountId);
              storesClearedForSwitch = false;
              accountStore.setActiveAccount(state.activeAccountId);
              set({
                isLoading: false,
                serverUrl: prevAccount.serverUrl,
                username: prevAccount.username,
                client: prevClient,
                ...getClientRateLimitState(prevClient),
                authMode: prevAccount.authMode,
                rememberMe: prevAccount.rememberMe,
                connectionLost: false,
                activeAccountId: state.activeAccountId,
              });
              return;
            }
          }

          set({ isLoading: false });
          // Redirect to login so the user can re-authenticate
          replaceWindowLocation(getLocaleLoginPath());
          return;
        }

        // GUARD: verify the connected session actually belongs to the target
        // account before we bind it. A corrupted slot->token mapping (e.g.
        // persisted client state left over from an older build, or any future
        // slot desync) can hand back a *different* account's token; the
        // connection then succeeds and we would silently show the wrong
        // mailbox. We accept the session when it matches the stored accountId
        // OR the server identity captured at this account's login (so a short
        // login username the server canonicalizes to a full address is still
        // recognized). On a genuine mismatch, drop the poisoned cookies for
        // this slot and force a clean re-auth instead of surfacing someone
        // else's mail.
        const connectedCandidates = await connectedAccountCandidates(targetClient, targetAccount.serverUrl);
        if (superseded()) return;
        // The server refused the login as a whole, now or before (#1539): it would
        // refuse every load the switch starts. Ask for a sign-in instead, the way
        // an account restored from the backup does.
        if (targetClient.isAccessRefused?.()) {
          accountStore.updateAccount(accountId, { isConnected: false, hasError: true, errorMessage: ACCOUNT_REFUSED });
          replaceWindowLocation(`${getLocaleLoginPath()}?mode=add-account&username=${encodeURIComponent(targetAccount.username)}`);
          return;
        }
        const verdict = classifySessionMatch(connectedCandidates, accountId, targetAccount.serverIdentifiers);
        if (verdict === 'reject') {
          debug.error(`switchAccount: slot ${targetAccount.cookieSlot} for ${accountId} resolved to [${connectedCandidates.join(", ")}] — forcing re-auth`);
          clients.delete(accountId);
          try { targetClient.disconnect(); } catch { /* noop */ }
          void clearSlotCredentials(targetAccount.cookieSlot, true);
          accountStore.updateAccount(accountId, { isConnected: false, hasError: true, errorMessage: 'session_mismatch' });
          set({ isLoading: false, error: 'connection_failed', activeAccountId: state.activeAccountId });
          replaceWindowLocation(getLocaleLoginPath());
          return;
        }
        // Refresh (or, for a legacy 'trust' entry, establish) the identity
        // baseline now that we've confirmed a good session.
        if (connectedCandidates.length > 0) {
          accountStore.updateAccount(accountId, { serverIdentifiers: connectedCandidates });
        }

        // Seamless path: the outgoing account is still on screen (we deferred
        // clearing it), so snapshot + clear it now - synchronously, right before
        // the restore and client swap below - so the UI never blanks between the
        // two accounts. The network path already snapshotted and cleared above.
        // The settings flush is a request, so it goes first: awaited after the
        // clear, the list showed "No emails" until it came back.
        if (wasConnected) {
          await useSettingsStore.getState().flushSync();
          useSettingsStore.getState().disableSync();
          if (superseded()) return;
          snapshotAndClearForSwitch(get().activeAccountId);
        }

        // Restore cached state or fetch fresh
        const restored = restoreAccount(accountId);
        storesClearedForSwitch = false;
        accountStore.setActiveAccount(accountId);
        accountStore.updateAccount(accountId, { isConnected: true, hasError: false, errorMessage: undefined });

        // Build identity state up front so the name updates atomically
        const restoredIdentities = restored ? useIdentityStore.getState().identities : [];
        const restoredPrimary = restoredIdentities[0] ?? null;

        set({
          isAuthenticated: true,
          isLoading: false,
          serverUrl: targetAccount.serverUrl,
          username: targetAccount.username,
          client: targetClient,
          ...getClientRateLimitState(targetClient),
          authMode: targetAccount.authMode,
          rememberMe: targetAccount.rememberMe,
          connectionLost: false,
          error: null,
          activeAccountId: accountId,
          identities: restoredIdentities,
          primaryIdentity: restoredPrimary,
        });

        if (!restored) {
          // Fetch fresh data
          try {
            const { identities, primaryIdentity } = loadIdentities(await targetClient.getIdentities(), targetAccount.username);
            // Switched on again while these loaded: they belong to this
            // account, not the one now active.
            if (superseded()) return;
            set({ identities, primaryIdentity });
            initializeFeatureStores(targetClient);
          } catch (err) {
            debug.error(`Failed to load data for ${accountId}:`, err);
          }
        }
        void syncAccountDisplayName(accountId, targetClient, get().primaryIdentity?.name);

        // Sync settings
        resumeSettingsSync(targetAccount);
      },

      checkAuth: async () => {
        const accountStore = useAccountStore.getState();
        // An account on a server the device's OS policy refuses stays stored, with its
        // cookies and local data, and stays out of everything until it's allowed again.
        const everyAccount = accountStore.accounts;
        let accounts = everyAccount.filter((account) => !accountRefusedByDesktopPolicy(account));
        if (everyAccount.length > 0 && accounts.length === 0) {
          set({ isLoading: false, isAuthenticated: false, client: null, activeAccountId: null });
          if (typeof window !== 'undefined' && !window.location.pathname.includes('/login')) leaveForRefusedServer();
          return;
        }

        // If every account is a demo account, re-initialize demo mode
        // instead of trying to restore a server session (which doesn't exist).
        if (accounts.length > 0 && accounts.every((a) => a.serverUrl === DEMO_SERVER_URL)) {
          await get().loginDemo();
          return;
        }

        // Orphan-cookie adoption - when no accounts are registered but a
        // basic-auth session cookie is present (set by /api/auth/impersonate
        // or by another server-side hand-off), promote it into the account
        // registry so the normal restoration path picks it up. Without this
        // the cookies sit unused and the SPA bounces to the login screen.
        // (Not in Lite: nothing hands sessions over server-side.)
        // Not while a forgotten PIN's cookies wait to be cleared: this would sign that
        // login back in with no PIN. The DELETE goes first, and adoption waits for it.
        if (accounts.length === 0 && !IS_LITE && await clearPendingCookies()) {
          try {
            const restore = await apiFetch('/api/auth/session', { method: 'PUT' });
            if (restore.ok) {
              const data = await restore.json();
              if (data?.serverUrl && data?.username && (data?.password || data?.token)) {
                // Stalwart master-user impersonation uses "target%master" as
                // the auth username. The full string must be preserved for
                // JMAP auth, but the user-facing display (avatar, switcher,
                // sign-out copy) should only show the target mailbox.
                const fullUsername: string = data.username;
                const displayMailbox = fullUsername.includes('%')
                  ? fullUsername.split('%', 1)[0]
                  : fullUsername;
                accountStore.addAccount({
                  label: displayMailbox,
                  serverUrl: data.serverUrl,
                  username: fullUsername,
                  authMode: data.token ? 'token' : 'basic',
                  rememberMe: true,
                  displayName: displayMailbox,
                  email: displayMailbox,
                  lastLoginAt: Date.now(),
                  isConnected: false,
                  hasError: false,
                  isDefault: true,
                });
                accounts = useAccountStore.getState().accounts;
              }
            }
          } catch (err) {
            debug.error('Orphan session cookie adoption failed:', err);
          }
        }

        // Multi-account restoration: restore all registered accounts
        if (accounts.length > 0) {
          // Null out client so the page doesn't fire data-loading effects
          // with a stale client reference while we're restoring accounts.
          set({ isLoading: true, client: null });

          // The offline hooks have to be there before the first request, or a
          // start without the server has nothing to paint from.
          if (!IS_LITE && useOfflineStore.getState().enabled.length > 0) {
            await import('@/lib/offline/offline-mode').then((offline) => offline.registerOfflineHooks()).catch(() => {});
          }

          // A wipe comes before anything from this device is shown: one a closed
          // window cut short, and what the instance has to say, briefly.
          if (!IS_LITE && (useOfflineStore.getState().enabled.length > 0 || getDesktopBridge()?.mode === 'instance' || wipeWorkWaiting())) {
            await import('@/lib/offline/device-wipe').then((wipe) => wipe.runDeviceGate()).catch(() => {});
            accounts = useAccountStore.getState().accounts;
            if (accounts.length === 0) {
              set({ isLoading: false, isAuthenticated: false, client: null, activeAccountId: null });
              return;
            }
          }

          // Determine which account to activate first
          const defaultAccount = accountStore.getDefaultAccount();
          const usable = (id: string | null | undefined) => (id && accounts.some((account) => account.id === id) ? id : null);
          const activeId = usable(get().activeAccountId);
          const targetId = activeId || usable(defaultAccount?.id) || accounts[0].id;

          // Restore one account: decrypt the stored credential/token, connect,
          // and sync the passthrough auth context. The context write never
          // throws and doesn't depend on the connect result, so its round trip
          // overlaps the connect instead of running after it.
          // Accounts signed in without "Remember me": a reload (or, when the
          // admin keeps them until the browser closes, a new start of the
          // browser) ends them on purpose, so it is not reported as an
          // expired session.
          let forgottenAccounts = 0;
          let expiredDuringRestore = false;
          const forgetAccount = (account: (typeof accounts)[number]) => {
            forgottenAccounts += 1;
            evictAccount(account.id);
            // The user's choice on what may be a shared computer: its local data goes too.
            // Not when the app lock is on: its reload ended this page, not the session, so
            // the mail and the outbox wait for the next sign-in.
            accountStore.removeAccount(account.id, isAppLockOn() ? 'evicted' : 'explicit');
            if (account.authMode === 'oauth') void clearSlotCredentials(account.cookieSlot, true);
          };
          const restoreAccount = async (account: (typeof accounts)[number]) => {
            if (clients.has(account.id)) return; // Already connected
            // Restored from the account list backup: listed until signed in.
            if (account.awaitingSignIn) return;

            // A password or access token login without rememberMe leaves
            // nothing to restore - the user logged in without persisting
            // credentials. Evict silently so the login screen is shown without
            // flagging a fake error. (Lite keeps a tab-scoped session either
            // way; a missing one surfaces as a 401 from fetchSlotSession below
            // and evicts too.) A password + TOTP login runs on tokens, but
            // without rememberMe it ends the same way: its refresh token goes.
            // So does a provider sign-in made with the box left unticked.
            // When the admin keeps unticked sign-ins until the browser closes
            // (BROWSER_SESSION_SIGN_IN), they restore from their session
            // cookies below instead, and go the same silent way once the
            // browser has dropped them.
            if (!account.rememberMe && !IS_LITE && !(await keepsUntickedSignIn())) {
              forgetAccount(account);
              return;
            }

            try {
              if (account.authMode === 'oauth') {
                const res = await fetchSlotAccessToken(account.cookieSlot, { remember: account.rememberMe });
                if (res.ok) {
                  const { access_token, expires_in } = await res.json();
                  const client = JMAPClient.withBearer(account.serverUrl, access_token, account.username, () => get().refreshAccessToken({ accountId: account.id }));
                  bindClientStatusHandlers(client, set, get, account.id);
                  const contextSync = syncStalwartAuthContext(account.serverUrl, account.username, client.getAuthHeader(), account.cookieSlot);
                  await client.connect();
                  holdClient(account.id, client);
                  scheduleRefresh(expires_in, () => get().refreshAccessToken({ accountId: account.id }), account.id);
                  await contextSync;
                  accountStore.updateAccount(account.id, { isConnected: true, hasError: false });
                  void syncAccountDisplayName(account.id, client);
                } else if (!account.rememberMe && !IS_LITE && await slotCookieGone(res)) {
                  forgetAccount(account);
                } else if (res.status >= 500 && !recordPermanentRefreshFailure(res.status, account.id)) {
                  throw new TransientAuthError('Token refresh failed', res.status);
                } else {
                  // Repeated 500/502 (see recordPermanentRefreshFailure) falls
                  // through here and evicts the account like a rejection. (#972)
                  if (res.status >= 500) notifySignInAgain();
                  throw Object.assign(new Error(`Token refresh failed: ${res.status}`), { forced: await forcedSignOutOf(res) });
                }
              } else {
                const res = await fetchSlotSession(account.cookieSlot);
                if (res.ok) {
                  const session: RememberedSession = await res.json();
                  const client = clientForSession(session);
                  bindClientStatusHandlers(client, set, get, account.id);
                  const contextSync = syncStalwartAuthContext(session.serverUrl, session.username, client.getAuthHeader(), account.cookieSlot);
                  await client.connect();
                  holdClient(account.id, client);
                  await contextSync;
                  accountStore.updateAccount(account.id, {
                    isConnected: true,
                    hasError: false,
                    impersonated: session.impersonated === true,
                  });
                  void syncAccountDisplayName(account.id, client);
                } else if (!account.rememberMe && !IS_LITE && await slotCookieGone(res)) {
                  forgetAccount(account);
                } else if (res.status >= 500 || res.status === 429) {
                  throw new TransientAuthError('Session restore failed', res.status);
                } else {
                  throw Object.assign(new Error(`Session cookie missing: ${res.status}`), { forced: await forcedSignOutOf(res) });
                }
              }
            } catch (err) {
              debug.error(`Failed to restore account ${account.id}:`, err);
              if (isRateLimitError(err)) {
                accountStore.updateAccount(account.id, {
                  isConnected: false,
                  hasError: true,
                  errorMessage: 'Temporarily rate limited by server',
                });
                return;
              }
              // Outage or offline - keep the account (and its cookies) so the
              // session resumes once the server is reachable again. Same
              // treatment as the rate-limit case above; only a definitive
              // rejection below evicts.
              if (isTransientAuthError(err)) {
                // Offline mode (#523): with this account's mail kept on the
                // device, start from it. The client answers from the device
                // only; a reload once the server is back signs in as usual.
                const offlineClient = await startOfflineClient(account.id, account.serverUrl, account.username);
                if (offlineClient) {
                  holdClient(account.id, offlineClient);
                  accountStore.updateAccount(account.id, { isConnected: true, hasError: false });
                  return;
                }
                accountStore.updateAccount(account.id, {
                  isConnected: false,
                  hasError: true,
                  errorMessage: 'Server unreachable',
                });
                return;
              }
              // Remove unrestorable accounts so the user is prompted to log in
              // again rather than seeing a stale error entry forever. Its
              // refresh token goes with it: nothing would use or revoke it. Its
              // local data waits.
              const { forced } = err as { forced?: ForcedSignOutKind | null };
              if (forced) noteRefusedLogin(account.id, true, forced);
              else if (refusedAtConnect.has(account.id)) noteRefusedLogin(account.id, false);
              refusedAtConnect.delete(account.id);
              expiredDuringRestore = true;
              requireAccountSignIn(account.id);
            }
          };

          // Restore the account the UI will show first, so time-to-inbox pays
          // for one account's round trips, not every registered account's. The
          // rest connect in the background once the target is up; the revision
          // bump re-runs per-client effects (push binding) over the full set.
          const targetEntry = accounts.find((account) => account.id === targetId);
          const otherAccounts = accounts.filter((account) => account.id !== targetId);
          // With the local store on, the local copy shows at once and the real
          // connect takes over when it's done (swapInRealClient below).
          const localCopy = targetEntry && !targetEntry.awaitingSignIn && targetEntry.rememberMe
            ? await startLocalCopyClient(targetEntry.id, targetEntry.serverUrl, targetEntry.username)
            : null;
          if (localCopy && targetEntry) {
            holdClient(targetEntry.id, localCopy);
            accountStore.updateAccount(targetEntry.id, { isConnected: true, hasError: false });
          } else if (targetEntry) {
            await restoreAccount(targetEntry);
          }

          /**
           * The real connect behind a local copy on screen. No reload and no
           * loading state: the client in the store changes and the pages
           * refetch from the server. A refused account goes through the usual
           * restore path, an unreachable server keeps the local copy.
           */
          const swapInRealClient = async (entry: (typeof accounts)[number], local: JMAPClient) => {
            clients.delete(entry.id);
            await restoreAccount(entry);
            const real = clients.get(entry.id);
            if (!real) {
              const retained = useAccountStore.getState().getAccountById(entry.id);
              if (retained && !retained.awaitingSignIn) {
                holdClient(entry.id, local);
                // A 5xx or a rate limit, with the server up otherwise. The app stays
                // on the local copy, and says so, and leaves it when the server answers.
                void import('@/lib/offline/offline-mode').then((offline) => offline.markStartedOffline()).catch(() => {});
                return;
              }
              if (get().activeAccountId !== entry.id) return;
              // Refused, and evicted by the restore. Whoever is left, or the login page.
              local.disconnect();
              clearAllStores();
              markSessionExpired();
              set({ client: null, isAuthenticated: false, activeAccountId: null });
              if (useAccountStore.getState().accounts.length > 0) await get().checkAuth();
              else markSessionExpired();
              return;
            }
            if (get().activeAccountId !== entry.id) return;
            initializeFeatureStores(real);
            set({ client: real, ...getClientRateLimitState(real), connectionLost: false, error: null });
            // The local copy may have had none yet, and the server's are newer.
            void real.getIdentities()
              .then((raw) => {
                if (get().client !== real) return;
                const { identities, primaryIdentity } = loadIdentities(raw, entry.username);
                set({ identities, primaryIdentity });
                applyPreferredIdentity(entry.id);
              })
              .catch((err) => debug.error('Failed to load identities after the local copy:', err));
          };

          // A few at a time rather than one after the other: with many logins
          // the serial walk left the last of them - and with it a complete
          // unified inbox - waiting on every other login's round trips. Each
          // restore handles its own failures, so one slow or broken login
          // holds up only its own slot.
          const restoreRemaining = async () => {
            const queue = [...otherAccounts];
            const worker = async () => {
              for (let next = queue.shift(); next; next = queue.shift()) {
                await restoreAccount(next);
              }
            };
            await Promise.allSettled(
              Array.from({ length: Math.min(RESTORE_CONCURRENCY, queue.length) }, worker),
            );
          };

          if (clients.has(targetId)) {
            if (otherAccounts.length > 0) {
              set({ restoringAccounts: true });
              void restoreRemaining().then(() => {
                set((state) => ({ connectedAccountsRevision: state.connectedAccountsRevision + 1, restoringAccounts: false }));
              });
            }
          } else {
            // Target didn't restore - the fallback below needs the other
            // accounts connected before it can pick one, so wait for them.
            await restoreRemaining();
          }

          // Activate the target account
          const targetClient = clients.get(targetId);
          const targetAccount = accountStore.getAccountById(targetId);
          if (targetClient && targetAccount) {
            accountStore.setActiveAccount(targetId);
            initializeFeatureStores(targetClient);

            // Identities only feed the composer's From picker and the settings
            // pages - not the mail list. Load them in the background instead of
            // spending a serial round trip before the UI unblocks.
            const identitiesLoaded = targetClient.getIdentities()
              .then((raw) => {
                // The real client took over meanwhile, and asks for itself.
                if (localCopy && get().client !== null && get().client !== targetClient) return;
                const { identities, primaryIdentity } = loadIdentities(raw, targetAccount.username);
                set({ identities, primaryIdentity });
              })
              .catch((err) => debug.error('Failed to load identities during restore:', err));

            set({
              isAuthenticated: true,
              isLoading: false,
              serverUrl: targetAccount.serverUrl,
              username: targetAccount.username,
              client: targetClient,
              ...getClientRateLimitState(targetClient),
              authMode: targetAccount.authMode,
              rememberMe: targetAccount.rememberMe,
              connectionLost: false,
              error: null,
              activeAccountId: targetId,
            });
            if (localCopy && targetEntry) void swapInRealClient(targetEntry, localCopy);

            fetchConfig().then(config => {
              if (!config.settingsSyncEnabled) return;
              useSettingsStore.getState().loadFromServer(targetAccount.username, targetAccount.serverUrl).finally(() => {
                useSettingsStore.getState().enableSync(targetAccount.username, targetAccount.serverUrl);
                // The preferred identity can only be applied once identities
                // are known; both loads run concurrently, so join here.
                identitiesLoaded.then(() => applyPreferredIdentity(targetAccount.id));
              });
            }).catch(() => {});
            return;
          }

          // If target didn't connect, try any connected account
          for (const [id, client] of clients.entries()) {
            const acc = accountStore.getAccountById(id);
            if (acc) {
              accountStore.setActiveAccount(id);
              const { identities, primaryIdentity } = loadIdentities(await client.getIdentities(), acc.username);
              initializeFeatureStores(client);

              set({
                isAuthenticated: true,
                isLoading: false,
                serverUrl: acc.serverUrl,
                username: acc.username,
                client,
                ...getClientRateLimitState(client),
                identities,
                primaryIdentity,
                authMode: acc.authMode,
                rememberMe: acc.rememberMe,
                connectionLost: false,
                error: null,
                activeAccountId: id,
              });
              return;
            }
          }

          // No accounts could be restored. Accounts restored from the account
          // list backup were never signed in here, so they say nothing about
          // the connection.
          if (accounts.some((account) => {
            const entry = accountStore.getAccountById(account.id);
            return entry && !entry.awaitingSignIn;
          })) {
            set({
              isAuthenticated: false,
              isLoading: false,
              isRateLimited: false,
              rateLimitUntil: null,
              client: null,
              error: 'connection_failed',
            });
            return;
          }

          if (forgottenAccounts === accounts.length) saveRedirectAfterLogin();
          else if (expiredDuringRestore) markSessionExpired();
          set({
            isAuthenticated: false,
            isLoading: false,
            isRateLimited: false,
            rateLimitUntil: null,
            client: null,
            serverUrl: null,
            username: null,
            authMode: 'basic',
            rememberMe: false,
            accessToken: null,
            tokenExpiresAt: null,
            activeAccountId: null,
          });
          return;
        }

        // Legacy single-account fallback (for accounts not yet in registry)
        const state = get();
        if (state.isAuthenticated && !state.client) {
          if (state.authMode === 'oauth' && state.serverUrl) {
            set({ isLoading: true, isRateLimited: false, rateLimitUntil: null });
            try {
              // Restore, not renewal - let the server hand back the cached
              // token if it is still valid rather than spending a refresh.
              const token = await get().refreshAccessToken({ allowCached: true });
              if (token && state.serverUrl) {
                const refreshFn = get().refreshAccessToken;
                const client = JMAPClient.withBearer(state.serverUrl, token, state.username || '', () => refreshFn());
                await client.connect();

                const accountId = generateAccountId(state.username || '', state.serverUrl);
                holdClient(accountId, client);
                bindClientStatusHandlers(client, set, get, accountId);

                // Migrate to account registry
                accountStore.addAccount({
                  label: state.username || '',
                  serverUrl: state.serverUrl,
                  username: state.username || '',
                  authMode: 'oauth',
                  rememberMe: true,
                  displayName: state.username || '',
                  email: state.username || '',
                  lastLoginAt: Date.now(),
                  isConnected: true,
                  hasError: false,
                  isDefault: accountStore.accounts.length === 0,
                });
                accountStore.setActiveAccount(accountId);

                const { identities, primaryIdentity } = loadIdentities(await client.getIdentities(), state.username || '');
                initializeFeatureStores(client);
                void syncAccountDisplayName(accountId, client, primaryIdentity?.name);

                set({
                  isAuthenticated: true,
                  isLoading: false,
                  client,
                  ...getClientRateLimitState(client),
                  identities,
                  primaryIdentity,
                  accessToken: token,
                  activeAccountId: accountId,
                });

                fetchConfig().then(config => {
                  if (!config.settingsSyncEnabled) return;
                  useSettingsStore.getState().loadFromServer(state.username || '', state.serverUrl!).finally(() => {
                    useSettingsStore.getState().enableSync(state.username || '', state.serverUrl!);
                    applyPreferredIdentity(accountId);
                  });
                }).catch(() => {});
                return;
              }
            } catch (error) {
              debug.error('OAuth session restore failed:', error);
              if (isRateLimitError(error)) {
                set({ isLoading: false, error: 'connection_failed', isRateLimited: false, rateLimitUntil: null });
                return;
              }
              clearRefreshTimer();
            }
          }

          if (state.authMode === 'basic') {
            set({ isLoading: true, isRateLimited: false, rateLimitUntil: null });
            try {
              const res = await fetchSlotSession();
              if (res.ok) {
                const data = await res.json();
                if (!data.serverUrl || !data.username || !data.password) {
                  debug.error('Session restore returned incomplete data');
                  throw new Error('Incomplete session data');
                }
                const { serverUrl, username, password } = data;
                const client = new JMAPClient(serverUrl, username, password);
                await client.connect();

                const accountId = generateAccountId(username, serverUrl);
                holdClient(accountId, client);
                bindClientStatusHandlers(client, set, get, accountId);

                // Migrate to account registry
                accountStore.addAccount({
                  label: username,
                  serverUrl,
                  username,
                  authMode: 'basic',
                  rememberMe: state.rememberMe,
                  displayName: username,
                  email: username,
                  lastLoginAt: Date.now(),
                  isConnected: true,
                  hasError: false,
                  isDefault: accountStore.accounts.length === 0,
                });
                accountStore.setActiveAccount(accountId);

                const cookieSlot = accountStore.getAccountById(accountId)?.cookieSlot ?? 0;
                await syncStalwartAuthContext(serverUrl, username, client.getAuthHeader(), cookieSlot);

                const { identities, primaryIdentity } = loadIdentities(await client.getIdentities(), username);
                initializeFeatureStores(client);
                void syncAccountDisplayName(accountId, client, primaryIdentity?.name);

                set({
                  isAuthenticated: true,
                  isLoading: false,
                  serverUrl,
                  username,
                  client,
                  ...getClientRateLimitState(client),
                  identities,
                  primaryIdentity,
                  authMode: 'basic',
                  activeAccountId: accountId,
                });

                fetchConfig().then(config => {
                  if (!config.settingsSyncEnabled) return;
                  useSettingsStore.getState().loadFromServer(username, serverUrl).finally(() => {
                    useSettingsStore.getState().enableSync(username, serverUrl);
                    applyPreferredIdentity(accountId);
                  });
                }).catch(() => {});
                return;
              }
            } catch (error) {
              debug.error('Basic session restore failed:', error);
              if (isRateLimitError(error) || isTransientAuthError(error)) {
                set({ isLoading: false, error: 'connection_failed', isRateLimited: false, rateLimitUntil: null });
                return;
              }
            }
          }

          markSessionExpired();

          set({
            isAuthenticated: false,
            isLoading: false,
            isRateLimited: false,
            rateLimitUntil: null,
            client: null,
            serverUrl: null,
            username: null,
            authMode: 'basic',
            rememberMe: false,
            accessToken: null,
            tokenExpiresAt: null,
            activeAccountId: null,
          });
        }

        set({ isLoading: false });
      },

      clearError: () => set({ error: null }),

      updateBasicPassword: async (newPassword) => {
        const { client, activeAccountId } = get();
        const account = activeAccountId ? useAccountStore.getState().getAccountById(activeAccountId) : undefined;
        if (!client || !account || account.authMode !== 'basic') return;
        client.updateBasicAuth(newPassword);
        await syncStalwartAuthContext(account.serverUrl, account.username, client.getAuthHeader(), account.cookieSlot);
        if (account.rememberMe || IS_LITE || keepsUntickedSignInNow()) {
          await persistSession(account.cookieSlot, { serverUrl: account.serverUrl, username: account.username, password: newPassword }, account.rememberMe);
        }
      },

      signInRestoredAccount: async (accountId, password, rememberMe) => {
        const accountStore = useAccountStore.getState();
        const account = accountStore.getAccountById(accountId);
        if (!account || account.authMode !== 'basic' || clients.has(accountId)) return false;
        targetGenerations.set(account, signInGenerations.get(account.id) ?? 0);
        const { serverUrl, username, cookieSlot } = account;
        await waitForCredentialCleanup(cookieSlot);
        if (await precheckCredentials(serverUrl, { username, password })) return false;
        const client = new JMAPClient(serverUrl, username, password);
        try {
          await client.connect();
          await verifySignInTarget(client, account);
          await checkStoreOwner(accountId, client.getAccountId(), serverUrl);
          await verifySignInTarget(client, account);
        } catch (err) {
          debug.error(`Failed to sign in to restored account ${accountId}:`, err);
          client.disconnect();
          return false;
        }
        // Without a remembered session the next reload would drop the account
        // again, like any sign-in made without "Remember me" (unless the admin
        // keeps those until the browser closes).
        await Promise.all([
          rememberMe || IS_LITE || keepsUntickedSignInNow() ? persistSession(cookieSlot, { serverUrl, username, password }, rememberMe) : null,
          syncStalwartAuthContext(serverUrl, username, client.getAuthHeader(), cookieSlot),
        ]);
        if (!useAccountStore.getState().getAccountById(accountId)?.awaitingSignIn
          || targetGenerations.get(account) !== (signInGenerations.get(accountId) ?? 0)) {
          client.disconnect();
          return false;
        }
        clearEvicted(accountId);
        dropEvictedOwner(accountId);
        holdClient(accountId, client);
        bindClientStatusHandlers(client, set, get, accountId);
        accountStore.updateAccount(accountId, {
          awaitingSignIn: false, isConnected: true, hasError: false, errorMessage: undefined,
          rememberMe, lastLoginAt: Date.now(), signedInAt: signedInAtForSlot(cookieSlot),
        });
        void syncAccountDisplayName(accountId, client);
        set((state) => ({ connectedAccountsRevision: state.connectedAccountsRevision + 1 }));
        return true;
      },

      syncIdentities: () => {
        const identityState = useIdentityStore.getState();
        const identities = identityState.identities;
        const primaryIdentity = identities[0] ?? null;
        set({ identities, primaryIdentity });

        const { activeAccountId, client } = get();
        if (activeAccountId && client) {
          void syncAccountDisplayName(activeAccountId, client, primaryIdentity?.name);
        }
      },

      refreshIdentities: async () => {
        const { client, username } = get();
        if (!client || !username) return;
        try {
          const rawIdentities = await client.getIdentities();
          const { identities, primaryIdentity } = loadIdentities(rawIdentities, username);
          set({ identities, primaryIdentity });
        } catch {
          // Silently fail - background sync should not surface errors to the user
        }
      },

      startSharedSession: async (options) => {
        // Locked: not from another window, and not from the cookies either.
        if (isAppLockedNow()) return 'no-session';
        set({ isLoading: true, client: null });
        const accountStore = useAccountStore.getState();
        const answer = await requestWindowSession(options?.accountId ? { accountId: options.accountId } : {});
        const sessions = answer?.sessions ?? [];

        // No main window open: what the cookies still hold. A login made
        // without "Remember me" has nothing there, and that is no reason to
        // evict it: the list is the main window's business.
        const restoreFromCookies = async (account: AccountEntry): Promise<JMAPClient | null> => {
          if (account.awaitingSignIn) return null;
          if (account.authMode === 'oauth') {
            const res = await fetchSlotAccessToken(account.cookieSlot, { remember: account.rememberMe });
            if (res.status >= 500) throw new TransientAuthError('Token refresh failed', res.status);
            if (!res.ok) return null;
            const { access_token } = await res.json();
            await syncStalwartAuthContext(account.serverUrl, account.username, `Bearer ${access_token}`, account.cookieSlot);
            return JMAPClient.withBearer(account.serverUrl, access_token, account.username, () => get().refreshAccessToken({ accountId: account.id }));
          }
          if (!account.rememberMe && !IS_LITE && !(await keepsUntickedSignIn())) return null;
          const res = await fetchSlotSession(account.cookieSlot);
          if (res.status >= 500) throw new TransientAuthError('Session restore failed', res.status);
          if (!res.ok) return null;
          const session: RememberedSession = await res.json();
          return clientForSession(session);
        };

        const adopt = async (accountId: string, session?: SharedAccountSession): Promise<JMAPClient | null> => {
          const account = accountStore.getAccountById(accountId);
          if (!account) return null;
          try {
            if (session?.offlineOnly) throw new TransientAuthError('The main window is offline', 503);
            const client = session
              ? JMAPClient.withSharedAuth(account.serverUrl, account.username, session.authHeader, session.authMode === 'oauth'
                ? () => get().refreshAccessToken({ accountId })
                : undefined)
              : await restoreFromCookies(account);
            if (!client) return null;
            bindClientStatusHandlers(client, set, get, accountId);
            await client.connect();
            holdClient(accountId, client);
            accountStore.updateAccount(accountId, { isConnected: true, hasError: false });
            return client;
          } catch (error) {
            debug.error(`A pop-out could not use account ${accountId}:`, error);
            if (!isTransientAuthError(error)) return null;
            const offlineClient = await startOfflineClient(accountId, account.serverUrl, account.username);
            if (offlineClient) holdClient(accountId, offlineClient);
            return offlineClient;
          }
        };

        const targetId = options?.accountId
          ?? answer?.activeAccountId
          ?? accountStore.activeAccountId
          ?? accountStore.getDefaultAccount()?.id
          ?? null;
        const account = targetId ? accountStore.getAccountById(targetId) : undefined;
        const client = account ? await adopt(account.id, sessions.find((session) => session.accountId === account.id)) : null;
        if (!account || !client) {
          set({ isLoading: false, isAuthenticated: false, client: null });
          return 'no-session';
        }

        // The window's other logins: a draft may live in one (see
        // ComposerDraftData), and the Pro From picker lists them.
        const others = sessions.filter((session) => session.accountId !== account.id);
        if (others.length > 0) {
          void Promise.allSettled(others.map((session) => adopt(session.accountId, session))).then(() => {
            set((state) => ({ connectedAccountsRevision: state.connectedAccountsRevision + 1 }));
          });
        }

        accountStore.setActiveAccount(account.id);
        initializeFeatureStores(client);
        let loaded: ReturnType<typeof loadIdentities> = { identities: [], primaryIdentity: null };
        try {
          loaded = loadIdentities(await client.getIdentities(), account.username);
        } catch (error) {
          debug.error('Failed to load identities in a pop-out:', error);
        }
        set({
          isAuthenticated: true,
          isLoading: false,
          serverUrl: account.serverUrl,
          username: account.username,
          client,
          ...getClientRateLimitState(client),
          identities: loaded.identities,
          primaryIdentity: loaded.primaryIdentity,
          authMode: account.authMode,
          rememberMe: account.rememberMe,
          connectionLost: false,
          error: null,
          activeAccountId: account.id,
        });
        return 'ready';
      },

      getClientForAccount: (accountId: string) => {
        return clients.get(accountId);
      },

      getAllConnectedClients: () => {
        return new Map(clients);
      },

      reconnectOfflineClients: async () => {
        const offline = [...clients.entries()].filter(([, c]) => c.isOfflineOnly());
        if (offline.length === 0) return true;
        for (const [id] of offline) clients.delete(id);
        skipLocalCopy = true;
        try {
          await get().checkAuth();
        } finally {
          skipLocalCopy = false;
        }
        return offline.every(([id]) => {
          const client = clients.get(id);
          return !!client && !client.isOfflineOnly();
        });
      },
    }),
    {
      name: 'auth-storage',
      storage: createJSONStorage(mainWindowStorage),
      partialize: (state) => {
        // Don't persist unauthenticated state - prevents resurrecting stale sessions
        if (!state.isAuthenticated) return {};
        return {
          serverUrl: state.serverUrl,
          username: state.username,
          authMode: state.authMode,
          isAuthenticated: (state.authMode === 'oauth' || state.rememberMe)
            ? state.isAuthenticated
            : undefined,
          rememberMe: state.rememberMe,
          activeAccountId: state.activeAccountId,
        };
      },
    }
  )
);

// Expose getClientForAccount to the calendar/contact stores via a small
// shared registry - see [[stores/client-registry]] for rationale.
setClientLookup((accountId) => useAuthStore.getState().getClientForAccount(accountId));

// Before signing in, the server only hands out the public part of the admin
// policy; fetch the rest once a session exists.
useAuthStore.subscribe((state, prev) => {
  if (state.isAuthenticated && !prev.isAuthenticated) void usePolicyStore.getState().refreshIfPartial();
});

// Domain and group scopes follow the active account. setPolicySubject skips
// the work when the account's address and groups stayed the same.
let policySubjectRequest = 0;
useAuthStore.subscribe((state, prev) => {
  if (
    state.client === prev.client
    && state.activeAccountId === prev.activeAccountId
    && state.isAuthenticated === prev.isAuthenticated
    && state.connectedAccountsRevision === prev.connectedAccountsRevision
  ) return;
  const request = ++policySubjectRequest;
  if (!state.isAuthenticated || !state.client) {
    usePolicyStore.getState().setPolicySubject(null);
    return;
  }
  usePolicyStore.getState().setSubjectPending(true);
  void policySubjectForClient(state.client).then(async (subject) => {
    if (request !== policySubjectRequest) return;
    // The server sends only the scopes of the domains signed in when the
    // policy was fetched; an account of another domain may have its own.
    if (subject && !usePolicyStore.getState().coversAddress(subject.email)) {
      await usePolicyStore.getState().fetchPolicy();
      if (request !== policySubjectRequest) return;
    }
    usePolicyStore.getState().setPolicySubject(subject);
  });
});

/** Off to the login page, which says why. The account stays, for when the policy allows it again. */
function leaveForRefusedServer(): void {
  if (isPopoutWindow()) {
    closePopoutWindow();
    return;
  }
  replaceWindowLocation(getLocaleLoginPath());
}

// What's refused now, as of this page's start too: a reload to the login page mustn't
// forget that an account is waiting, or it wouldn't come back when it's allowed again.
let refusedAccounts = new Set<string>();

/**
 * The device's OS policy took a server off its list, or put one back. A refused account
 * stops: no client, no push, no renewals, and with no client its store has nothing to
 * sync through. It isn't signed out: cookies, outbox and mail stay. The active one moves
 * to the next allowed account, or to the login page.
 */
export function applyDesktopServerPolicy(): void {
  const auth = useAuthStore.getState();
  const accounts = useAccountStore.getState().accounts;
  const plan = planForRefusedAccounts(accounts, auth.activeAccountId, getDesktopPolicy());
  for (const id of plan.stop) {
    clearRefreshTimer(id);
    const client = clients.get(id);
    if (client) {
      forgetCalendarSubscriptions(client);
      try { client.disconnect(); } catch { /* noop */ }
      clients.delete(id);
    }
    useAccountStore.getState().updateAccount(id, { isConnected: false });
  }
  const returned = [...refusedAccounts].filter((id) => !plan.refused.includes(id));
  refusedAccounts = new Set(plan.refused);

  if (plan.activeRefused) {
    if (plan.next) void auth.switchAccount(plan.next);
    else {
      useAuthStore.setState({ client: null, isAuthenticated: false });
      leaveForRefusedServer();
    }
    return;
  }
  // Allowed again. With nobody signed in the start-up path restores it from its cookies;
  // otherwise it shows in the switcher again and connects when switched to.
  if (returned.length > 0 && !auth.client) window.location.replace('/');
}

if (typeof window !== 'undefined') {
  refusedAccounts = new Set(planForRefusedAccounts(useAccountStore.getState().accounts, null, getDesktopPolicy()).refused);
  onDesktopPolicyChange(applyDesktopServerPolicy);
}

// See canEnterLoginInPlace. A page that starts behind the app lock has shown nothing yet,
// whatever the stored state says, and a page load here would ask for the PIN again.
let signedInSincePageLoad = !isAppLockOn() && useAuthStore.getState().isAuthenticated;
useAuthStore.subscribe((state) => {
  if (state.isAuthenticated) {
    signedInSincePageLoad = true;
    freshLoginDone();
  }
});

// Another tab signed everyone out: this one's cookies and account list are
// gone too, so leave for the login page instead of showing stale mail.
if (typeof window !== 'undefined') {
  onSignedOutElsewhere(() => {
    // A pop-out saves its typing first (components/popout/popout-shell.tsx).
    if (isPopoutWindow()) return;
    if (useAuthStore.getState().isAuthenticated) navigateToLogin();
  });
}

// Plugins hear when a session becomes usable (after start-up or a sign-in)
// and when another account becomes active, whichever path got there.
useAuthStore.subscribe((state, prev) => {
  const ready = state.isAuthenticated && !!state.client && !!state.activeAccountId;
  const wasReady = prev.isAuthenticated && !!prev.client && !!prev.activeAccountId;
  if (ready && !wasReady) void authHooks.onAuthReady.emit({ accountId: state.activeAccountId });
  if (state.activeAccountId !== prev.activeAccountId) noteDesktopCertificateAccount(state.activeAccountId);
  // Whenever the account in use goes, not only at a sign-out: an expired or refused session
  // ends with no account, and the next person at this computer has to be asked.
  if (prev.activeAccountId && state.activeAccountId !== prev.activeAccountId) clearKeystoreGrants();
  if (state.activeAccountId && prev.activeAccountId && state.activeAccountId !== prev.activeAccountId) {
    clearDesktopCrashFiles();
    void authHooks.onAccountSwitch.emit({ accountId: state.activeAccountId, previousAccountId: prev.activeAccountId });
  }
});
