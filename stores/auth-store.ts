import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { JMAPClient, RateLimitError } from '@/lib/jmap/client';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useIdentityStore } from './identity-store';
import { setClientLookup } from './client-registry';
import { useContactStore } from './contact-store';
import { useVacationStore } from './vacation-store';
import { subscriptionOwner, useCalendarStore } from './calendar-store';
import { useFilterStore } from './filter-store';
import { useSettingsStore } from './settings-store';
import { useAccountStore, type AccountEntry } from './account-store';
import { fetchPrincipalDisplayName } from '@/lib/stalwart/principal';
import { fetchConfig } from '@/hooks/use-config';
import { debug } from '@/lib/debug';
import { setServerAuthIssue } from '@/lib/server-auth-status';
import { generateAccountId, MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { replaceWindowLocation, getPathPrefix, getLocaleFromPath, apiFetch } from '@/lib/browser-navigation';
import { isEmbedded, notifyParent } from '@/lib/iframe-bridge';
import { snapshotAccount, restoreAccount, clearAllStores, evictAccount, evictAll } from '@/lib/account-state-manager';
import { clearAllPluginStorage, clearPluginStorageForAccount } from '@/lib/plugin-sandbox/storage-scope';
import { broadcastSignOut, onSignedOutElsewhere, purgeSignedOutData } from '@/lib/sign-out-cleanup';
import { useSearchHistoryStore } from './search-history-store';
import { useCalendarNotificationStore } from './calendar-notification-store';
import { usePolicyStore } from './policy-store';
import type { Identity } from '@/lib/jmap/types';
import { authHooks } from '@/lib/plugin-hooks';
import { IS_LITE, IS_LITE_STALWART } from '@/lib/lite';
import { toAsciiEmail } from '@/lib/idn';
import {
  LiteLoginError,
  clearLiteRefreshToken,
  getLiteClientId,
  liteExchangeAuthorizationCode,
  liteRefreshTokens,
  liteTokenLogin,
  nameLiteRefreshToken,
  readLiteBasicSession,
  revokeAllLiteSessions,
  revokeLiteSlot,
  saveLiteBasicSession,
  saveLiteRefreshToken,
} from '@/lib/auth/lite-tokens';
import { clearLiteOAuthFlow, readLiteOAuthFlow } from '@/lib/auth/lite-oauth';

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
  authMode: 'basic' | 'oauth';
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

  login: (serverUrl: string, username: string, password: string, totp?: string, rememberMe?: boolean) => Promise<boolean>;
  loginWithOAuth: (serverUrl: string, code: string, codeVerifier: string, redirectUri: string, serverId?: string) => Promise<boolean>;
  loginWithServerSso: (code: string, state: string) => Promise<boolean>;
  loginDemo: () => Promise<boolean>;
  /**
   * Obtain a usable access token for the active account.
   *
   * Renews against the IdP by default. `allowCached` lets a session restore
   * reuse the token the server still holds for this slot - IdPs that gate
   * refresh tokens behind an `nbf` claim reject an early renewal outright.
   */
  refreshAccessToken: (options?: { allowCached?: boolean }) => Promise<string | null>;
  /**
   * Sign out of the active account. Switches to the next signed-in account
   * when there is one; otherwise ends the identity provider's session too
   * (see {@link LogoutOptions}) and leaves the app.
   */
  logout: (options?: LogoutOptions) => Promise<void>;
  /**
   * Sign out of every account. Ends at most one identity provider session:
   * see {@link pickEndSessionSlot}.
   */
  logoutAll: () => Promise<void>;
  removeAccount: (accountId: string) => void;
  switchAccount: (accountId: string) => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
  syncIdentities: () => void;
  /**
   * Keep a Basic-auth session working after the user changed the password:
   * the client, the server-side management context and the remembered
   * session still hold the old one, which the server now refuses.
   */
  updateBasicPassword: (newPassword: string) => Promise<void>;
  refreshIdentities: () => Promise<void>;
  getClientForAccount: (accountId: string) => JMAPClient | undefined;
  getAllConnectedClients: () => Map<string, JMAPClient>;
}

export interface LogoutOptions {
  /**
   * Also end the identity provider's session when the account signed in
   * through it (#905). Default true. False when the session ended on its own
   * (rejected or unrenewable token): the user did not ask to leave the
   * provider, and signing in again should stay a single click.
   */
  endProviderSession?: boolean;
}

