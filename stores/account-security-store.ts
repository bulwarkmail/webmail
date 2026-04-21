import { create } from 'zustand';
import { debug } from '@/lib/debug';
import { useAuthStore } from '@/stores/auth-store';
import { stalwartJmap, requireResult } from '@/lib/stalwart/jmap-passthrough';

export type EncryptionType = 'Disabled' | 'Aes128' | 'Aes256';

export interface AppPasswordInfo {
  id: string;
  description: string;
  createdAt: string | null;
  expiresAt: string | null;
  allowedIps: string[];
}

interface AccountSecurityState {
  isStalwart: boolean | null;
  isProbing: boolean;

  // Auth info
  otpEnabled: boolean;
  appPasswords: AppPasswordInfo[];
  isLoadingAuth: boolean;

  // Encryption-at-rest
  encryptionType: EncryptionType;
  isLoadingCrypto: boolean;

  // Profile
  displayName: string;
  emails: string[];
  quota: number;
  roles: string[];
  isLoadingPrincipal: boolean;

  isSaving: boolean;
  error: string | null;

  probe: () => Promise<boolean>;
  fetchAuthInfo: () => Promise<void>;
  fetchCryptoInfo: () => Promise<void>;
  fetchPrincipal: () => Promise<void>;
  fetchAll: () => Promise<void>;

  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  updateDisplayName: (displayName: string) => Promise<void>;

  enableTotp: (currentPassword: string, otpUrl: string, otpCode: string) => Promise<void>;
  disableTotp: (currentPassword: string) => Promise<void>;

  createAppPassword: (description: string, expiresAt?: string | null) => Promise<{ id: string; secret: string }>;
  removeAppPassword: (id: string) => Promise<void>;

  clearState: () => void;
}

function getPrimaryAccountId(): string {
  const client = useAuthStore.getState().client;
  if (!client) throw new Error('Not authenticated');
  return client.getAccountId();
}

function appPasswordFromResult(raw: Record<string, unknown>): AppPasswordInfo {
  const allowedIps = raw.allowedIps && typeof raw.allowedIps === 'object'
    ? Object.keys(raw.allowedIps as Record<string, unknown>)
    : [];
  return {
    id: String(raw.id ?? ''),
    description: typeof raw.description === 'string' ? raw.description : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : null,
    allowedIps,
  };
}

function extractEncryptionType(raw: unknown): EncryptionType {
  if (!raw || typeof raw !== 'object') return 'Disabled';
  const type = (raw as { ['@type']?: string })['@type'];
  if (type === 'Aes128' || type === 'Aes256') return type;
  return 'Disabled';
}

