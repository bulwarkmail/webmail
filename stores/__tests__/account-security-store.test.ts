import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAccountSecurityStore } from '../account-security-store';

function mockFetchResponse(status: number, body?: unknown): Response {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const defaultState = {
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
};

// All tests pass null as client to exercise the legacy REST fallback path.
const NO_CLIENT = null;

describe('AccountSecurityStore', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    useAccountSecurityStore.setState(defaultState);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('probe', () => {
    it('sets isStalwart to true when probe succeeds', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { isStalwart: true }));

      const result = await useAccountSecurityStore.getState().probe(NO_CLIENT);

      expect(result).toBe(true);
      expect(useAccountSecurityStore.getState().isStalwart).toBe(true);
      expect(useAccountSecurityStore.getState().isProbing).toBe(false);
    });

    it('sets isStalwart to false when probe returns false', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { isStalwart: false }));

      const result = await useAccountSecurityStore.getState().probe(NO_CLIENT);

      expect(result).toBe(false);
      expect(useAccountSecurityStore.getState().isStalwart).toBe(false);
    });

    it('sets isStalwart to false on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('Network error'));

      const result = await useAccountSecurityStore.getState().probe(NO_CLIENT);

      expect(result).toBe(false);
      expect(useAccountSecurityStore.getState().isStalwart).toBe(false);
      expect(useAccountSecurityStore.getState().isProbing).toBe(false);
    });
  });

  describe('fetchAuthInfo', () => {
    it('populates auth info on success', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse(200, { data: { otpEnabled: true, appPasswords: ['app1', 'app2'] } })
      );

      await useAccountSecurityStore.getState().fetchAuthInfo(NO_CLIENT);

      const state = useAccountSecurityStore.getState();
      expect(state.otpEnabled).toBe(true);
      expect(state.appPasswords).toEqual(['app1', 'app2']);
      expect(state.isLoadingAuth).toBe(false);
      expect(state.error).toBeNull();
    });

    it('sets defaults when data fields are missing', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: {} }));

      await useAccountSecurityStore.getState().fetchAuthInfo(NO_CLIENT);

      const state = useAccountSecurityStore.getState();
      expect(state.otpEnabled).toBe(false);
      expect(state.appPasswords).toEqual([]);
    });

    it('sets error on HTTP failure', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(500));

      await useAccountSecurityStore.getState().fetchAuthInfo(NO_CLIENT);

      const state = useAccountSecurityStore.getState();
      expect(state.isLoadingAuth).toBe(false);
      expect(state.error).toBe('HTTP 500');
    });

    it('sets error on network failure', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Connection refused'));

      await useAccountSecurityStore.getState().fetchAuthInfo(NO_CLIENT);

      const state = useAccountSecurityStore.getState();
      expect(state.isLoadingAuth).toBe(false);
      expect(state.error).toBe('Connection refused');
    });
  });

  describe('fetchCryptoInfo', () => {
    it('populates crypto info on success', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse(200, { data: { type: 'pgp' } })
      );

      await useAccountSecurityStore.getState().fetchCryptoInfo(NO_CLIENT);

      const state = useAccountSecurityStore.getState();
      expect(state.encryptionType).toBe('pgp');
      expect(state.isLoadingCrypto).toBe(false);
    });

    it('defaults to disabled when type is missing', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: {} }));

      await useAccountSecurityStore.getState().fetchCryptoInfo(NO_CLIENT);

      expect(useAccountSecurityStore.getState().encryptionType).toBe('disabled');
    });

    it('sets error on failure', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(403));

      await useAccountSecurityStore.getState().fetchCryptoInfo(NO_CLIENT);

      expect(useAccountSecurityStore.getState().error).toBe('HTTP 403');
    });
  });

  describe('fetchPrincipal', () => {
    it('populates principal info on success', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse(200, {
          data: {
            description: 'John Doe',
            emails: ['john@example.com', 'doe@example.com'],
            quota: 5000000,
            roles: ['user', 'admin'],
          },
        })
      );

      await useAccountSecurityStore.getState().fetchPrincipal(NO_CLIENT);

      const state = useAccountSecurityStore.getState();
      expect(state.displayName).toBe('John Doe');
      expect(state.emails).toEqual(['john@example.com', 'doe@example.com']);
      expect(state.quota).toBe(5000000);
      expect(state.roles).toEqual(['user', 'admin']);
      expect(state.isLoadingPrincipal).toBe(false);
    });

    it('handles single email string as array', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse(200, {
          data: { description: 'User', emails: 'single@example.com', quota: 0, roles: [] },
        })
      );

      await useAccountSecurityStore.getState().fetchPrincipal(NO_CLIENT);

      expect(useAccountSecurityStore.getState().emails).toEqual(['single@example.com']);
    });

    it('handles missing emails gracefully', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse(200, { data: { description: 'User' } })
      );

      await useAccountSecurityStore.getState().fetchPrincipal(NO_CLIENT);

      expect(useAccountSecurityStore.getState().emails).toEqual([]);
    });

    it('sets defaults when fields are missing', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: {} }));

      await useAccountSecurityStore.getState().fetchPrincipal(NO_CLIENT);

      const state = useAccountSecurityStore.getState();
      expect(state.displayName).toBe('');
      expect(state.emails).toEqual([]);
      expect(state.quota).toBe(0);
      expect(state.roles).toEqual([]);
    });
  });

  describe('fetchAll', () => {
    it('calls all three fetch methods in parallel', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockFetchResponse(200, { data: { otpEnabled: false, appPasswords: [] } }))
        .mockResolvedValueOnce(mockFetchResponse(200, { data: { type: 'smime' } }))
        .mockResolvedValueOnce(mockFetchResponse(200, { data: { description: 'Test', emails: [], quota: 0, roles: [] } }));

      await useAccountSecurityStore.getState().fetchAll(NO_CLIENT);

      const state = useAccountSecurityStore.getState();
      expect(state.encryptionType).toBe('smime');
      expect(state.displayName).toBe('Test');
      expect(state.isLoadingAuth).toBe(false);
      expect(state.isLoadingCrypto).toBe(false);
      expect(state.isLoadingPrincipal).toBe(false);
    });

    it('continues even if one fetch fails', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockFetchResponse(500)) // auth fails
        .mockResolvedValueOnce(mockFetchResponse(200, { data: { type: 'pgp' } }))
        .mockResolvedValueOnce(mockFetchResponse(200, { data: { description: 'OK', emails: [], quota: 0, roles: [] } }));

      await useAccountSecurityStore.getState().fetchAll(NO_CLIENT);

      const state = useAccountSecurityStore.getState();
      expect(state.encryptionType).toBe('pgp');
      expect(state.displayName).toBe('OK');
    });
  });

  describe('changePassword', () => {
    it('sends POST with currentPassword and newPassword', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { ok: true }));

      await useAccountSecurityStore.getState().changePassword(NO_CLIENT, 'oldpass', 'newpass123');

      expect(fetchSpy).toHaveBeenCalledWith('/api/account/stalwart/password', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ currentPassword: 'oldpass', newPassword: 'newpass123' }),
      }));
      expect(useAccountSecurityStore.getState().isSaving).toBe(false);
    });

    it('throws and sets error on failure', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(403, { error: 'Current password is incorrect' }));

      await expect(
        useAccountSecurityStore.getState().changePassword(NO_CLIENT, 'wrong', 'newpass123')
      ).rejects.toThrow('Current password is incorrect');

      expect(useAccountSecurityStore.getState().isSaving).toBe(false);
      expect(useAccountSecurityStore.getState().error).toBe('Current password is incorrect');
    });
  });

  describe('updateDisplayName', () => {
    it('sends PATCH and updates local state on success', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: null }));

      await useAccountSecurityStore.getState().updateDisplayName(NO_CLIENT, 'New Name');

      const state = useAccountSecurityStore.getState();
      expect(state.displayName).toBe('New Name');
      expect(state.isSaving).toBe(false);

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body).toEqual([{ action: 'set', field: 'description', value: 'New Name' }]);
    });

    it('throws and sets error on failure', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(500, { error: 'Server error' }));

      await expect(
        useAccountSecurityStore.getState().updateDisplayName(NO_CLIENT, 'Name')
      ).rejects.toThrow('Server error');

      expect(useAccountSecurityStore.getState().isSaving).toBe(false);
    });
  });

  describe('enableTotp', () => {
    it('sends enableOtpAuth and returns TOTP URL', async () => {
      const totpUrl = 'otpauth://totp/user@example.com?secret=ABC';
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: totpUrl }));

      const result = await useAccountSecurityStore.getState().enableTotp(NO_CLIENT);

      expect(result).toBe(totpUrl);
      expect(useAccountSecurityStore.getState().otpEnabled).toBe(true);
      expect(useAccountSecurityStore.getState().isSaving).toBe(false);

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body).toEqual([{ type: 'enableOtpAuth' }]);
    });

    it('throws and preserves otpEnabled=false on failure', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(400, { error: 'TOTP error' }));

      await expect(
        useAccountSecurityStore.getState().enableTotp(NO_CLIENT)
      ).rejects.toThrow('TOTP error');

      expect(useAccountSecurityStore.getState().otpEnabled).toBe(false);
    });
  });

  describe('disableTotp', () => {
    it('sends disableOtpAuth and sets otpEnabled to false', async () => {
      useAccountSecurityStore.setState({ otpEnabled: true });
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: null }));

      await useAccountSecurityStore.getState().disableTotp(NO_CLIENT);

      expect(useAccountSecurityStore.getState().otpEnabled).toBe(false);
      expect(useAccountSecurityStore.getState().isSaving).toBe(false);
    });
  });

  describe('addAppPassword', () => {
    it('sends addAppPassword and refreshes auth info', async () => {
      // First call: POST addAppPassword
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: null }));
      // Second call: fetchAuthInfo refresh
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse(200, { data: { otpEnabled: false, appPasswords: ['Thunderbird'] } })
      );

      await useAccountSecurityStore.getState().addAppPassword(NO_CLIENT, 'Thunderbird', 'secret');

      const state = useAccountSecurityStore.getState();
      expect(state.appPasswords).toEqual(['Thunderbird']);
      expect(state.isSaving).toBe(false);

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body).toEqual([{ type: 'addAppPassword', name: 'Thunderbird', password: 'secret' }]);
    });

    it('throws on failure', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(500, { error: 'Server down' }));

      await expect(
        useAccountSecurityStore.getState().addAppPassword(NO_CLIENT, 'App', 'pass')
      ).rejects.toThrow('Server down');
    });
  });

  describe('removeAppPassword', () => {
    it('sends removeAppPassword and refreshes auth info', async () => {
      useAccountSecurityStore.setState({ appPasswords: ['Thunderbird', 'iPhone'] });

      // First call: POST removeAppPassword
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: null }));
      // Second call: fetchAuthInfo refresh
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse(200, { data: { otpEnabled: false, appPasswords: ['iPhone'] } })
      );

      await useAccountSecurityStore.getState().removeAppPassword(NO_CLIENT, 'Thunderbird');

      expect(useAccountSecurityStore.getState().appPasswords).toEqual(['iPhone']);

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body).toEqual([{ type: 'removeAppPassword', name: 'Thunderbird' }]);
    });
  });

  describe('updateEncryption', () => {
    it('sends crypto settings and updates local encryptionType', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: null }));

      await useAccountSecurityStore.getState().updateEncryption(NO_CLIENT, { type: 'pgp' });

      expect(useAccountSecurityStore.getState().encryptionType).toBe('pgp');
      expect(useAccountSecurityStore.getState().isSaving).toBe(false);
    });

    it('throws on failure without changing encryptionType', async () => {
      useAccountSecurityStore.setState({ encryptionType: 'disabled' });
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(500, { error: 'Encryption error' }));

      await expect(
        useAccountSecurityStore.getState().updateEncryption(NO_CLIENT, { type: 'pgp' })
      ).rejects.toThrow('Encryption error');

      expect(useAccountSecurityStore.getState().encryptionType).toBe('disabled');
    });
  });

  describe('clearState', () => {
    it('resets all state to defaults', () => {
      useAccountSecurityStore.setState({
        isStalwart: true,
        otpEnabled: true,
        appPasswords: ['app1'],
        encryptionType: 'pgp',
        displayName: 'Test User',
        emails: ['test@example.com'],
        quota: 5000000,
        roles: ['admin'],
        error: 'some error',
      });

      useAccountSecurityStore.getState().clearState();

      const state = useAccountSecurityStore.getState();
      expect(state.isStalwart).toBeNull();
      expect(state.isProbing).toBe(false);
      expect(state.otpEnabled).toBe(false);
      expect(state.appPasswords).toEqual([]);
      expect(state.encryptionType).toBe('disabled');
      expect(state.displayName).toBe('');
      expect(state.emails).toEqual([]);
      expect(state.quota).toBe(0);
      expect(state.roles).toEqual([]);
      expect(state.isSaving).toBe(false);
      expect(state.error).toBeNull();
    });
  });
});