const ERROR_PATTERNS: Array<{ key: string; matches: string[] }> = [
  { key: 'cors_blocked', matches: ['CORS_ERROR'] },
  { key: 'totp_required', matches: ['TOTP_REQUIRED'] },
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
 * Ask our own backend to try the Basic credentials before the browser does
 * (#969). A wrong password answered straight from the JMAP server arrives as
 * 401 + `WWW-Authenticate: Basic`, which makes the browser open its native
 * login dialog on top of our form when the JMAP server shares our origin
 * (reverse-proxied under the same host). Rejecting wrong credentials via a
 * JSON reply from our origin sidesteps that. Only a definitive
 * `unauthorized` short-circuits; anything else (route missing, backend can't
 * reach the JMAP server, TOTP challenge, ...) falls through to the regular
 * browser-side connect so no deployment loses the ability to log in.
 */
async function precheckBasicCredentials(serverUrl: string, username: string, password: string): Promise<boolean> {
  // App-relative servers (the dev mock) never send a Basic challenge, and the
  // static Lite build has no backend to ask.
  if (IS_LITE || serverUrl.startsWith('/')) return false;
  try {
    const res = await apiFetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl, username, password }),
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
 * forever. On Stalwart the identity name itself is a one-time snapshot of the
 * principal "Full name", so the live value has to come from the principal;
 * elsewhere the primary identity name is the best available source.
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

  const name = (await fetchPrincipalDisplayName(client, account.cookieSlot))
    || fallbackName?.trim()
    || '';
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

const TIMED_OUT = Symbol('timed out');

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
      body: JSON.stringify({ serverUrl, username, password, totp, slot, redirectUri }),
    });
  }
  try {
    const tokens = await liteTokenLogin({ serverUrl, username, password, totp, redirectUri });
    // "Remember me" keeps the refresh token across browser restarts
    // (localStorage); otherwise it lives with the tab (sessionStorage).
    if (tokens.refreshToken) {
      saveLiteRefreshToken(slot, { serverUrl, username, refreshToken: tokens.refreshToken, clientId: getLiteClientId() }, rememberMe);
    } else {
      clearLiteRefreshToken(slot);
    }
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
}): Promise<Response> {
  const { serverUrl, code, codeVerifier, redirectUri, slot, serverId } = params;
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
      }),
    });
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
      saveLiteRefreshToken(slot, {
        serverUrl,
        username: '',
        refreshToken: tokens.refreshToken,
        clientId: flow.clientId,
        tokenEndpoint: flow.tokenEndpoint,
        revocationEndpoint: flow.revocationEndpoint,
      }, flow.persistent);
    } else {
      clearLiteRefreshToken(slot);
    }
    return jsonResponse({ access_token: tokens.accessToken, expires_in: tokens.expiresIn });
  } catch (err) {
    if (err instanceof LiteLoginError) return jsonResponse({ error: err.code }, liteErrorStatus(err));
    throw err;
  }
}

