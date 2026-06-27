import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { JMAPClient, RateLimitError } from '@/lib/jmap/client';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useIdentityStore } from './identity-store';
import { setClientLookup } from './client-registry';
import { useContactStore } from './contact-store';
import { useVacationStore } from './vacation-store';
import { useCalendarStore } from './calendar-store';
import { useFilterStore } from './filter-store';
import { useSettingsStore } from './settings-store';
import { useAccountStore } from './account-store';
import { fetchConfig } from '@/hooks/use-config';
import { debug } from '@/lib/debug';
import { generateAccountId } from '@/lib/account-utils';
import { replaceWindowLocation, getPathPrefix, getLocaleFromPath, apiFetch } from '@/lib/browser-navigation';
import { notifyParent } from '@/lib/iframe-bridge';
import { snapshotAccount, restoreAccount, clearAllStores, evictAccount, evictAll } from '@/lib/account-state-manager';
import type { Identity } from '@/lib/jmap/types';

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

  login: (serverUrl: string, username: string, password: string, totp?: string, rememberMe?: boolean) => Promise<boolean>;
  loginWithOAuth: (serverUrl: string, code: string, codeVerifier: string, redirectUri: string, serverId?: string) => Promise<boolean>;
  loginWithServerSso: (code: string, state: string) => Promise<boolean>;
  loginDemo: () => Promise<boolean>;
  refreshAccessToken: () => Promise<string | null>;
  logout: () => void;
  logoutAll: () => void;
  switchAccount: (accountId: string) => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
  syncIdentities: () => void;
  refreshIdentities: () => Promise<void>;
  getClientForAccount: (accountId: string) => JMAPClient | undefined;
  getAllConnectedClients: () => Map<string, JMAPClient>;
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

async function syncStalwartAuthContext(
  serverUrl: string,
  username: string,
  authHeader: string,
  slot: number,
): Promise<void> {
  try {
    const response = await apiFetch('/api/auth/stalwart-context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl, username, authHeader, slot }),
    });

    if (!response.ok) {
      debug.warn('auth', `Failed to sync Stalwart auth context: ${response.status}`);
    }
  } catch (error) {
    debug.warn('auth', 'Failed to sync Stalwart auth context:', error);
  }
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

function saveRedirectAfterLogin(): void {
  if (typeof window === 'undefined') return;

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
}

