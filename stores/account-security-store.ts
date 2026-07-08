import { create } from 'zustand';
import { debug } from '@/lib/debug';
import { useAuthStore } from '@/stores/auth-store';
import { stalwartJmap, requireResult, type JmapMethodResponse } from '@/lib/stalwart/jmap-passthrough';

export type EncryptionType = 'Disabled' | 'Aes128' | 'Aes256';

export interface AppPasswordInfo {
  id: string;
  description: string;
  createdAt: string | null;
  expiresAt: string | null;
  allowedIps: string[];
}

export interface ApiKeyInfo {
  id: string;
  description: string;
  createdAt: string | null;
  expiresAt: string | null;
  allowedIps: string[];
}

export interface AppCredentialInput {
  description: string;
  expiresAt?: string | null;
  allowedIps?: string[];
}

interface AccountSecurityState {
  isStalwart: boolean | null;
  isProbing: boolean;

  // Auth info
  otpEnabled: boolean;
  appPasswords: AppPasswordInfo[];
  apiKeys: ApiKeyInfo[];
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

  createAppPassword: (input: AppCredentialInput) => Promise<{ id: string; secret: string }>;
  removeAppPassword: (id: string) => Promise<void>;

  createApiKey: (input: AppCredentialInput) => Promise<{ id: string; secret: string }>;
  removeApiKey: (id: string) => Promise<void>;

  clearState: () => void;
}

function getPrimaryAccountId(): string {
  const client = useAuthStore.getState().client;
  if (!client) throw new Error('Not authenticated');
  return client.getAccountId();
}

