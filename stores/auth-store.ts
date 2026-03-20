import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { JMAPClient } from '@/lib/jmap/client';
import { useIdentityStore } from './identity-store';
import { useContactStore } from './contact-store';
import { useVacationStore } from './vacation-store';
import { useCalendarStore } from './calendar-store';
import { useFilterStore } from './filter-store';
import { useSettingsStore } from './settings-store';
import { useAccountStore } from './account-store';
import { fetchConfig } from '@/hooks/use-config';
import { debug } from '@/lib/debug';
import { generateAccountId } from '@/lib/account-utils';
import { replaceWindowLocation } from '@/lib/browser-navigation';
import { snapshotAccount, restoreAccount, clearAllStores, evictAccount, evictAll } from '@/lib/account-state-manager';
import type { Identity } from '@/lib/jmap/types';

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  serverUrl: string | null;
  username: string | null;
  client: JMAPClient | null;
  identities: Identity[];
  primaryIdentity: Identity | null;
  authMode: 'basic' | 'oauth';
  rememberMe: boolean;
  accessToken: string | null;
  tokenExpiresAt: number | null;
  connectionLost: boolean;
  activeAccountId: string | null;

  login: (serverUrl: string, username: string, password: string, totp?: string, rememberMe?: boolean) => Promise<boolean>;
  loginWithOAuth: (serverUrl: string, code: string, codeVerifier: string, redirectUri: string) => Promise<boolean>;
  refreshAccessToken: () => Promise<string | null>;
  logout: () => Promise<void>;
  logoutAll: () => void;
  switchAccount: (accountId: string) => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
  syncIdentities: () => void;
  getClientForAccount: (accountId: string) => JMAPClient | undefined;
}

