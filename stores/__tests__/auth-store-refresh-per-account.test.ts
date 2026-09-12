import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as browserNavigation from '@/lib/browser-navigation';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const SERVER = 'https://mail.example.test';

function account(id: string, slot: number, active: boolean) {
  return {
    id,
    label: id,
    serverUrl: SERVER,
    username: `${id}@example.test`,
    authMode: 'oauth' as const,
    rememberMe: true,
    displayName: id,
    email: `${id}@example.test`,
    lastLoginAt: Date.now(),
    isConnected: false,
    hasError: false,
    isDefault: active,
    cookieSlot: slot,
    avatarColor: '#000',
  };
}

function session(username: string) {
  return {
    username,
    accounts: { acc: { name: username } },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc' },
    apiUrl: `${SERVER}/jmap`,
    downloadUrl: `${SERVER}/download`,
    uploadUrl: `${SERVER}/upload`,
    capabilities: {},
  };
}

function jsonResponse(status: number, body: unknown) {
  const res = {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url: '',
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() { return res; },
  };
  return res;
}

/**
 * Reproduction for the silent account drop (#refresh-race).
 *
 * Two OAuth accounts: A (active, slot 0) and B (background, slot 1). B's
 * cached access token is already expired as far as the mail server is
 * concerned, so B's first JMAP call gets a 401 and its client asks the store
 * for a fresh token. The store must refresh SLOT 1 (B's refresh token) and
 * hand B a token minted for B - not force-rotate the active account's
 * refresh token and hand B the active account's token.
 */
describe('auth-store: token refresh is scoped to the account that needs it', () => {
  const forcedRefreshSlots: number[] = [];
  const deletedSessions: string[] = [];
  let freshCounter = 0;

  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    forcedRefreshSlots.length = 0;
    deletedSessions.length = 0;
    freshCounter = 0;
    window.history.pushState({}, '', '/en');
    vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});

    useAccountStore.setState({
      accounts: [account('A', 0, true), account('B', 1, false)],
      activeAccountId: 'A',
      defaultAccountId: 'A',
    });
    useAuthStore.setState({
      isAuthenticated: true,
      isLoading: false,
      error: null,
      serverUrl: SERVER,
      username: 'A@example.test',
      client: null,
      authMode: 'oauth',
      rememberMe: true,
      accessToken: null,
      tokenExpiresAt: null,
      connectionLost: false,
      activeAccountId: 'A',
    });

    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;

      // Bulwark token route: plain PUT hands back the cached token for the
      // slot; force=true mints a fresh one for that slot.
      const m = url.match(/^\/api\/auth\/token\?slot=(\d+)(&force=true)?$/);
      if (m && method === 'PUT') {
        const slot = Number(m[1]);
        const who = slot === 0 ? 'A' : 'B';
        if (m[2]) {
          forcedRefreshSlots.push(slot);
          freshCounter += 1;
          return jsonResponse(200, { access_token: `${who}-fresh-${freshCounter}`, expires_in: 3600 });
        }
        return jsonResponse(200, { access_token: `${who}-cached`, expires_in: 3600 });
      }
      if (url.startsWith('/api/auth/session') && method === 'DELETE') {
        deletedSessions.push(url);
        return jsonResponse(200, {});
      }
      if (url.startsWith('/api/auth/token') && method === 'DELETE') {
        return jsonResponse(200, {});
      }
      if (url === '/api/auth/stalwart-context') {
        return jsonResponse(200, { ok: true });
      }

      // Mail server: B's cached token is expired; everything else is accepted
      // and answered with the session of the account the token belongs to.
      if (url === `${SERVER}/.well-known/jmap`) {
        const auth = headers.Authorization ?? '';
        if (auth === 'Bearer B-cached') return jsonResponse(401, {});
        const owner = auth.includes('Bearer A') ? 'A' : 'B';
        return jsonResponse(200, session(`${owner}@example.test`));
      }
      // Anything else (display-name lookups etc.) is irrelevant here.
      return jsonResponse(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    for (const client of useAuthStore.getState().getAllConnectedClients().values()) {
      try { client.disconnect(); } catch { /* ignore */ }
    }
    vi.unstubAllGlobals();
  });

  it('keeps a background account whose restore is rejected, marked instead of removed', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const original = fetchMock.getMockImplementation() as (input: FetchInput, init?: FetchInit) => Promise<unknown>;
    fetchMock.mockImplementation(async (input: FetchInput, init?: FetchInit) => {
      if (String(input) === '/api/auth/token?slot=1' && init?.method === 'PUT') {
        return jsonResponse(401, { error: 'No refresh token' });
      }
      return original(input, init);
    });

    await useAuthStore.getState().checkAuth();
    await vi.waitFor(() => {
      expect(useAccountStore.getState().getAccountById('B')?.hasError).toBe(true);
    });

    const ids = useAccountStore.getState().accounts.map((a) => a.id).sort();
    expect(ids).toEqual(['A', 'B']);
    expect(useAccountStore.getState().getAccountById('B')?.isConnected).toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(deletedSessions).toEqual([]);
  });

  it('refreshes the background account\'s own slot and keeps both accounts', async () => {
    await useAuthStore.getState().checkAuth();

    // Background restore of B runs fire-and-forget after A is up.
    await vi.waitFor(() => {
      expect(forcedRefreshSlots.length).toBeGreaterThan(0);
    });
    // Give the retry-after-refresh a moment to land.
    await vi.waitFor(() => {
      expect(useAuthStore.getState().getClientForAccount('B')).toBeDefined();
    });

    // The refresh B asked for must be spent on B's slot, never on A's.
    expect(forcedRefreshSlots).toEqual([1]);

    // B ends up holding a token minted for B, not A's.
    const clientB = useAuthStore.getState().getClientForAccount('B')!;
    expect(clientB.getAuthHeader()).toMatch(/^Bearer B-fresh-/);

    // Nobody got evicted and the active session is untouched.
    const ids = useAccountStore.getState().accounts.map((a) => a.id).sort();
    expect(ids).toEqual(['A', 'B']);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(deletedSessions).toEqual([]);
  });
});
