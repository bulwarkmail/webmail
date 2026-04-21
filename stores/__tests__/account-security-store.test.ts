import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/stalwart/jmap-passthrough', () => ({
  stalwartJmap: vi.fn(),
  requireResult: <T,>(responses: Array<[string, unknown, string]>, method: string): T => {
    const match = responses.find(r => r[0] === method);
    if (!match) throw new Error(`Missing ${method}`);
    return match[1] as T;
  },
}));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: {
    getState: () => ({
      client: {
        getAccountId: () => 'acc-primary',
        hasAccountCapability: (cap: string) => cap === 'urn:stalwart:jmap',
      },
    }),
  },
}));

import { useAccountSecurityStore } from '../account-security-store';
import { stalwartJmap } from '@/lib/stalwart/jmap-passthrough';

const mockedJmap = stalwartJmap as unknown as ReturnType<typeof vi.fn>;

function resetStore() {
  useAccountSecurityStore.getState().clearState();
}

describe('account-security-store', () => {
  beforeEach(() => {
    mockedJmap.mockReset();
    resetStore();
  });

  describe('probe', () => {
    it('sets isStalwart=true when the account has the urn:stalwart:jmap capability', async () => {
      const ok = await useAccountSecurityStore.getState().probe();
      expect(ok).toBe(true);
      expect(useAccountSecurityStore.getState().isStalwart).toBe(true);
      expect(useAccountSecurityStore.getState().isProbing).toBe(false);
    });
  });

  describe('fetchAuthInfo', () => {
    it('reports TOTP enabled when AccountPassword singleton has otpUrl', async () => {
      mockedJmap.mockResolvedValueOnce([
        ['x:AccountPassword/get', { list: [{ id: 'singleton', otpAuth: { otpUrl: 'otpauth://totp/x' } }] }, '0'],
        ['x:AppPassword/query', { ids: [] }, '1'],
      ]);

      await useAccountSecurityStore.getState().fetchAuthInfo();

      expect(useAccountSecurityStore.getState().otpEnabled).toBe(true);
      expect(useAccountSecurityStore.getState().appPasswords).toEqual([]);
    });

    it('reports TOTP disabled when otpAuth is empty', async () => {
      mockedJmap.mockResolvedValueOnce([
        ['x:AccountPassword/get', { list: [{ id: 'singleton', otpAuth: {} }] }, '0'],
        ['x:AppPassword/query', { ids: [] }, '1'],
      ]);

      await useAccountSecurityStore.getState().fetchAuthInfo();

      expect(useAccountSecurityStore.getState().otpEnabled).toBe(false);
    });

    it('resolves app password rows via a follow-up Get when query returns ids', async () => {
      mockedJmap
        .mockResolvedValueOnce([
          ['x:AccountPassword/get', { list: [{ otpAuth: {} }] }, '0'],
          ['x:AppPassword/query', { ids: ['p1'] }, '1'],
        ])
        .mockResolvedValueOnce([
          ['x:AppPassword/get', {
            list: [{
              id: 'p1',
              description: 'Thunderbird',
              createdAt: '2026-01-01T00:00:00Z',
              expiresAt: null,
              allowedIps: { '10.0.0.1': true },
            }],
          }, '0'],
        ]);

      await useAccountSecurityStore.getState().fetchAuthInfo();

      const pw = useAccountSecurityStore.getState().appPasswords[0];
      expect(pw).toMatchObject({
        id: 'p1',
        description: 'Thunderbird',
        createdAt: '2026-01-01T00:00:00Z',
        expiresAt: null,
        allowedIps: ['10.0.0.1'],
      });
      expect(mockedJmap).toHaveBeenCalledTimes(2);
    });

    it('records error on failure and clears loading flag', async () => {
      mockedJmap.mockRejectedValueOnce(new Error('boom'));

      await useAccountSecurityStore.getState().fetchAuthInfo();

      expect(useAccountSecurityStore.getState().isLoadingAuth).toBe(false);
      expect(useAccountSecurityStore.getState().error).toBe('boom');
    });
  });

  describe('fetchCryptoInfo', () => {
    it('reads encryption type from encryptionAtRest.@type', async () => {
      mockedJmap.mockResolvedValueOnce([
        ['x:AccountSettings/get', { list: [{ encryptionAtRest: { '@type': 'Aes256' } }] }, '0'],
      ]);

      await useAccountSecurityStore.getState().fetchCryptoInfo();

      expect(useAccountSecurityStore.getState().encryptionType).toBe('Aes256');
    });

    it('defaults to Disabled when @type is missing or unknown', async () => {
      mockedJmap.mockResolvedValueOnce([
        ['x:AccountSettings/get', { list: [{ encryptionAtRest: null }] }, '0'],
      ]);

      await useAccountSecurityStore.getState().fetchCryptoInfo();

      expect(useAccountSecurityStore.getState().encryptionType).toBe('Disabled');
    });
  });

  describe('fetchPrincipal', () => {
    it('combines primary name with enabled aliases and exposes quota/roles', async () => {
      mockedJmap.mockResolvedValueOnce([
        ['x:Account/get', {
          list: [{
            name: 'user@example.com',
            description: 'Display User',
            aliases: {
              a1: { name: 'alias1@example.com', enabled: true },
              a2: { name: 'alias2@example.com', enabled: false },
              a3: { name: 'alias3@example.com', enabled: true },
            },
            quotas: { maxDiskQuota: 5_000_000 },
            roles: { '@type': 'User' },
          }],
        }, '0'],
      ]);

      await useAccountSecurityStore.getState().fetchPrincipal();

      const state = useAccountSecurityStore.getState();
      expect(state.displayName).toBe('Display User');
      expect(state.emails).toEqual(['user@example.com', 'alias1@example.com', 'alias3@example.com']);
      expect(state.quota).toBe(5_000_000);
      expect(state.roles).toEqual(['User']);
    });

    it('swallows forbidden errors (non-admins cannot read their own Account) without setting error', async () => {
      mockedJmap.mockRejectedValueOnce(new Error('Forbidden: missing sysAccountGet permission'));

      await useAccountSecurityStore.getState().fetchPrincipal();

      expect(useAccountSecurityStore.getState().isLoadingPrincipal).toBe(false);
      expect(useAccountSecurityStore.getState().error).toBeNull();
    });

    it('records non-forbidden errors', async () => {
      mockedJmap.mockRejectedValueOnce(new Error('network down'));

      await useAccountSecurityStore.getState().fetchPrincipal();

      expect(useAccountSecurityStore.getState().error).toBe('network down');
    });
  });

  describe('changePassword', () => {
    it('calls x:AccountPassword/set with currentSecret and secret', async () => {
      mockedJmap.mockResolvedValueOnce([
        ['x:AccountPassword/set', { updated: { singleton: null } }, '0'],
      ]);

      await useAccountSecurityStore.getState().changePassword('old', 'new');

      const calls = mockedJmap.mock.calls[0][0];
      expect(calls).toEqual([[
        'x:AccountPassword/set',
        {
          accountId: 'acc-primary',
          update: { singleton: { currentSecret: 'old', secret: 'new' } },
        },
        '0',
      ]]);
    });

    it('propagates errors and records state', async () => {
      mockedJmap.mockRejectedValueOnce(new Error('forbidden'));

      await expect(useAccountSecurityStore.getState().changePassword('x', 'y')).rejects.toThrow('forbidden');
      expect(useAccountSecurityStore.getState().error).toBe('forbidden');
      expect(useAccountSecurityStore.getState().isSaving).toBe(false);
    });
  });

  describe('updateDisplayName', () => {
    it('patches AccountSettings.description and updates local state', async () => {
      mockedJmap.mockResolvedValueOnce([
        ['x:AccountSettings/set', { updated: { singleton: null } }, '0'],
      ]);

      await useAccountSecurityStore.getState().updateDisplayName('New Name');

      expect(useAccountSecurityStore.getState().displayName).toBe('New Name');
      const args = mockedJmap.mock.calls[0][0][0][1];
      expect(args).toEqual({ accountId: 'acc-primary', update: { singleton: { description: 'New Name' } } });
    });
  });

  describe('enableTotp / disableTotp', () => {
    it('enableTotp sends currentSecret + otpAuth.otpUrl + otpCode', async () => {
      mockedJmap.mockResolvedValueOnce([
        ['x:AccountPassword/set', { updated: { singleton: null } }, '0'],
      ]);

      await useAccountSecurityStore.getState().enableTotp('pw', 'otpauth://totp/x?secret=S', '123456');

      expect(useAccountSecurityStore.getState().otpEnabled).toBe(true);
      const args = mockedJmap.mock.calls[0][0][0][1];
      expect(args.update.singleton).toEqual({
        currentSecret: 'pw',
        otpAuth: { otpUrl: 'otpauth://totp/x?secret=S', otpCode: '123456' },
      });
    });

    it('disableTotp clears otpUrl', async () => {
      useAccountSecurityStore.setState({ otpEnabled: true });
      mockedJmap.mockResolvedValueOnce([
        ['x:AccountPassword/set', { updated: { singleton: null } }, '0'],
      ]);

      await useAccountSecurityStore.getState().disableTotp('pw');

      expect(useAccountSecurityStore.getState().otpEnabled).toBe(false);
      const args = mockedJmap.mock.calls[0][0][0][1];
      expect(args.update.singleton).toEqual({ currentSecret: 'pw', otpAuth: { otpUrl: null } });
    });
  });

  describe('createAppPassword', () => {
    it('returns the server-generated id and secret then refreshes auth info', async () => {
      mockedJmap
        .mockResolvedValueOnce([
          ['x:AppPassword/set', { created: { new: { id: 'p-new', secret: 'S3CR3T' } } }, '0'],
        ])
        .mockResolvedValueOnce([
          ['x:AccountPassword/get', { list: [{ otpAuth: {} }] }, '0'],
          ['x:AppPassword/query', { ids: [] }, '1'],
        ]);

      const result = await useAccountSecurityStore.getState().createAppPassword('CLI', '2026-12-01T00:00:00Z');

      expect(result).toEqual({ id: 'p-new', secret: 'S3CR3T' });

      const createArgs = mockedJmap.mock.calls[0][0][0][1];
      expect(createArgs.create.new).toEqual({ description: 'CLI', expiresAt: '2026-12-01T00:00:00Z' });
      expect(mockedJmap).toHaveBeenCalledTimes(2);
    });

    it('throws with server-provided description when notCreated is returned', async () => {
      mockedJmap.mockResolvedValueOnce([
        ['x:AppPassword/set', { notCreated: { new: { type: 'invalidProperties', description: 'description too short' } } }, '0'],
      ]);

      await expect(
        useAccountSecurityStore.getState().createAppPassword('x')
      ).rejects.toThrow('description too short');
    });

    it('throws when the server does not return a secret', async () => {
      mockedJmap.mockResolvedValueOnce([
        ['x:AppPassword/set', { created: { new: { id: 'p' } } }, '0'],
      ]);

      await expect(
        useAccountSecurityStore.getState().createAppPassword('x')
      ).rejects.toThrow(/did not return/i);
    });
  });

  describe('removeAppPassword', () => {
    it('calls AppPassword/set with destroy and refreshes auth info', async () => {
      mockedJmap
        .mockResolvedValueOnce([['x:AppPassword/set', { destroyed: ['p1'] }, '0']])
        .mockResolvedValueOnce([
          ['x:AccountPassword/get', { list: [{ otpAuth: {} }] }, '0'],
          ['x:AppPassword/query', { ids: [] }, '1'],
        ]);

      await useAccountSecurityStore.getState().removeAppPassword('p1');

      const args = mockedJmap.mock.calls[0][0][0][1];
      expect(args).toEqual({ accountId: 'acc-primary', destroy: ['p1'] });
      expect(mockedJmap).toHaveBeenCalledTimes(2);
    });
  });

  describe('clearState', () => {
    it('resets all derived fields back to defaults', () => {
      useAccountSecurityStore.setState({
        isStalwart: true,
        otpEnabled: true,
        appPasswords: [{ id: 'p', description: 'd', createdAt: null, expiresAt: null, allowedIps: [] }],
        encryptionType: 'Aes256',
        displayName: 'user',
        emails: ['a@b'],
        quota: 10,
        roles: ['User'],
        error: 'x',
      });

      useAccountSecurityStore.getState().clearState();

      const state = useAccountSecurityStore.getState();
      expect(state.isStalwart).toBeNull();
      expect(state.otpEnabled).toBe(false);
      expect(state.appPasswords).toEqual([]);
      expect(state.encryptionType).toBe('Disabled');
      expect(state.displayName).toBe('');
      expect(state.emails).toEqual([]);
      expect(state.quota).toBe(0);
      expect(state.roles).toEqual([]);
      expect(state.error).toBeNull();
    });
  });
});