function credentialFromResult(raw: Record<string, unknown>): AppPasswordInfo {
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

function ipsToMap(ips?: string[]): Record<string, true> | undefined {
  if (!ips || ips.length === 0) return undefined;
  return Object.fromEntries(ips.map((ip) => [ip, true]));
}

function buildCreateBody(input: AppCredentialInput): Record<string, unknown> {
  const body: Record<string, unknown> = { description: input.description };
  if (input.expiresAt) body.expiresAt = input.expiresAt;
  const allowed = ipsToMap(input.allowedIps);
  if (allowed) body.allowedIps = allowed;
  return body;
}

type SetMethod = 'x:AppPassword/set' | 'x:ApiKey/set';

type StoreGet = () => AccountSecurityState;
type StoreSet = (partial: Partial<AccountSecurityState>) => void;

async function createCredential(
  get: StoreGet,
  set: StoreSet,
  method: SetMethod,
  input: AppCredentialInput,
  fallbackError: string,
): Promise<{ id: string; secret: string }> {
  set({ isSaving: true, error: null });
  try {
    const accountId = getPrimaryAccountId();
    const tmpId = 'new';
    const responses = await stalwartJmap([
      [method, { accountId, create: { [tmpId]: buildCreateBody(input) } }, '0'],
    ]);
    const result = requireResult<{
      created?: Record<string, { id: string; secret: string; createdAt?: string }>;
      notCreated?: Record<string, { type: string; description?: string }>;
    }>(responses, method);

    const notCreated = result.notCreated?.[tmpId];
    if (notCreated) {
      throw new Error(notCreated.description || notCreated.type || fallbackError);
    }
    const created = result.created?.[tmpId];
    if (!created?.id || !created.secret) {
      throw new Error(`Server did not return created credential`);
    }

    await get().fetchAuthInfo();
    set({ isSaving: false });
    return { id: created.id, secret: created.secret };
  } catch (error) {
    set({
      isSaving: false,
      error: error instanceof Error ? error.message : fallbackError,
    });
    throw error;
  }
}

async function removeCredential(
  get: StoreGet,
  set: StoreSet,
  method: SetMethod,
  id: string,
  fallbackError: string,
): Promise<void> {
  set({ isSaving: true, error: null });
  try {
    const accountId = getPrimaryAccountId();
    await stalwartJmap([
      [method, { accountId, destroy: [id] }, '0'],
    ]);
    await get().fetchAuthInfo();
    set({ isSaving: false });
  } catch (error) {
    set({
      isSaving: false,
      error: error instanceof Error ? error.message : fallbackError,
    });
    throw error;
  }
}

/**
 * A JMAP `/set` reports per-object failures (wrong current password, weak
 * password, …) inside `notUpdated` with an HTTP 200 — `stalwartJmap` does not
 * throw for these. Inspect the response and surface the server's message so the
 * UI doesn't report a failed change as successful.
 */
function requireAccountPasswordUpdate(responses: JmapMethodResponse[], fallbackError: string): void {
  const result = requireResult<{
    updated?: Record<string, unknown>;
    notUpdated?: Record<string, { type?: string; description?: string }>;
  }>(responses, 'x:AccountPassword/set');
  const failed = result.notUpdated?.singleton;
  if (failed) {
    throw new Error(failed.description || failed.type || fallbackError);
  }
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
  apiKeys: [],
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
      // No live client yet (e.g. the OAuth session is still reconnecting after
      // a reload). Don't record a verdict — leave isStalwart null so the caller
      // re-probes once the client is ready, instead of caching a false "not a
      // Stalwart server" from a session that hasn't loaded its capabilities.
      if (!client) {
        set({ isProbing: false });
        return false;
      }
      const isStalwart = !!client.hasAccountCapability?.('urn:stalwart:jmap');
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
        ['x:ApiKey/query', { accountId }, '2'],
      ]);

      const passwordResult = requireResult<{ list: Array<{ otpAuth?: { otpUrl?: string | null } }> }>(
        responses,
        'x:AccountPassword/get',
      );
      const appPwQuery = requireResult<{ ids: string[] }>(responses, 'x:AppPassword/query');
      const apiKeyQuery = requireResult<{ ids: string[] }>(responses, 'x:ApiKey/query');

      const otpAuth = passwordResult.list?.[0]?.otpAuth;
      const otpEnabled = !!(otpAuth && typeof otpAuth === 'object' && otpAuth.otpUrl);

      const followUps: [string, Record<string, unknown>, string][] = [];
      if (appPwQuery.ids?.length) {
        followUps.push(['x:AppPassword/get', { accountId, ids: appPwQuery.ids }, 'app']);
      }
      if (apiKeyQuery.ids?.length) {
        followUps.push(['x:ApiKey/get', { accountId, ids: apiKeyQuery.ids }, 'key']);
      }

      let appPasswords: AppPasswordInfo[] = [];
      let apiKeys: ApiKeyInfo[] = [];
      if (followUps.length) {
        const followUpResponses = await stalwartJmap(followUps);
        if (appPwQuery.ids?.length) {
          const r = requireResult<{ list: Array<Record<string, unknown>> }>(followUpResponses, 'x:AppPassword/get');
          appPasswords = (r.list ?? []).map(credentialFromResult);
        }
        if (apiKeyQuery.ids?.length) {
          const r = requireResult<{ list: Array<Record<string, unknown>> }>(followUpResponses, 'x:ApiKey/get');
          apiKeys = (r.list ?? []).map(credentialFromResult);
        }
      }

      set({ otpEnabled, appPasswords, apiKeys, isLoadingAuth: false });
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
      const responses = await stalwartJmap([
        [
          'x:AccountPassword/set',
          {
            accountId,
            update: { singleton: { currentSecret: currentPassword, secret: newPassword } },
          },
          '0',
        ],
      ]);
      requireAccountPasswordUpdate(responses, 'Failed to change password');
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
      const responses = await stalwartJmap([
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
      requireAccountPasswordUpdate(responses, 'Failed to enable TOTP');
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
      const responses = await stalwartJmap([
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
      requireAccountPasswordUpdate(responses, 'Failed to disable TOTP');
      set({ otpEnabled: false, isSaving: false });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to disable TOTP',
      });
      throw error;
    }
  },

  createAppPassword: async (input) => {
    return createCredential(get, set, 'x:AppPassword/set', input, 'Failed to create app password');
  },

  removeAppPassword: async (id) => {
    return removeCredential(get, set, 'x:AppPassword/set', id, 'Failed to remove app password');
  },

  createApiKey: async (input) => {
    return createCredential(get, set, 'x:ApiKey/set', input, 'Failed to create API key');
  },

  removeApiKey: async (id) => {
    return removeCredential(get, set, 'x:ApiKey/set', id, 'Failed to remove API key');
  },

  clearState: () => set({
    isStalwart: null,
    isProbing: false,
    otpEnabled: false,
    appPasswords: [],
    apiKeys: [],
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
