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

  it('marks session expiry, preserves the current path, and redirects to login when the refresh is rejected (401)', async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/api/auth/token?slot=0' && method === 'PUT') {
        return { ok: false, status: 401, json: async () => ({}) };
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

  it('keeps the session and schedules a retry when the token endpoint is unavailable (5xx)', async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/api/auth/token?slot=0' && method === 'PUT') {
        return { ok: false, status: 503, json: async () => ({}) };
      }

      throw new Error(`Unexpected fetch call: ${method} ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    const replaceSpy = vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});

    useAuthStore.setState({
      isAuthenticated: true,
      authMode: 'oauth',
      activeAccountId: null,
    });

    const token = await useAuthStore.getState().refreshAccessToken();

    expect(token).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(sessionStorage.getItem('session_expired')).toBeNull();
    expect(replaceSpy).not.toHaveBeenCalled();

    const countPuts = () => fetchMock.mock.calls.filter(
      ([input, init]) => String(input) === '/api/auth/token?slot=0' && init?.method === 'PUT',
    ).length;

    // A retry is armed: advancing past the ~30 s window fires a second PUT.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(countPuts()).toBe(2);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);

    // Backoff: after the second failure the next retry waits ~60 s, not 30.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(countPuts()).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(countPuts()).toBe(3);
  });

  it('stops retrying when the user signs out during the outage (#588)', async () => {
    vi.useFakeTimers();

    let resolveInFlight: ((value: { ok: boolean; status: number; json: () => Promise<object> }) => void) | undefined;
    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/api/auth/token?slot=0' && method === 'PUT') {
        return new Promise((resolve) => { resolveInFlight = resolve; });
      }
      if (method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`Unexpected fetch call: ${method} ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});

    useAuthStore.setState({
      isAuthenticated: true,
      authMode: 'oauth',
      activeAccountId: null,
    });

    // Refresh goes in flight, then the user signs out before it settles.
    const pending = useAuthStore.getState().refreshAccessToken();
    useAuthStore.getState().logout();
    resolveInFlight!({ ok: false, status: 503, json: async () => ({}) });
    await pending;

    // The failure lands after the sign-out - no retry may be re-armed.
    const countPuts = () => fetchMock.mock.calls.filter(
      ([input, init]) => String(input) === '/api/auth/token?slot=0' && init?.method === 'PUT',
    ).length;
    expect(countPuts()).toBe(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(countPuts()).toBe(1);
  });

  it('keeps the session when the refresh request fails with a network error', async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/api/auth/token?slot=0' && method === 'PUT') {
        throw new TypeError('Failed to fetch');
      }

      throw new Error(`Unexpected fetch call: ${method} ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    const replaceSpy = vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});

    useAuthStore.setState({
      isAuthenticated: true,
      authMode: 'oauth',
      activeAccountId: null,
    });

    const token = await useAuthStore.getState().refreshAccessToken();

    expect(token).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(sessionStorage.getItem('session_expired')).toBeNull();
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});