import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/stalwart/principal', () => ({
  fetchPrincipalDisplayName: vi.fn(),
}));

import { syncAccountDisplayName } from '../auth-store';
import { useAccountStore } from '../account-store';
import { fetchPrincipalDisplayName } from '@/lib/stalwart/principal';

const mockedPrincipal = fetchPrincipalDisplayName as unknown as ReturnType<typeof vi.fn>;

const SERVER = 'https://mail.example.com';
const client = {} as never;

function seedAccount(displayName = 'Old Name', label = displayName): string {
  const store = useAccountStore.getState();
  const id = store.addAccount({
    label,
    serverUrl: SERVER,
    username: 'user@example.com',
    authMode: 'basic',
    rememberMe: true,
    displayName,
    email: 'user@example.com',
    lastLoginAt: 0,
    isConnected: true,
    hasError: false,
    isDefault: true,
  });
  return id;
}

// Issue #900: the registry entry is written once by addAccount and never
// refreshed, so a renamed user kept the old name in the account switcher.
// settings-p2-2: the name that counts is the primary identity's, the one
// recipients see and Settings > Account edits. Stalwart's principal
// description is only the fallback for an account without one.
describe('syncAccountDisplayName (#900, settings-p2-2)', () => {
  beforeEach(() => {
    mockedPrincipal.mockReset();
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  });

  it('takes the identity name over the Stalwart principal description', async () => {
    const id = seedAccount('Old Name');
    mockedPrincipal.mockResolvedValue('Admin note (throwaway)');

    await syncAccountDisplayName(id, client, 'Sam Settings');

    const account = useAccountStore.getState().getAccountById(id)!;
    expect(account.displayName).toBe('Sam Settings');
    expect(account.label).toBe('Sam Settings');
    expect(mockedPrincipal).not.toHaveBeenCalled();
  });

  it('falls back to the principal name when the identity has no name', async () => {
    const id = seedAccount('Old Name');
    mockedPrincipal.mockResolvedValueOnce('New Name');

    await syncAccountDisplayName(id, client, '   ');

    const account = useAccountStore.getState().getAccountById(id)!;
    expect(account.displayName).toBe('New Name');
    expect(mockedPrincipal).toHaveBeenCalledWith(client, account.cookieSlot);
  });

  it('keeps the cached name when neither source yields one', async () => {
    const id = seedAccount('Old Name');
    mockedPrincipal.mockResolvedValueOnce(null);

    await syncAccountDisplayName(id, client, '   ');

    expect(useAccountStore.getState().getAccountById(id)!.displayName).toBe('Old Name');
  });

  it('keeps the name when the caller does not know the identities', async () => {
    const id = seedAccount('Sam Settings');
    mockedPrincipal.mockResolvedValue('Admin note (throwaway)');

    await syncAccountDisplayName(id, client);

    expect(useAccountStore.getState().getAccountById(id)!.displayName).toBe('Sam Settings');
    expect(mockedPrincipal).not.toHaveBeenCalled();
  });

  it('names an unnamed account from the principal when the identities are unknown', async () => {
    const id = seedAccount('');
    mockedPrincipal.mockResolvedValueOnce('New Name');

    await syncAccountDisplayName(id, client);

    expect(useAccountStore.getState().getAccountById(id)!.displayName).toBe('New Name');
  });

  it('leaves a diverged label alone', async () => {
    const id = seedAccount('Old Name', 'Work');

    await syncAccountDisplayName(id, client, 'New Name');

    const account = useAccountStore.getState().getAccountById(id)!;
    expect(account.displayName).toBe('New Name');
    expect(account.label).toBe('Work');
  });

  it('is a no-op for unknown accounts and for unchanged names', async () => {
    await syncAccountDisplayName('missing', client, 'Whatever');
    expect(mockedPrincipal).not.toHaveBeenCalled();

    const id = seedAccount('Same');
    const before = useAccountStore.getState().getAccountById(id);
    await syncAccountDisplayName(id, client, 'Same');
    expect(useAccountStore.getState().getAccountById(id)).toBe(before);
  });
});
