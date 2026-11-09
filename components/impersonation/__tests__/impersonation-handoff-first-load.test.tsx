import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createJSONStorage } from 'zustand/middleware';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// The first load after an impersonation handoff: the page still holds the
// account list from before, and the reconciler drops it before the reload.
// The sign-in check runs on that same load. If it still saw the old list,
// it would evict an account signed in without "Remember me" and clear its
// slot, and for slot 0 that sign-out revokes the impersonation the handoff
// just opened (DELETE /api/auth/session?slot=0 deletes the grant's app
// password), so the reload landed on the login page.

vi.mock('@/lib/jmap/client', () => {
  class RequestTimeoutError extends Error {}
  class JMAPClient {
    constructor(public serverUrl: string, public username: string, public password: string) {}
    static withBearer() { throw new Error('not used'); }
    async connect() {}
    getSessionUsername() { return this.username; }
    getUsername() { return this.username; }
    async getIdentities() { return []; }
    getAuthHeader() { return 'Basic eA=='; }
    onConnectionChange() {}
    onRateLimit() {}
    getRateLimitRemainingMs() { return 0; }
    supportsContacts() { return false; }
    supportsPrincipals() { return false; }
    supportsVacationResponse() { return false; }
    supportsCalendars() { return false; }
    supportsSieve() { return false; }
    disconnect() {}
    getAccountId() { return 'acct'; }
  }
  class RateLimitError extends Error {}
  return { JMAPClient, RateLimitError, RequestTimeoutError };
});
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));

import * as browserNavigation from '@/lib/browser-navigation';
import { IMPERSONATION_MARKER_COOKIE } from '@/lib/impersonation/marker-cookie';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { ImpersonationReconciler } from '../impersonation-reconciler';

/** The admin's own sign-in, made without "Remember me", in slot 0. */
const admin = {
  id: 'admin@mail.x.test', label: 'Admin', serverUrl: 'https://mail.x.test', username: 'admin', authMode: 'oauth' as const,
  rememberMe: false, cookieSlot: 0, displayName: 'Admin', email: 'admin@x.test', isConnected: true, hasError: false,
  lastLoginAt: 1, avatarColor: '#000000', isDefault: true,
};

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/api/auth/session') && init?.method === 'PUT') {
    return Response.json({ serverUrl: 'https://mail.x.test', username: 'alice@x.test', password: 'app-password', impersonated: true });
  }
  if (url.includes('/api/config')) return Response.json(createConfig());
  return Response.json({});
});

let replace: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  vi.stubGlobal('fetch', fetchMock);
});

beforeEach(() => {
  localStorage.clear();
  useAccountStore.persist.setOptions({ storage: createJSONStorage(() => localStorage) });
  useAuthStore.persist.setOptions({ storage: createJSONStorage(() => localStorage) });
  replace = vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});
  useAccountStore.setState({ accounts: [admin], activeAccountId: admin.id, defaultAccountId: admin.id });
  useAuthStore.setState({ isAuthenticated: false, client: null, activeAccountId: admin.id, error: null });
  fetchMock.mockClear();
});

afterEach(() => {
  replace.mockRestore();
  window.history.replaceState({}, '', '/');
});

it('does not sign out of slot 0, which would end the impersonation it just opened', async () => {
  window.history.replaceState({}, '', '/en?impersonated=1');
  document.cookie = `${IMPERSONATION_MARKER_COOKIE}=1; path=/`;

  // The reconciler sits before the page in the layout, so its effect runs
  // first; the page's sign-in check follows on the same load.
  render(<ImpersonationReconciler />);
  await useAuthStore.getState().checkAuth();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const deletes = fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')
    .map(([url]) => String(url));
  expect(deletes).toEqual([]);
  expect(replace).toHaveBeenCalledWith('/en');
});