/** POST /api/auth/session?slot=N - remember Basic credentials for `slot`. */
async function persistBasicSession(slot: number, serverUrl: string, username: string, password: string): Promise<void> {
  if (IS_LITE) {
    // Only reached when the server has no token login: keep the credentials
    // with this tab so a reload does not sign the user out.
    saveLiteBasicSession(slot, { serverUrl, username, password });
    return;
  }
  try {
    const res = await apiFetch(`/api/auth/session?slot=${slot}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl, username, password, slot }),
    });
    if (!res.ok) debug.error('Failed to store session: server returned', res.status);
  } catch (err) {
    debug.error('Failed to store session:', err);
  }
}

/** PUT /api/auth/token?slot=N - renew (or, unless `force`, reuse) the slot's access token. */
async function fetchSlotAccessToken(slot: number, opts: { force?: boolean } = {}): Promise<Response> {
  // Renewing would write the tokens of a slot being signed out back.
  if (closingSlots.has(slot)) return jsonResponse({ error: 'signed_out' }, 401);
  if (!IS_LITE) {
    return trackSessionWrite(slot, (signal) => apiFetch(`/api/auth/token?slot=${slot}${opts.force ? '&force=true' : ''}`, { method: 'PUT', signal }));
  }
  return trackSessionWrite(slot, async () => {
    try {
      const tokens = await liteRefreshTokens(slot);
      return jsonResponse({ access_token: tokens.accessToken, expires_in: tokens.expiresIn });
    } catch (err) {
      if (err instanceof LiteLoginError) return jsonResponse({ error: err.code }, liteErrorStatus(err));
      throw err; // network failure - callers treat it as an outage, not a rejection
    }
  });
}

/** PUT /api/auth/session[?slot=N] - the slot's remembered Basic credentials. */
async function fetchSlotSession(slot?: number): Promise<Response> {
  if (!IS_LITE) {
    return apiFetch(slot === undefined ? '/api/auth/session' : `/api/auth/session?slot=${slot}`, { method: 'PUT' });
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
  try {
    await settleSessionWrites(slots);
    const result = await withTimeout(requests(), CREDENTIAL_CLEANUP_TIMEOUT_MS);
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
      await revokeLiteSlot(slot);
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
      await revokeAllLiteSessions();
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

function bindClientStatusHandlers(
  client: IJMAPClient,
  set: (state: Partial<AuthState>) => void,
  get: () => AuthState,
  accountId?: string,
): void {
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

function emailMatchesUsername(email: string, username: string): boolean {
  if (email === username) return true;
  // Handle local-part login: username "user" should match "user@domain.tld"
  if (!username.includes('@') && email.split('@')[0] === username) return true;
  return false;
}

function sortIdentities(rawIdentities: Identity[], username: string): Identity[] {
  return [...rawIdentities].sort((a, b) => {
    const aMatch = emailMatchesUsername(a.email, username);
    const bMatch = emailMatchesUsername(b.email, username);
    if (aMatch && !bMatch) return -1;
    if (!aMatch && bMatch) return 1;
    // Among matching identities, prefer canonical (non-deletable) over aliases
    if (aMatch && bMatch) {
      if (!a.mayDelete && b.mayDelete) return -1;
      if (a.mayDelete && !b.mayDelete) return 1;
    }
    return 0;
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
      useSettingsStore.getState().updateSetting('preferredIdentityIds', { ...current, [targetId]: legacy });
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

    if (currentPath !== loginPath) {
      sessionStorage.setItem('redirect_after_login', currentPath);
    }
  } catch {
    /* noop */
  }
}

export function redirectToLogin(): void {
  if (typeof window === 'undefined' || leavingForProviderLogout) return;
  navigateToLogin();
}

function navigateToLogin(): void {
  if (typeof window === 'undefined') return;

  const loginPath = getLocaleLoginPath();
  if (window.location.pathname === loginPath) return;
  replaceWindowLocation(loginPath);
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

    // Default trusted-sender syncing on when contacts are available, unless the
    // user has already made an explicit choice (`null` = not yet decided).
    const settings = useSettingsStore.getState();
    if (settings.trustedSendersAddressBook === null) {
      settings.updateSetting('trustedSendersAddressBook', true);
    }
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

function performFullLogout(set: (state: Partial<AuthState>) => void): void {
  useSettingsStore.getState().disableSync();

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
  try { localStorage.removeItem('account-registry'); } catch { /* noop */ }
  purgeSignedOutData();
  // Other tabs still hold the accounts' mail in memory.
  broadcastSignOut();
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

      login: async (serverUrl, typedUsername, password, totp, rememberMe) => {
        set({ isLoading: true, error: null, isRateLimited: false, rateLimitUntil: null });

        // Sign in with the ASCII (punycode) form of an IDN domain, the form
        // Stalwart stores and reports back in the session and identities, so
        // `user@bücher.de` and `user@xn--bcher-kva.de` are one account (#1100).
        const username = toAsciiEmail(typedUsername);

        try {
          // Resolve account/slot info up front so the TOTP exchange can target
          // the right per-account refresh-token cookie slot.
          const accountStore = useAccountStore.getState();
          const accountId = generateAccountId(username, serverUrl);
          const cookieSlot = accountStore.hasAccount(username, serverUrl)
            ? (accountStore.getAccountById(accountId)?.cookieSlot ?? accountStore.getNextCookieSlot())
            : accountStore.getNextCookieSlot();

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
                debug.warn('auth', 'TOTP login exchange failed, trying legacy basic auth:', tokenRes.status, errorBody);
              }
            } catch (err) {
              if (err instanceof Error && err.message === 'TOTP_REQUIRED') throw err;
              // Unreachable (a server without /api/auth rarely answers CORS).
              tokenLoginUnavailable = true;
              debug.warn('auth', 'TOTP login exchange error, trying legacy basic auth:', err);
            }

            if (bearerToken) {
              client = JMAPClient.withBearer(serverUrl, bearerToken, username, () => get().refreshAccessToken());
              await client.connect();
              oauthAccessToken = bearerToken;
              upgradedToOAuth = true;
            } else if (totp) {
              // Legacy fallback for pre-0.16 Stalwart, which accepts the TOTP
              // appended to the password over basic auth.
              if (await precheckBasicCredentials(serverUrl, username, `${password}$${totp}`)) {
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
              // then kept with the tab only, see persistBasicSession.
              client = new JMAPClient(serverUrl, username, password);
              await client.connect();
            }
          } else {
            if (await precheckBasicCredentials(serverUrl, username, password)) {
              throw new Error('Invalid username or password');
            }
            client = new JMAPClient(serverUrl, username, password);
            await client.connect();
          }

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
          // caught locally so Promise.all doesn't reject on either.
          // In Lite a Basic session is kept for the tab (sessionStorage) on a
          // server without token login, so a reload does not sign the user
          // out; the regular build only writes the cookie when the user asked
          // to be remembered.
          const sessionWrite: Promise<unknown> = ((IS_LITE ? tokenLoginUnavailable : rememberMe) && !upgradedToOAuth)
            ? persistBasicSession(cookieSlot, serverUrl, username, password)
            : Promise.resolve();

          const [rawIdentities] = await Promise.all([
            identitiesPromise,
            sessionWrite,
            syncStalwartAuthContext(serverUrl, username, client.getAuthHeader(), cookieSlot),
          ]);

          const { identities, primaryIdentity } = loadIdentities(rawIdentities, username);
          initializeFeatureStores(client);

          // Store client in multi-account map
          clients.set(accountId, client);
          bindClientStatusHandlers(client, set, get, accountId);

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

          // Kick off mailbox/quota/email fetches now so they overlap with the
          // soft-nav + home-page hydration that follows login. Dynamic import
          // avoids a static circular dep with email-store.
          import('@/stores/email-store').then(({ useEmailStore }) => {
            useEmailStore.getState().prefetchInitialData(client).catch((err) => {
              debug.error('Initial data prefetch failed:', err);
            });
          }).catch(() => {});

          // Schedule token refresh for TOTP-upgraded sessions
          if (upgradedToOAuth && oauthExpiresIn > 0) {
            scheduleRefresh(oauthExpiresIn, get().refreshAccessToken, accountId);
          }

          // Sync settings from server (only if enabled)
          fetchConfig().then(config => {
            if (!config.settingsSyncEnabled) return;
            useSettingsStore.getState().loadFromServer(username, serverUrl).finally(() => {
              useSettingsStore.getState().enableSync(username, serverUrl);
              applyPreferredIdentity(accountId);
            });
          }).catch(() => {});

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

      loginDemo: async () => {
        set({ isLoading: true, error: null, isRateLimited: false, rateLimitUntil: null });
        try {
          // Clear all store data before re-initializing with fresh demo data
          clearAllStores();

          const { DemoJMAPClient } = await import('@/lib/demo/demo-client');
          const client = new DemoJMAPClient();
          await client.connect();

          const username = client.getUsername();
          const { identities, primaryIdentity } = loadIdentities(await client.getIdentities(), username);
          initializeFeatureStores(client);

          // Register a demo account entry so the account-switcher shows
          // proper avatar/name instead of a "?" placeholder.
          const accountStore = useAccountStore.getState();
          const demoAccountId = accountStore.addAccount({
            label: primaryIdentity?.name || 'Demo User',
            serverUrl: 'https://demo.example.com',
            username,
            authMode: 'basic',
            rememberMe: false,
            displayName: primaryIdentity?.name || 'Demo User',
            email: primaryIdentity?.email || username,
            lastLoginAt: Date.now(),
            isConnected: true,
            hasError: false,
            isDefault: true,
          });
          accountStore.setActiveAccount(demoAccountId);

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
          const rawSlot = typeof window !== 'undefined'
            ? sessionStorage.getItem('oauth_cookie_slot')
            : null;
          const pendingSlot = rawSlot !== null ? parseInt(rawSlot, 10) : NaN;
          const slot = !isNaN(pendingSlot) && pendingSlot >= 0 && pendingSlot <= 4
            ? pendingSlot
            : accountStore.getNextCookieSlot();

          const tokenRes = await exchangeOAuthCode({ serverUrl, code, codeVerifier, redirectUri, slot, serverId });

          if (!tokenRes.ok) {
            throw new Error('token_exchange_failed');
          }
          if (IS_LITE) unnamedLiteSlot = slot;

          const { access_token, expires_in } = await tokenRes.json();

          const refreshFn = get().refreshAccessToken;
          const client = JMAPClient.withBearer(serverUrl, access_token, '', () => refreshFn());
          await client.connect();

          const jmapUsername = client.getUsername();
          const { identities, primaryIdentity } = loadIdentities(await client.getIdentities(), jmapUsername);
          // For OAuth/OIDC, the JMAP session account name may be the
          // preferred_username claim rather than the real email address.
          // Prefer the email from the primary identity when available.
          const username = primaryIdentity?.email || jmapUsername;
          if (IS_LITE) {
            nameLiteRefreshToken(slot, username);
            unnamedLiteSlot = null;
          }
          initializeFeatureStores(client);

          // Register in account store
          const accountId = generateAccountId(username, serverUrl);

          // Snapshot current account if switching away and clear stores so
          // the new account starts with a clean email/contact/calendar state.
          const prevAccountId = get().activeAccountId;
          if (prevAccountId && prevAccountId !== accountId) {
            snapshotAccount(prevAccountId);
            clearAllStores();
          }

          clients.set(accountId, client);
          bindClientStatusHandlers(client, set, get, accountId);

          accountStore.addAccount({
            label: primaryIdentity?.name || username,
            serverUrl,
            username,
            authMode: 'oauth',
            rememberMe: true,
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

          await syncStalwartAuthContext(serverUrl, username, client.getAuthHeader(), slot);
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

          scheduleRefresh(expires_in, get().refreshAccessToken, accountId);

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
          }

          return true;
        } catch (error) {
          debug.error('OAuth login error:', error);
          // The code was redeemed but the session never came up: nothing owns
          // the refresh token the exchange stored.
          if (unnamedLiteSlot !== null) clearLiteRefreshToken(unnamedLiteSlot);
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
          const slot = accountStore.getNextCookieSlot();

          // SSO token exchange and config fetch are independent - fire both
          // up front and let them resolve in parallel.
          const [ssoRes, config] = await Promise.all([
            apiFetch('/api/auth/sso/complete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ code, state, slot }),
            }),
            fetchConfig(),
          ]);

          if (!ssoRes.ok) {
            const errorData = await ssoRes.json().catch(() => ({ error: 'token_exchange_failed' }));
            throw new Error(errorData.error || 'token_exchange_failed');
          }

          const { access_token, expires_in } = await ssoRes.json();

          const ssoServerUrl = config.jmapServerUrl;

          if (!ssoServerUrl) {
            throw new Error('Server URL not configured');
          }

          const refreshFn = get().refreshAccessToken;
          const client = JMAPClient.withBearer(ssoServerUrl, access_token, '', () => refreshFn());
          await client.connect();

          const jmapUsername = client.getUsername();
          const { identities, primaryIdentity } = loadIdentities(await client.getIdentities(), jmapUsername);
          // For SSO/OIDC, the JMAP session account name may be the
          // preferred_username claim rather than the real email address.
          // Prefer the email from the primary identity when available.
          const username = primaryIdentity?.email || jmapUsername;
          initializeFeatureStores(client);

          const accountId = generateAccountId(username, ssoServerUrl);

          const prevAccountId = get().activeAccountId;
          if (prevAccountId && prevAccountId !== accountId) {
            snapshotAccount(prevAccountId);
            clearAllStores();
          }

          clients.set(accountId, client);
          bindClientStatusHandlers(client, set, get, accountId);

          accountStore.addAccount({
            label: primaryIdentity?.name || username,
            serverUrl: ssoServerUrl,
            username,
            authMode: 'oauth',
            rememberMe: true,
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
          accountStore.updateAccount(accountId, { cookieSlot: slot, providerSession: true });
          accountStore.setActiveAccount(accountId);

          await syncStalwartAuthContext(ssoServerUrl, username, client.getAuthHeader(), slot);
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

          scheduleRefresh(expires_in, get().refreshAccessToken, accountId);

          notifyParent('sso:auth-success', { username });

          fetchConfig().then(cfg => {
            if (!cfg.settingsSyncEnabled) return;
            useSettingsStore.getState().loadFromServer(username, ssoServerUrl).finally(() => {
              useSettingsStore.getState().enableSync(username, ssoServerUrl);
              applyPreferredIdentity(accountId);
            });
          }).catch(() => {});

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
        }
      },

      refreshAccessToken: async (options) => {
        if (refreshPromise) return refreshPromise;

        const accountId = get().activeAccountId;
        if (accountId && refreshPromises.has(accountId)) {
          return refreshPromises.get(accountId)!;
        }

        const account = accountId ? useAccountStore.getState().getAccountById(accountId) : null;
        const slot = account?.cookieSlot ?? 0;
        // The account is being signed out: a renewal now would only undo that.
        if (closingSlots.has(slot)) return null;

        const promise = (async () => {
          try {
            // Default to forcing a genuine refresh: the usual caller was told
            // the current token is unusable (rejected by JMAP, or due for
            // scheduled renewal), so the server-side cache must be skipped.
            // Session restore passes allowCached to reuse a still-valid token.
            const res = await fetchSlotAccessToken(slot, { force: !options?.allowCached });

            if (!res.ok) {
              // Only a definitive 401 ends the session. Anything else (5xx
              // while the server restarts, proxy errors) is an outage - keep
              // the session and retry shortly so "stay signed in" survives
              // maintenance windows and offline spells.
              if (res.status === 401) {
                resetRefreshBackoff(accountId ?? undefined);
                notifyParent('sso:session-expired');
                markSessionExpired();
                get().logout({ endProviderSession: false });
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
                if (accountId && accountId !== get().activeAccountId) get().removeAccount(accountId);
                else get().logout({ endProviderSession: false });
                return null;
              }
              if (shouldRetryRefresh(slot, accountId ?? undefined)) {
                const retryIn = nextRefreshRetrySeconds(accountId ?? undefined);
                debug.error(`Token refresh unavailable (${res.status}), retrying with backoff`);
                scheduleRefresh(retryIn, get().refreshAccessToken, accountId ?? undefined);
              }
              return null;
            }

            const { access_token, expires_in } = await res.json();

            // Signed out while the renewal was in flight: nothing to keep alive.
            if (closingSlots.has(slot)) return null;

            get().client?.updateAccessToken(access_token);

            if (account) {
              await syncStalwartAuthContext(
                account.serverUrl,
                account.username,
                `Bearer ${access_token}`,
                slot,
              );
            }

            set({
              accessToken: access_token,
              tokenExpiresAt: Date.now() + expires_in * 1000,
            });

            resetRefreshBackoff(accountId ?? undefined);
            scheduleRefresh(expires_in, get().refreshAccessToken, accountId ?? undefined);
            return access_token;
          } catch (error) {
            // Network failure (offline, Wi-Fi switch, server unreachable) -
            // not a rejection. Keep the session and retry with backoff.
            debug.error('Token refresh failed, retrying with backoff:', error);
            if (shouldRetryRefresh(slot, accountId ?? undefined)) {
              scheduleRefresh(nextRefreshRetrySeconds(accountId ?? undefined), get().refreshAccessToken, accountId ?? undefined);
            }
            return null;
          } finally {
            refreshPromise = null;
            if (accountId) refreshPromises.delete(accountId);
          }
        })();

        refreshPromise = promise;
        if (accountId) refreshPromises.set(accountId, promise);

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
        const endProviderSession = userInitiated && !wasDemoMode && shouldEndProviderSession(account);

        const ok = await authHooks.onBeforeLogout.intercept({
          accountId: accountId ?? 'all',
        });

        if(!ok){
          return;
        }

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
          accountStore.removeAccount(accountId);
          if (!wasDemoMode) clearPluginStorageForAccount(accountId);
        }

        await useSettingsStore.getState().flushSync();
        useSettingsStore.getState().disableSync();

        await authHooks.onAfterLogout.emit({
          accountId: accountId ?? 'all',
        });

        // Check if there are remaining accounts to switch to. Read the store
        // afresh: `accountStore` is the state from before removeAccount().
        const nextAccount = wasDemoMode ? undefined : useAccountStore.getState().accounts[0];
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

          // Client not in memory - sign out fully instead.
          // Trying to async-restore during logout caused the original bug.
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
            accountStore.removeAccount(remaining.id);
          }
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

        performFullLogout(set);

        notifyParent('sso:logout');

        finishSignOut(endSessionUrl, userInitiated);
      },

      // Remove a specific (typically non-active) account: tear down its client,
      // drop it from the registry, and clear its per-slot cookies. If asked to
      // remove the active account, defer to logout() which handles switching
      // away or redirecting.
      removeAccount: (accountId: string) => {
        if (accountId === get().activeAccountId) { void get().logout(); return; }
        const accountStore = useAccountStore.getState();
        const account = accountStore.getAccountById(accountId);
        if (!account) return;
        const slot = account.cookieSlot ?? 0;
        const wasOAuth = account.authMode === 'oauth';

        // Started first: the cleanup marks the slot closing right away, so a
        // renewal in flight cannot bring the session back.
        void clearSlotCredentials(slot, wasOAuth);
        clearRefreshTimer(accountId);
        const client = clients.get(accountId);
        if (client) {
          forgetCalendarSubscriptions(client);
          try { client.disconnect(); } catch { /* noop */ }
        }
        clients.delete(accountId);
        evictAccount(accountId);
        accountStore.removeAccount(accountId);
        clearPluginStorageForAccount(accountId);
      },

      logoutAll: async () => {
        const ok = await authHooks.onBeforeLogout.intercept({
          accountId: 'all'
        });

        if(!ok){
          return;
        }

        const accountStore = useAccountStore.getState();
        const allAccounts = [...accountStore.accounts];
        const endSessionSlot = get().isDemoMode ? null : pickEndSessionSlot(allAccounts, get().activeAccountId);

        // Starts by marking every slot closing, so nothing renews a session
        // while the clients are torn down.
        const cleanup = clearAllCredentials(endSessionSlot);

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

        performFullLogout(set);

        // Clear all accounts from registry
        for (const account of allAccounts) {
          accountStore.removeAccount(account.id);
        }

        await authHooks.onAfterLogout.emit({
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
        if (!targetAccount) return;

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
              const res = await fetchSlotAccessToken(targetAccount.cookieSlot);
              if (res.ok) {
                const { access_token, expires_in } = await res.json();
                const refreshFn = get().refreshAccessToken;
                targetClient = JMAPClient.withBearer(targetAccount.serverUrl, access_token, targetAccount.username, () => refreshFn());
                bindClientStatusHandlers(targetClient, set, get, accountId);
                await targetClient.connect();
                clients.set(accountId, targetClient);
                scheduleRefresh(expires_in, get().refreshAccessToken, accountId);
                await syncStalwartAuthContext(
                  targetAccount.serverUrl,
                  targetAccount.username,
                  targetClient.getAuthHeader(),
                  targetAccount.cookieSlot,
                );
              }
            } else if (targetAccount.authMode === 'basic' && targetAccount.rememberMe) {
              const res = await fetchSlotSession(targetAccount.cookieSlot);
              if (res.ok) {
                const { serverUrl, username, password } = await res.json();
                targetClient = new JMAPClient(serverUrl, username, password);
                bindClientStatusHandlers(targetClient, set, get, accountId);
                await targetClient.connect();
                clients.set(accountId, targetClient);
                await syncStalwartAuthContext(serverUrl, username, targetClient.getAuthHeader(), targetAccount.cookieSlot);
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
          evictAccount(accountId);
          accountStore.removeAccount(accountId);
          void clearSlotCredentials(targetAccount.cookieSlot, false);

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
        if (wasConnected) {
          snapshotAndClearForSwitch(get().activeAccountId);
          await useSettingsStore.getState().flushSync();
          useSettingsStore.getState().disableSync();
          if (superseded()) return;
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
        let accounts = accountStore.accounts;

        // If the only account is the demo account, re-initialize demo mode
        // instead of trying to restore a server session (which doesn't exist).
        if (accounts.length === 1 && accounts[0].serverUrl === 'https://demo.example.com') {
          await get().loginDemo();
          return;
        }

        // Orphan-cookie adoption - when no accounts are registered but a
        // basic-auth session cookie is present (set by /api/auth/impersonate
        // or by another server-side hand-off), promote it into the account
        // registry so the normal restoration path picks it up. Without this
        // the cookies sit unused and the SPA bounces to the login screen.
        // (Not in Lite: nothing hands sessions over server-side.)
        if (accounts.length === 0 && !IS_LITE) {
          try {
            const restore = await apiFetch('/api/auth/session', { method: 'PUT' });
            if (restore.ok) {
              const data = await restore.json();
              if (data?.serverUrl && data?.username && data?.password) {
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
                  authMode: 'basic',
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

          // Determine which account to activate first
          const defaultAccount = accountStore.getDefaultAccount();
          const activeId = get().activeAccountId;
          const targetId = activeId || defaultAccount?.id || accounts[0].id;

          // Restore one account: decrypt the stored credential/token, connect,
          // and sync the passthrough auth context. The context write never
          // throws and doesn't depend on the connect result, so its round trip
          // overlaps the connect instead of running after it.
          const restoreAccount = async (account: (typeof accounts)[number]) => {
            if (clients.has(account.id)) return; // Already connected

            // Basic auth without rememberMe leaves nothing to restore - the
            // user logged in without persisting credentials. Evict silently
            // so the login screen is shown without flagging a fake error.
            // (Lite keeps a tab-scoped Basic session either way; a missing one
            // surfaces as a 401 from fetchSlotSession below and evicts too.)
            if (account.authMode === 'basic' && !account.rememberMe && !IS_LITE) {
              evictAccount(account.id);
              accountStore.removeAccount(account.id);
              return;
            }

            try {
              if (account.authMode === 'oauth') {
                const res = await fetchSlotAccessToken(account.cookieSlot);
                if (res.ok) {
                  const { access_token, expires_in } = await res.json();
                  const refreshFn = get().refreshAccessToken;
                  const client = JMAPClient.withBearer(account.serverUrl, access_token, account.username, () => refreshFn());
                  bindClientStatusHandlers(client, set, get, account.id);
                  const contextSync = syncStalwartAuthContext(account.serverUrl, account.username, client.getAuthHeader(), account.cookieSlot);
                  await client.connect();
                  clients.set(account.id, client);
                  scheduleRefresh(expires_in, get().refreshAccessToken, account.id);
                  await contextSync;
                  accountStore.updateAccount(account.id, { isConnected: true, hasError: false });
                  void syncAccountDisplayName(account.id, client);
                } else if (res.status >= 500 && !recordPermanentRefreshFailure(res.status, account.id)) {
                  throw new TransientAuthError('Token refresh failed', res.status);
                } else {
                  // Repeated 500/502 (see recordPermanentRefreshFailure) falls
                  // through here and evicts the account like a rejection. (#972)
                  if (res.status >= 500) notifySignInAgain();
                  throw new Error(`Token refresh failed: ${res.status}`);
                }
              } else {
                const res = await fetchSlotSession(account.cookieSlot);
                if (res.ok) {
                  const { serverUrl, username, password } = await res.json();
                  const client = new JMAPClient(serverUrl, username, password);
                  bindClientStatusHandlers(client, set, get, account.id);
                  const contextSync = syncStalwartAuthContext(serverUrl, username, client.getAuthHeader(), account.cookieSlot);
                  await client.connect();
                  clients.set(account.id, client);
                  await contextSync;
                  accountStore.updateAccount(account.id, { isConnected: true, hasError: false });
                  void syncAccountDisplayName(account.id, client);
                } else if (res.status >= 500) {
                  throw new TransientAuthError('Session restore failed', res.status);
                } else {
                  throw new Error(`Session cookie missing: ${res.status}`);
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
                accountStore.updateAccount(account.id, {
                  isConnected: false,
                  hasError: true,
                  errorMessage: 'Server unreachable',
                });
                return;
              }
              // Remove unrestorable accounts so the user is prompted to log in
              // again rather than seeing a stale error entry forever.
              evictAccount(account.id);
              accountStore.removeAccount(account.id);
              void clearSlotCredentials(account.cookieSlot, false);
            }
          };

          // Restore the account the UI will show first, so time-to-inbox pays
          // for one account's round trips, not every registered account's. The
          // rest connect in the background once the target is up; the revision
          // bump re-runs per-client effects (push binding) over the full set.
          const targetEntry = accounts.find((account) => account.id === targetId);
          const otherAccounts = accounts.filter((account) => account.id !== targetId);
          if (targetEntry) await restoreAccount(targetEntry);

          const restoreRemaining = async () => {
            for (const account of otherAccounts) {
              await restoreAccount(account);
            }
          };

          if (clients.has(targetId)) {
            if (otherAccounts.length > 0) {
              void restoreRemaining().then(() => {
                set((state) => ({ connectedAccountsRevision: state.connectedAccountsRevision + 1 }));
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

          // No accounts could be restored
          if (accounts.some((account) => accountStore.getAccountById(account.id))) {
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
                clients.set(accountId, client);
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
                clients.set(accountId, client);
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
        if (account.rememberMe || IS_LITE) {
          await persistBasicSession(account.cookieSlot, account.serverUrl, account.username, newPassword);
        }
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

      getClientForAccount: (accountId: string) => {
        return clients.get(accountId);
      },

      getAllConnectedClients: () => {
        return new Map(clients);
      },
    }),
    {
      name: 'auth-storage',
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

// Another tab signed everyone out: this one's cookies and account list are
// gone too, so leave for the login page instead of showing stale mail.
if (typeof window !== 'undefined') {
  onSignedOutElsewhere(() => {
    if (useAuthStore.getState().isAuthenticated) navigateToLogin();
  });
}
