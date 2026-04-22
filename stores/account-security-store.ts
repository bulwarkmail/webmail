import { create } from 'zustand';
import { debug } from '@/lib/debug';
import { getActiveAccountSlotHeaders } from '@/lib/auth/active-account-slot';
import { apiFetch } from '@/lib/browser-navigation';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

interface AccountSecurityState {
  // Detection
  isStalwart: boolean | null; // null = not yet probed
  isProbing: boolean;

  // Auth info
  otpEnabled: boolean;
  appPasswords: string[];
  isLoadingAuth: boolean;

  // Crypto info
  encryptionType: string;
  isLoadingCrypto: boolean;

  // Principal info
  displayName: string;
  emails: string[];
  quota: number;
  roles: string[];
  isLoadingPrincipal: boolean;

  // Operation states
  isSaving: boolean;
  error: string | null;

  // Actions — client param enables JMAP path when non-null, falls back to REST otherwise
  probe: (client: IJMAPClient | null) => Promise<boolean>;
  fetchAuthInfo: (client: IJMAPClient | null) => Promise<void>;
  fetchCryptoInfo: (client: IJMAPClient | null) => Promise<void>;
  fetchPrincipal: (client: IJMAPClient | null) => Promise<void>;
  fetchAll: (client: IJMAPClient | null) => Promise<void>;
  changePassword: (client: IJMAPClient | null, currentPassword: string, newPassword: string) => Promise<void>;
  updateDisplayName: (client: IJMAPClient | null, displayName: string) => Promise<void>;
  enableTotp: (client: IJMAPClient | null) => Promise<string>;
  disableTotp: (client: IJMAPClient | null) => Promise<void>;
  addAppPassword: (client: IJMAPClient | null, name: string, password: string) => Promise<string | undefined>;
  removeAppPassword: (client: IJMAPClient | null, name: string) => Promise<void>;
  updateEncryption: (client: IJMAPClient | null, settings: { type: string; algo?: string; certs?: string }) => Promise<void>;
  clearState: () => void;
}

function getApiHeaders(): Record<string, string> {
  return getActiveAccountSlotHeaders();
}

/** Return the client only if it supports Stalwart JMAP management. */
function jmap(client: IJMAPClient | null): IJMAPClient | null {
  return client?.supportsStalwartManagement() ? client : null;
}

// ── BEGIN LEGACY REST FALLBACK ──────────────────────────────────
// The functions below proxy through Next.js API routes to Stalwart's
// REST API (pre-0.16). They can be removed once Stalwart <0.16
// support is dropped.

async function legacyProbe(): Promise<boolean> {
  const response = await apiFetch('/api/account/stalwart/probe', {
    headers: getApiHeaders(),
  });
  const data = await response.json();
  return data.isStalwart === true;
}

