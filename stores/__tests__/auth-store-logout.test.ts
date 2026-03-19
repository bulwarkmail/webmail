import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as browserNavigation from '@/lib/browser-navigation';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

describe('auth-store logout redirects', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    window.history.pushState({}, '', '/en');

    useAccountStore.setState({
      accounts: [],
      activeAccountId: null,
      defaultAccountId: null,
    });

    useAuthStore.setState({
      isAuthenticated: false,
      isLoading: false,
      error: null,
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
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('redirects full logout to the locale login page', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const replaceSpy = vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});

    window.history.pushState({}, '', '/fr/calendar');
    useAuthStore.setState({ isAuthenticated: true, authMode: 'basic' });

    useAuthStore.getState().logout();

    expect(replaceSpy).toHaveBeenCalledWith('/fr/login');
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/session?slot=0', { method: 'DELETE', keepalive: true });
  });

  it('marks session expiry, preserves the current path, and redirects to login on refresh failure', async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/api/auth/token?slot=0' && method === 'PUT') {
        return { ok: false, json: async () => ({}) };
      }

      if (url === '/api/auth/token?slot=0' && method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }

      if (url === '/api/auth/session?slot=0' && method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }

      throw new Error(`Unexpected fetch call: ${method} ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    const replaceSpy = vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});

    window.history.pushState({}, '', '/en/calendar?view=day');
    useAuthStore.setState({
      isAuthenticated: true,
      authMode: 'oauth',
      activeAccountId: null,
    });

    await useAuthStore.getState().refreshAccessToken();
    await vi.runAllTimersAsync();

    expect(sessionStorage.getItem('session_expired')).toBe('true');
    expect(sessionStorage.getItem('redirect_after_login')).toBe('/en/calendar?view=day');
    expect(replaceSpy).toHaveBeenCalledWith('/en/login');
  });
});