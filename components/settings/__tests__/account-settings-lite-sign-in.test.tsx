import 'fake-indexeddb/auto';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSettings } from '../account-settings';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { clearAllLiteSessions, saveLiteRefreshToken } from '@/lib/auth/lite-tokens';

// Every Lite sign-in ends as a token session, so Settings > Account read
// "Sign-in page of your organisation" after a password sign-in.

vi.mock('@/lib/lite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/lite')>()),
  IS_LITE: true,
}));
vi.mock('next-intl', () => {
  const t = (key: string) => key;
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('@/hooks/use-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-config')>()),
  useConfig: () => ({ accountManagementUrl: '', accountManagementLabel: '' }),
}));
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: vi.fn(async () => '') }));
vi.mock('../identity-settings', () => ({ EmailAddressesSection: () => null }));
vi.mock('../layout-settings', () => ({ MultipleAccountsSection: () => null }));
vi.mock('../sign-out-row', () => ({ SignOutRow: () => null }));
vi.mock('../account-archive-settings', () => ({ AccountArchiveSettings: () => null }));
vi.mock('../your-name-row', () => ({ YourNameRow: () => null }));

const SERVER = 'https://mail.x.test';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearAllLiteSessions();
  useAccountStore.setState({
    accounts: [{
      id: 'a', label: 'sam', serverUrl: SERVER, username: 'sam@x.test', authMode: 'oauth', rememberMe: true,
      displayName: 'Sam', email: 'sam@x.test', lastLoginAt: 0, isConnected: true, hasError: false, isDefault: true,
      cookieSlot: 1, avatarColor: '#000',
    }] as never,
    activeAccountId: 'a',
    defaultAccountId: 'a',
  });
  useAuthStore.setState({
    username: 'sam@x.test', serverUrl: SERVER, isDemoMode: false, authMode: 'oauth',
    client: { getSharedAccounts: () => [] } as never, activeAccountId: 'a', identities: [], primaryIdentity: null,
  } as never);
});

describe('Account: how you sign in, on Lite', () => {
  it('says password after a password sign-in', () => {
    saveLiteRefreshToken(1, { serverUrl: SERVER, username: 'sam@x.test', refreshToken: 'fake-refresh', clientId: 'bulwark-webmail' }, true);
    render(<AccountSettings />);
    expect(screen.getByText('auth_method_basic')).toBeInTheDocument();
    expect(screen.queryByText('auth_method_oauth')).toBeNull();
  });

  it('keeps single sign-on for a sign-in at the organisation sign-in page', () => {
    saveLiteRefreshToken(1, {
      serverUrl: SERVER, username: 'sam@x.test', refreshToken: 'fake-refresh', clientId: 'app', tokenEndpoint: 'https://id.x.test/token',
    }, true);
    render(<AccountSettings />);
    expect(screen.getByText('auth_method_oauth')).toBeInTheDocument();
  });

  it('reads the slot of the account shown, not another one', () => {
    saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'other@x.test', refreshToken: 'fake-refresh-0' }, true);
    saveLiteRefreshToken(1, {
      serverUrl: SERVER, username: 'sam@x.test', refreshToken: 'fake-refresh', clientId: 'app', tokenEndpoint: 'https://id.x.test/token',
    }, true);
    render(<AccountSettings />);
    expect(screen.getByText('auth_method_oauth')).toBeInTheDocument();
  });
});