// Only re-arm a failed refresh while someone is still signed in to that
// account. A sign-out during the outage - or while the request was in
// flight - must end the retry loop instead of keeping it alive with
// doomed requests (#588).
function shouldRetryRefresh(accountId?: string): boolean {
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

  // Remove persisted state AFTER the final set() so the persist middleware
  // doesn't re-write stale values.
  try { localStorage.removeItem('auth-storage'); } catch { /* noop */ }
  try { localStorage.removeItem('account-storage'); } catch { /* noop */ }
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

      login: async (serverUrl, username, password, totp, rememberMe) => {
        set({ isLoading: true, error: null, isRateLimited: false, rateLimitUntil: null });

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
          let oauthAccessToken: string | null = null;
          let oauthExpiresIn = 0;

          if (totp) {
            // Stalwart 0.16+ dropped the `password$totp` basic-auth convention;
            // the MFA code must be exchanged for tokens via the structured login
            // endpoint (handled server-side). Token auth also survives TOTP
            // rotation, unlike basic auth which embeds the ~30s code per request.
            let bearerToken: string | null = null;
            try {
              // The callback URL the OAuth client already registers; the route
              // needs an identical redirect URI for the login + token-exchange
              // steps (and registered when require_client_registration is on).
              const redirectUri = typeof window !== 'undefined'
                ? `${window.location.origin}${getPathPrefix()}/${getLocaleFromPath()}/auth/callback`
                : '';
              const tokenRes = await apiFetch('/api/auth/totp-token-exchange', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // server_id isn't passed - the route looks up the server entry by
                // serverUrl, so per-server OAuth still applies for password+TOTP.
                body: JSON.stringify({ serverUrl, username, password, totp, slot: cookieSlot, redirectUri }),
              });
              if (tokenRes.ok) {
                const { access_token, expires_in, has_refresh_token } = await tokenRes.json();
                bearerToken = access_token;
                oauthExpiresIn = expires_in;
                debug.log('auth', 'TOTP login exchanged for token-based auth (has_refresh_token=' + has_refresh_token + ')');
              } else {
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
              debug.warn('auth', 'TOTP login exchange error, trying legacy basic auth:', err);
            }

            if (bearerToken) {
              client = JMAPClient.withBearer(serverUrl, bearerToken, username, () => get().refreshAccessToken());
              await client.connect();
              oauthAccessToken = bearerToken;
              upgradedToOAuth = true;
            } else {
              // Legacy fallback for pre-0.16 Stalwart, which accepts the TOTP
              // appended to the password over basic auth.
              client = new JMAPClient(serverUrl, username, `${password}$${totp}`);
              await client.connect();
              const { useTotpReauthStore } = await import('@/stores/totp-reauth-store');
              client.enableTotpReauth(password, () => useTotpReauthStore.getState().requestTotp());
              debug.log('auth', 'TOTP re-auth enabled (legacy basic-auth path)');
            }
          } else {
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
          const sessionWrite: Promise<unknown> = (rememberMe && !upgradedToOAuth)
            ? apiFetch(`/api/auth/session?slot=${cookieSlot}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ serverUrl, username, password, slot: cookieSlot }),
              }).then((res) => {
                if (!res.ok) debug.error('Failed to store session: server returned', res.status);
              }).catch((err) => debug.error('Failed to store session:', err))
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

          // Update account entry in case it already existed (addAccount is a no-op for existing accounts)
          accountStore.updateAccount(accountId, {
            authMode: effectiveAuthMode,
            rememberMe: !!rememberMe,
            isConnected: true,
            hasError: false,
            errorMessage: undefined,
            lastLoginAt: Date.now(),
          });

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

          const tokenRes = await apiFetch(`/api/auth/token?slot=${slot}`, {
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

          if (!tokenRes.ok) {
            throw new Error('token_exchange_failed');
          }

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
          accountStore.updateAccount(accountId, { cookieSlot: slot });
          accountStore.setActiveAccount(accountId);

          await syncStalwartAuthContext(serverUrl, username, client.getAuthHeader(), slot);

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
          accountStore.updateAccount(accountId, { cookieSlot: slot });
          accountStore.setActiveAccount(accountId);

          await syncStalwartAuthContext(ssoServerUrl, username, client.getAuthHeader(), slot);

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

      refreshAccessToken: async () => {
        if (refreshPromise) return refreshPromise;

        const accountId = get().activeAccountId;
        if (accountId && refreshPromises.has(accountId)) {
          return refreshPromises.get(accountId)!;
        }

        const account = accountId ? useAccountStore.getState().getAccountById(accountId) : null;
        const slot = account?.cookieSlot ?? 0;

        const promise = (async () => {
          try {
            const res = await apiFetch(`/api/auth/token?slot=${slot}`, { method: 'PUT' });

            if (!res.ok) {
              // Only a definitive 401 ends the session. Anything else (5xx
              // while the server restarts, proxy errors) is an outage - keep
              // the session and retry shortly so "stay signed in" survives
              // maintenance windows and offline spells.
              if (res.status === 401) {
                resetRefreshBackoff(accountId ?? undefined);
                notifyParent('sso:session-expired');
                markSessionExpired();
                get().logout();
                return null;
              }
              if (shouldRetryRefresh(accountId ?? undefined)) {
                const retryIn = nextRefreshRetrySeconds(accountId ?? undefined);
                debug.error(`Token refresh unavailable (${res.status}), retrying with backoff`);
                scheduleRefresh(retryIn, get().refreshAccessToken, accountId ?? undefined);
              }
              return null;
            }

            const { access_token, expires_in } = await res.json();

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
            if (shouldRetryRefresh(accountId ?? undefined)) {
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

      logout: () => {
        const state = get();
        const wasDemoMode = state.isDemoMode;
        const wasOAuth = state.authMode === 'oauth';
        const accountId = state.activeAccountId;
        const accountStore = useAccountStore.getState();
        const account = accountId ? accountStore.getAccountById(accountId) : null;
        const slot = account?.cookieSlot ?? 0;

        // Stop refresh timers immediately
        clearRefreshTimer(accountId ?? undefined);

        // Disconnect and null out the client BEFORE clearing stores so the
        // page doesn't fire data-loading effects with the stale client.
        const oldClient = state.client;
        set({ client: null });
        oldClient?.disconnect();

        // Remove client from multi-account map
        if (accountId) {
          clients.delete(accountId);
          evictAccount(accountId);
          accountStore.removeAccount(accountId);
        }

        useSettingsStore.getState().disableSync();

        // Check if there are remaining accounts to switch to
        const remainingAccounts = accountStore.accounts;

        if (remainingAccounts.length > 0 && !wasDemoMode) {
          // Switch to the next account - this is the one path that stays in-app
          const nextAccount = remainingAccounts[0];
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
          } else {
            // Client not in memory - clear everything and redirect.
            // Trying to async-restore during logout caused the original bug.
            debug.error(`Cannot restore next account ${nextAccount.id}, performing full logout`);
            evictAccount(nextAccount.id);
            accountStore.removeAccount(nextAccount.id);
            performFullLogout(set);
          }

          // Background cookie cleanup for the removed account
          apiFetch(`/api/auth/session?slot=${slot}`, { method: 'DELETE', keepalive: true }).catch(() => {});
          if (wasOAuth) {
            apiFetch(`/api/auth/token?slot=${slot}`, { method: 'DELETE', keepalive: true }).catch(() => {});
          }
          return;
        }

        // No accounts remaining (or demo mode) - full logout + redirect
        performFullLogout(set);

        notifyParent('sso:logout');

        // Background cookie/token cleanup - keepalive ensures completion during navigation
        if (!wasDemoMode) {
          apiFetch(`/api/auth/session?slot=${slot}`, { method: 'DELETE', keepalive: true }).catch(() => {});
          if (wasOAuth) {
            apiFetch(`/api/auth/token?slot=${slot}`, { method: 'DELETE', keepalive: true }).catch(() => {});
          }
        }

        // Redirect to login - this is synchronous and happens AFTER all state is cleared
        redirectToLogin();
      },

      logoutAll: () => {
        // Disconnect all clients
        for (const c of clients.values()) {
          c.disconnect();
        }
        clients.clear();
        clearAllRefreshTimers();
        evictAll();

        performFullLogout(set);

        // Clear all accounts from registry
        const accountStore = useAccountStore.getState();
        const allAccounts = [...accountStore.accounts];
        for (const account of allAccounts) {
          accountStore.removeAccount(account.id);
        }

        // Background cookie/token cleanup
        apiFetch('/api/auth/session?all=true', { method: 'DELETE', keepalive: true }).catch(() => {});
        apiFetch('/api/auth/token?all=true', { method: 'DELETE', keepalive: true }).catch(() => {});

        redirectToLogin();
      },

      switchAccount: async (accountId: string) => {
        const state = get();
        if (state.activeAccountId === accountId) return;

        const accountStore = useAccountStore.getState();
        const targetAccount = accountStore.getAccountById(accountId);
        if (!targetAccount) return;

        // Null out the client immediately so the page doesn't fire data-loading
        // effects with the old client while stores are being cleared.
        set({ isLoading: true, client: null, isRateLimited: false, rateLimitUntil: null });

        // Snapshot current account
        if (state.activeAccountId) {
          snapshotAccount(state.activeAccountId);
        }

        // Clear current stores
        clearAllStores();
        useSettingsStore.getState().disableSync();

        // Get or create client for target account
        let targetClient = clients.get(accountId);
        let targetRestoreRateLimited = false;

        if (!targetClient) {
          // Client not connected - try to restore
          try {
            if (targetAccount.authMode === 'oauth') {
              const res = await apiFetch(`/api/auth/token?slot=${targetAccount.cookieSlot}`, { method: 'PUT' });
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
              const res = await apiFetch(`/api/auth/session?slot=${targetAccount.cookieSlot}`, { method: 'PUT' });
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

        if (!targetClient) {
          if (targetRestoreRateLimited) {
            if (state.activeAccountId && state.activeAccountId !== accountId) {
              const prevClient = clients.get(state.activeAccountId);
              const prevAccount = accountStore.getAccountById(state.activeAccountId);
              if (prevClient && prevAccount) {
                restoreAccount(state.activeAccountId);
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
          apiFetch(`/api/auth/session?slot=${targetAccount.cookieSlot}`, { method: 'DELETE' }).catch(() => {});

          // Restore the previous account if still available
          if (state.activeAccountId && state.activeAccountId !== accountId) {
            const prevClient = clients.get(state.activeAccountId);
            const prevAccount = accountStore.getAccountById(state.activeAccountId);
            if (prevClient && prevAccount) {
              restoreAccount(state.activeAccountId);
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

        // Restore cached state or fetch fresh
        const restored = restoreAccount(accountId);
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
            set({ identities, primaryIdentity });
            initializeFeatureStores(targetClient);
          } catch (err) {
            debug.error(`Failed to load data for ${accountId}:`, err);
          }
        }

        // Sync settings
        fetchConfig().then(config => {
          if (!config.settingsSyncEnabled) return;
          useSettingsStore.getState().loadFromServer(targetAccount.username, targetAccount.serverUrl).finally(() => {
            useSettingsStore.getState().enableSync(targetAccount.username, targetAccount.serverUrl);
            applyPreferredIdentity(targetAccount.id);
          });
        }).catch(() => {});
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
        if (accounts.length === 0) {
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

          // Try to connect all accounts
          for (const account of accounts) {
            if (clients.has(account.id)) continue; // Already connected

            // Basic auth without rememberMe leaves nothing to restore - the
            // user logged in without persisting credentials. Evict silently
            // so the login screen is shown without flagging a fake error.
            if (account.authMode === 'basic' && !account.rememberMe) {
              evictAccount(account.id);
              accountStore.removeAccount(account.id);
              continue;
            }

            try {
              if (account.authMode === 'oauth') {
                const res = await apiFetch(`/api/auth/token?slot=${account.cookieSlot}`, { method: 'PUT' });
                if (res.ok) {
                  const { access_token, expires_in } = await res.json();
                  const refreshFn = get().refreshAccessToken;
                  const client = JMAPClient.withBearer(account.serverUrl, access_token, account.username, () => refreshFn());
                  bindClientStatusHandlers(client, set, get, account.id);
                  await client.connect();
                  clients.set(account.id, client);
                  scheduleRefresh(expires_in, get().refreshAccessToken, account.id);
                  await syncStalwartAuthContext(account.serverUrl, account.username, client.getAuthHeader(), account.cookieSlot);
                  accountStore.updateAccount(account.id, { isConnected: true, hasError: false });
                } else if (res.status >= 500) {
                  throw new TransientAuthError('Token refresh failed', res.status);
                } else {
                  throw new Error(`Token refresh failed: ${res.status}`);
                }
              } else {
                const res = await apiFetch(`/api/auth/session?slot=${account.cookieSlot}`, { method: 'PUT' });
                if (res.ok) {
                  const { serverUrl, username, password } = await res.json();
                  const client = new JMAPClient(serverUrl, username, password);
                  bindClientStatusHandlers(client, set, get, account.id);
                  await client.connect();
                  clients.set(account.id, client);
                  await syncStalwartAuthContext(serverUrl, username, client.getAuthHeader(), account.cookieSlot);
                  accountStore.updateAccount(account.id, { isConnected: true, hasError: false });
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
                continue;
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
                continue;
              }
              // Remove unrestorable accounts so the user is prompted to log in
              // again rather than seeing a stale error entry forever.
              evictAccount(account.id);
              accountStore.removeAccount(account.id);
              apiFetch(`/api/auth/session?slot=${account.cookieSlot}`, { method: 'DELETE' }).catch(() => {});
            }
          }

          // Activate the target account
          const targetClient = clients.get(targetId);
          const targetAccount = accountStore.getAccountById(targetId);
          if (targetClient && targetAccount) {
            accountStore.setActiveAccount(targetId);
            const { identities, primaryIdentity } = loadIdentities(await targetClient.getIdentities(), targetAccount.username);
            initializeFeatureStores(targetClient);

            set({
              isAuthenticated: true,
              isLoading: false,
              serverUrl: targetAccount.serverUrl,
              username: targetAccount.username,
              client: targetClient,
              ...getClientRateLimitState(targetClient),
              identities,
              primaryIdentity,
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
                applyPreferredIdentity(targetAccount.id);
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
              const token = await get().refreshAccessToken();
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
              const res = await apiFetch('/api/auth/session', { method: 'PUT' });
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

      syncIdentities: () => {
        const identityState = useIdentityStore.getState();
        const identities = identityState.identities;
        const primaryIdentity = identities[0] ?? null;
        set({ identities, primaryIdentity });
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