async function legacyFetchAuthInfo(): Promise<{ otpEnabled: boolean; appPasswords: string[] }> {
  const response = await apiFetch('/api/account/stalwart/auth', {
    headers: getApiHeaders(),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return {
    otpEnabled: data.data?.otpEnabled ?? false,
    appPasswords: data.data?.appPasswords ?? [],
  };
}

async function legacyFetchCryptoInfo(): Promise<string> {
  const response = await apiFetch('/api/account/stalwart/crypto', {
    headers: getApiHeaders(),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return data.data?.type ?? 'disabled';
}

async function legacyFetchPrincipal(): Promise<{ description: string; emails: string[]; quota: number; roles: string[] }> {
  const response = await apiFetch('/api/account/stalwart/principal', {
    headers: getApiHeaders(),
  });
  if (!response.ok) {
    if (response.status === 403) {
      return { description: '', emails: [], quota: 0, roles: [] };
    }
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  const principal = data.data;
  return {
    description: principal?.description ?? '',
    emails: Array.isArray(principal?.emails) ? principal.emails : principal?.emails ? [principal.emails] : [],
    quota: principal?.quota ?? 0,
    roles: principal?.roles ?? [],
  };
}

async function legacyChangePassword(currentPassword: string, newPassword: string): Promise<void> {
  const response = await apiFetch('/api/account/stalwart/password', {
    method: 'POST',
    headers: { ...getApiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || `HTTP ${response.status}`);
  }
}

async function legacyUpdateDisplayName(displayName: string): Promise<void> {
  const response = await apiFetch('/api/account/stalwart/principal', {
    method: 'PATCH',
    headers: { ...getApiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify([
      { action: 'set', field: 'description', value: displayName },
    ]),
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || `HTTP ${response.status}`);
  }
}

async function legacyEnableTotp(): Promise<string> {
  const response = await apiFetch('/api/account/stalwart/auth', {
    method: 'POST',
    headers: { ...getApiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify([{ type: 'enableOtpAuth' }]),
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || data.details || `HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.data;
}

async function legacyDisableTotp(): Promise<void> {
  const response = await apiFetch('/api/account/stalwart/auth', {
    method: 'POST',
    headers: { ...getApiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify([{ type: 'disableOtpAuth' }]),
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || data.details || `HTTP ${response.status}`);
  }
}

async function legacyAddAppPassword(name: string, password: string): Promise<void> {
  const response = await apiFetch('/api/account/stalwart/auth', {
    method: 'POST',
    headers: { ...getApiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify([{ type: 'addAppPassword', name, password }]),
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || data.details || `HTTP ${response.status}`);
  }
}

async function legacyRemoveAppPassword(name: string): Promise<void> {
  const response = await apiFetch('/api/account/stalwart/auth', {
    method: 'POST',
    headers: { ...getApiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify([{ type: 'removeAppPassword', name }]),
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || data.details || `HTTP ${response.status}`);
  }
}

async function legacyUpdateEncryption(settings: { type: string; algo?: string; certs?: string }): Promise<void> {
  const response = await apiFetch('/api/account/stalwart/crypto', {
    method: 'POST',
    headers: { ...getApiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || data.details || `HTTP ${response.status}`);
  }
}

// ── END LEGACY REST FALLBACK ────────────────────────────────────

export const useAccountSecurityStore = create<AccountSecurityState>()((set, get) => ({
  isStalwart: null,
  isProbing: false,
  otpEnabled: false,
  appPasswords: [],
  isLoadingAuth: false,
  encryptionType: 'disabled',
  isLoadingCrypto: false,
  displayName: '',
  emails: [],
  quota: 0,
  roles: [],
  isLoadingPrincipal: false,
  isSaving: false,
  error: null,

  probe: async (client) => {
    set({ isProbing: true });
    try {
      if (jmap(client)) {
        set({ isStalwart: true, isProbing: false });
        return true;
      }
      const isStalwart = await legacyProbe();
      set({ isStalwart, isProbing: false });
      return isStalwart;
    } catch (error) {
      debug.error('Stalwart probe failed:', error);
      set({ isStalwart: false, isProbing: false });
      return false;
    }
  },

  fetchAuthInfo: async (client) => {
    set({ isLoadingAuth: true, error: null });
    try {
      const j = jmap(client);
      if (j) {
        const [appPasswords, accountPassword] = await Promise.all([
          j.stalwartGetAppPasswords(),
          j.stalwartGetAccountPassword(),
        ]);
        set({
          otpEnabled: !!accountPassword.otpAuth?.otpUrl,
          appPasswords: appPasswords.map(ap => ap.description),
          isLoadingAuth: false,
        });
      } else {
        const info = await legacyFetchAuthInfo();
        set({
          otpEnabled: info.otpEnabled,
          appPasswords: info.appPasswords,
          isLoadingAuth: false,
        });
      }
    } catch (error) {
      debug.error('Failed to fetch auth info:', error);
      set({
        isLoadingAuth: false,
        error: error instanceof Error ? error.message : 'Failed to fetch auth info',
      });
    }
  },

  fetchCryptoInfo: async (client) => {
    set({ isLoadingCrypto: true, error: null });
    try {
      const j = jmap(client);
      if (j) {
        const encryptionType = await j.stalwartGetEncryption();
        set({ encryptionType, isLoadingCrypto: false });
      } else {
        const encryptionType = await legacyFetchCryptoInfo();
        set({ encryptionType, isLoadingCrypto: false });
      }
    } catch (error) {
      debug.error('Failed to fetch crypto info:', error);
      set({
        isLoadingCrypto: false,
        error: error instanceof Error ? error.message : 'Failed to fetch crypto info',
      });
    }
  },

  fetchPrincipal: async (client) => {
    set({ isLoadingPrincipal: true, error: null });
    try {
      const j = jmap(client);
      if (j) {
        const info = await j.stalwartGetAccountInfo();
        set({
          displayName: info.description ?? info.name ?? '',
          emails: info.emails ?? [],
          quota: info.quota ?? 0,
          roles: info.roles ?? [],
          isLoadingPrincipal: false,
        });
      } else {
        const principal = await legacyFetchPrincipal();
        set({
          displayName: principal.description,
          emails: principal.emails,
          quota: principal.quota,
          roles: principal.roles,
          isLoadingPrincipal: false,
        });
      }
    } catch (error) {
      debug.error('Failed to fetch principal:', error);
      set({
        isLoadingPrincipal: false,
        error: error instanceof Error ? error.message : 'Failed to fetch principal',
      });
    }
  },

  fetchAll: async (client) => {
    const { fetchAuthInfo, fetchCryptoInfo, fetchPrincipal } = get();
    await Promise.allSettled([fetchAuthInfo(client), fetchCryptoInfo(client), fetchPrincipal(client)]);
  },

  changePassword: async (client, currentPassword, newPassword) => {
    set({ isSaving: true, error: null });
    try {
      const j = jmap(client);
      if (j) {
        await j.stalwartChangePassword(currentPassword, newPassword);
      } else {
        await legacyChangePassword(currentPassword, newPassword);
      }
      set({ isSaving: false });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to change password',
      });
      throw error;
    }
  },

  updateDisplayName: async (client, displayName) => {
    set({ isSaving: true, error: null });
    try {
      const j = jmap(client);
      if (j) {
        await j.stalwartUpdateDisplayName(displayName);
      } else {
        await legacyUpdateDisplayName(displayName);
      }
      set({ displayName, isSaving: false });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to update display name',
      });
      throw error;
    }
  },

  enableTotp: async (client) => {
    set({ isSaving: true, error: null });
    try {
      const j = jmap(client);
      let url: string;
      if (j) {
        url = await j.stalwartEnableTotp();
      } else {
        url = await legacyEnableTotp();
      }
      set({ otpEnabled: true, isSaving: false });
      return url;
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to enable TOTP',
      });
      throw error;
    }
  },

  disableTotp: async (client) => {
    set({ isSaving: true, error: null });
    try {
      const j = jmap(client);
      if (j) {
        await j.stalwartDisableTotp();
      } else {
        await legacyDisableTotp();
      }
      set({ otpEnabled: false, isSaving: false });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to disable TOTP',
      });
      throw error;
    }
  },

  addAppPassword: async (client, name, password) => {
    set({ isSaving: true, error: null });
    try {
      let serverSecret: string | undefined;
      const j = jmap(client);
      if (j) {
        const created = await j.stalwartCreateAppPassword(name);
        serverSecret = created.secret;
      } else {
        await legacyAddAppPassword(name, password);
      }
      await get().fetchAuthInfo(client);
      set({ isSaving: false });
      return serverSecret;
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to add app password',
      });
      throw error;
    }
  },

  removeAppPassword: async (client, name) => {
    set({ isSaving: true, error: null });
    try {
      const j = jmap(client);
      if (j) {
        const passwords = await j.stalwartGetAppPasswords();
        const match = passwords.find(ap => ap.description === name);
        if (!match) throw new Error(`App password "${name}" not found`);
        await j.stalwartDestroyAppPassword(match.id);
      } else {
        await legacyRemoveAppPassword(name);
      }
      await get().fetchAuthInfo(client);
      set({ isSaving: false });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to remove app password',
      });
      throw error;
    }
  },

  updateEncryption: async (client, settings) => {
    set({ isSaving: true, error: null });
    try {
      const j = jmap(client);
      if (j) {
        await j.stalwartUpdateEncryption(settings);
      } else {
        await legacyUpdateEncryption(settings);
      }
      set({ encryptionType: settings.type, isSaving: false });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to update encryption',
      });
      throw error;
    }
  },

  clearState: () => set({
    isStalwart: null,
    isProbing: false,
    otpEnabled: false,
    appPasswords: [],
    isLoadingAuth: false,
    encryptionType: 'disabled',
    isLoadingCrypto: false,
    displayName: '',
    emails: [],
    quota: 0,
    roles: [],
    isLoadingPrincipal: false,
    isSaving: false,
    error: null,
  }),
}));