const ERROR_PATTERNS: Array<{ key: string; matches: string[] }> = [
  { key: 'cors_blocked', matches: ['CORS_ERROR'] },
  { key: 'invalid_credentials', matches: ['Invalid username or password', '401', 'Unauthorized'] },
  { key: 'connection_failed', matches: ['network', 'Failed to fetch', 'NetworkError', 'ECONNREFUSED'] },
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
  const preferredPrimaryId = useIdentityStore.getState().preferredPrimaryId;
  const identities = sortIdentities(rawIdentities, username);

  // If user has a preferred primary, move it to front
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

function getLocaleLoginPath(): string {
  if (typeof window === 'undefined') return '/en/login';

  const segments = window.location.pathname.split('/').filter(Boolean);
  const locale = segments[0] || 'en';
  return `/${locale}/login`;
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

function redirectToLogin(): void {
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

function initializeFeatureStores(client: JMAPClient): void {
  if (client.supportsContacts()) {
    const contactStore = useContactStore.getState();
    contactStore.setSupportsSync(true);
    contactStore.fetchAddressBooks(client).catch((err) => debug.error('Failed to fetch address books:', err));
    contactStore.fetchContacts(client).catch((err) => debug.error('Failed to fetch contacts:', err));
  } else {
    useContactStore.getState().setSupportsSync(false);
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
  } else {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    refreshPromise = null;
  }
}

function clearAllRefreshTimers(): void {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  refreshPromise = null;
  for (const timer of refreshTimers.values()) clearTimeout(timer);
  refreshTimers.clear();
  refreshPromises.clear();
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      isAuthenticated: false,
      isLoading: false,
      error: null,
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

      login: async (serverUrl, username, password, totp, rememberMe) => {
        const effectivePassword = totp ? `${password}$${totp}` : password;
        set({ isLoading: true, error: null });

        try {
          const client = new JMAPClient(serverUrl, username, effectivePassword);
          client.onConnectionChange((connected) => {
            set({ connectionLost: !connected });
          });
          await client.connect();

          const { identities, primaryIdentity } = loadIdentities(await client.getIdentities(), username);
          initializeFeatureStores(client);

          // Register in account store
          const accountStore = useAccountStore.getState();
          const accountId = generateAccountId(username, serverUrl);
          const cookieSlot = accountStore.hasAccount(username, serverUrl)
            ? (accountStore.getAccountById(accountId)?.cookieSlot ?? accountStore.getNextCookieSlot())
            : accountStore.getNextCookieSlot();

          // Snapshot current account if switching away and clear stores so
          // the new account starts with a clean email/contact/calendar state.
          const prevAccountId = get().activeAccountId;
          if (prevAccountId && prevAccountId !== accountId) {
            snapshotAccount(prevAccountId);
            clearAllStores();
          }

          // Store client in multi-account map
          clients.set(accountId, client);

          accountStore.addAccount({
            label: primaryIdentity?.name || username,
            serverUrl,
            username,
            authMode: 'basic',
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
            rememberMe: !!rememberMe,
            isConnected: true,
            hasError: false,
            errorMessage: undefined,
            lastLoginAt: Date.now(),
          });

          // Store session cookie BEFORE setting isAuthenticated to avoid a race
          // condition: setting isAuthenticated triggers navigation to the main page,
          // whose checkAuth() would try to read the cookie before it was stored.
          if (rememberMe) {
            try {
              const res = await fetch(`/api/auth/session?slot=${cookieSlot}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ serverUrl, username, password: effectivePassword, slot: cookieSlot }),
              });
              if (!res.ok) {
                debug.error('Failed to store session: server returned', res.status);
              }
            } catch (err) {
              debug.error('Failed to store session:', err);
            }
          }

          set({
            isAuthenticated: true,
            isLoading: false,
            serverUrl,
            username,
            client,
            identities,
            primaryIdentity,
            authMode: 'basic',
            rememberMe: !!rememberMe,
            accessToken: null,
            tokenExpiresAt: null,
            connectionLost: false,
            error: null,
            activeAccountId: accountId,
          });

          // Sync settings from server (only if enabled)
          fetchConfig().then(config => {
            if (!config.settingsSyncEnabled) return;
            useSettingsStore.getState().loadFromServer(username, serverUrl).finally(() => {
              useSettingsStore.getState().enableSync(username, serverUrl);
            });
          }).catch(() => {});

          return true;
        } catch (error) {
          debug.error('Login error:', error);
          set({
            isLoading: false,
            error: classifyLoginError(error),
            isAuthenticated: false,
            client: null,
          });
          return false;
        }
      },

      loginWithOAuth: async (serverUrl, code, codeVerifier, redirectUri) => {
        set({ isLoading: true, error: null });

        try {
          // Determine slot for this account (use slot from sessionStorage if re-adding)
          const accountStore = useAccountStore.getState();
          const pendingSlot = typeof window !== 'undefined'
            ? parseInt(sessionStorage.getItem('oauth_cookie_slot') || '0', 10)
            : 0;
          const slot = pendingSlot >= 0 && pendingSlot <= 4 ? pendingSlot : accountStore.getNextCookieSlot();

          const tokenRes = await fetch(`/api/auth/token?slot=${slot}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, code_verifier: codeVerifier, redirect_uri: redirectUri, slot }),
          });

          if (!tokenRes.ok) {
            throw new Error('token_exchange_failed');
          }

          const { access_token, expires_in } = await tokenRes.json();

          const refreshFn = get().refreshAccessToken;
          const client = JMAPClient.withBearer(serverUrl, access_token, '', () => refreshFn());
          client.onConnectionChange((connected) => {
            set({ connectionLost: !connected });
          });
          await client.connect();

          const username = client.getUsername();
          const { identities, primaryIdentity } = loadIdentities(await client.getIdentities(), username);
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
          accountStore.setActiveAccount(accountId);

          set({
            isAuthenticated: true,
            isLoading: false,
            serverUrl,
            username,
            client,
            identities,
            primaryIdentity,
            authMode: 'oauth',
            accessToken: access_token,
            tokenExpiresAt: Date.now() + expires_in * 1000,
            connectionLost: false,
            error: null,
            activeAccountId: accountId,
          });

          scheduleRefresh(expires_in, get().refreshAccessToken, accountId);

          // Sync settings from server (only if enabled)
          fetchConfig().then(config => {
            if (!config.settingsSyncEnabled) return;
            useSettingsStore.getState().loadFromServer(username, serverUrl).finally(() => {
              useSettingsStore.getState().enableSync(username, serverUrl);
            });
          }).catch(() => {});

          // Clean up sessionStorage
          if (typeof window !== 'undefined') {
            sessionStorage.removeItem('oauth_cookie_slot');
          }

          return true;
        } catch (error) {
          debug.error('OAuth login error:', error);
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'generic',
            isAuthenticated: false,
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
            const res = await fetch(`/api/auth/token?slot=${slot}`, { method: 'PUT' });

            if (!res.ok) {
              markSessionExpired();
              get().logout();
              return null;
            }

            const { access_token, expires_in } = await res.json();

            get().client?.updateAccessToken(access_token);

            set({
              accessToken: access_token,
              tokenExpiresAt: Date.now() + expires_in * 1000,
            });

            scheduleRefresh(expires_in, get().refreshAccessToken, accountId ?? undefined);
            return access_token;
          } catch (error) {
            debug.error('Token refresh failed:', error);
            markSessionExpired();
            get().logout();
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

      logout: async () => {
        const state = get();
        const wasOAuth = state.authMode === 'oauth';
        const accountId = state.activeAccountId;
        const accountStore = useAccountStore.getState();
        const account = accountId ? accountStore.getAccountById(accountId) : null;
        const slot = account?.cookieSlot ?? 0;

        clearRefreshTimer(accountId ?? undefined);

        // Null out the client BEFORE disconnecting so the page doesn't fire
        // data-loading effects with the stale disconnected client while
        // stores are being cleared.
        set({ client: null });
        state.client?.disconnect();

        // Remove client from multi-account map
        if (accountId) {
          clients.delete(accountId);
          evictAccount(accountId);
          accountStore.removeAccount(accountId);
        }

        useSettingsStore.getState().disableSync();

        // Check if there are remaining accounts to switch to
        const remainingAccounts = accountStore.accounts;
        const shouldRedirectToLogin = remainingAccounts.length === 0;
        if (remainingAccounts.length > 0) {
          // Switch to the next account
          const nextAccount = remainingAccounts[0];
          // Clean current stores, then switch
          clearAllStores();

          // Restore next account
          let nextClient = clients.get(nextAccount.id);

          // If the client isn't in memory, try to restore it from the session
          if (!nextClient) {
            try {
              if (nextAccount.authMode === 'oauth') {
                const res = await fetch(`/api/auth/token?slot=${nextAccount.cookieSlot}`, { method: 'PUT' });
                if (res.ok) {
                  const { access_token, expires_in } = await res.json();
                  const refreshFn = get().refreshAccessToken;
                  nextClient = JMAPClient.withBearer(nextAccount.serverUrl, access_token, nextAccount.username, () => refreshFn());
                  nextClient.onConnectionChange((connected) => {
                    if (get().activeAccountId === nextAccount.id) {
                      set({ connectionLost: !connected });
                    }
                    accountStore.updateAccount(nextAccount.id, { isConnected: connected });
                  });
                  await nextClient.connect();
                  clients.set(nextAccount.id, nextClient);
                  scheduleRefresh(expires_in, get().refreshAccessToken, nextAccount.id);
                }
              } else if (nextAccount.authMode === 'basic' && nextAccount.rememberMe) {
                const res = await fetch(`/api/auth/session?slot=${nextAccount.cookieSlot}`);
                if (res.ok) {
                  const { serverUrl: sUrl, username: uName, password: pwd } = await res.json();
                  nextClient = new JMAPClient(sUrl, uName, pwd);
                  nextClient.onConnectionChange((connected) => {
                    if (get().activeAccountId === nextAccount.id) {
                      set({ connectionLost: !connected });
                    }
                    accountStore.updateAccount(nextAccount.id, { isConnected: connected });
                  });
                  await nextClient.connect();
                  clients.set(nextAccount.id, nextClient);
                }
              }
            } catch (err) {
              debug.error(`Failed to restore next account ${nextAccount.id} during logout:`, err);
              nextClient = undefined;
            }
          }

          if (nextClient) {
            const restored = restoreAccount(nextAccount.id);
            accountStore.setActiveAccount(nextAccount.id);

            // Build identity state up front so the name updates atomically
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
            // Could not restore the next account — remove it and do a full logout
            debug.error(`Cannot restore next account ${nextAccount.id}, performing full logout`);
            evictAccount(nextAccount.id);
            accountStore.removeAccount(nextAccount.id);

            set({
              isAuthenticated: false,
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
            });

            localStorage.removeItem('auth-storage');
            clearAllStores();
            redirectToLogin();
          }
        } else {
          // No accounts remaining — full logout
          set({
            isAuthenticated: false,
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
          });

          localStorage.removeItem('auth-storage');
          clearAllStores();
        }

        // Clean up cookies for the removed account
        fetch(`/api/auth/session?slot=${slot}`, { method: 'DELETE', keepalive: shouldRedirectToLogin }).catch((err) => {
          debug.error('Failed to clear session cookie:', err);
        });

        if (wasOAuth && shouldRedirectToLogin) {
          let redirectCommitted = false;
          const commitLoginRedirect = () => {
            if (redirectCommitted) return;
            redirectCommitted = true;
            redirectToLogin();
          };

          window.setTimeout(commitLoginRedirect, 0);

          fetch(`/api/auth/token?slot=${slot}`, { method: 'DELETE', keepalive: true })
            .then((res) => {
              if (!res.ok) throw new Error(`Revocation failed: ${res.status}`);
              return res.json();
            })
            .then((data) => {
              if (redirectCommitted) return;

              if (data.end_session_url) {
                redirectCommitted = true;
                const locale = window.location.pathname.split('/')[1] || 'en';
                const redirectUri = `${window.location.origin}/${locale}/login`;
                const url = new URL(data.end_session_url);
                url.searchParams.set('post_logout_redirect_uri', redirectUri);
                replaceWindowLocation(url.toString());
                return;
              }

              commitLoginRedirect();
            })
            .catch((err) => {
              debug.error('OAuth logout cleanup failed:', err);
              commitLoginRedirect();
            });
        } else if (wasOAuth) {
          fetch(`/api/auth/token?slot=${slot}`, { method: 'DELETE', keepalive: false })
            .catch((err) => {
              debug.error('OAuth logout cleanup failed:', err);
            });
        } else if (shouldRedirectToLogin) {
          redirectToLogin();
        }
      },

      logoutAll: () => {
        // Disconnect all clients
        for (const client of clients.values()) {
          client.disconnect();
        }
        clients.clear();
        clearAllRefreshTimers();
        evictAll();

        useSettingsStore.getState().disableSync();
        useAccountStore.getState().accounts.forEach(() => {});

        set({
          isAuthenticated: false,
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
        });

        localStorage.removeItem('auth-storage');
        clearAllStores();

        // Clear all accounts from registry
        const accountStore = useAccountStore.getState();
        const allAccounts = [...accountStore.accounts];
        for (const account of allAccounts) {
          accountStore.removeAccount(account.id);
        }

        // Delete all cookies
        fetch('/api/auth/session?all=true', { method: 'DELETE', keepalive: true }).catch(() => {});
        fetch('/api/auth/token?all=true', { method: 'DELETE', keepalive: true }).catch(() => {});
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
        set({ isLoading: true, client: null });

        // Snapshot current account
        if (state.activeAccountId) {
          snapshotAccount(state.activeAccountId);
        }

        // Clear current stores
        clearAllStores();
        useSettingsStore.getState().disableSync();

        // Get or create client for target account
        let targetClient = clients.get(accountId);

        if (!targetClient) {
          // Client not connected — try to restore
          try {
            if (targetAccount.authMode === 'oauth') {
              const res = await fetch(`/api/auth/token?slot=${targetAccount.cookieSlot}`, { method: 'PUT' });
              if (res.ok) {
                const { access_token, expires_in } = await res.json();
                const refreshFn = get().refreshAccessToken;
                targetClient = JMAPClient.withBearer(targetAccount.serverUrl, access_token, targetAccount.username, () => refreshFn());
                targetClient.onConnectionChange((connected) => {
                  if (get().activeAccountId === accountId) {
                    set({ connectionLost: !connected });
                  }
                  accountStore.updateAccount(accountId, { isConnected: connected });
                });
                await targetClient.connect();
                clients.set(accountId, targetClient);
                scheduleRefresh(expires_in, get().refreshAccessToken, accountId);
              }
            } else if (targetAccount.authMode === 'basic' && targetAccount.rememberMe) {
              const res = await fetch(`/api/auth/session?slot=${targetAccount.cookieSlot}`);
              if (res.ok) {
                const { serverUrl, username, password } = await res.json();
                targetClient = new JMAPClient(serverUrl, username, password);
                targetClient.onConnectionChange((connected) => {
                  if (get().activeAccountId === accountId) {
                    set({ connectionLost: !connected });
                  }
                  accountStore.updateAccount(accountId, { isConnected: connected });
                });
                await targetClient.connect();
                clients.set(accountId, targetClient);
              }
            }
          } catch (err) {
            debug.error(`Failed to restore client for ${accountId}:`, err);
          }
        }

        if (!targetClient) {
          // Cannot restore — remove the stale account and redirect to login
          evictAccount(accountId);
          accountStore.removeAccount(accountId);
          fetch(`/api/auth/session?slot=${targetAccount.cookieSlot}`, { method: 'DELETE' }).catch(() => {});

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
          });
        }).catch(() => {});
      },

      checkAuth: async () => {
        const accountStore = useAccountStore.getState();
        const accounts = accountStore.accounts;

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

            try {
              if (account.authMode === 'oauth') {
                const res = await fetch(`/api/auth/token?slot=${account.cookieSlot}`, { method: 'PUT' });
                if (res.ok) {
                  const { access_token, expires_in } = await res.json();
                  const refreshFn = get().refreshAccessToken;
                  const client = JMAPClient.withBearer(account.serverUrl, access_token, account.username, () => refreshFn());
                  client.onConnectionChange((connected) => {
                    if (get().activeAccountId === account.id) {
                      set({ connectionLost: !connected });
                    }
                    accountStore.updateAccount(account.id, { isConnected: connected });
                  });
                  await client.connect();
                  clients.set(account.id, client);
                  scheduleRefresh(expires_in, get().refreshAccessToken, account.id);
                  accountStore.updateAccount(account.id, { isConnected: true, hasError: false });
                } else {
                  throw new Error(`Token refresh failed: ${res.status}`);
                }
              } else if (account.authMode === 'basic' && account.rememberMe) {
                const res = await fetch(`/api/auth/session?slot=${account.cookieSlot}`);
                if (res.ok) {
                  const { serverUrl, username, password } = await res.json();
                  const client = new JMAPClient(serverUrl, username, password);
                  client.onConnectionChange((connected) => {
                    if (get().activeAccountId === account.id) {
                      set({ connectionLost: !connected });
                    }
                    accountStore.updateAccount(account.id, { isConnected: connected });
                  });
                  await client.connect();
                  clients.set(account.id, client);
                  accountStore.updateAccount(account.id, { isConnected: true, hasError: false });
                } else {
                  throw new Error(`Session cookie missing: ${res.status}`);
                }
              } else {
                // Basic auth without rememberMe — can't restore
                throw new Error('No saved session');
              }
            } catch (err) {
              debug.error(`Failed to restore account ${account.id}:`, err);
              // Remove unrestorable accounts so the user is prompted to log in
              // again rather than seeing a stale error entry forever.
              evictAccount(account.id);
              accountStore.removeAccount(account.id);
              fetch(`/api/auth/session?slot=${account.cookieSlot}`, { method: 'DELETE' }).catch(() => {});
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
          markSessionExpired();
          set({
            isAuthenticated: false,
            isLoading: false,
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
            set({ isLoading: true });
            try {
              const token = await get().refreshAccessToken();
              if (token && state.serverUrl) {
                const refreshFn = get().refreshAccessToken;
                const client = JMAPClient.withBearer(state.serverUrl, token, state.username || '', () => refreshFn());
                client.onConnectionChange((connected) => {
                  set({ connectionLost: !connected });
                });
                await client.connect();

                const accountId = generateAccountId(state.username || '', state.serverUrl);
                clients.set(accountId, client);

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
                  identities,
                  primaryIdentity,
                  accessToken: token,
                  activeAccountId: accountId,
                });

                fetchConfig().then(config => {
                  if (!config.settingsSyncEnabled) return;
                  useSettingsStore.getState().loadFromServer(state.username || '', state.serverUrl!).finally(() => {
                    useSettingsStore.getState().enableSync(state.username || '', state.serverUrl!);
                  });
                }).catch(() => {});
                return;
              }
            } catch (error) {
              debug.error('OAuth session restore failed:', error);
              clearRefreshTimer();
            }
          }

          if (state.authMode === 'basic') {
            set({ isLoading: true });
            try {
              const res = await fetch('/api/auth/session');
              if (res.ok) {
                const data = await res.json();
                if (!data.serverUrl || !data.username || !data.password) {
                  debug.error('Session restore returned incomplete data');
                  throw new Error('Incomplete session data');
                }
                const { serverUrl, username, password } = data;
                const client = new JMAPClient(serverUrl, username, password);
                client.onConnectionChange((connected) => {
                  set({ connectionLost: !connected });
                });
                await client.connect();

                const accountId = generateAccountId(username, serverUrl);
                clients.set(accountId, client);

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

                const { identities, primaryIdentity } = loadIdentities(await client.getIdentities(), username);
                initializeFeatureStores(client);

                set({
                  isAuthenticated: true,
                  isLoading: false,
                  serverUrl,
                  username,
                  client,
                  identities,
                  primaryIdentity,
                  authMode: 'basic',
                  activeAccountId: accountId,
                });

                fetchConfig().then(config => {
                  if (!config.settingsSyncEnabled) return;
                  useSettingsStore.getState().loadFromServer(username, serverUrl).finally(() => {
                    useSettingsStore.getState().enableSync(username, serverUrl);
                  });
                }).catch(() => {});
                return;
              }
            } catch (error) {
              debug.error('Basic session restore failed:', error);
            }
          }

          markSessionExpired();

          set({
            isAuthenticated: false,
            isLoading: false,
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

      getClientForAccount: (accountId: string) => {
        return clients.get(accountId);
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        serverUrl: state.serverUrl,
        username: state.username,
        authMode: state.authMode,
        isAuthenticated: (state.authMode === 'oauth' || state.rememberMe)
          ? state.isAuthenticated
          : undefined,
        rememberMe: state.rememberMe,
        activeAccountId: state.activeAccountId,
      }),
    }
  )
);