export const useAccountSecurityStore = create<AccountSecurityState>()((set, get) => ({
  isStalwart: null,
  isProbing: false,
  otpEnabled: false,
  appPasswords: [],
  isLoadingAuth: false,
  encryptionType: 'Disabled',
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
      const client = useAuthStore.getState().client;
      const isStalwart = !!client?.hasAccountCapability?.('urn:stalwart:jmap');
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
      const accountId = getPrimaryAccountId();
      const responses = await stalwartJmap([
        ['x:AccountPassword/get', { accountId, ids: ['singleton'] }, '0'],
        ['x:AppPassword/query', { accountId }, '1'],
      ]);

      const passwordResult = requireResult<{ list: Array<{ otpAuth?: { otpUrl?: string | null } }> }>(
        responses,
        'x:AccountPassword/get',
      );
      const queryResult = requireResult<{ ids: string[] }>(responses, 'x:AppPassword/query');

      const otpAuth = passwordResult.list?.[0]?.otpAuth;
      const otpEnabled = !!(otpAuth && typeof otpAuth === 'object' && otpAuth.otpUrl);

      let appPasswords: AppPasswordInfo[] = [];
      if (queryResult.ids?.length) {
        const getResponses = await stalwartJmap([
          ['x:AppPassword/get', { accountId, ids: queryResult.ids }, '0'],
        ]);
        const getResult = requireResult<{ list: Array<Record<string, unknown>> }>(getResponses, 'x:AppPassword/get');
        appPasswords = (getResult.list ?? []).map(appPasswordFromResult);
      }

      set({ otpEnabled, appPasswords, isLoadingAuth: false });
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
      const accountId = getPrimaryAccountId();
      const responses = await stalwartJmap([
        ['x:AccountSettings/get', { accountId, ids: ['singleton'] }, '0'],
      ]);
      const result = requireResult<{ list: Array<{ encryptionAtRest?: unknown }> }>(
        responses,
        'x:AccountSettings/get',
      );
      const encryptionType = extractEncryptionType(result.list?.[0]?.encryptionAtRest);
      set({ encryptionType, isLoadingCrypto: false });
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
      const accountId = getPrimaryAccountId();
      const responses = await stalwartJmap([
        ['x:Account/get', { accountId, ids: [accountId] }, '0'],
      ]);
      const result = requireResult<{
        list: Array<{
          description?: string | null;
          aliases?: Record<string, { name?: string; domainId?: string; enabled?: boolean }>;
          quotas?: { maxDiskQuota?: number };
          roles?: { ['@type']?: string };
          name?: string;
          domainId?: string;
        }>;
      }>(responses, 'x:Account/get');

      const acc = result.list?.[0];
      const aliasAddresses = acc?.aliases
        ? Object.values(acc.aliases)
            .flatMap((a) => (a && a.enabled !== false && a.name ? [a.name] : []))
        : [];
      const primaryEmail = acc?.name ? [acc.name] : [];
      set({
        displayName: acc?.description ?? '',
        emails: [...primaryEmail, ...aliasAddresses],
        quota: acc?.quotas?.maxDiskQuota ?? 0,
        roles: acc?.roles?.['@type'] ? [acc.roles['@type']] : [],
        isLoadingPrincipal: false,
      });
    } catch (error) {
      debug.error('Failed to fetch principal:', error);
      const msg = error instanceof Error ? error.message : 'Failed to fetch principal';
      const isForbidden = msg.toLowerCase().includes('forbidden');
      set({
        isLoadingPrincipal: false,
        error: isForbidden ? null : msg,
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
      const accountId = getPrimaryAccountId();
      await stalwartJmap([
        [
          'x:AccountPassword/set',
          {
            accountId,
            update: { singleton: { currentSecret: currentPassword, secret: newPassword } },
          },
          '0',
        ],
      ]);
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
      const accountId = getPrimaryAccountId();
      await stalwartJmap([
        [
          'x:AccountSettings/set',
          { accountId, update: { singleton: { description: displayName } } },
          '0',
        ],
      ]);
      set({ displayName, isSaving: false });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to update display name',
      });
      throw error;
    }
  },

  enableTotp: async (currentPassword, otpUrl, otpCode) => {
    set({ isSaving: true, error: null });
    try {
      const accountId = getPrimaryAccountId();
      await stalwartJmap([
        [
          'x:AccountPassword/set',
          {
            accountId,
            update: {
              singleton: {
                currentSecret: currentPassword,
                otpAuth: { otpUrl, otpCode },
              },
            },
          },
          '0',
        ],
      ]);
      set({ otpEnabled: true, isSaving: false });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to enable TOTP',
      });
      throw error;
    }
  },

  disableTotp: async (currentPassword) => {
    set({ isSaving: true, error: null });
    try {
      const accountId = getPrimaryAccountId();
      await stalwartJmap([
        [
          'x:AccountPassword/set',
          {
            accountId,
            update: {
              singleton: {
                currentSecret: currentPassword,
                otpAuth: { otpUrl: null },
              },
            },
          },
          '0',
        ],
      ]);
      set({ otpEnabled: false, isSaving: false });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to disable TOTP',
      });
      throw error;
    }
  },

  createAppPassword: async (description, expiresAt) => {
    set({ isSaving: true, error: null });
    try {
      const accountId = getPrimaryAccountId();
      const tmpId = 'new';
      const responses = await stalwartJmap([
        [
          'x:AppPassword/set',
          {
            accountId,
            create: {
              [tmpId]: {
                description,
                ...(expiresAt ? { expiresAt } : {}),
              },
            },
          },
          '0',
        ],
      ]);
      const result = requireResult<{
        created?: Record<string, { id: string; secret: string; createdAt?: string }>;
        notCreated?: Record<string, { type: string; description?: string }>;
      }>(responses, 'x:AppPassword/set');

      const notCreated = result.notCreated?.[tmpId];
      if (notCreated) {
        throw new Error(notCreated.description || notCreated.type || 'Failed to create app password');
      }
      const created = result.created?.[tmpId];
      if (!created?.id || !created.secret) {
        throw new Error('Server did not return created app password');
      }

      await get().fetchAuthInfo();
      set({ isSaving: false });
      return { id: created.id, secret: created.secret };
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to create app password',
      });
      throw error;
    }
  },

  removeAppPassword: async (id) => {
    set({ isSaving: true, error: null });
    try {
      const accountId = getPrimaryAccountId();
      await stalwartJmap([
        ['x:AppPassword/set', { accountId, destroy: [id] }, '0'],
      ]);
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

  clearState: () => set({
    isStalwart: null,
    isProbing: false,
    otpEnabled: false,
    appPasswords: [],
    isLoadingAuth: false,
    encryptionType: 'Disabled',
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
