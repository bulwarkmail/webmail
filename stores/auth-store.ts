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

import { aurionApi, aurionSession, aurionStorage, runInitialIndexing, verifyAndSyncRouting } from '@/lib/aurion';//AURION
import type { SecurityMode } from 'aurion-crypto-sdk';// AURION
import { cryptoWorkerBridge } from '@/lib/aurion/worker-bridge';//AURION

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
  securityMode: SecurityMode;// AURION

  login: (serverUrl: string, username: string, password: string, totp?: string, rememberMe?: boolean, securityMode?: SecurityMode, mailPassword?: string) => Promise<boolean>;
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

/**
 * Synchronously clears all auth and feature store state.
 * Called during full logout (no remaining accounts).
 */
function performFullLogout(set: (state: Partial<AuthState>) => void): void {
  useSettingsStore.getState().disableSync();
  aurionSession.clearSession().catch((err) => debug.error('Aurion wipe error:', err));// AURION

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
      securityMode: 'Confort',//AURION

     login: async (serverUrl, username, password, totp, rememberMe, securityMode = 'Confort', mailPassword?: string) => {//AURION
        const effectivePassword = totp ? `${password}$${totp}` : password;
        set({ isLoading: true, error: null, isRateLimited: false, rateLimitUntil: null });

        try {
          //
          //
          //-----------------------BEGIN AURION--------------
          //
          //
          // Import des singletons Aurion exportés depuis lib/aurion/index.ts
         

          // ==========================================
          // INTERCEPTION & LOGIQUE CIPHER AURION
          // ==========================================
          
          // 1. Récupération des sels de dérivation depuis l'infrastructure Aurion Network
          const salts = await aurionApi.getSalts(username);

          // 2. Initialisation du Vault en RAM (calcul de h0)
          // Si mode 'Confort', h0 est persisté de manière opaque dans IndexedDB via le storageDriver interne
          await aurionSession.unlockVault(password); 

          // 3. Récupération / Détermination du mot de passe JMAP effectif
          let jmapPassword = '';

          if (securityMode === 'Confort') {
            // Le serveur renvoie les données de session nécessaires (contenant le jeton et l'état)
            const authState = await aurionApi.login(username, password, salts.salt_server);
            
            // Extraction de la chaîne chiffrée provenant du backend
            const encryptedMailCreds = (await aurionApi.getServerLogin()).server_password_encrypted;
            
            // Déchiffrement local à l'aide de la session active (qui utilise h0 en interne)
            jmapPassword = await aurionSession.decryptMailCredentials(encryptedMailCreds);

          } else if (securityMode === 'Parano') {
            // Validation ZKP auprès du serveur Aurion pour authentifier la session
            await aurionApi.login(username, password, salts.salt_server);

            // CORRECTION : Utilisation de notre driver IndexedDB (aurionStorage) à la place de localStorage
            const localCiphertext = await aurionStorage.getItem(`aurion_creds_${username}`);
            
            if (!localCiphertext) {
              // 2. CAS DE L'ONBOARDING : Si le bloc n'existe pas, le mot de passe en clair est obligatoire
              if (!mailPassword) {
                throw new Error("PREMIER_ACCES_APPAREIL : Le mot de passe de messagerie est requis pour configurer cet appareil.");
              }

              // On utilise le mot de passe fourni en clair pour cette session
              jmapPassword = mailPassword;

              // 3. PERSISTANCE POUR LE FUTUR : On chiffre le mot de passe avec h0 (RAM) 
              // pour créer le bloc local dans IndexedDB
              const newCiphertext = await aurionSession.encryptMailCredentials(mailPassword);
              await aurionStorage.setItem(`aurion_creds_${username}`, newCiphertext);
              
              debug.log('auth', 'Appareil provisionné avec succès en mode Parano (Bloc chiffré créé dans IndexedDB).');
            } else {
              // 4. CAS STANDARD : Le bloc existe, on le déchiffre normalement avec h0
              jmapPassword = await aurionSession.decryptMailCredentials(localCiphertext);
            }

          } else if (securityMode === 'Extreme') {
            // En mode Extreme, l'utilisateur doit fournir son mot de passe de messagerie JMAP en clair.
            if (!mailPassword) {
              throw new Error("Mail password is required for Extreme mode");
            }
            jmapPassword = mailPassword;

            // Simple validation ZKP auprès du serveur Aurion pour initialiser le token réseau
            await aurionApi.login(username, password, salts.salt_server);
          }

          // Gestion du TOTP JMAP si applicable sur le mot de passe effectif déchiffré
          const effectiveJmapPassword = totp ? `${jmapPassword}$${totp}` : jmapPassword;
          
          // Connexion au serveur JMAP classique sous-jacent avec le vrai mot de passe de messagerie déchiffré
          
          
          const client = new JMAPClient(serverUrl, username, effectiveJmapPassword);
          await client.connect();

          // 4. Déchiffrement et montage du Keyring OpenPGP en RAM volatile
          const keyContainer = await aurionApi.getEncryptedPrivateKey();
          await aurionSession.decryptAndLoadPrivateKeys(keyContainer.keys, salts.salt_client);
          await cryptoWorkerBridge.initWorkerSession(
            aurionSession,
                  keyContainer.keys, 
                  salts.salt_client, 
                  aurionSession.h0
                );
          
          //
          //
          //-----------------------END AURION--------------
          //
          //

          // Resolve account/slot info up front so writes can start immediately.
          const accountStore = useAccountStore.getState();
          const accountId = generateAccountId(username, serverUrl);
          await runInitialIndexing(client, accountId);// AURION
          await verifyAndSyncRouting(); //AURION
          const cookieSlot = accountStore.hasAccount(username, serverUrl)
            ? (accountStore.getAccountById(accountId)?.cookieSlot ?? accountStore.getNextCookieSlot())
            : accountStore.getNextCookieSlot();

          // Snapshot/clear before kicking off any feature-store fetches so they
          // don't write into stores we're about to wipe.
          const prevAccountId = get().activeAccountId;
          if (prevAccountId && prevAccountId !== accountId) {
            snapshotAccount(prevAccountId);
            clearAllStores();
          }

          // Identities can fly in parallel with everything below. JMAPClient
          // captures the auth header per-request, so the optional TOTP upgrade
          // doesn't affect this already-issued request.
          const identitiesPromise = client.getIdentities();

          // When TOTP was used, try to upgrade to token-based auth so the
          // session survives TOTP rotation (basic auth embeds the TOTP in
          // every request, which expires after ~30 seconds). Must complete
          // before stalwart-context reads the auth header.
          let upgradedToOAuth = false;
          let oauthAccessToken: string | null = null;
          let oauthExpiresIn = 0;

          if (totp) {
            try {
              const tokenRes = await apiFetch('/api/auth/totp-token-exchange', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ serverUrl, username, password: effectivePassword, slot: cookieSlot }),
                // Note: server_id isn't passed here - the route looks up the
                // server entry by serverUrl, so per-server OAuth still applies
                // for password+TOTP logins through the dropdown.
              });
              if (tokenRes.ok) {
                const { access_token, expires_in, has_refresh_token } = await tokenRes.json();
                // Upgrade client to Bearer auth
                client.upgradeToBearer(access_token, () => get().refreshAccessToken());
                oauthAccessToken = access_token;
                oauthExpiresIn = expires_in;
                upgradedToOAuth = true;
                debug.log('auth', 'TOTP login upgraded to token-based auth (has_refresh_token=' + has_refresh_token + ')');
              } else {
                const errorBody = await tokenRes.json().catch(() => ({ error: 'unknown' }));
                debug.warn('auth', 'TOTP token exchange failed:', tokenRes.status, errorBody);
              }
            } catch (err) {
              debug.warn('auth', 'TOTP token exchange error:', err);
            }

            // If token exchange failed, enable TOTP re-auth prompt so the
            // client can ask for a fresh code on 401 instead of disconnecting.
            if (!upgradedToOAuth) {
              const { useTotpReauthStore } = await import('@/stores/totp-reauth-store');
              client.enableTotpReauth(password, () => useTotpReauthStore.getState().requestTotp());
              debug.log('auth', 'TOTP re-auth enabled - user will be prompted for fresh codes on session expiry');
            }
          }

          const effectiveAuthMode = upgradedToOAuth ? 'oauth' : 'basic';

          // Run the remaining independent requests in parallel. The session
          // write and stalwart-context write are best-effort persistence; the
          // outer login still succeeds even if they log a warning. Errors are
          // caught locally so Promise.all doesn't reject on either.
          const sessionWrite: Promise<unknown> = (rememberMe && !upgradedToOAuth)
            ? apiFetch(`/api/auth/session?slot=${cookieSlot}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ serverUrl, username, password: effectivePassword, slot: cookieSlot }),
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
              notifyParent('sso:session-expired');
              markSessionExpired();
              get().logout();
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

            scheduleRefresh(expires_in, get().refreshAccessToken, accountId ?? undefined);
            return access_token;
          } catch (error) {
            debug.error('Token refresh failed:', error);
            notifyParent('sso:session-expired');
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
        // ==========================================
        // 1. BEGIN AURION : SÉCURITÉ DES MODES VOLATILES (RAM SÉCHÉE APRÈS F5)
        // ==========================================
        const currentSecurityMode = get().securityMode;
        
        // Si on est en mode Parano/Extreme et que l'état crypto en RAM est mort (F5)
        if ((currentSecurityMode === 'Parano' || currentSecurityMode === 'Extreme') && !aurionSession.isUnlocked()) {
          debug.warn('auth', `RAM cleared after F5 in ${currentSecurityMode} mode. Forcing re-authentication.`);
          get().logout();
          return;
        }
        // ==========================================

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
                } else {
                  throw new Error(`Token refresh failed: ${res.status}`);
                }
              } else {
                // ==========================================
                // 2. BEGIN AURION : AUTO-UNLOCK INTERNE (Mode Confort)
                // ==========================================
                if (currentSecurityMode === 'Confort' && !aurionSession.isUnlocked()) {
                  const isVaultUnlocked = await aurionSession.tryAutoUnlock();
                  if (!isVaultUnlocked) {
                    throw new Error("Aurion Vault hardware key missing or corrupted in IndexedDB.");
                  }
                }
                //==========================================
                const res = await apiFetch(`/api/auth/session?slot=${account.cookieSlot}`, { method: 'PUT' });
                if (res.ok) {
                  const { serverUrl, username, password } = await res.json();
                  const client = new JMAPClient(serverUrl, username, password);
                  bindClientStatusHandlers(client, set, get, account.id);
                  await client.connect();
                  clients.set(account.id, client);
                  await syncStalwartAuthContext(serverUrl, username, client.getAuthHeader(), account.cookieSlot);
                  accountStore.updateAccount(account.id, { isConnected: true, hasError: false });
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
            // ==========================================
            // 3. ANCHOR AURION : REMONTAGE DU KEYRING PGP DE L'UTILISATEUR ACTIF
            // ==========================================
            if (aurionSession.isUnlocked()) {
              try {
                const salts = await aurionApi.getSalts(targetAccount.username);
                const keyContainer = await aurionApi.getEncryptedPrivateKey();
                await aurionSession.decryptAndLoadPrivateKeys(keyContainer.keys, salts.salt_client);
                debug.log('auth', `Aurion OpenPGP Keyring loaded successfully for ${targetAccount.username}`);
                // avec le h0 pour qu'il fasse son propre déchiffrement isolé
                await cryptoWorkerBridge.initWorkerSession(
                  aurionSession,
                  keyContainer.keys, 
                  salts.salt_client, 
                  aurionSession.h0
                );
                await runInitialIndexing(targetClient, targetId);//AURION
                await verifyAndSyncRouting();//AURION
              } catch (cryptoErr) {
                debug.error('Failed to load Aurion PGP Keys during session restoration:', cryptoErr);
              }
            }
            
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
                  });
                }).catch(() => {});
                return;
              }
            } catch (error) {
              debug.error('Basic session restore failed:', error);
              if (isRateLimitError(error)) {
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
          securityMode: state.securityMode//AURION
        };
      },
    }
  )
);

// Expose getClientForAccount to the calendar/contact stores via a small
// shared registry - see [[stores/client-registry]] for rationale.
setClientLookup((accountId) => useAuthStore.getState().getClientForAccount(accountId));
