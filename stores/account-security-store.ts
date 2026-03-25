import { create } from 'zustand';
import { debug } from '@/lib/debug';
import { useAuthStore } from './auth-store';

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

  // Actions
  probe: () => Promise<boolean>;
  fetchAuthInfo: () => Promise<void>;
  fetchCryptoInfo: () => Promise<void>;
  fetchPrincipal: () => Promise<void>;
  fetchAll: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  updateDisplayName: (displayName: string) => Promise<void>;
  enableTotp: () => Promise<string>;
  disableTotp: () => Promise<void>;
  addAppPassword: (name: string, password: string) => Promise<void>;
  removeAppPassword: (name: string) => Promise<void>;
  updateEncryption: (settings: { type: string; algo?: string; certs?: string }) => Promise<void>;
  clearState: () => void;
}

function getApiHeaders(): Record<string, string> {
  const { client } = useAuthStore.getState();
  if (!client) return {};
  return {
    'Authorization': client.getAuthHeader(),
    'X-JMAP-Server-URL': client.getServerUrl(),
    'X-JMAP-Username': client.getUsername(),
  };
}

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

  probe: async () => {
    set({ isProbing: true });
    try {
      const response = await fetch('/api/account/stalwart/probe', {
        headers: getApiHeaders(),
      });
      const data = await response.json();
      const isStalwart = data.isStalwart === true;
      set({ isStalwart, isProbing: false });
      return isStalwart;
    } catch (error) {
      debug.error('Stalwart probe failed:', error);
      set({ isStalwart: false, isProbing: false });
      return false;
    }
  },

  fetchAuthInfo: async () => {
    set({ isLoadingAuth: true, error: null });
    try {
      const response = await fetch('/api/account/stalwart/auth', {
        headers: getApiHeaders(),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      set({
        otpEnabled: data.data?.otpEnabled ?? false,
        appPasswords: data.data?.appPasswords ?? [],
        isLoadingAuth: false,
      });
    } catch (error) {
      debug.error('Failed to fetch auth info:', error);
      set({
        isLoadingAuth: false,
        error: error instanceof Error ? error.message : 'Failed to fetch auth info',
      });
    }
  },

  fetchCryptoInfo: async () => {
    set({ isLoadingCrypto: true, error: null });
    try {
      const response = await fetch('/api/account/stalwart/crypto', {
        headers: getApiHeaders(),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      set({
        encryptionType: data.data?.type ?? 'disabled',
        isLoadingCrypto: false,
      });
    } catch (error) {
      debug.error('Failed to fetch crypto info:', error);
      set({
        isLoadingCrypto: false,
        error: error instanceof Error ? error.message : 'Failed to fetch crypto info',
      });
    }
  },

  fetchPrincipal: async () => {
    set({ isLoadingPrincipal: true, error: null });
    try {
      const response = await fetch('/api/account/stalwart/principal', {
        headers: getApiHeaders(),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const principal = data.data;
      set({
        displayName: principal?.description ?? '',
        emails: Array.isArray(principal?.emails) ? principal.emails : principal?.emails ? [principal.emails] : [],
        quota: principal?.quota ?? 0,
        roles: principal?.roles ?? [],
        isLoadingPrincipal: false,
      });
    } catch (error) {
      debug.error('Failed to fetch principal:', error);
      set({
        isLoadingPrincipal: false,
        error: error instanceof Error ? error.message : 'Failed to fetch principal',
      });
    }
  },

  fetchAll: async () => {
    const { fetchAuthInfo, fetchCryptoInfo, fetchPrincipal } = get();
    await Promise.allSettled([fetchAuthInfo(), fetchCryptoInfo(), fetchPrincipal()]);
  },

  changePassword: async (currentPassword, newPassword) => {
    set({ isSaving: true, error: null });
    try {
      const response = await fetch('/api/account/stalwart/password', {
        method: 'POST',
        headers: { ...getApiHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || `HTTP ${response.status}`);
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

  updateDisplayName: async (displayName) => {
    set({ isSaving: true, error: null });
    try {
      const response = await fetch('/api/account/stalwart/principal', {
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

      set({ displayName, isSaving: false });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to update display name',
      });
      throw error;
    }
  },

  enableTotp: async () => {
    set({ isSaving: true, error: null });
    try {
      const response = await fetch('/api/account/stalwart/auth', {
        method: 'POST',
        headers: { ...getApiHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify([{ type: 'enableOtpAuth' }]),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || data.details || `HTTP ${response.status}`);
      }

      const data = await response.json();
      set({ otpEnabled: true, isSaving: false });
      return data.data;
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to enable TOTP',
      });
      throw error;
    }
  },

  disableTotp: async () => {
    set({ isSaving: true, error: null });
    try {
      const response = await fetch('/api/account/stalwart/auth', {
        method: 'POST',
        headers: { ...getApiHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify([{ type: 'disableOtpAuth' }]),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || data.details || `HTTP ${response.status}`);
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

  addAppPassword: async (name, password) => {
    set({ isSaving: true, error: null });
    try {
      const response = await fetch('/api/account/stalwart/auth', {
        method: 'POST',
        headers: { ...getApiHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify([{ type: 'addAppPassword', name, password }]),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || data.details || `HTTP ${response.status}`);
      }

      // Refresh auth info to get updated app passwords list
      await get().fetchAuthInfo();
      set({ isSaving: false });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to add app password',
      });
      throw error;
    }
  },

  removeAppPassword: async (name) => {
    set({ isSaving: true, error: null });
    try {
      const response = await fetch('/api/account/stalwart/auth', {
        method: 'POST',
        headers: { ...getApiHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify([{ type: 'removeAppPassword', name }]),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || data.details || `HTTP ${response.status}`);
      }

      // Refresh auth info to get updated app passwords list
      await get().fetchAuthInfo();
      set({ isSaving: false });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to remove app password',
      });
      throw error;
    }
  },

  updateEncryption: async (settings) => {
    set({ isSaving: true, error: null });
    try {
      const response = await fetch('/api/account/stalwart/crypto', {
        method: 'POST',
        headers: { ...getApiHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || data.details || `HTTP ${response.status}`);
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
