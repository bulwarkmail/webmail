import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import { generateAccountId } from '@/lib/account-utils';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';

const SERVER = 'https://mail.example.com';
const OPTIONS = { remember: true, rememberPassword: true, allowedServers: null, customServersAllowed: true };

/**
 * What the desktop app becomes after a sign-in in the browser. A typed password stays a
 * password account (#1432): its settings are there, and sign-out doesn't go to a provider.
 */
describe('loginWithDesktopHandoff', () => {
  let redeemAnswer: unknown;
  let redeemBody: Record<string, unknown>;

  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    window.history.pushState({}, '', '/en/login');
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
    useAuthStore.setState({ isAuthenticated: false, isLoading: false, error: null, serverUrl: null, username: null, client: null, activeAccountId: null });
    vi.spyOn(JMAPClient.prototype, 'connect').mockResolvedValue(undefined as never);
    vi.spyOn(JMAPClient.prototype, 'getUsername').mockReturnValue('session-name@example.com');
    vi.spyOn(JMAPClient.prototype, 'getSessionUsername').mockReturnValue('session-name@example.com');
    vi.spyOn(JMAPClient.prototype, 'getIdentities').mockResolvedValue([{ id: 'i', name: 'Alice', email: 'alice@example.com' }] as never);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/auth/desktop-handoff/redeem')) {
        redeemBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(redeemAnswer), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const account = () => useAccountStore.getState().getActiveAccount();

  it('tokens from a typed password are a password account, under the name typed', async () => {
    redeemAnswer = { flow: 'tokens', server_url: SERVER, access_token: 'a', expires_in: 3600, remember: true, password_login: true, username: 'alice' };
    expect(await useAuthStore.getState().loginWithDesktopHandoff('c', 'v', OPTIONS)).toBe('ok');
    expect(account()).toMatchObject({ authMode: 'oauth', providerSession: false, username: 'alice' });
    // A short login name has the same id as the password sign-in, so what was kept for it comes back.
    expect(account()?.id).toBe(generateAccountId('alice', SERVER));
    expect(account()?.id).not.toBe(generateAccountId('alice@example.com', SERVER));
    expect(useAuthStore.getState().username).toBe('alice');
    expect(account()?.serverIdentifiers?.length).toBeGreaterThan(0);
  });

  it('a provider\'s sign-in stays a provider session, under the address the server gives', async () => {
    redeemAnswer = { flow: 'tokens', server_url: SERVER, access_token: 'a', expires_in: 3600, remember: true };
    expect(await useAuthStore.getState().loginWithDesktopHandoff('c', 'v', OPTIONS)).toBe('ok');
    expect(account()).toMatchObject({ authMode: 'oauth', providerSession: true, username: 'alice@example.com' });
  });

  it('sends the device\'s rules with the code', async () => {
    redeemAnswer = { flow: 'tokens', server_url: SERVER, access_token: 'a', expires_in: 3600, remember: true };
    await useAuthStore.getState().loginWithDesktopHandoff('c', 'v', { ...OPTIONS, allowedServers: ['https://a.example'], customServersAllowed: false });
    expect(redeemBody).toMatchObject({ code: 'c', code_verifier: 'v', allowed_servers: ['https://a.example'], custom_servers_allowed: false });
  });
});
